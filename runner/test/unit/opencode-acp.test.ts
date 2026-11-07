// The ACP client against a fake `agent acp`: the initialize result is the
// handshake captured from OpenCode CLI 2026.11.05-86047df on this machine
// (not logged in). Permission option ids (allow-once, allow-always,
// reject-once) are what that build sends. session/new's models field is
// the shape in its session-create return, not a live response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { OpenCodeAdapter, permissionDecision } from '../../src/adapters/opencode/adapter.ts';
import { parseOpenCodeModels, parseOpenCodeAuthList } from '../../src/adapters/opencode/cli.ts';
import { ThreadbearMcp } from '../../src/adapters/cursor/mcp-http.ts';
import type { SessionSink, StartSessionOptions, ToolApprovalAnswer } from '../../src/adapters/types.ts';
import type { AcpProcess } from '../../src/adapters/cursor/acp.ts';
import { tmpDir } from '../helpers/fakes.ts';

const HANDSHAKE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'opencode', 'handshake.json'), 'utf8'));

type Msg = Record<string, any>;

class FakeAcp extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 424242;
  killed = false;
  lines: Msg[] = [];
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }
}

function fakeProcess(): { proc: AcpProcess; fake: FakeAcp } {
  const fake = new FakeAcp();
  let buf = '';
  fake.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(fake, JSON.parse(line) as Msg);
      nl = buf.indexOf('\n');
    }
  });
  return { proc: fake as unknown as AcpProcess, fake };
}

function reply(fake: FakeAcp, id: number, result: unknown): void {
  fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function onLine(fake: FakeAcp, msg: Msg): void {
  fake.lines.push(msg);
  if (msg.method === 'initialize') reply(fake, msg.id, HANDSHAKE);
  else if (msg.method === 'authenticate') reply(fake, msg.id, {});
  else if (msg.method === 'session/new' || msg.method === 'session/load') {
    reply(fake, msg.id, {
      sessionId: 'chat-1',
      modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] },
      models: { currentModelId: 'opencode/big-pickle', availableModels: [{ modelId: 'opencode/big-pickle', name: 'Composer 2' }, { modelId: 'opencode/beam-free', name: 'GPT-5' }] },
      configOptions: [
        { id: 'mode', name: 'Mode', currentValue: 'agent' },
        {
          id: 'model',
          currentValue: 'opencode/big-pickle',
          options: [
            { value: 'opencode/big-pickle', name: 'Big Pickle' },
            { value: 'opencode/beam-free', name: 'Beam Free' },
          ],
        },
      ],
    });
  } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') reply(fake, msg.id, {});
  else if (msg.method === 'session/prompt') {
    fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' }, messageId: 'a' } } }) + '\n');
    fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'session/request_permission', params: { sessionId: 'chat-1', toolCall: { toolCallId: 'shell-1', title: 'Run tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } }) + '\n');
  }
}

function opts(root: string, extra: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return {
    threadId: 'thread-1',
    cwd: root,
    account: { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: root },
    permissionMode: 'full',
    sessionId: 'preassigned',
    resume: false,
    mediaDir: path.join(root, 'media'),
    blobsDir: path.join(root, 'blobs'),
    tmpDir: root,
    ...extra,
  };
}

function collect() {
  const outs: { kind: string; [k: string]: unknown }[] = [];
  let approvals = 0;
  const sink: SessionSink = {
    output: (o) => outs.push(o as { kind: string }),
    requestApproval: async () => {
      approvals++;
      return { decision: 'allow' };
    },
    requestQuestion: async () => ({ answers: null }),
    exited: () => {},
  };
  return { outs, sink, approvals: () => approvals };
}

test('permission: full access allows once without a card; ask maps the card', () => {
  const options = [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'allow-always', kind: 'allow_always' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ];
  assert.deepEqual(permissionDecision('full', options), { outcome: 'selected', optionId: 'allow-once' });
  const allow: ToolApprovalAnswer = { decision: 'allow' };
  const always: ToolApprovalAnswer = { decision: 'allowAlways' };
  const deny: ToolApprovalAnswer = { decision: 'deny' };
  assert.deepEqual(permissionDecision('ask', options, allow), { outcome: 'selected', optionId: 'allow-once' });
  assert.deepEqual(permissionDecision('ask', options, always), { outcome: 'selected', optionId: 'allow-always' });
  assert.deepEqual(permissionDecision('plan', options, deny), { outcome: 'selected', optionId: 'reject-once' });
  assert.deepEqual(permissionDecision('ask', options), { outcome: 'selected', optionId: 'reject-once' });
});

test('status and models parsers', () => {
  assert.deepEqual(parseOpenCodeAuthList('0 credentials\n'), { loggedIn: true, credentialCount: 0 });
  assert.deepEqual(parseOpenCodeAuthList('1 credentials\nben@example.com'), { loggedIn: true, credentialCount: 1, email: 'ben@example.com' });
  const printed = ['opencode/beam-free', 'opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free'].join('\n');
  const parsed = parseOpenCodeModels(printed);
  assert.deepEqual(parsed.models.map((m) => m.id), printed.split('\n'));
  assert.ok(parsed.defaultModel?.includes('flash') || parsed.defaultModel?.includes('beam'));
});

test('handshake authenticates with opencode-login, opens a session, and full access does not ask', async () => {
  const root = tmpDir('tb-opencode-acp-');
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  const { proc, fake } = fakeProcess();
  const image = path.join(root, 'pic.png');
  fs.writeFileSync(image, 'png-bytes');
  const { outs, sink, approvals } = collect();
  const adapter = new OpenCodeAdapter({
    binary: () => '/bin/agent',
    spawn: () => proc,
    version: async () => '2026.11.05-86047df',
    toolsFor: () => [],
  });
  const session = adapter.start(opts(root, { permissionMode: 'full', model: 'opencode/big-pickle' }), sink);
  session.send({ id: 'turn-1', text: 'Hello', images: [{ path: image, mediaType: 'image/png' }] });
  await waitForLines(fake, (lines) => lines.some((m) => m.method === 'session/prompt'));
  assert.equal(approvals(), 0, 'full access answers allow-once itself');
  assert.deepEqual(fake.lines.map((m) => m.method).filter(Boolean).slice(0, 4), ['initialize', 'authenticate', 'session/new', 'session/set_mode']);
  assert.equal(fake.lines[0].params.protocolVersion, 1);
  assert.equal(fake.lines[0].params.clientInfo.name, 'threadbear');
  assert.equal(fake.lines[1].params.methodId, 'opencode-login');
  const created = must(fake.lines.find((m) => m.method === 'session/new'), 'session/new');
  assert.equal(created.params.cwd, root);
  assert.deepEqual(created.params.mcpServers, []);
  assert.equal(must(fake.lines.find((m) => m.method === 'session/set_mode'), 'set_mode').params.modeId, 'agent');
  const modelSet = must(fake.lines.find((m) => m.method === 'session/set_config_option'), 'set_config_option');
  assert.deepEqual(modelSet.params, { sessionId: 'chat-1', configId: 'model', value: 'opencode/big-pickle' });
  const prompt = must(fake.lines.find((m) => m.method === 'session/prompt'), 'prompt');
  assert.equal(prompt.params.prompt[0].text, 'Hello');
  assert.equal(prompt.params.prompt[1].type, 'image');
  assert.equal(prompt.params.prompt[1].mimeType, 'image/png');
  assert.equal(prompt.params.prompt[1].data, Buffer.from('png-bytes').toString('base64'));
  await waitForLines(fake, (lines) => lines.some((m) => m.id === 50 && m.result));
  assert.deepEqual(must(fake.lines.find((m) => m.id === 50), 'permission reply').result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  reply(fake, prompt.id, { stopReason: 'end_turn' });
  const done = (await waitFor(outs, (o) => o.kind === 'result')) as unknown as { result: { outcome: string; answers?: string } };
  assert.equal(done.result.outcome, 'completed');
  assert.equal(done.result.answers, 'turn-1');
  const text = outs.find((o) => o.kind === 'event' && (o as { event?: { type?: string } }).event?.type === 'assistant.text') as unknown as { event: { text: string } };
  assert.equal(text.event.text, 'Hello');
  const sessionOut = outs.find((o) => o.kind === 'session') as unknown as { nativeSessionId: string; model?: string };
  assert.equal(sessionOut.nativeSessionId, 'chat-1');
  assert.equal(sessionOut.model, 'opencode/big-pickle');
  assert.equal((outs.find((o) => o.kind === 'cliVersion') as unknown as { version: string }).version, '2026.11.05-86047df');
  session.kill();
});

test('ask mode shows an approval card and resume loads the session', async () => {
  const root = tmpDir('tb-opencode-acp-');
  const { proc, fake } = fakeProcess();
  let decision: ToolApprovalAnswer['decision'] = 'deny';
  const outs: { kind: string; event?: { type?: string; text?: string }; result?: { outcome?: string } }[] = [];
  const sink: SessionSink = {
    output: (o) => outs.push(o as { kind: string }),
    requestApproval: async () => ({ decision }),
    requestQuestion: async () => ({ answers: { 'Pick one': 'Yes' } }),
    exited: () => {},
  };
  const adapter = new OpenCodeAdapter({ binary: () => '/bin/agent', spawn: () => proc, version: async () => '2026.11.05-86047df', toolsFor: () => [] });
  const session = adapter.start(opts(root, { permissionMode: 'ask', resume: true, sessionId: 'chat-kept' }), sink);
  session.send({ id: 'turn-2', text: 'Go', images: [] });
  await waitForLines(fake, (lines) => lines.some((m) => m.method === 'session/load'));
  assert.equal(must(fake.lines.find((m) => m.method === 'session/load'), 'load').params.sessionId, 'chat-kept');
  assert.equal(must(fake.lines.find((m) => m.method === 'session/set_mode'), 'mode').params.modeId, 'ask');
  await waitForLines(fake, (lines) => lines.some((m) => m.id === 50 && m.result));
  assert.deepEqual(must(fake.lines.find((m) => m.id === 50), 'permission reply').result, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
  const prompt = must(fake.lines.find((m) => m.method === 'session/prompt'), 'prompt');
  reply(fake, prompt.id, { stopReason: 'end_turn' });
  await waitFor(outs, (o) => o.kind === 'result');
  const note = outs.find((o) => o.kind === 'event' && o.event?.type === 'system.note');
  assert.equal(note, undefined, 'ask mode does not add the auto-classifier note');
  await session.interrupt();
  assert.ok(fake.lines.some((m) => m.method === 'session/cancel'));
  session.kill();
  void decision;
});

test('threadbear MCP lists end_turn on the HTTP url the CLI posts to', async () => {
  const mcp = await ThreadbearMcp.start(
    [
      { name: 'end_turn', description: 'End the turn', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'Noted.' }] }) },
      { name: 'list_threads', description: 'List threads', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'none' }] }) },
    ],
    'End every turn by calling end_turn.',
  );
  try {
    assert.equal(mcp.endpoint.type, 'http');
    assert.match(mcp.endpoint.url, /\/mcp\//);
    const post = (method: string, id: number, params?: unknown) =>
      fetch(mcp.endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      });
    const init = await post('initialize', 1, { protocolVersion: '2025-03-26' });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('content-type'), 'application/json');
    const initBody = (await init.json()) as { result: { instructions: string; serverInfo: { name: string } } };
    assert.equal(initBody.result.serverInfo.name, 'threadbear');
    assert.match(initBody.result.instructions, /end_turn/);
    const list = await post('tools/list', 2);
    const listed = (await list.json()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(
      listed.result.tools.map((t) => t.name),
      ['end_turn', 'list_threads'],
    );
    const call = await post('tools/call', 3, { name: 'end_turn', arguments: {} });
    const called = (await call.json()) as { result: { content: { text: string }[] } };
    assert.equal(called.result.content[0].text, 'Noted.');
    // The older SSE transport still answers, for a client that asks for it.
    const sseUrl = mcp.endpoint.url.replace('/mcp/', '/sse/');
    const sse = await fetch(sseUrl);
    assert.equal(sse.ok, true);
    await sse.body?.cancel();
  } finally {
    mcp.stop();
  }
});

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function waitFor<T>(items: T[], pred: (item: T) => boolean, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = items.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function waitForLines(fake: FakeAcp, pred: (lines: Msg[]) => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred(fake.lines)) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
