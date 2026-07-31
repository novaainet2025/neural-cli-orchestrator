const { spawn } = require('child_process');
const { dirname } = require('path');
const nodeDir = dirname(process.execPath);
const env = { PATH: `${nodeDir}:/usr/bin:/bin` };
const child = spawn('env', ['node', '-v'], { env });
child.stdout.on('data', d => console.log('OUT:', d.toString()));
child.stderr.on('data', d => console.log('ERR:', d.toString()));
child.on('close', c => console.log('EXIT:', c));
