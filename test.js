var exp = require('node-expect');
var cp = require('child_process');

var ssh = cp.spawn('ssh', ['pete@10.170.222.100']);

var p = new exp();



p.conversation()
    .sync()
    .expect(/Password:/i)
    .send('tunafish\n')
    .send('who\n')
    .monitor(ssh);
    