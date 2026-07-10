import { readFile, writeFile, unlink, readdir, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { execa } from 'execa';
import { SandboxManager } from '../security/sandbox-manager.js';
import { fileChangeGuard } from '../security/file-change-guard.js';
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
    private projectDir?: string,
  ) {}

  private resolvePath(p: string): string {
    return this.projectDir ? resolve(this.projectDir, p) : resolve(p);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (!this.sandbox.canExecute()) {
      return { ok: false, output: '', error: 'Agent isolated by Circuit Breaker' };
    }

    // Session-based approval check for dangerous tools
    const dangerousTools = ['writeFile', 'deleteFile', 'runCommand', 'gitCommit'];
    if (dangerousTools.includes(call.tool) && this.taskId) {
      try {
        const { sessionManager } = await import('./session-manager.js');
        const session = sessionManager.getSession(this.taskId);
        if (session && session.status === 'running') {
          const approved = await sessionManager.requestApproval(this.taskId, {
            tool: call.tool, args: call.args,
          });
          if (!approved) {
            return { ok: false, output: '', error: `Tool ${call.tool} rejected by user` };
          }
        }
      } catch { /* session manager not available — auto-approve */ }
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

      return result;
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    } finally {
      release();
    }
  }

  private async dispatch(call: ToolCall): Promise<ToolResult> {
    switch (call.tool) {
      case 'readFile': return this.readFile(call.args.path, Number(call.args.offset), Number(call.args.limit));
      case 'writeFile': return this.writeFile(call.args.path, call.args.content);
      case 'createFile': return this.createFile(call.args.path, call.args.content);
      case 'editFile': return this.editFile(call.args.path, call.args.old, call.args.new);
      case 'deleteFile': return this.deleteFile(call.args.path);
      case 'listFiles': return this.listFiles(call.args.path || call.args.dir);
      case 'runCommand': return this.runCommand(call.args.command || call.args.cmd);
      case 'runTest': return this.runCommand('npm', call.args.path ? ['test', '--', call.args.path] : ['test']);
      case 'searchCode': {
        const query = call.args.query;
        const path = call.args.path || '.';
        return this.runCommand('grep', ['-rnE', query, path]);
      }
      case 'searchFiles': return this.runCommand('find', ['.', '-name', call.args.pattern, '-not', '-path', '*/node_modules/*']);
      case 'gitDiff': return this.runCommand('git', ['diff']);
      case 'gitStatus': return this.runCommand('git', ['status', '--short']);
      case 'gitCommit': return this.runCommandSequence([
        { command: 'git', args: ['add', '-A'] },
        { command: 'git', args: ['commit', '-m', call.args.message] },
      ]);
      case 'sendMessage': return this.sendMessage(call.args.to, call.args.content);
      case 'broadcast': return this.broadcastMsg(call.args.content);
      default:
        return { ok: false, output: '', error: `Unknown tool: ${call.tool}` };
    }
  }

  // ─── File Operations ────────────────────────────────
  private async readFile(path: string, offset?: number, limit?: number): Promise<ToolResult> {
    const absPath = this.resolvePath(path);
    this.sandbox.assertPath(absPath);
    try {
      const content = await readFile(absPath, 'utf-8');

      let result = content;
      if (offset !== undefined && offset > 0) {
        result = content.substring(offset);
      }
      if (limit !== undefined && limit > 0) {
        result = result.substring(0, limit);
      }

      return { ok: true, output: result };
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  private async writeFile(path: string, content: string): Promise<ToolResult> {
    const absPath = this.resolvePath(path);
    this.sandbox.assertPath(absPath);
    this.sandbox.assertFileSize(Buffer.byteLength(content));

    // File lock check
    const holder = await sharedState.getLockHolder(absPath);
    if (holder && holder !== this.agentId) {
      await eventBus.publish({
        type: 'message:direct', from: this.agentId, to: holder,
        content: `I need to write to ${absPath}, but you hold the lock. Can I proceed?`,
      });
      return { ok: false, output: '', error: `File locked by ${holder}` };
    }

    // FileChangeGuard — validate change ratio before writing
    let originalContent = '';
    try {
      if (existsSync(absPath)) {
        originalContent = await readFile(absPath, 'utf-8');
      }
    } catch { /* new file — original empty */ }

    if (originalContent.length > 0) {
      const validation = await fileChangeGuard.validateChange(
        absPath, originalContent, content, this.agentId, this.taskId,
      );
      if (validation.action === 'blocked') {
        return { ok: false, output: '', error: validation.reason || 'Change blocked by FileChangeGuard' };
      }
      // backup_then_proceed → backup already created, continue writing
    }

    await sharedState.acquireLock(absPath, this.agentId);
    try {
      const dir = dirname(absPath);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      await writeFile(absPath, content, 'utf-8');
      return { ok: true, output: `Written: ${absPath} (${Buffer.byteLength(content)} bytes)` };
    } finally {
      await sharedState.releaseLock(absPath, this.agentId);
    }
  }

  private async createFile(path: string, content: string): Promise<ToolResult> {
    const absPath = this.resolvePath(path);
    if (existsSync(absPath)) {
      return { ok: false, output: '', error: `File already exists: ${absPath}` };
    }
    return this.writeFile(absPath, content);
  }

  private async editFile(path: string, oldStr: string, newStr: string): Promise<ToolResult> {
    const absPath = this.resolvePath(path);
    this.sandbox.assertPath(absPath);
    try {
      const current = await readFile(absPath, 'utf-8');
      if (!current.includes(oldStr)) {
        return { ok: false, output: '', error: 'Old string not found in file' };
      }
      const updated = current.replace(oldStr, newStr);

      // FileChangeGuard — validate before edit
      const validation = await fileChangeGuard.validateChange(
        absPath, current, updated, this.agentId, this.taskId,
      );
      if (validation.action === 'blocked') {
        return { ok: false, output: '', error: validation.reason || 'Edit blocked by FileChangeGuard' };
      }

      return this.writeFile(absPath, updated);
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  private async deleteFile(path: string): Promise<ToolResult> {
    const absPath = this.resolvePath(path);
    this.sandbox.assertPath(absPath);
    try {
      await unlink(absPath);
      return { ok: true, output: `Deleted: ${absPath}` };
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  private async listFiles(dir: string): Promise<ToolResult> {
    const absPath = this.resolvePath(dir);
    this.sandbox.assertPath(absPath);
    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const list = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      return { ok: true, output: list };
    } catch (err: any) {
      return { ok: false, output: '', error: err.message };
    }
  }

  // ─── Command Execution ──────────────────────────────
  private async runCommand(commandOrCmd: string, providedArgs?: string[]): Promise<ToolResult> {
    const parsed = providedArgs ? { command: commandOrCmd, args: providedArgs } : this.parseCommand(commandOrCmd);
    if (!parsed) {
      return { ok: false, output: '', error: 'Unsupported shell metacharacter in command' };
    }

    this.sandbox.assertCommand(parsed.command, parsed.args);

    try {
      const result = await execa(parsed.command, parsed.args, {
        cwd: this.projectDir || undefined,
        shell: false,
        timeout: this.sandbox.getTimeout(),
        maxBuffer: 5 * 1024 * 1024,
        reject: false,
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const ok = result.exitCode === 0 && !result.failed;
      return {
        ok,
        output,
        error: ok ? undefined : result.shortMessage || `Command exited with code ${result.exitCode ?? 'unknown'}`,
      };
    } catch (err: any) {
      return { ok: false, output: err.stdout || '', error: err.message };
    }
  }

  private async runCommandSequence(commands: Array<{ command: string; args: string[] }>): Promise<ToolResult> {
    const outputs: string[] = [];

    for (const command of commands) {
      const result = await this.runCommand(command.command, command.args);
      if (result.output) outputs.push(result.output);
      if (!result.ok) {
        return {
          ok: false,
          output: outputs.join('\n'),
          error: result.error,
        };
      }
    }

    return { ok: true, output: outputs.join('\n') };
  }

  private parseCommand(cmd: string): { command: string; args: string[] } | null {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (const ch of cmd.trim()) {
      if (escaping) {
        current += ch;
        escaping = false;
        continue;
      }

      if (ch === '\\') {
        escaping = true;
        continue;
      }

      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          current += ch;
        }
        continue;
      }

      if (ch === '"' || ch === '\'') {
        quote = ch;
        continue;
      }

      if (/\s/.test(ch)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }

      if (';&|<>`$()'.includes(ch)) {
        return null;
      }

      current += ch;
    }

    if (escaping || quote) return null;
    if (current) args.push(current);
    if (args.length === 0) return null;

    const [command, ...rest] = args;
    return { command, args: rest };
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
