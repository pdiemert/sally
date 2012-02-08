var _ = require('underscore');
//var p_zmq = require('zeromq');
var p_zmq = require('zmq');
var p_os = require('os');
var p_ssa = require('ssa');
var p_eyes = require('eyes');

var p_c = require('../modules/colored');

var p_const = require('./const.js');
var p_cmdr = require('../modules/commander.js');
var p_u = require('./util.js');
var p_mon = require('./Monitor.js');

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
 * All suite functions outside of start and finish are passed the following on the this.loadTest object:
 *
 * userIndex        The index of this user within the population of running users
 * userCount        Total number of users, of this type, in the population
 * runCount         The total number of times this user suite has been run
 * getUserCount     A function that returns the user count for a user name
 *
 * All logs are merged before finish is called
 *
 * options is an object that can have the same properties as SuiteRunner with the additional:
 *
 * params           Parameters sent to all suites context
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
 */

function LoadRunner(test, options)
{
    var _options = _.clone(options);

    var _fncComplete;
    var _log = options.log || new p_ssa.Logger();
    var _test = test;
    var _workerOut;
    var _workerIn;
    var _succeed = 0;
    var _fail = 0;
    var _abort = 0;
    var _workerCount = 0;
    var _modestack = [];
    var _workers;
    var _userstat = {};


    _options.loadTest = this;

    if (_options.verbose) _log.echoToConsole = true;

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

    function error(msg)
    {
        _log.error(msg);
    }

    function out(msg)
    {
        console.log(msg);
    }

    function info(msg)
    {
        if (_options.verbose) _log.info(msg);
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

        if (_.isArray(prof))
        {
            var max = 0;
            prof.forEach(function (e)
            {
                if (e[1] > max) max = e[1];
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
                if (!(u in _population)) _population[u] = 0;

                if (prof[u])
                {
                    prof[u].forEach(function (e)
                    {
                        if (e[1] > _population[u]) _population[u] = e[1];
                    });
                }
            }
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

    function handleInbound(data)
    {
        var o = p_u.unpackJS(data.toString());
        var fnc;

        // First see if there is a mode specific func
        var m = mode();
        if (m) fnc = getFnc(['onCmd_' + m + '_' + o.cmd]);

        // Non mode specific
        if (!fnc) fnc = getFnc(['onCmd_' + o.cmd]);

        if (fnc) fnc(o);
        else console.log('Ignoring msg: ' + o.cmd);
    }

    function closeHub()
    {
        _workerOut.close();
        _workerIn.close();
    }

    function openHub()
    {
        _workerOut = p_zmq.createSocket('push');
        _workerOut.bindSync('tcp://*:' + p_const.defaultWorkerOutPort);
        info('Downstream worker hub open on ' + p_const.defaultWorkerOutPort);

        _workerIn = p_zmq.createSocket('pull');
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
        if (_fncComplete)
        {
            _fncComplete(_succeed, _fail, _abort, _log);
        }
        else
        {
            _log.dumpToConsole();

            var sum = [];
            if (_succeed > 0) sum.push(p_c.green(_succeed + ' succeeded'));
            if (_fail > 0) sum.push(p_c.red(_fail + ' failed'));
            if (_abort > 0) sum.push(p_c.yellow(_abort + ' aborted'));

            console.log(sum.join(', ') + '.');
        }
    }

    function finish()
    {
        closeHub();

        // Run finish
        if (_test.finish)
        {
            out('Running finish')

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

        out('Searching for workers');

        enter('workerInit');

        workerOut({
                cmd:'workerInit',
                host:p_os.hostname(),
                time:new Date()
            });
    }

    /**************************************************
     * Inbound handlers
     */

    function onCmd_workerInit_setup(data)
    {
        // if worker already logged then we've found all the workers
        if (data.id in _workers)
        {
            leave();
            runProfile();
            return;
        }

        // log worker
        _workers[data.id] = true;

        // Continue search for new workers
        workerOut({
                cmd:'workerInit',
                host:p_os.hostname(),
                time:new Date()
            });
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

        // Once received from all workers, terminate
        if (!--_workerCount)
            finish();
    }

    function onCmd_workerMetrics(data)
    {
        p_eyes.inspect(data);

    }

    /**************************************************
     */

    function runProfile()
    {
        _workerCount = Object.keys(_workers).length;

        out('Found ' + _workerCount + ' worker' + (_workerCount == 1 ? '' : 's') + ', starting...');

        // Send test to workers
        var iWorker = 0;
        for (var w in _workers)
        {
            var parms = {
                cmd:'run',
                users:_test.users,
                options:_options,
                workerIndex:iWorker++,
                workerCount:_workerCount,
                population:{}
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
    }

    this.run = function (fnc)
    {
        _fncComplete = fnc;

        openHub();

        calcPopulation();

        // Run start
        if (_test.start)
        {
            out('Running start')

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

exports.LoadRunner = LoadRunner;