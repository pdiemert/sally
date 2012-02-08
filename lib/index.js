var p_lr = require('./LoadRunner.js');

var p_mon = require('./Monitor.js');

exports.runLoad = function(test, options)
{
    //var m = new p_mon('pete@10.170.222.100');
    //var m = new p_mon('PlayUp@localhost');
    
    //m.open();
    
    //return;


    var l = new p_lr.LoadRunner(test, options);

    l.run();
};