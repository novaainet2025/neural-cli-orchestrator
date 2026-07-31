const { spawn } = require('child_process');
const { PtySession } = require('../local-bridge/src/pty.js');
const { expect } = require('chai');
const { promisify } = require('util');
const setTimeout = promisify(setTimeout);

describe('PTY kill escalation', () => {
  let proc, session;

  beforeEach(() => {
    proc = spawn('sleep', ['10']);
    session = new PtySession(proc);
  });

  it('should gracefully kill after grace period', async () => {
    session.kill(false);
    await setTimeout(500);
    expect(proc.exitCode).to.be.null;
    await setTimeout(1000);
    expect(proc.exitCode).to.not.be.null;
  });

  it('force kill should immediately terminate process', () => {
    session.kill(true);
    expect(proc.exitCode).to.not.be.null;
  });

  afterEach(() => {
    if (proc && !proc.exitCode) {
      proc.kill('SIGKILL');
    }
  });
});