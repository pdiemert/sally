var http = require('http');

function now()
{
	return new Date().getTime();
}

var creq = 0;
var lasttime = now();

http.createServer(
	function (req, res)
	{
		res.writeHead(200, {'Content-Type':'text/plain'});
		res.end('Hello World');

		creq++;

	}).listen(1337, '127.0.0.1');

setInterval(function()
{
	var elapsedsec = (now() - lasttime) / 1000;
	var reqsec = creq / elapsedsec;

	console.log('Receiving approximately ' + reqsec.toFixed(2) + ' requests/sec.')

	lasttime = now();
	creq = 0;
}, 2000);


console.log('Server running at http://127.0.0.1:1337/');
