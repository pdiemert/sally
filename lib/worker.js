/*global require*/
var _ = require('underscore');
var p_zmq = require('zmq');
var p_ssa = require('ssa');
var p_os = require('os');
//var p_eyes = require('eyes');
//p_eyes.inspect(p_zmq);
var p_const = require('./const.js');
var p_u = require('./util.js')

var g_inbound;
var g_outbound;
var g_log;
var g_host;
var g_tmrHeartbeat;
var g_tmrMetrics;
var g_reqclock;
var g_test;
var g_starttime;
var g_runningSuites = {};
var g_suiteRunCount = 0;
var g_suiteConcurrent = 0;

// maps user to a status object:
// { 
//      max:,   number of users allowed for this worker at this point in time
//      s:,     number of successful tests executed
//      f:,     number of failed tests executed
//      a:,     number of aborted tests executed
//      log:    log for user
//  }
var g_userstat = {};

// The running population map, an object, each property is the user name, and the value is an array of VirtualUser
var g_pop = {};

function reset()
{
	g_log = new p_ssa.Logger();
	g_host = undefined;
	g_tmrHeartbeat = undefined;
	g_tmrMetrics = undefined;
	g_test = undefined;
	g_starttime = undefined;
	g_userstat = {};
	g_pop = {};
	g_reqclock = {};
}

function VirtualUser(user, index)
{
	var _user = user;
	var _index = index;
	var _fstopped = false;
	var _timeout;
	var _self = this;
	var _count = 0;

	this.start = function ()
	{
		var suite = g_test.users[_user];
		var st = stat(_user);

		// console.log('Starting ' + _user + ' @ ' + _index);

		var opt = _.clone(g_test.options);
		opt.loadTest = {
			workerId:    workerId(),
			userIndex:   _index,
			userCount:   g_test.population[_user][2],
			runCount:    _count,
			params:      g_test.options.params,
			getUserCount:function (u)
			{
				return g_test.population[u][2];
			}
		};

		opt.log = st.log;

		opt.reqclock = g_reqclock;

		// No output
		opt.verbosity = -1;

		var run = ++g_suiteRunCount;
		g_runningSuites[run] = suite;
		g_suiteConcurrent++;

		p_ssa.runSuite(suite, opt,
			function()
			{
				delete g_runningSuites[run];
				g_suiteConcurrent--;
				handleSuiteFinish.apply(this, arguments);
			});
	};

	this.stop = function ()
	{
		// console.log('Stoping ' + _user + ' @ ' + _index);
		_fstopped = true;
		if (_timeout) clearTimeout(_timeout);
	};

	function handleSuiteFinish(s, f, a, l)
	{
		// console.log('Finishing ' + _user + ' ' + s + ' ' + f + ' ' + a);
		var st = stat(_user);

		// We may have been shut down so g_test is null
		if (st)
		{
			st.s += s;
			st.f += f;
			st.a += a;
		}

		if (_fstopped) return;

		// Not stopped so reschedule
		_timeout = setTimeout(function ()
		{
			_timeout = null;

			if (_fstopped) return;

			_self.start();

		}, calcRepeatInterval(_user));
	}
}

// Updates the user population 
// Starts or stops virtual users as needed
//
// Getting the index correct is tricky, it breaks down like this
//
// - There is a MAX number of users per type across all workers calculated by the loadrunner
// - This MAX is partitioned per number of workers, index and count for our partition are passed to us on run
// - We calc the actual number of users based on the time and load profile (see findIntervalPop)
// - We keep an array for each user type with one slot for each active user
// - The index of the user in the total population is the index into this array + our base index, passed to us on run
// - As user count goes up/down we add to the end of the array, subtract from the end of the array so that we can re-use user indexes
// - The user index then never goes below the base and never goes about base + partition_size

function updateUserPop(user, count)
{
	var st = stat(user);
	var pop = population(user);
	var vu;

	st.max = count;

	var base = g_test.population[user][0];

	// Create new vusers if needed, add to end
	while (pop.length < st.max)
	{
		vu = new VirtualUser(user, base + pop.length);
		pop.push(vu);

		vu.start();
	}

	// Remove excess vusers if needed, remove from end
	while (pop.length > st.max)
	{
		vu = pop.pop();
		vu.stop();
	}
}

function calcRepeatInterval(user)
{
	if (!('repeatDelay' in g_test.options))
		return p_const.defaultRepeatDelay;

	if (_.isNumber(g_test.options.repeatDelay))
		return g_test.options.repeatDelay;

	if (!_.isObject(g_test.options.repeatDelay))
		return p_const.defaultRepeatDelay;

	return g_test.options.repeatDelay[user];
}

function out(m)
{
	console.log(m);
}

function start(host, portFromMaster, portToMaster)
{
	g_inbound = p_zmq.socket('pull');
	g_inbound.connect('tcp://' + host + ':' + portFromMaster);

	g_outbound = p_zmq.socket('push');
	g_outbound.connect('tcp://' + host + ':' + portToMaster);

	g_inbound.on('message', handleIncoming);

	reset();
}

function stop()
{
	g_inbound.close();
	g_outbound.close();
}


function workerId()
{
	return p_os.hostname() + ':' + process.pid;
}

function send(o)
{
	try
	{
		g_outbound.send(p_u.packJS(o));
	} catch (e)
	{
		console.log(e);
	}
}

function getFnc(afunc)
{
	for (var i = 0; i < afunc.length; i++)
	{
		if (eval("typeof " + afunc[i] + " == 'function'")) return eval(afunc[i]);
	}

	return null;
}

function handleIncoming(env)
{
	var msg = env.toString();

	var o = p_u.unpackJS(msg);

	var fnc = getFnc(['onCmd_' + o.cmd]);
	if (fnc) fnc(o);
}

function finish()
{
	// Shutdown heartbeat
	clearInterval(g_tmrHeartbeat);
	clearInterval(g_tmrMetrics);

	// Shut down all users
	for (var user in g_test.users)
		updateUserPop(user, 0);

	// Now wait for suites to finish
	var wait = setInterval(function()
	{
		if (g_suiteConcurrent > 0)
		{
			out('Waiting for ' + g_suiteConcurrent + ' suite(s) to complete...');
		}
		else
		{
			clearInterval(wait);
			completeFinish();
		}
	}, 1000);
}

function completeFinish()
{
	var stat = {};

	for (var u in g_userstat)
	{
		var st = g_userstat[u];

		stat[u] = {
			s:  st.s,
			f:  st.f,
			a:  st.a,
			log:st.log.logArray
		};
	}

	send({
		cmd:  'finish',
		id:   workerId(),
		log:  g_log.logArray,
		stat: stat,
		clock:g_reqclock
	});

	reset();

	out('Test session ended, waiting for next session...                    ');

}

function puts(s)
{
	process.stdout.write(s);
}

function curSave()
{
	puts('\033[s');
}

function curLoad()
{
	puts('\033[u');
}

// For an array of pairs (sec offset, population) find the whole number population for the current time

function findIntervalPop(a)
{
	if (a.length === 0) return 0;

	// If we don't have a 0,0, slip one in
	if (a[0][0] != 0) a.unshift([0, 0]);

	// Find # of seconds
	var c = elapsedMS() / 1000;

	// Find interval start (iPrev) and end (iNext)
	var iNext = 0;
	var iPrev = 0;
	while (iNext < a.length && a[iNext][0] < c)
		iNext++;

	if (iNext == a.length) iNext = iPrev = (a.length - 1);
	else iPrev = iNext - 1;

	// If start and end are the same then population is not tweened
	if (iNext == iPrev) return a[iNext][1];

	// Current interval duration in s
	var dur = a[iNext][0] - a[iPrev][0];

	// Offset in sec into current interval
	var off = c - a[iPrev][0];

	var pcnt = off / dur;

	var pop = ((a[iNext][1] - a[iPrev][1]) * pcnt) + a[iPrev][1];

	// Floor it, rounding
	return ~~(pop + 0.5);
}

function elapsedSec()
{
	return ~~(elapsedMS() / 1000);
}

function elapsedMS()
{
	return ((new Date().getTime() - g_starttime.getTime()));

}

function stat(user)
{
	if (!g_test || !g_userstat) return null;

	if (!(user in g_userstat))
	{
		var stat = {
			max:0,
			s:  0,
			f:  0,
			a:  0,
			log:new p_ssa.Logger().newScope('user/' + user)
		};

		g_userstat[user] = stat;
	}

	return g_userstat[user];
}

function population(user)
{
	if (!(user in g_pop)) g_pop[user] = [];

	return g_pop[user];
}

function updateWorkers()
{
	var elapsed = elapsedSec();

	curSave();
	puts('Test running, ' + (g_test.options.duration - elapsed) + 's remaining, ' + g_suiteConcurrent + ' suite(s) in progress     ');
	curLoad();

	// If we've hit duration then finish
	if (elapsed >= g_test.options.duration)
		finish();
	else
	{
		var lp = g_test.options.loadProfile;

		var pop;
		if (_.isArray(lp)) pop = findIntervalPop(lp);

		// update running population
		var userlist = _.keys(g_test.users);
		var usercount = userlist.length;

		for (var i = 0; i < usercount; i++)
		{
			var usrpop;
			if (_.isArray(lp))
			{
				// Partition by user types
				usrpop = p_u.partition(pop, usercount, i)[1];
			}
			else
			{
				var usrprof = lp[userlist[i]];
				if (usrprof) usrpop = findIntervalPop(usrprof);
				else usrpop = 0; // Bad, no profile for this user type
			}

			// Now that we have a user specific population count in time
			// partition over the number workers
			var usrwkrpop = p_u.partition(usrpop, g_test.workerCount, g_test.workerIndex);

			updateUserPop(userlist[i], usrwkrpop[1]);
		}
	}
}

var g_previousUsedCPU = 0;
var g_previousFreeCPU = 0;

function getMetrics(cb)
{
	var time = Math.round(Date.now() / 1000);

	function cpu()
	{
		// generate CPU metrics
		var usedCPU = 0;
		var freeCPU = 0;
		var cpuUsage = 0;

		var currentUsedCPU = 0;
		var currentFreeCPU = 0;

		var cpus = p_os.cpus();
		for (var i = 0; i < cpus.length; i++)
		{
			currentUsedCPU += cpus[i].times.user + cpus[i].times.nice + cpus[i].times.sys;
			currentFreeCPU += cpus[i].times.idle;
		}

		usedCPU = currentUsedCPU - g_previousUsedCPU;
		freeCPU = currentFreeCPU - g_previousFreeCPU;

		g_previousUsedCPU = currentUsedCPU;
		g_previousFreeCPU = currentFreeCPU;

		cpuUsage = Math.round((usedCPU / (usedCPU + freeCPU)) * 100) / 100;

		return cpuUsage;
	}

	function mem()
	{
		// generate Memory Metrics
		var totalMem = p_os.totalmem();
		var usedMem = p_os.totalmem() - p_os.freemem();
		var memUsage = Math.round((usedMem / totalMem) * 100) / 100;

		return memUsage;
	}

	function hd(cb)
	{
		var diskUsage = [];
		var exec = require('child_process').exec;
		exec('df -h', function (error, stdout, stderr)
		{
			/*
			 if ((!error) && (!stderr) && (stdout))
			 {
			 var disks = stdout.toString().split('\n');
			 for (var i = 0; i < disks.length; i++)
			 {
			 var disk = disks[i];
			 if (disk.indexOf('/') === 0)
			 {
			 // [0]:Filesystem, [1]:Size, [2]:Used, [3]:Avail, [4]:Capacity, [5]:Mounted on
			 var parts = disk.trim().split(/\s+/, 6);
			 var name = parts[0];
			 var percentage = parseInt(parts[4].replace('%', ''), 10) / 100;
			 if (percentage) diskUsage.push([name, percentage]);
			 }
			 }
			 }
			 */

			cb(diskUsage.length > 0 ? diskUsage : 0);
		});
	}

	var metrics = {
		cpu: cpu(),
		mem: mem(),
		time:time
	};

	hd(function (dsk)
	{
		metrics.disk = dsk;
		cb(metrics);
	});

}


//
// Gather stats, push them to master
//

function pollMetrics()
{
	getMetrics(function (m)
	{
		var pop = {};
		var stat = {};

		_.keys(g_pop).forEach(function (e)
		{
			pop[e] = g_pop[e].length;
		});
		_.keys(g_userstat).forEach(function (e)
		{
			stat[e] = {
				s:g_userstat[e].s,
				f:g_userstat[e].f,
				a:g_userstat[e].a
			};
		});

		send({
			cmd:    'workerMetrics',
			id:     workerId(),
			metrics:m,
			pop:    pop,
			stat:   stat,
			clock:  g_reqclock
		});

		// Reset the clock (leave it for now)
		//for(var c in g_reqclock)
		//    g_reqclock[c] = {count:0,elapsed:0};
	});
}

/****************************************************************************************************
 * Inbound handlers
 */

function onCmd_workerInit(o)
{
	if (g_host != o.host)
	{
		out('Connected to host: ' + o.host);
		g_host = o.host;
	}

	g_log.syncTime(o.time);

	send({
		cmd:'setup',
		id: workerId()
	});
}

function onCmd_run(o)
{
	// Kick off
	g_starttime = new Date();

	console.log('Running as worker #' + (o.workerIndex + 1) + ' of ' + o.workerCount);

	g_test = o;

	if (!g_test.options) g_test.options = {};

	g_tmrHeartbeat = setInterval(updateWorkers, p_const.workerHeartbeatInterval);
	g_tmrMetrics = setInterval(pollMetrics, p_const.workerMetricsInterval);
}

exports.start = start;
exports.stop = stop;