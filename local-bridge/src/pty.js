const { process } = require('child_process');
const { NCO_PTY_KILL_GRACE_MS = 1500 } = process.env;

// Clamp grace period to [100, 10000]ms
const graceMs = Math.max(100, Math.min(10000, NCO_PTY_KILL_GRACE_MS));

class PtySession {
  constructor(proc) {
    this.proc = proc;
    this.killTimer = null;
  }

  async kill(force = false) {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }

    if (force) {
      if (this.proc && this.proc.pid) {
        this.proc.kill('SIGKILL');
      }
      return;
    }

    // Only attempt graceful kill if process is active
    if (this.proc && this.proc.pid) {
      try {
        // Send HUP to process group
        this.proc.kill('SIGHUP');

        // Start escalation timer
        this.killTimer = setTimeout(() => {
          if (this.proc && this.proc.pid) {
            try {
              // Send SIGKILL to process group
              this.proc.kill('SIGKILL');
            } catch (e) {
              // Fallback to process.kill()
              this.proc.kill();
            }
          }
          this.killTimer = null;
        }, graceMs);
        this.killTimer.unref();

        // Clean up after process exits
        this.proc.on('exit', () => {
          if (this.killTimer) {
            clearTimeout(this.killTimer);
            this.killTimer = null;
          }
        });
      } catch (e) {
        // Fallback to immediate kill on error
        this.proc.kill();
      }
    }
  }
}

module.exports = { PtySession };