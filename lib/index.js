var p_lr = require('./LoadRunner.js');

var p_mon = require('./Monitor.js');

exports.runLoad = function(test, options, cb)
{
	var l = new p_lr.LoadRunner(test, options);

	l.run(cb);
};