var p_lr = require('./LoadRunner.js');


exports.runLoad = function(test, options)
{

    var l = new p_lr.LoadRunner(test, options);

    l.run();
};