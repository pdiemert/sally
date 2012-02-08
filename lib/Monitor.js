var p_ch = require('child_process');
var p_util = require('util');
var p_ev = require('events');

if (!String.prototype.endsWith)
{
    String.prototype.endsWith = function (suffix)
    {
        return this.indexOf(suffix, this.length - suffix.length) !== -1;
    };
}

// Pass in [user@]host name to monitor or blank to monitor localhost
// If pw is passed then sshpass will be used (make sure this is installed)
// An 'metrics' event is generated every interval (use on() to catch)
// Default interval is 1000

function Monitor(host, pw, interval)
{
    // Tiny hack
    // Because we have touble knowing when SSH has completed a command we simply
    // echo this piece text after ever command and we get it back through STDOUT we
    // know we've completed
    var EOC = '_-_-_-EOC-_-_-';

    var _host = host;
    var _pw = pw;
    var _interval = interval || 1000;
    var _timer;
    var _state = 'start';
    var _prompt = true;
    var _ssh;
    var _os;
    var _osver;
    var _output;

    // Opens SSH to host
    this.open = function ()
    {
        var ssh;
        var args = [];
        var host = _host || 'localhost';

        if (_pw)
        {
            ssh = 'sshpass';
            args.push('-p', _pw);
        }
        else
        {
            ssh = 'ssh';
        }

        args.push(host);

        _ssh = p_ch.spawn(ssh, args);

        _ssh.stdout.on('data', handleData);
        _ssh.stdout.on('error', handleData);

        // Send initial EOC
        sendEOC();
    };

    this.close = function ()
    {
        if (_timer)
        {
            clearTimeout(_timer);
            _timer = null;
        }

        _ssh.stdin.end();
    };

    function send(cmd)
    {
        _ssh.stdin.write(cmd + '\n');
    }

    function sendEOC()
    {
        send('echo ' + EOC);
    }

    function sendCmd(cmd, newstate)
    {
        _prompt = true;
        _state = newstate;
        _output = "";
        send(cmd);
        sendEOC();
    }

    function trim(ln)
    {
        return ln.replace(/^(\s*)((\S+\s*?)*)(\s*)$/, "$2");
    }

    function gotoState(st, ms)
    {
        _timer = setTimeout(
            function()
            {
                _state = st;
                handleData();
            }, ms ? ms : 0, null);
    }

    function queuePoll()
    {
        gotoState('poll_' + _os.toLowerCase(), _interval);
    }

    function handleData(data)
    {
        if (_prompt)
        {
            var s = data.toString();

            _output += s;

            if (_output.endsWith(EOC + '\n'))
            {
                _output = trim(_output.substr(0, _output.length - (EOC.length + 1)));
                _prompt = false;
            }
            else return;
        }

        var fnc;
        eval('fnc = (state_' + _state + ');');

        if (fnc)
            fnc();
    }

    /********************************************************************************
     * State functions
     */

    function state_start()
    {
        sendCmd('cat /etc/issue', 'detectos_nomac');
    }

    function state_detectos_nomac()
    {
        if (!_output)
        {
            sendCmd('defaults read loginwindow SystemVersionStampAsString', 'detectos_mac');
            return;
        }
        var a = _output.split(' ');
        _os = a[0];
        _osver = a[1];
        gotoState('startpoll');
    }

    function state_detectos_mac()
    {
        if (!_output)
        {
            // NO known os!
            console.log('Monitor : Unable to detect os on ' + _host);
            return;
        }

        _os = 'OSX';
        _osver = _output;

        gotoState('startpoll');
    }

    function state_startpoll()
    {
        queuePoll();
    }

    function state_poll_osx()
    {
        sendCmd('iostat', 'poll_osx_parse');
    }

    function state_poll_osx_parse()
    {
        console.log(_output);
        /*
        var lines = _output.split('\n');
        var head = lines[0].split(/\s+/);

        var data = lines[2].split(/\s+/);

        var cpu = parseInt(data[1 + (3 * head.indexOf('cpu'))]);
        console.log(cpu);
        //for(var i=0; i < data.length; i++)
        //    console.log('[' + i + '] ' + data[i]);
*/
        queuePoll();
    }
}

p_util.inherits(Monitor, p_ev.EventEmitter);

module.exports = Monitor;