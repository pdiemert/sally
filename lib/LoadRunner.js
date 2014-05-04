var _ = require('underscore');
var p_zmq = require('zmq');
var p_os = require('os');
var p_ssa = require('ssa');
var p_ssaLogger = p_ssa.Logger;

var p_c = require('../modules/colored');

var p_const = require('./const.js');
var p_cmdr = require('commander');
var p_u = require('./util.js');
var p_mon = require('./Monitor.js');
var p_cur = require('ncurses');

// NCurses top window
var _wscr;

function vbar(w, r, c, len, ch)
{
	while(len--)
		w.print(r++, c, ch ? ch : '#');
}

function hbar(w, r, c, len, ch)
{
	while(len--)
		w.print(r, c++, ch ? ch : '#');
}

function strat(w, r, c, str, opt)
{
	str += '';

	if (opt && opt.right)
		c = Math.max(0, c - str.length);

	w.print(r, c, str);
}

/********************************************************************************
 * load runner
 *
 * Load tests consist of an object with the following properties:
 *
 * {
 *      // Suite to run first (optional)
 *      start: [],
 *
 *      users:
 *      {
 *          // Object of virtual users, each item is "<name>" : [<suite>]
 *
 *      },
 *
 *      // Suite to run last (optional)
 *      finish: []
 * }
 *
 * All suite functions are passed the following on the this.loadTest object:
 *
 * userIndex        The index of this user within the population of running users (not sent to start/finish)
 * userCount        Total number of users, of this type, in the population (not sent to start/finish)
 * runCount         The total number of times this user suite has been run (not sent to start/finish)
 * getUserCount     A function that returns the user count for a user name
 * params           An object which should be used during start to set properties which will be passed to all users
 * workerId         An id for the worker processes, every SLAVE has a unique worker id
 *
 * All logs are merged before finish is called
 *
 * There is one method:
 *
 *  runLoad(options)
 *
 * options is an object that can have the same properties as SuiteRunner with the additional:
 *
 * params           Parameters sent to all suites context
 * verbosity        Verbosity level, each higher level will include all lower level messages, can be:
 *                              0   No messages, just show errors and summary
 *                              1   All test results
 *                              2   All info messages
 *                              3   All request/responses
 * duration         Duration of test in seconds
 * loadProfile      Can be either:
 *
 *                  1)  An array -  Each item is a two element array, first is a time offset in seconds, second is a user count
 *                                  The user count is divided evenly among the different virtual users.  For example:
 *
 *                                  [[0,10],[120,1000]]
 *                                  Starts with 10 users at the beginning of the test and ramps to 1000 after 120 seconds
 *
 *                  2)  An object - Each property name corresponds to a virtual user name, each value is a two
 *                                  element array of offset, user count as above
 *
 * repeatDelay      Can be either a number which will be the number of milliseconds between suite execution for all users
 *                  or an object with each property a user name and each value the number of millisecond delay for those users
 *                  If no repeat delay then a default 1000ms is used
 *
 * dumpLog          If true, will dump contents of combined log after load test
 *                  If "onfail" then will dump only on failure
 */

function LoadRunner(test, options)
{
	var _options = _.clone(options);

	var _wpop;
	var _wsuccess;
	var _wfail;

	// A map of worker ids
	var _workers;

	// An object used to gather metrics from each worker, once all workers have provided
	// data, the info is logged
	var _workermetrics;

	var _startTime;
	var _fncComplete;
	var _log = options.log || new p_ssa.Logger();
	var _profilelog = _log.newScope('InProfile');
	var _test = test;
	var _workerOut;
	var _workerIn;
	var _succeed = 0;
	var _fail = 0;
	var _abort = 0;
	var _clock = {};
	var _workerCount = 0;
	var _modestack = [];
	var _userstat = {};

	_options.loadTest = this;

	if (!_options.params)
		_options.params = {};

	this.params = _options.params;
	this.clock = _clock;

	switch (_options.verbosity != undefined)
	{
		case 3:
		case 2:
			_log.echoToConsole(true);
			break;
		case 1:
			_log.echoToConsole([_log.ErrorType, _log.WarningType, _log.GoodType]);
			break;
		case 0:
			_log.echoToConsole(false);
			break;
	}

	p_cmdr.option('-up, --uport <n>').option('-dp, --dport <n>').parse(process.argv);

	// Calculate population, create object with each prop a user name and each value a user count
	var _population = {};

	function enter(mode)
	{
		_modestack.push(mode);
	}

	function leave()
	{
		_modestack.pop();
	}

	function mode()
	{
		return _modestack.length == 0 ? null : _modestack[_modestack.length - 1];
	}

	//function error(msg)
	//{
	//	_log.error(msg);
	//}

	function out(msg)
	{
		_wscr.cursor(2,0);
		_wscr.clrtoeol();
		_wscr.centertext(2, msg);
		_wscr.refresh();
		//console.log(msg);
	}

	function info(msg)
	{
		_log.info(msg);
	}

	function opt(name, def)
	{
		if (!(name in _options))
		{
			if (def === undefined) throw 'Missing required option \"' + name + '\"';
			else return def;
		}

		return _options[name];
	}

	function stat(u)
	{
		if (!(u in _userstat))
		{
			_userstat[u] = {s:0, f:0, a:0, log:new p_ssa.Logger()};
		}

		return _userstat[u];
	}

	function calcPopulation()
	{
		// Find peaks for each user type
		var prof = opt('loadProfile');

		var max = 0;

		if (_.isArray(prof))
		{
			prof.forEach(function (e)
			{
				if (e[1] > max)
					max = e[1];
			});

			var pop = Math.max(1, ~~(max / _.keys(_test.users).length));

			for (var u in _test.users)
			{
				_population[u] = pop;
			}
		}
		else
		{
			for (var u in _test.users)
			{
				if (!(u in _population))
					_population[u] = 0;

				if (prof[u])
				{
					prof[u].forEach(function (e)
					{
						if (e[1] > _population[u])
							_population[u] = e[1];
						if (e[1] > max)
							max = e[1];
					});
				}
			}
		}

		_maxpop = max;
	}

	function getFnc(afunc)
	{
		for (var i = 0; i < afunc.length; i++)
		{
			if (eval("typeof " + afunc[i] + " == 'function'")) return eval(afunc[i]);
		}

		return null;
	}

	function handleInbound(data)
	{
		var o = p_u.unpackJS(data.toString());
		var fnc;

		// First see if there is a mode specific func
		var m = mode();
		if (m)
			fnc = getFnc(['onCmd_' + m + '_' + o.cmd]);

		// Non mode specific
		if (!fnc)
			fnc = getFnc(['onCmd_' + o.cmd]);

		if (fnc)
			fnc(o);
		// else console.log('Ignoring msg: ' + o.cmd);
	}

	function closeHub()
	{
		_workerOut.close();
		_workerIn.close();
	}

	function openHub()
	{
		_workerOut = p_zmq.socket('push');
		_workerOut.bindSync('tcp://*:' + p_const.defaultWorkerOutPort);
		info('Downstream worker hub open on ' + p_const.defaultWorkerOutPort);

		_workerIn = p_zmq.socket('pull');
		_workerIn.bindSync('tcp://*:' + p_const.defaultWorkerInPort);
		_workerIn.on('message', handleInbound);
		info('Upstream worker results open on ' + p_const.defaultWorkerInPort);
	}

	this.getUserCount = function (name)
	{
		if (!(name in _population)) return 0;
		else return _population[name];
	};

	function dumpResults()
	{
		if (_options.debug)
		{
			_profilelog.dumpToConsole();
		}

		if (_options.dumpLog)
		{
			if (_options.dumpLog == 'onfail')
			{
				if (_fail > 0)
					_log.filter(_log.ErrorType).dumpToConsole();
			}
			else
				_log.dumpToConsole();
		}

		if (_fncComplete)
		{
			_fncComplete(null, _succeed, _fail, _abort, _log);
		}
		else
		{
			var elapse = new Date().getTime() - _startTime.getTime();

			var sum = [];
			if (_succeed > 0) sum.push(p_c.green(_succeed + ' succeeded'));
			if (_fail > 0) sum.push(p_c.red(_fail + ' failed'));
			if (_abort > 0) sum.push(p_c.yellow(_abort + ' aborted'));

			console.log(sum.join(', ') + ' in ' + elapse + 'ms.');
		}
	}

	function finish()
	{
		closeHub();

		// Run finish
		if (_test.finish)
		{
			out('..Finish..')

			var scope = _log.newScope('finish');
			_options.log = scope;

			p_ssa.runSuite(_test.finish, _options, function (s, f, a, l)
			{
				_succeed += s;
				_fail += f;
				_abort += a;

				dumpResults();
			});
		}
		else
		{
			dumpResults();
		}
	}

	function workerOut(msg)
	{
		_workerOut.send(p_u.packJS(msg));
	}

	function findWorkers()
	{
		_workers = {};

		out('..Load Testing, searching for slaves..');

		enter('workerInit');

		// Search for 3 sec, strobe every 100ms
		var searchDur = 3000;
		var t = new Date().getTime();

		var search = setInterval(function()
		{
			workerOut({
				cmd: 'workerInit',
				host:p_os.hostname(),
				time:new Date()
			});

			if ((new Date().getTime() - t) >= searchDur)
			{
				clearInterval(search);

				if (_.keys(_workers).length == 0)
				{
					return _fncComplete && _fncComplete(new Error('Unable to locate any workers'));
				}
				else
				{
					leave();
					runProfile();
				}
			}
		}, 100);
	}

	/**************************************************
	 * Inbound handlers
	 */

	function onCmd_workerInit_setup(data)
	{
		// if worker already logged then we've found all the workers
		if (data.id in _workers)
			return;

		// log worker
		_workers[data.id] = true;
	}

	function onCmd_finish(data)
	{
		// bump totals
		for (var u in data.stat)
		{
			var st = stat(u);

			st.s += data.stat[u].s;
			st.f += data.stat[u].f;
			st.a += data.stat[u].a;

			_succeed += data.stat[u].s;
			_fail += data.stat[u].f;
			_abort += data.stat[u].a;

			_log.append(data.stat[u].log);
		}

		// Merge clocks
		mergeClocks(_clock, data.clock);

		// Once received from all workers, terminate
		if (!--_workerCount)
			finish();
	}

	function onCmd_workerMetrics(data)
	{
		if (!_workermetrics)
			_workermetrics = {};

		_workermetrics[data.id] = data;

		if (_.keys(_workermetrics).length == _workerCount)
		{
			var mWorker = {};
			var mPop = {};
			var mClock = {};
			var totalpop = 0;
			var totals = 0;
			var totalf = 0;

			// Sum
			for (var id in _workermetrics)
			{
				var m = _workermetrics[id];

				if (!(m.id in mWorker))
					mWorker[m.id] = {cpu:m.metrics.cpu, mem:m.metrics.mem};

				for (var p in m.pop)
				{
					if (!(p in mPop))
						mPop[p] = { c:0, s:0, f:0, a:0  };

					mPop[p].c += m.pop[p];

					totalpop += m.pop[p];

					mPop[p].s += m.stat[p].s;
					mPop[p].f += m.stat[p].f;
					mPop[p].a += m.stat[p].a;

					totals += m.stat[p].s;
					totalf += m.stat[p].f;
				}
			}

			// Merge clocks
			mergeClocks(mClock, data.clock)

			_wpop.refresh(totalpop);
			_wsuccess.refresh(totals);
			_wfail.refresh(totalf);

			//_profilelog.out('##workermetrics##', mWorker);
			//_profilelog.out('##popmetrics##', mPop);
			//_profilelog.out('##reqmetrics##', mClock);

			_workermetrics = {};
		}
	}

	/**************************************************
	 */
	function mergeClocks(clockset, clock)
	{
		for(var name in clock)
		{
			var c = clockset[name];
			if (!c)
			{
				c = {count:0, elapsed:0, avg:0,hist:[]};
				clockset[name] = c;
			}

			c.count += clock[name].count;
			c.elapsed += clock[name].elapsed;
			c.avg = clock[name].elapsed / clock[name].count;

			// Merge historic, as each worker starts near the same moment and polls at the same interval
			// the historic ***should** be one for one
			// Cluster on p_const.workerMetricsInterval
			var ci = clock[name];

			if (ci.hist)
			{
				for(var ih = 0; ih < ci.hist.length; ih++)
				{
					var i = Math.round(ci.hist[ih].offset / p_const.workerMetricsInterval);

					var h = c.hist[i];

					if (h === undefined)
					{
						h = {count:0, elapsed:0, avg:0, offset:i*p_const.workerMetricsInterval};
						c.hist[i] = h;
					}

					h.count += ci.hist[ih].count;
					h.elapsed += ci.hist[ih].elapsed;
					h.avg  = h.elapsed / h.count;
				}

				if (!c.hist[0])
					c.hist.splice(0, 1);
			}
		}
	}

	function runProfile()
	{
		_workerCount = Object.keys(_workers).length;

		out('....Found ' + _workerCount + ' slave' + (_workerCount == 1 ? '' : 's') + ', starting...');

		// Send test to workers
		var iWorker = 0;
		for (var w in _workers)
		{
			var parms = {
				cmd:        'run',
				users:      _test.users,
				options:    _options,
				workerIndex:iWorker++,
				workerCount:_workerCount,
				population: {}
			};

			// Calc the population partition
			for (var u in _population)
			{
				var part = p_u.partition(_population[u], _workerCount, parms.workerIndex);
				parms.population[u] = [part[0], part[1], _population[u]];
			}

			// Object sent to worker -
			//
			// users        user object as specified in load profile
			// population   object that maps user type to [index base for worker, max pop for worker, max pop total]
			// options      options passed to runload
			// workerIndex  0-based index of the worker
			// workerCount  total # of workers
			workerOut(parms);
		}

		_startTime = new Date();

		_wpop = new StaticHistWidget('Population', _maxpop, _startTime, _options.duration, Math.round(_wscr.height * 0.1), 0, _wscr.width, Math.round(_wscr.height * 0.5));
		_wsuccess = new GaugeWidget('Successes', _wpop.bottom + 1, 0);
		_wfail = new GaugeWidget('Failures', _wpop.bottom + 1, _wsuccess.right + 2);
	}

	this.run = function (cb)
	{
		_wscr = new p_cur.Window();

		p_cur.showCursor = false;

		process.on('SIGINT', function()
		{
			return _fncComplete && _fncComplete();
		});

		_fncComplete = function(err,s,f,a,l)
		{
			_wscr.close();
			cb(err, s == undefined ? 0 : s, f == undefined ? 0 : f, a == undefined ? 0 : a, l);
		};

		openHub();

		calcPopulation();

		// Run start
		if (_test.start)
		{
			out('Running START suite');

			var scope = _log.newScope('start');
			_options.log = scope;

			p_ssa.runSuite(_test.start, _options, function (s, f, a, l)
			{
				_succeed += s;
				_fail += f;
				_abort += a;

				// if failures then stop
				if (f > 0 || !_test.users)
					finish();
				else
					findWorkers();
			});
		}
		else
		{
			if (!_test.users)
				finish();
			else
				findWorkers();
		}

	};
}

function addWinProp(o)
{
	Object.defineProperty(o, 'width', { get : function() { return o.window.width; }});
	Object.defineProperty(o, 'height', { get : function() { return o.window.height; }});
	Object.defineProperty(o, 'top', { get : function() { return o.window.begy; }});
	Object.defineProperty(o, 'left', { get : function() { return o.window.begx; }});
	Object.defineProperty(o, 'bottom', { get : function() { return o.window.begy + o.window.height - 1; }});
	Object.defineProperty(o, 'right', { get : function() { return o.window.begx + o.window.width - 1; }});
}

function StaticHistWidget(title, maxpop, start, dursec, r, c, w, h)
{
	var _dur = dursec * 1000;
	var _startTime = start;
	var _max = maxpop;
	var _w = new p_cur.Window(h, w);
	var _padl = (_max + '').length + 2;
	var _padb = 2;
	var _padt = 1;
	var _padr = 0;

	var _xlast = 0;
	var _ylast = 0;

	this.window = _w;

	this.refresh = 	function (totalpop)
	{
		var hmax = _w.height - (_padb + _padt);
		var wmax = _w.width - (_padl + _padr);

		var x = Math.round(((Date.now() - _startTime.getTime()) / (_dur)) * wmax);
		var y = Math.round((totalpop / _max) * hmax);

		// If already drawn then erase current
		if (x == _xlast)
			vbar(_w, _padt, _padl+x, hmax, ' ');

		// Draw tween
		for(var ix = _xlast + 1; ix < x; ix++)
		{
			var d = Math.round(_ylast + ((y - _ylast) * ((ix - _xlast) / (x-_xlast))));

			vbar(_w, _padt + (hmax - d), _padl + ix, d);
		}

		// Draw bar
		vbar(_w, _padt + (hmax - y), _padl + x, y);

		_xlast = x;
		_ylast = y;

		_w.refresh();
	};

	addWinProp(this);

	_w.move(r, c);

	vbar(_w, _padt, _padl - 1, _w.height - (_padt + _padb), '|');
	hbar(_w, _w.height - _padb, _padl, _w.width - (_padl + _padr), '-');

	strat(_w, 0, 0, title);
	strat(_w, _padt, _padl-2, _maxpop, { right : true});
	strat(_w, _w.height-1, _w.width, (_dur / 1000).toFixed(1) + 's', {right : true});

	_w.refresh();


}

function GaugeWidget(title, r, c)
{
	var _val = 0;
	var _w = new p_cur.Window(1, title.length + 7);
	this.window = _w;

	addWinProp(this);

	_w.move(r, c);

	strat(_w, 0, 0, title + ':');
	strat(_w, 0, _w.width, 0, { right : true});

	_w.refresh();

	this.refresh = 	function (v)
	{
		_val = v;
		strat(_w, 0, _w.width, _val, { right : true});

		_w.refresh();
	};
}

exports.LoadRunner = LoadRunner;