#!/usr/bin/env node
;(function ()
    { // wrapper in case we're in module_context mode

// windows: running "ssa blah" in this folder will invoke WSH, not node.
        if (typeof WScript !== "undefined")
            {
                WScript.echo("sally does not work when run\n" + "with the Windows Scripting Host\n\n" + "'cd' to a different directory,\n" + "or type 'ssa.cmd <args>',\n" + "or type 'node ssa <args>'.");
                WScript.quit(1);
                return;
            }

        var consts = require('../lib/const.js');
        var program = require('commander');
        var childp = require('child_process');
        var files = [];
        var host;
        var port;

        program.usage('[options] [filespec]')
            .description('Start a slave load generator or initiates a load test\nas the master if filespec specifies a .JS load test')
            .option('-m, --master [host]', 'If a slave, the master host [' + consts.defaultMasterHost + ']')
            .option('-up, --uport <n>', 'If a slave, the slave to master port [' + consts.defaultWorkerOutPort + ']')
            .option('-dp, --dport <n>', 'If a slave, the master to slave port [' + consts.defaultWorkerInPort + ']')
            .option('-d, --debug', 'Passes --debug-brk to node]')
            .parse(process.argv);

        var host = program.master || consts.defaultMasterHost;
        var uport = program.uport || consts.defaultWorkerOutPort;
        var dport = program.dport || consts.defaultWorkerInPort;
        var debug = program.debug;

        function puts(msg)
            {
                process.stdout.write(msg);
            }
        function putl(msg)
            {
                process.stdout.write(msg + '\n');
            }

        function spawn(file, cb)
            {
                var prc = childp.spawn(process.argv[0], debug ? ['--debug-brk',file] : [file]);

                var out = '';
                prc.stdout.on("data", function(data)
                {
                    puts(data.toString());
                    out += data;
                });
                prc.stderr.on('data', function(data)
                {
                    puts(data.toString());
                    out += data;
                });

                var cbT = cb;

                prc.on("exit", function(code)
                {
                    if (cbT)
                        cbT(code, out);
                });
            }

        if (program.args.length > 0 && program.args[0] != 'nocluster')
            {
                // We are master
                if (program.master)
                    {
                        out(program);
                        out('Error: Can not specify a load test (i.e. be a master) and specify slave options as well');
                        process.exit(1);
                        return;
                    }

                files = program.args.slice();

                putl('Running as the master, up port ' + uport + ', down port ' + dport);

                files.forEach(function(f)
                {
                   spawn(f, function(code, output)
                   {
                      console.log('done');
                   });
                });
            }
        else
            {
                // We are slave, start up a cluster
				if (process.argv.indexOf('nocluster') == -1)
				{
					var _cluster = require('cluster');

					var cCPU = require('os').cpus().length;

					if (_cluster.isMaster)
					{
						putl('Master started, forking workers');

						for (var i = 0; i < cCPU; i++)
							_cluster.fork();

						_cluster.on('exit', function (worker, code, signal)
						{
							//putl('Worker #' + worker.process.pid + ' exited');
						});

						_cluster.on('online', function (worker)
						{
							//putl('Worker #%d online', worker.process.pid);
						});

						return;
					}
				}

                putl('Running as a slave to ' + host + ', up port ' + uport + ', down port ' + dport);

                var wkr = require('../lib/worker.js');

                wkr.start(host, uport, dport);
            }

    })();