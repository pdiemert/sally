/*global require*/
var _ = require('underscore');
var p_zmq = require('zeromq');
//var p_zmq = require('zmq');
var p_const = require('./const.js');
var p_u = require('./util.js')
var p_ssa = require('ssa');
var p_os = require('os');

var g_control;
var g_inbound;
var g_outbound;
var g_log;
var g_host;
var g_heartbeat;
var g_test;
var g_starttime;

// The running population map, an object, each property is the user name, and the value is an array of VirtualUser
var g_pop = {};

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

        g_log = new p_ssa.Logger;
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
            } catch(e)
            {
                console.log(e);
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

function handleIncoming(env)
    {
        var msg = env.toString();

        var o = p_u.unpackJS(msg);

        var fnc = getFnc(['onCmd_' + o.cmd]);
        if (fnc)
            fnc(o);
    }

function finish()
    {
        out('fin');

        // Shutdown heartbeat
        clearInterval(g_heartbeat);

        send({cmd:'finish', id:workerId(), log:p_u.packJS(g_log.logArray)});
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
        if (a.length == 0)
            return 0;

        // Find # of seconds
        var c = elapsedMS() / 1000;

        // Find interval start (iPrev) and end (iNext)
        var iNext = 0;
        var iPrev = 0;
        while(iNext < a.length && a[iNext][0] < c)
            iNext++;

        if (iNext == a.length)
            iNext = iPrev = (a.length-1);
        else
            iPrev = iNext-1;

        // If start and end are the same then population is not tweened
        if (iNext == iPrev)
            return a[iNext][1];

        // Current interval duration in s
        var dur = a[iNext][0] - a[iPrev][0];

        // Offset in sec into current interval
        var off = c - a[iPrev][0];

        var pcnt = off / dur;

        var pop = ((a[iNext][1] - a[iPrev][1]) * pcnt) + a[iPrev][1];

        // Floor it, rounding
        return ~~(pop + .5);
    }

// Given a total _count_ to distribute in round robin to some number of _parties_
// return the count allotted to the party at _index_
function roundRobin(count, parties, index)
    {
        var pop = 0;

        // first get whole number of users
        pop = ~~(count / parties);

        // Now we add in another up to our index
        if (index  < (count % parties))
            pop++;

        return pop;
    }

function elapsedSec()
    {
        return ~~((new Date().getTime() - g_starttime.getTime()) / 1000);
    }

function elapsedMS()
    {
        return ((new Date().getTime() - g_starttime.getTime()));

    }

// Updates the user population 
function updateUserPop(user, count)
    {

    }

function heartbeat()
    {
        var elapsed = elapsedSec();

        curSave();
        puts('time: ' + elapsed );
        curLoad();
        
        // If we've hit duration then finish
        if (elapsed >= g_test.options.duration)
            finish();
        else
            {
                var lp = g_test.options.loadProfile;

                var pop;
                if (_.isArray(pop))
                    pop = findIntervalPop(lp)

                // update running population
                var userlist = _.keys(g_test.users);
                var usercount = userlist.length;

                for (var i=0; i < usercount; i++)
                    {
                        var usrpop;
                        if (_.isArray(lp))
                            {
                                // Calc the user pop for this user by roundrobin of
                                // total pop at this interval over the total user types
                                usrpop = roundRobin(pop, usercount, i);
                            }
                        else
                            {
                                var usrprof = lp[userlist[i]];
                                if (usrprof)
                                    usrpop = findIntervalPop(usrprof);
                                else
                                    usrpop = 0; // Bad, no profile for this user type
                            }

                        // Now that we have a user specific population count in time
                        // Calc how much this work gets via roundrobin
                        var usrwkrpop = roundRobin(usrPop, g_test.workerCount, g_test.workerIndex);

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

        send({cmd:'setup', id:workerId()})
    }

function onCmd_run(o)
    {
        // Kick off
        g_starttime = new Date();

        console.log('running as worker #' + o.workerIndex);

        g_test = o;

        g_heartbeat = setInterval(heartbeat, 100);
    }

exports.start = start;
exports.stop = stop;