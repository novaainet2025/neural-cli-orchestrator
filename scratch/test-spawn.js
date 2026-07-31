const { spawn } = require('child_process');
const child = spawn('env', ['node', '-v'], { env: { PATH: '/usr/bin:/bin' } });
child.stdout.on('data', d => console.log('OUT:', d.toString()));
child.stderr.on('data', d => console.log('ERR:', d.toString()));
child.on('close', c => console.log('EXIT:', c));
