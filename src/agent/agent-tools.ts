import { readFile, writeFile, unlink, readdir, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { execa } from 'execa';
import { SandboxManager } from '../security/sandbox-manager.js';
import { eventBus } from '../core/event-bus.js';
import { sharedState } from '../core/shared-state.js';
import { createLogger } from '../utils/logger.js';
import type { ToolCall } from './tool-parser.js';

const log = createLogger('agent-tools');

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export class AgentToolExecutor {
  constructor(
    private agentId: string,
    private sandbox: SandboxManager,
    private taskId?: string,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    if (!this.sandbox.canExecute()) {
      return { ok: false, output: '', error: 'Agent isolated by Circuit Breaker' };
    }

    const release = await this.sandbox.acquireSlot();
    try {
      const result = await this.dispatch(call);

      // Broadcast action to Event Bus
      await eventBus.publish({
        type: `action:${call.tool}`,
        agentId: this.agentId,
        taskId: this.taskId,
        tool: call.tool,
        args: call.args,
        success: result.ok,
        output: result.output.slice(0, 500), // truncate for event
      });

      if (result.ok) {
        this.sandbox.recordSuccess();
      } else {
        this.sandbox.recordFailure(result.error);
      }

      return result;
    } catch (err: any) {
      this.sandbox.recordFailure(err.message);
      return { ok: false, output: '', error: err.message };
    } finally {
      release();
    }
  }

  private async dispatch(call: ToolCall): Promise<ToolResult> {
    switch (call.tool) {
      case 'readFile': return this.readFile(call.args.path);
      case 'writeFile': return this.writeFile(call.args.path, call.args.content);
      case 'createFile': return this.createFile(call.args.path, call.args.content);
      case 'editFile': return this.editFile(call.args.path, call.args.old, call.args.new);
      case 'deleteFile': return this.deleteFile(call.args.path);
      case 'listFiles': return this.listFiles(call.args.path || call.args.dir);
      case 'runCommand': return this.runCommand(call.args.command || call.args.cmd);
      case 'runTest': return this.runCommand(`npm test -- ${call.args.path || ''}`);
      case 'searchCode': return this.runCommand(`grep -rn "${call.args.query}" --include="*.ts" --include="*.js" .`);
      case 'searchFiles': return this.runCommand(`find . -name "${call.args.pattern}" -not -path "*/node_modules/*"`);
      case 'gitDiff': return this.runCommand('git diff');
      case 'gitStatus': return this.runCommand('git status --short');
      case 'gitCommit': return this.runCommand(`git add -A && git commit -m "${call.args.message}"`);
      case 'sendMessage': return this.sendMessage(call.args.to, call.args.content);
      case 'broadcast': return this.broadcastMsg(call.args.content);
      default:
        return { ok: false, output: '', error: `Unknown tool: ${call.tool}` };
    }
  }

  // ─── File Operations ────────────────────────────────
  private async readFile(path: string): Promise<ToolResult> {
    this.sandbox.assertPath(path);
    try {
      const content = await readFile(path, 'utf-8');
      return { ok: true, output: content };
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  private async writeFile(path: string, content: string): Promise<ToolResult> {
    this.sandbox.assertPath(path);
    this.sandbox.assertFileSize(Buffer.byteLength(content));

    // File lock check
    const holder = await sharedState.getLockHolder(path);
    if (holder && holder !== this.agentId) {
      await eventBus.publish({
        type: 'message:direct', from: this.agentId, to: holder,
        content: `I need to write to ${path}, but you hold the lock. Can I proceed?`,
      });
      return { ok: false, output: '', error: `File locked by ${holder}` };
    }

    await sharedState.acquireLock(path, this.agentId);
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(path, content, 'utf-8');
      return { ok: true, output: `Written: ${path} (${Buffer.byteLength(content)} bytes)` };
    } finally {
      await sharedState.releaseLock(path, this.agentId);
    }
  }

  private async createFile(path: string, content: string): Promise<ToolResult> {
    if (existsSync(path)) {
      return { ok: false, output: '', error: `File already exists: ${path}` };
    }
    return this.writeFile(path, content);
  }

  private async editFile(path: string, oldStr: string, newStr: string): Promise<ToolResult> {
    this.sandbox.assertPath(path);
    try {
      const current = await readFile(path, 'utf-8');
      if (!current.includes(oldStr)) {
        return { ok: false, output: '', error: 'Old string not found in file' };
      }
      const updated = current.replace(oldStr, newStr);
      return this.writeFile(path, updated);
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  private async deleteFile(path: string): Promise<ToolResult> {
    this.sandbox.assertPath(path);
    try {
      await unlink(path);
      return { ok: true, output: `Deleted: ${path}` };
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  private async listFiles(dir: string): Promise<ToolResult> {
    this.sandbox.assertPath(dir);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const list = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      return { ok: true, output: list };
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  // ─── Command Execution ──────────────────────────────
  private async runCommand(cmd: string): Promise<ToolResult> {
    const parts = cmd.split(/\s+/);
    const base = parts[0];
    const args = parts.slice(1);

    this.sandbox.assertCommand(base, args);

    try {
      const { stdout, stderr } = await execa(base, args, {
        shell: true,
        timeout: this.sandbox.getTimeout(),
        maxBuffer: 5 * 1024 * 1024,
        reject: false,
      });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return { ok: true, output };
    } catch (err: any) {
      return { ok: false, output: err.stdout || '', error: err.message };
    }
  }

  // ─── Messaging ──────────────────────────────────────
  private async sendMessage(to: string, content: string): Promise<ToolResult> {
    await eventBus.publish({
      type: 'message:direct',
      from: this.agentId,
      to,
      content,
    });
    return { ok: true, output: `Message sent to ${to}` };
  }

  private async broadcastMsg(content: string): Promise<ToolResult> {
    await eventBus.publish({
      type: 'message:broadcast',
      from: this.agentId,
      content,
    });
    return { ok: true, output: 'Broadcast sent' };
  }
}
