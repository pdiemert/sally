/*global require*/
var _ = require('underscore');
var assert = require('assert');
//var p_zmq = require('zeromq');
var p_zmq = require('zmq');
var p_const = require('./const.js');
var p_u = require('./util.js')
var p_ssa = require('ssa');
var p_os = require('os');
var p_eyes = require('eyes');

var g_inbound;
var g_outbound;
var g_log;
var g_host;
var g_heartbeat;
var g_test;
var g_starttime;

// maps user to a status object:
// { 
//      max:,   number of users allowed for this worker at this point in time
//      s:,     number of successful tests executed
//      f:,     number of failed tests executed
//      a:      number of aborted tests executed
//  }
var g_userstat = {}; 

// The running population map, an object, each property is the user name, and the value is an array of VirtualUser
var g_pop = {};

function VirtualUser(user,index)
{
    var _user = user;
    var _index = index;
    var _fstopped = false;
    var _timeout;
    var _self = this;
    var _count = 0;
    
    this.start = function()
    {
        var suite = g_test.users[_user];

        console.log('Starting ' + _user + ' @ ' + _index);
        
        //setTimeout(handleSuiteFinish, 2000, 1, 0, 0);
        
        var opt = _.clone(g_test.options);
        opt.loadTest =
        {
            userIndex: _index,
            userCount: g_test.population[_user][2],
            runCount: _count,
            getUserCount : function(u)
            {
                return g_test.population[u][2];
            }
        };
        
        p_ssa.runSuite(suite, g_test.options, handleSuiteFinish);
    };
    
    this.stop = function()
    {
        console.log('Stoping ' + _user + ' @ ' + _index);
        
        _fstopped = true;
        if (_timeout)
            clearTimeout(_timeout);
    };
    
    function handleSuiteFinish(s,f,a,l)
    {
        console.log('Finishing ' + _user);
        
        var st = stat(_user);
        
        st.s += s;
        st.f += f;
        st.a += a;

        if (_fstopped)
            return;
            
        // Not stopped so reschedule
        _timeout = setTimeout(function()
        {
            _timeout = null;
            
            if (_fstopped)
                return;
                
            _self.start();
        });
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
    
        assert.ok(pop.length >= st.max);
        vu.start();
    }
    
    // Remove excess vusers if needed, remove from end
    while(pop.length > st.max)
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
        
    if (!('user' in g_test.options.repeatDelay))
        return p_const.defaultRepeatDelay;
        
    return g_test.options.repeatDelay[user];
}

function out(m)
{
    console.log(m);
}

function start(host, portFromMaster, portToMaster)
{
    g_inbound = p_zmq.createSocket('pull');
    g_inbound.connect('tcp://' + host + ':' + portFromMaster);

    g_outbound = p_zmq.createSocket('push');
    g_outbound.connect('tcp://' + host + ':' + portToMaster);

    g_inbound.on('message', handleIncoming);

    g_log = new p_ssa.Logger();
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
        g_outbound.send(JSON.stringify(o));
    }
    catch (e)
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
    out('fin');

    // Shutdown heartbeat
    clearInterval(g_heartbeat);

    send(
    {
        cmd: 'finish',
        id: workerId(),
        log: p_u.packJS(g_log.logArray)
    });
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
    if (a.length === 0) 
        return 0;

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
    return ~~ (pop + 0.5);
}

function elapsedSec()
{
    return ~~ (elapsedMS() / 1000);
}

function elapsedMS()
{
    return ((new Date().getTime() - g_starttime.getTime()));

}

function stat(user)
{
    if (!(user in g_userstat)) 
        g_userstat[user] =
        {
        max: 0,
        s: 0,
        f: 0,
        a: 0
    };

    return g_userstat[user];
}

function population(user)
{
    if (!(user in g_pop))
        g_pop[user] = [];
        
    return g_pop[user];
}

function updateWorkers()
{
    var elapsed = elapsedSec();

    //curSave();
    //puts('time: ' + elapsed);
    //curLoad();

    // If we've hit duration then finish
    if (elapsed >= g_test.options.duration) 
        finish();
    else
    {
        var lp = g_test.options.loadProfile;

        var pop;
        if (_.isArray(lp)) 
            pop = findIntervalPop(lp);

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

/**************************************************
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

    send(
    {
        cmd: 'setup',
        id: workerId()
    });
}

function onCmd_run(o)
{
    p_eyes.inspect(o);
    
    
    // Kick off
    g_starttime = new Date();

    console.log('running as worker #' + o.workerIndex);

    g_test = o;

    g_heartbeat = setInterval(updateWorkers, 100);
}

exports.start = start;
exports.stop = stop;