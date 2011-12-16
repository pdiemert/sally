var _ = require('underscore');
var p_zmq = require('zeromq');
//var p_zmq = require('zmq');
var p_os = require('os');
var p_ssa = require('ssa');
var p_c = require('../modules/colored');
var p_const = require('./const.js');
var p_cmdr = require('../modules/commander.js');
var p_u = require('./util.js');

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
 *      [
 *          // Array of virtual users, each item is {user:"<name>", suite:[]}
 *
 *      ],
 *
 *      // Suite to run last (optional)
 *      finish: []
 * }
 *
 * All suite functions are passed the following on the context.loadTest:
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
 */

function LoadRunner(test, options)
    {
        var self = this;
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


        _options.loadTest = this;
        _options.log = _log;

        if (_options.verbose)
            _log.echoToConsole = true;

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
                if (_options.verbose)
                    _log.info(msg);
            }

        function opt(name, def)
            {
                if (!(name in _options))
                    {
                        if (def === undefined)
                            throw 'Missing required option \"' + name + '\"';
                        else
                            return def;
                    }

                return _options[name];
            }

        function calcPopulation()
            {
                // Find peaks for each user type
                var prof = opt('loadProfile');

                if (_.isArray(prof))
                    {
                        var max = 0;
                        prof.forEach(function(e)
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

                                _test.users[u].forEach(function(e)
                                {
                                    if (e[1] > _population[u])
                                        _population[u] = e[1];
                                });
                            }
                    }
            }

        function getFnc(afunc)
            {
                for (var i = 0; i < afunc.length; i++)
                    {
                        if (eval("typeof " + afunc[i] + " == 'function'"))
                            return eval(afunc[i]);
                    }

                return null;
            }

        function handleInbound(data)
            {
                var o = JSON.parse(data.toString());
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
                else
                    console.log('Ignoring msg: ' + o.cmd);
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

        this.getUserCount = function(name)
            {
                if (!(name in _population))
                    return 0;
                else
                    return _population[name];
            };

        function finish()
            {
                closeHub();

                if (_fncComplete)
                    {
                        _fncComplete(_succeed, _fail, _abort, _log);
                    }
                else
                    {
                        _log.dumpToConsole();

                        var sum = [];
                        if (_succeed > 0)
                            sum.push(p_c.green(_succeed + ' succeeded'));
                        if (_fail > 0)
                            sum.push(p_c.red(_fail + ' failed'));
                        if (_abort > 0)
                            sum.push(p_c.yellow(_abort + ' aborted'));

                        console.log(sum.join(', ') + '.');
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

                workerOut({cmd:'workerInit', host:p_os.hostname(),time:new Date()});
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
                workerOut({cmd:'workerInit', host:p_os.hostname(),time:new Date()});
            }

        function onCmd_finish(data)
            {
                if (!--_workerCount)
                    finish();

            }

        /**************************************************
         */

        function runProfile()
            {
                _workerCount = Object.keys(_workers).length;

                out('Found ' + _workerCount + ' worker' + (_workerCount == 1 ? '' : 's') + ', starting...');

                // Send test to workers
                var iWorker = 0;
                for(var w in _workers)
                    {
                        // Object sent to worker -
                        //
                        // users        user object as specified in load profile
                        // options      options passed to runload
                        // workerIndex  0-based index of the worker
                        // workerCount  total # of workers
                        workerOut({cmd:'run', users:_test.users, options:_options, workerIndex: iWorker++, workerCount:_workerCount});
                    }
            }

        this.run = function(fnc)
            {
                _fncComplete = fnc;

                openHub();

                calcPopulation();

                // Run start
                if (_test.start)
                    {
                        out('Running start')
                        p_ssa.runSuite(_test.start, _options, function(s, f, a, l)
                        {
                            _succeed += s;
                            _fail += f;
                            _abort += a;

                            // if failures then stop
                            if (f > 0)
                                finish();
                            else
                                findWorkers();
                        });
                    }

            };
    }

exports.LoadRunner = LoadRunner;