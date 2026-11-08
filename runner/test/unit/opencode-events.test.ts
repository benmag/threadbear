// OpenCode's helper (task tool) sessions, from SSE captured off
// `opencode acp --port` on CLI 1.19.5 (test/fixtures/opencode/events*.ndjson).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCodeEvents, type ChildPermission } from '../../src/adapters/opencode/events.ts';
import { cursorToolIdentity } from '../../src/adapters/cursor/normalize.ts';
import type { SubagentUpdate } from '../../src/adapters/types.ts';

const load = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'opencode', name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function run(name: string, root: string, fetchFn?: typeof fetch) {
  const subs: SubagentUpdate[] = [];
  const perms: ChildPermission[] = [];
  const ev = new OpenCodeEvents({ port: 1, rootSessionId: () => root, onSubagent: (u) => subs.push(u), onPermission: (p) => perms.push(p), ...(fetchFn ? { fetch: fetchFn } : {}) });
  for (const e of load(name)) ev.handle(e);
  return { ev, subs, perms };
}

test('a helper becomes a sub-agent with live tool activity and a result', () => {
  const events = load('events.ndjson');
  const root = events.find((e) => e.type === 'message.part.updated' && e.properties.part.tool === 'task').properties.sessionID;
  const { subs } = run('events.ndjson', root);
  const first = subs.find((u) => u.started);
  assert.ok(first);
  assert.equal(subs.find((u) => u.agentType === 'general')?.description, 'Run ls -la and count lines');
  assert.ok(subs.some((u) => u.activity?.startsWith('Running bash: ls -la')));
  const done = subs.at(-1)!;
  assert.equal(done.status, 'completed');
  assert.match(done.summary ?? '', /lines/);
  assert.ok(subs.every((u) => u.id === first.id));
  assert.equal(subs.find((u) => u.activity)?.toolUses, 1);
});

test('events for sessions that are not ours are ignored', () => {
  const { subs, perms } = run('events.ndjson', 'ses_other');
  assert.equal(subs.length, 0);
  assert.equal(perms.length, 0);
});

test("a helper's permission question is surfaced with its command", () => {
  const events = load('events-permission.ndjson');
  const root = events.find((e) => e.type === 'message.part.updated' && e.properties.part.tool === 'task').properties.sessionID;
  const { perms } = run('events-permission.ndjson', root);
  assert.equal(perms.length, 1);
  assert.equal(perms[0].command, 'touch /tmp/tb_perm_test.txt');
  assert.equal(perms[0].permission, 'external_directory');
  assert.notEqual(perms[0].sessionId, root);
  assert.ok(perms[0].taskCallId);
});

test('replying posts to the child session with basic auth', async () => {
  const calls: { url: string; init: any }[] = [];
  const fake = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: true } as Response;
  }) as typeof fetch;
  const ev = new OpenCodeEvents({ port: 4999, password: 'pw', rootSessionId: () => 'r', onSubagent: () => {}, onPermission: () => {}, fetch: fake });
  assert.equal(await ev.reply('ses_c', 'per_1', 'always'), true);
  assert.equal(calls[0].url, 'http://127.0.0.1:4999/session/ses_c/permissions/per_1');
  assert.equal(JSON.parse(calls[0].init.body).response, 'always');
  assert.match(calls[0].init.headers.authorization, /^Basic /);
});

test("OpenCode's task call is named Task, not a generic think row", () => {
  const first = cursorToolIdentity({ title: 'task', kind: 'think', rawInput: {} }, new Set(), '/w');
  assert.equal(first.name, 'Task');
  const later = cursorToolIdentity({ title: 'Run ls', kind: 'think', rawInput: { description: 'Run ls', subagent_type: 'general', prompt: 'x' } }, new Set(), '/w');
  assert.equal(later.name, 'Task');
  assert.equal(later.kind, 'task');
});

test('a helper keeps a record of its prompt, tool calls, results and replies', () => {
  const events = load('events.ndjson');
  const root = events.find((e) => e.type === 'message.part.updated' && e.properties.part.tool === 'task').properties.sessionID;
  const { subs } = run('events.ndjson', root);
  const bodies = subs.flatMap((u) => u.events ?? []);
  assert.equal(bodies.filter((b) => b.type === 'tool.call').length, 2);
  const result = bodies.find((b) => b.type === 'tool.result');
  assert.ok(result && result.type === 'tool.result' && result.ok && result.text.startsWith('total'));
  assert.equal(bodies.filter((b) => b.type === 'user.message').length, 1);

  const subs2: SubagentUpdate[] = [];
  const ev = new OpenCodeEvents({ port: 1, rootSessionId: () => 'root', onSubagent: (u) => subs2.push(u), onPermission: () => {} });
  ev.handle({ type: 'session.created', properties: { info: { id: 'kid', parentID: 'root', title: 't' } } });
  ev.handle({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant' } } });
  const text = { id: 'p1', messageID: 'm1', type: 'text', text: 'All done', time: { start: 1, end: 2 } };
  ev.handle({ type: 'message.part.updated', properties: { sessionID: 'kid', part: text } });
  ev.handle({ type: 'message.part.updated', properties: { sessionID: 'kid', part: text } });
  assert.deepEqual(subs2.flatMap((u) => u.events ?? []), [{ type: 'assistant.text', itemId: 'p1', text: 'All done' }]);
});
