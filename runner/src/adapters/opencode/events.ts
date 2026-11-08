// OpenCode's ACP stream only carries the main session. A helper started by
// its `task` tool runs in a child session whose tool calls and permission
// questions never reach ACP, so the thread looked frozen on one open task
// call. `opencode acp --port N` also serves OpenCode's HTTP API; its /event
// SSE stream carries every session. This follows the main session's
// children and turns them into sub-agent updates and approval requests.
// Event shapes are from OpenCode 1.19.5 (test/fixtures/opencode/events.ndjson);
// anything unrecognised is ignored.
import net from 'node:net';
import type { SubagentUpdate } from '../types.ts';
import type { Logger } from '../../log.ts';

type Any = Record<string, any>;

export type ChildPermission = {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  command?: string;
  // The parent's task tool call that started the helper, when known.
  taskCallId?: string;
  description?: string;
};

export type PermissionReply = 'once' | 'always' | 'reject';

export type EventsDeps = {
  port: number;
  password?: string;
  rootSessionId: () => string | undefined;
  onSubagent: (u: SubagentUpdate) => void;
  onPermission: (p: ChildPermission) => void;
  log?: Logger;
  fetch?: typeof fetch;
};

type Child = { id: string; parent: string; callId?: string; description?: string; tools: Set<string>; status: 'running' | 'completed' | 'failed' | 'stopped' };

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export class OpenCodeEvents {
  private deps: EventsDeps;
  private children = new Map<string, Child>();
  private stopped = false;
  private abort?: AbortController;
  private lastEventAt = 0;

  constructor(deps: EventsDeps) {
    this.deps = deps;
  }

  private base(): string {
    return `http://127.0.0.1:${this.deps.port}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h = { ...extra };
    if (this.deps.password) h.authorization = `Basic ${Buffer.from(`opencode:${this.deps.password}`).toString('base64')}`;
    return h;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  // Milliseconds since the stream last said anything (heartbeats included).
  quietMs(): number {
    return this.lastEventAt ? Date.now() - this.lastEventAt : 0;
  }

  runningChildren(): string[] {
    return [...this.children.values()].filter((c) => c.status === 'running').map((c) => c.id);
  }

  private async loop(): Promise<void> {
    let delay = 500;
    while (!this.stopped) {
      try {
        await this.connect();
        delay = 500;
      } catch (e) {
        if (this.stopped) return;
        this.deps.log?.debug('opencode events', { error: String(e) });
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }

  private async connect(): Promise<void> {
    this.abort = new AbortController();
    const f = this.deps.fetch ?? fetch;
    const res = await f(`${this.base()}/event`, { headers: this.headers({ accept: 'text/event-stream' }), signal: this.abort.signal });
    if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        this.lastEventAt = Date.now();
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          this.handle(JSON.parse(data));
        } catch (e) {
          this.deps.log?.debug('opencode event skipped', { error: String(e) });
        }
      }
    }
  }

  private known(sessionId: unknown): boolean {
    if (typeof sessionId !== 'string') return false;
    return sessionId === this.deps.rootSessionId() || this.children.has(sessionId);
  }

  // Exposed for tests.
  handle(e: Any): void {
    const props: Any = e?.properties ?? {};
    switch (e?.type) {
      case 'session.created': {
        const info: Any = props.info ?? {};
        if (typeof info.id !== 'string' || typeof info.parentID !== 'string' || !this.known(info.parentID)) return;
        this.adopt(info.id, info.parentID, typeof info.title === 'string' ? info.title : undefined);
        return;
      }
      case 'message.part.updated': {
        const part: Any = props.part ?? {};
        if (part.type !== 'tool' || typeof props.sessionID !== 'string') return;
        if (!this.known(props.sessionID)) return;
        if (part.tool === 'task') this.taskPart(props.sessionID, part);
        else if (props.sessionID !== this.deps.rootSessionId()) this.childTool(props.sessionID, part);
        return;
      }
      case 'permission.asked': {
        const child = this.children.get(props.sessionID);
        if (!child || typeof props.id !== 'string') return;
        const md: Any = props.metadata ?? {};
        this.deps.onPermission({
          id: props.id,
          sessionId: child.id,
          permission: typeof props.permission === 'string' ? props.permission : 'tool',
          patterns: Array.isArray(props.patterns) ? props.patterns.filter((p: unknown) => typeof p === 'string') : [],
          ...(typeof md.command === 'string' ? { command: md.command } : {}),
          ...(child.callId ? { taskCallId: child.callId } : {}),
          ...(child.description ? { description: child.description } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  private adopt(id: string, parent: string, title?: string): Child {
    let c = this.children.get(id);
    if (!c) {
      c = { id, parent, tools: new Set(), status: 'running', ...(title ? { description: title } : {}) };
      this.children.set(id, c);
      this.deps.onSubagent({ id, started: true, status: 'running', ...(title ? { description: title } : {}) });
    }
    return c;
  }

  private taskPart(sessionId: string, part: Any): void {
    const state: Any = part.state ?? {};
    const childId = state.metadata?.sessionId;
    if (typeof childId !== 'string') return; // pending: no child yet
    const input: Any = state.input ?? {};
    const description = typeof input.description === 'string' ? input.description : typeof state.title === 'string' ? state.title : undefined;
    const child = this.adopt(childId, sessionId, description);
    if (typeof part.callID === 'string') child.callId = part.callID;
    if (description) child.description = description;
    const update: SubagentUpdate = {
      id: childId,
      ...(child.callId ? { itemId: child.callId } : {}),
      ...(sessionId !== this.deps.rootSessionId() ? { parentId: sessionId } : {}),
      ...(description ? { description } : {}),
      ...(typeof input.subagent_type === 'string' ? { agentType: input.subagent_type } : {}),
    };
    if (state.status === 'completed') {
      child.status = 'completed';
      update.status = 'completed';
      const summary = resultText(state.output);
      if (summary) update.summary = summary;
    } else if (state.status === 'error') {
      child.status = 'failed';
      update.status = 'failed';
      if (typeof state.error === 'string') update.summary = state.error.slice(0, 500);
    } else update.status = 'running';
    update.toolUses = child.tools.size;
    this.deps.onSubagent(update);
  }

  private childTool(sessionId: string, part: Any): void {
    const child = this.children.get(sessionId);
    if (!child || typeof part.callID !== 'string') return;
    child.tools.add(part.callID);
    const state: Any = part.state ?? {};
    const input: Any = state.input ?? {};
    const detail = [input.command, input.filePath, input.pattern, input.url, input.description].find((v) => typeof v === 'string' && v) as string | undefined;
    const verb = typeof part.tool === 'string' ? part.tool : 'tool';
    const done = state.status === 'completed' || state.status === 'error';
    const activity = `${done ? 'Finished' : 'Running'} ${verb}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
    this.deps.onSubagent({ id: child.id, activity, toolUses: child.tools.size });
  }

  // Marks helpers still running as stopped (after an interrupt).
  stopRunning(): string[] {
    const ids: string[] = [];
    for (const c of this.children.values()) {
      if (c.status !== 'running') continue;
      c.status = 'stopped';
      ids.push(c.id);
      this.deps.onSubagent({ id: c.id, status: 'stopped' });
    }
    return ids;
  }

  async reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<boolean> {
    const f = this.deps.fetch ?? fetch;
    try {
      const res = await f(`${this.base()}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ response }),
      });
      return res.ok;
    } catch (e) {
      this.deps.log?.warn('opencode permission reply failed', { error: String(e) });
      return false;
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    const f = this.deps.fetch ?? fetch;
    try {
      await f(`${this.base()}/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', headers: this.headers() });
    } catch {
      // already gone
    }
  }
}

// The task tool wraps the helper's answer as <task_result>...</task_result>.
function resultText(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const m = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(output);
  const text = (m ? m[1] : output).trim();
  return text ? text.slice(0, 500) : undefined;
}
