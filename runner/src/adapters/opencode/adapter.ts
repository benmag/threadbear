// Drives one `opencode acp` process per live thread. The process stays up
// across turns: session/new (or session/load) once, then session/prompt
// per message. Tool approval is session/request_permission. Full access
// answers allow-once without a card; ask and plan show the card. There is
// no rewind. Usage is recorded when the agent sends usage_update.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { PermissionMode } from '../../protocol.ts';
import type { Logger } from '../../log.ts';
import type { ProcessRegistry } from '../../proc.ts';
import { killGroup } from '../../proc.ts';
import { RUNNER_VERSION } from '../../config.ts';
import type { ToolDefinition } from '../codex/tools.ts';
import { fileContext } from '../context.ts';
import type { AgentAdapter, AgentSession, SessionSink, StartSessionOptions, ToolApprovalAnswer, UserInput } from '../types.ts';
import { SessionNotFoundError } from '../types.ts';
import { AcpConnection, AcpError, type AcpProcess } from '../acp/connection.ts';
import { openAcpSession } from '../acp/session.ts';
import { findOpenCodeBinary, modelsFromSessionConfig, openCodeModels, openCodeStatus, openCodeVersion, parseOpenCodeModels } from './cli.ts';
import { ThreadbearMcp } from '../acp/mcp-http.ts';
import { CursorNormalizer, commandsOf, effortNote } from '../cursor/normalize.ts';
import type { SlashCommand } from '../../slash-commands.ts';
import type { ModelChoice } from '../../protocol.ts';

type Any = Record<string, any>;

export type PermissionOption = { optionId: string; kind?: string; name?: string };

// Full access allows the call and does not write Cursor's own allow-list
// (allow-once, not allow-always). Ask and plan wait for the card.
export function permissionDecision(mode: PermissionMode, options: PermissionOption[], answer?: ToolApprovalAnswer): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const allowOnce = options.find((o) => o.kind === 'allow_once' || o.optionId === 'allow-once');
  const allowAlways = options.find((o) => o.kind === 'allow_always' || o.optionId === 'allow-always');
  const reject = options.find((o) => o.kind === 'reject_once' || o.optionId === 'reject-once') ?? options.find((o) => o.kind === 'reject_always');
  if (mode === 'full') {
    const pick = allowOnce ?? allowAlways;
    return pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
  }
  if (!answer || answer.decision === 'deny' || answer.decision === 'expired') {
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  }
  if (answer.decision === 'allowAlways' && allowAlways) return { outcome: 'selected', optionId: allowAlways.optionId };
  if (allowOnce) return { outcome: 'selected', optionId: allowOnce.optionId };
  if (allowAlways) return { outcome: 'selected', optionId: allowAlways.optionId };
  return { outcome: 'cancelled' };
}

function acpMode(mode: PermissionMode): 'agent' | 'plan' | 'ask' {
  if (mode === 'plan') return 'plan';
  if (mode === 'ask' || mode === 'auto') return 'ask';
  return 'agent';
}

export type OpenCodeAdapterDeps = {
  binary?: () => string | undefined;
  spawn?: (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => AcpProcess;
  registry?: ProcessRegistry;
  log?: Logger;
  toolsFor?: (threadId: string) => ToolDefinition[];
  guidance?: (threadId: string) => string;
  // Injected in tests. The real one shells out.
  status?: (bin: string) => Promise<{ loggedIn: boolean; email?: string }>;
  models?: (bin: string) => Promise<{ models: ModelChoice[]; defaultModel?: string }>;
  version?: (bin: string) => Promise<string | undefined>;
};

export class OpenCodeAdapter implements AgentAdapter {
  readonly provider = 'opencode' as const;
  // A prompt already running keeps its mode; the next prompt uses the new one.
  readonly settingsApplyNextTurn = true;
  // Nothing here starts a turn when background work ends.
  readonly wakesAfterTasks = false;
  private deps: OpenCodeAdapterDeps;
  private knownModels: ModelChoice[] | undefined;
  private loginAt = 0;
  private loginCache: { email?: string } | null | undefined;

  constructor(deps: OpenCodeAdapterDeps = {}) {
    this.deps = deps;
  }

  private binary(): string | undefined {
    return (this.deps.binary ?? (() => findOpenCodeBinary()))();
  }

  async login(): Promise<{ email?: string } | null> {
    if (this.loginCache !== undefined && Date.now() - this.loginAt < 60_000) return this.loginCache;
    this.loginAt = Date.now();
    const bin = this.binary();
    if (!bin) {
      this.loginCache = null;
      return null;
    }
    try {
      const status = await (this.deps.status ?? openCodeStatus)(bin);
      this.loginCache = status?.loggedIn ? { ...(status.email ? { email: status.email } : {}) } : null;
    } catch (e) {
      this.deps.log?.warn('opencode status failed', { error: String(e) });
      this.loginCache = null;
    }
    return this.loginCache;
  }

  private knownDefault?: string;

  async models(): Promise<{ models: ModelChoice[]; defaultModel?: string }> {
    const bin = this.binary();
    if (bin) {
      try {
        const listed = await (this.deps.models ?? openCodeModels)(bin);
        if (listed.models.length) {
          this.knownModels = listed.models;
          this.knownDefault = listed.defaultModel;
          return listed;
        }
      } catch (e) {
        this.deps.log?.warn('opencode models failed', { error: String(e) });
      }
    }
    return { models: this.knownModels ?? [], ...(this.knownDefault ? { defaultModel: this.knownDefault } : {}) };
  }

  start(opts: StartSessionOptions, sink: SessionSink): AgentSession {
    return new OpenCodeSession(opts, sink, this.deps, (listed) => {
      if (listed.models.length) this.knownModels = listed.models;
      if (listed.defaultModel) this.knownDefault = listed.defaultModel;
    });
  }
}

class OpenCodeSession implements AgentSession {
  private opts: StartSessionOptions;
  private sink: SessionSink;
  private deps: OpenCodeAdapterDeps;
  private learnModels: (listed: { models: ModelChoice[]; defaultModel?: string }) => void;
  private normalizer: CursorNormalizer;
  private conn?: AcpConnection;
  private proc?: AcpProcess;
  private mcp?: ThreadbearMcp;
  private ready: Promise<void>;
  private readyOk = false;
  private sessionId?: string;
  private mode: PermissionMode;
  private model?: string;
  private effort: StartSessionOptions['effort'];
  private effortSaid = false;
  private autoSaid = false;
  private prompting = false;
  private ending = false;
  private exited = false;
  private approvalAbort = new AbortController();
  private queue: UserInput[] = [];
  private briefed = false;
  private slash: SlashCommand[] = [];
  private pendingPermissions = new Set<number | string>();

  constructor(opts: StartSessionOptions, sink: SessionSink, deps: OpenCodeAdapterDeps, learnModels: (listed: { models: ModelChoice[]; defaultModel?: string }) => void) {
    this.opts = opts;
    this.sink = sink;
    this.deps = deps;
    this.learnModels = learnModels;
    this.mode = opts.permissionMode;
    this.model = opts.model;
    this.effort = opts.effort;
    const tools = deps.toolsFor?.(opts.threadId) ?? [];
    this.normalizer = new CursorNormalizer(fileContext(opts.cwd, opts.mediaDir, opts.blobsDir), { threadbearTools: tools.map((t) => t.name) });
    this.ready = this.open(tools);
    // send() awaits this. A start that never gets a message must not be an
    // unhandled rejection; the error still rejects `ready` for pump().
    void this.ready.catch(() => {});
  }

  private async open(tools: ToolDefinition[]): Promise<void> {
    const bin = (this.deps.binary ?? (() => findOpenCodeBinary()))();
    if (!bin) throw new Error("The OpenCode CLI isn't installed. Install it from https://opencode.ai/docs, then send again.");
    const version = await (this.deps.version ?? openCodeVersion)(bin).catch(() => undefined);
    if (version) this.sink.output({ kind: 'cliVersion', version });
    if (tools.length) {
      try {
        this.mcp = await ThreadbearMcp.start(tools, this.deps.guidance?.(this.opts.threadId) ?? '');
      } catch (e) {
        this.deps.log?.warn('threadbear MCP for OpenCode did not start', { error: String(e) });
      }
    }
    const env = { ...process.env, ...this.opts.env };
    const proc = (this.deps.spawn ?? defaultSpawn)(bin, ['acp'], { cwd: this.opts.cwd, env });
    this.proc = proc;
    if (!this.deps.spawn && proc.pid) this.deps.registry?.add(proc.pid, bin);
    this.conn = new AcpConnection(
      proc,
      {
        notification: (method, params) => this.onNotification(method, params),
        request: (id, method, params) => this.onRequest(id, method, params),
      },
      { label: 'OpenCode ACP' },
    );
    proc.stderr?.on('data', (chunk: Buffer | string) => this.deps.log?.debug('opencode acp', { text: String(chunk).slice(0, 500) }));
    proc.on('exit', () => {
      if (this.proc?.pid && !this.deps.spawn) this.deps.registry?.remove(this.proc.pid);
      this.giveUp(new Error('OpenCode ACP exited.'));
    });
    const init = (await this.conn.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'threadbear', version: RUNNER_VERSION },
      },
      20_000,
    )) as Any;
    if (init?.protocolVersion !== 1) this.deps.log?.info('opencode acp protocol', { protocolVersion: init?.protocolVersion });
    try {
      await this.conn.request('authenticate', { methodId: 'opencode-login' }, 30_000);
    } catch (e) {
      throw authError(e);
    }
    const mcpServers = this.mcp ? [this.mcp.endpoint] : [];
    const loadSession = (init as Any)?.agentCapabilities?.loadSession === true;
    const opened = await openAcpSession(this.conn, {
      resume: this.opts.resume,
      sessionId: this.opts.sessionId,
      cwd: this.opts.cwd,
      mcpServers,
      loadSession,
      agentLabel: 'OpenCode',
    });
    const created = opened.created;
    this.sessionId = opened.sessionId;
    const listed = modelsOf(created);
    if (listed.models.length) this.learnModels(listed);
    const picked = this.model || listed.defaultModel || currentModel(created);
    const model = picked ? picked.trim() : '';
    this.sink.output({
      kind: 'session',
      nativeSessionId: this.sessionId,
      ...(model ? { model } : {}),
      ...(listed.models.length ? { models: listed.models } : {}),
    });
    await this.applySettings(created);
    this.readyOk = true;
  }

  private async applySettings(created: Any): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    try {
      await this.conn.request('session/set_mode', { sessionId: this.sessionId, modeId: acpMode(this.mode) }, 15_000);
    } catch (e) {
      this.deps.log?.info('opencode mode was not set', { error: String(e) });
    }
    if (this.model) {
      try {
        await this.conn.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: this.model }, 15_000);
      } catch (e) {
        this.deps.log?.info('opencode model was not set', { model: this.model, error: String(e) });
      }
    }
    const effortId = effortOptionId(created);
    if (this.effort && effortId) {
      try {
        await this.conn.request('session/set_config_option', { sessionId: this.sessionId, configId: effortId, value: this.effort }, 15_000);
        this.effortSaid = true;
      } catch {
        // said below, once
      }
    }
  }

  send(input: UserInput): void {
    this.queue.push(input);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.prompting || this.ending) return;
    this.prompting = true;
    try {
      await this.ready;
    } catch (e) {
      this.prompting = false;
      if (this.exited) return;
      const err = e instanceof Error ? e : new Error(String(e));
      if (err instanceof SessionNotFoundError || err.name === 'SessionNotFoundError') {
        this.stopProcess();
        this.giveUp(err);
        return;
      }
      const auth = /log in|login|auth/i.test(err.message);
      this.sink.output({
        kind: 'result',
        result: { outcome: 'failed', durationMs: 0, error: err.message, ...(auth ? { errorKind: 'auth' as const } : {}) },
      });
      this.stopProcess();
      this.giveUp();
      return;
    }
    const input = this.queue.shift();
    if (!input || this.ending) {
      this.prompting = false;
      return;
    }
    try {
      await this.prompt(input);
    } catch (e) {
      if (this.exited) return;
      const message = e instanceof Error ? e.message : String(e);
      const auth = e instanceof AcpError && (e.code === -32000 || /auth/i.test(message));
      this.normalizer.begin(input.id);
      for (const o of this.normalizer.finish(auth ? 'refusal' : 'error')) {
        if (o.kind === 'result') {
          o.result.error = message;
          if (auth) o.result.errorKind = 'auth';
          if (this.queue.length) o.result.queuedTurns = this.queue.length;
        }
        this.sink.output(o);
      }
    } finally {
      this.prompting = false;
      if (this.queue.length && !this.ending) void this.pump();
    }
  }

  private async prompt(input: UserInput): Promise<void> {
    if (this.mode === 'auto' && !this.autoSaid) {
      this.autoSaid = true;
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: "OpenCode has no auto classifier, so this thread asks before tools that need permission." } });
    }
    const note = effortNote(this.effort, this.effortSaid);
    if (note && !this.effortSaid) {
      this.effortSaid = true;
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: note } });
    }
    let text = input.text;
    if (this.opts.instructions && !this.briefed) {
      this.briefed = true;
      text = `${this.opts.instructions}\n\n${text}`;
    }
    const prompt = contentBlocks(text, input.images, (dropped) => {
      this.sink.output({ kind: 'event', event: { type: 'system.note', text: dropped } });
    });
    this.normalizer.begin(input.id);
    const result = (await this.conn!.request('session/prompt', { sessionId: this.sessionId, prompt })) as Any;
    for (const o of this.normalizer.finish(result && typeof result === 'object' ? result : undefined)) {
      if (o.kind === 'result' && this.queue.length) o.result.queuedTurns = this.queue.length;
      this.sink.output(o);
    }
  }

  async interrupt(): Promise<void> {
    this.approvalAbort.abort();
    this.approvalAbort = new AbortController();
    if (!this.conn || !this.sessionId) return;
    for (const id of this.pendingPermissions) {
      try {
        this.conn.respond(id, { outcome: { outcome: 'cancelled' } });
      } catch {
        // already answered
      }
    }
    this.pendingPermissions.clear();
    this.conn.notify('session/cancel', { sessionId: this.sessionId });
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
    if (!this.readyOk || !this.conn || !this.sessionId || !model) return;
    await this.conn.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: model }, 15_000);
  }

  async setEffort(effort: StartSessionOptions['effort']): Promise<void> {
    this.effort = effort;
    this.effortSaid = false;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    if (!this.readyOk || !this.conn || !this.sessionId) return;
    await this.conn.request('session/set_mode', { sessionId: this.sessionId, modeId: acpMode(mode) }, 15_000);
  }

  async commands(): Promise<SlashCommand[]> {
    return this.slash.length ? this.slash : this.normalizer.slashCommands();
  }

  async end(): Promise<void> {
    this.ending = true;
    this.stopProcess();
    this.giveUp();
    await Promise.resolve();
  }

  kill(): void {
    this.ending = true;
    this.stopProcess();
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !params || typeof params !== 'object') return;
    const update = (params as Any).update;
    if (!update || typeof update !== 'object') return;
    if (update.sessionUpdate === 'available_commands_update') this.slash = commandsOf(update.availableCommands);
    if (!this.readyOk) return; // session/load replays history before it returns
    for (const o of this.normalizer.handleUpdate(update)) this.sink.output(o);
  }

  private async onRequest(id: number | string, method: string, params: unknown): Promise<unknown> {
    const p = (params && typeof params === 'object' ? params : {}) as Any;
    if (method === 'session/request_permission') return this.permission(id, p);
    if (method === 'cursor/ask_question' || method === 'opencode/ask_question') return this.question(p);
    throw new Error(`Method not found: ${method}`);
  }

  private async permission(id: number | string, params: Any): Promise<unknown> {
    const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : [];
    const tool = params.toolCall && typeof params.toolCall === 'object' ? (params.toolCall as Any) : {};
    if (this.mode === 'full') return { outcome: permissionDecision('full', options) };
    this.pendingPermissions.add(id);
    try {
      const answer = await this.sink.requestApproval({
        toolUseId: typeof tool.toolCallId === 'string' ? tool.toolCallId : undefined,
        name: typeof tool.kind === 'string' ? tool.kind : 'tool',
        title: typeof tool.title === 'string' ? tool.title : 'Allow this?',
        input: tool.rawInput && typeof tool.rawInput === 'object' ? (tool.rawInput as Record<string, unknown>) : {},
        canAlwaysAllow: options.some((o) => o.kind === 'allow_always' || o.optionId === 'allow-always'),
        signal: this.approvalAbort.signal,
      });
      return { outcome: permissionDecision(this.mode, options, answer) };
    } finally {
      this.pendingPermissions.delete(id);
    }
  }

  private async question(params: Any): Promise<unknown> {
    const raw = Array.isArray(params.questions) ? params.questions : [];
    if (!raw.length) return { outcome: { outcome: 'skipped', reason: 'No questions.' } };
    const questions = raw.map((q: Any) => ({
      question: typeof q.prompt === 'string' ? q.prompt : 'Question',
      ...(typeof params.title === 'string' ? { header: params.title } : {}),
      multiSelect: Boolean(q.allowMultiple),
      options: Array.isArray(q.options) ? q.options.map((o: Any) => ({ label: typeof o.label === 'string' ? o.label : String(o.id ?? '') })) : [],
    }));
    const answer = await this.sink.requestQuestion({
      ...(typeof params.toolCallId === 'string' ? { toolUseId: params.toolCallId } : {}),
      questions,
      signal: this.approvalAbort.signal,
    });
    if (!answer.answers) return { outcome: { outcome: 'skipped', reason: answer.message || 'Skipped.' } };
    const answers = raw.map((q: Any, i: number) => {
      const chosen = answer.answers?.[questions[i].question] ?? '';
      const labels = chosen.split(',').map((s) => s.trim()).filter(Boolean);
      const options = Array.isArray(q.options) ? q.options : [];
      const ids = options
        .filter((o: Any) => labels.includes(typeof o.label === 'string' ? o.label : '') || labels.includes(String(o.id ?? '')))
        .map((o: Any) => String(o.id ?? o.label ?? ''))
        .filter(Boolean);
      return { questionId: q.id, selectedOptionIds: ids };
    });
    return { outcome: { outcome: 'answered', answers } };
  }

  private stopProcess(): void {
    const proc = this.proc;
    if (!proc) return;
    this.mcp?.stop();
    this.mcp = undefined;
    if (this.deps.spawn) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
      return;
    }
    if (proc.pid) killGroup(proc.pid, 'SIGTERM');
    else {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  private giveUp(err?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.ending = true;
    this.mcp?.stop();
    this.sink.exited(err);
  }
}

function defaultSpawn(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): AcpProcess {
  const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess;
  return child as unknown as AcpProcess;
}

function authError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (/timed out/i.test(message)) return new Error("OpenCode didn't accept the login in time. Run `opencode auth login` in Terminal, then send again.");
  if (/auth|login|logged/i.test(message)) return new Error(`${message} Run \`opencode auth login\` in Terminal, then send again.`);
  return e instanceof Error ? e : new Error(message);
}

function contentBlocks(text: string, images: UserInput['images'], dropped: (note: string) => void): { type: string; text?: string; data?: string; mimeType?: string }[] {
  const blocks: { type: string; text?: string; data?: string; mimeType?: string }[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const image of images) {
    try {
      const data = fs.readFileSync(image.path).toString('base64');
      blocks.push({ type: 'image', data, mimeType: image.mediaType || 'application/octet-stream' });
    } catch {
      dropped(`Couldn't attach ${image.path}, so OpenCode didn't get that image.`);
    }
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function modelsOf(created: Any): { models: ModelChoice[]; defaultModel?: string } {
  const fromOptions = modelsFromSessionConfig(created?.configOptions);
  if (fromOptions.models.length) return fromOptions;
  return parseOpenCodeModels('');
}

function currentModel(created: Any): string | undefined {
  const options = Array.isArray(created?.configOptions) ? created.configOptions : [];
  const modelOption = options.find((row: Any) => row?.id === 'model');
  const id = modelOption?.currentValue;
  return typeof id === 'string' && id ? id.trim() : undefined;
}

function effortOptionId(created: Any): string | undefined {
  const options = created?.configOptions;
  if (!Array.isArray(options)) return undefined;
  for (const row of options) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id : '';
    const name = typeof row.name === 'string' ? row.name : '';
    if (/effort|thinking|reasoning/i.test(`${id} ${name}`)) return id || undefined;
  }
  return undefined;
}
