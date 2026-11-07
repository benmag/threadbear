// Replays ACP session/update lines through CursorNormalizer. The fixture is
// composed from the Agent Client Protocol schema and the update shapes in
// Cursor CLI 2026.11.05-86047df (sendAgentMessageChunk, tool_call,
// tool_call_update). It is not a capture of a logged-in turn: this machine
// had no Cursor login, so `agent acp` could initialize but not start a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CursorNormalizer, commandsOf, effortNote, protocolToolName } from '../../src/adapters/cursor/normalize.ts';
import { fileContext } from '../../src/adapters/context.ts';
import type { AdapterOutput } from '../../src/adapters/types.ts';
import { checkEvent } from '../helpers/protocol-check.ts';
import { tmpDir } from '../helpers/fakes.ts';

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'cursor', 'turn.ndjson');

function load(): Record<string, unknown>[] {
  return fs
    .readFileSync(FIX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function run() {
  const root = tmpDir('tb-cursor-norm-');
  const n = new CursorNormalizer(fileContext(path.join(root, 'proj'), path.join(root, 'media'), path.join(root, 'blobs')), { threadbearTools: ['end_turn', 'list_threads'] });
  n.begin('turn-1');
  const outs: AdapterOutput[] = [];
  for (const update of load()) outs.push(...n.handleUpdate(update));
  outs.push(...n.finish('end_turn'));
  for (const o of outs) {
    if (o.kind !== 'event' && o.kind !== 'delta') continue;
    const body = o.kind === 'event' ? o.event : o.delta;
    assert.deepEqual(checkEvent({ seq: 1, ts: '2026-11-07T00:00:00.000Z', threadId: 't', ...body }), [], `${body.type} breaks the protocol`);
  }
  return { outs, commands: n.slashCommands() };
}

const events = (outs: AdapterOutput[]) => outs.filter((o) => o.kind === 'event').map((o) => (o as Extract<AdapterOutput, { kind: 'event' }>).event);
const deltas = (outs: AdapterOutput[]) => outs.filter((o) => o.kind === 'delta').map((o) => (o as Extract<AdapterOutput, { kind: 'delta' }>).delta);

test('message chunks become deltas and one assistant.text before the tool', () => {
  const { outs } = run();
  const textDeltas = deltas(outs).filter((d) => d.type === 'assistant.text.delta');
  assert.deepEqual(textDeltas.map((d) => d.text), ["I'll read ", 'README.']);
  const texts = events(outs).filter((e) => e.type === 'assistant.text');
  assert.equal(texts.length, 1);
  assert.equal((texts[0] as { text: string }).text, "I'll read README.");
  const thought = events(outs).find((e) => e.type === 'reasoning') as { text: string };
  assert.equal(thought.text, 'The file is short.');
});

test('tool calls, the end_turn name, a diff and a plan', () => {
  const { outs, commands } = run();
  const calls = events(outs).filter((e) => e.type === 'tool.call') as { name: string; kind: string; itemId: string }[];
  assert.deepEqual(calls.map((c) => [c.itemId, c.name, c.kind]), [
    ['t1', 'read', 'read'],
    ['t2', 'edit', 'edit'],
    ['e1', 'mcp__threadbear__end_turn', 'mcp'],
  ]);
  const results = events(outs).filter((e) => e.type === 'tool.result') as { itemId: string; ok: boolean; text: string }[];
  assert.equal(results.find((r) => r.itemId === 't1')?.text, '# Hi');
  assert.equal(results.find((r) => r.itemId === 'e1')?.text, 'Noted. Read the file.');
  const diff = events(outs).find((e) => e.type === 'edit.diff') as { path: string; hunks: { lines: string[] }[] };
  assert.equal(diff.path, '/work/a.ts');
  assert.ok(diff.hunks[0].lines.some((l) => l.startsWith('-a')));
  assert.ok(diff.hunks[0].lines.some((l) => l.startsWith('+b')));
  const plan = events(outs).find((e) => e.type === 'plan.updated') as { entries: { text: string; status: string }[] };
  assert.deepEqual(plan.entries, [
    { text: 'Read README', status: 'completed' },
    { text: 'Reply', status: 'pending' },
  ]);
  assert.deepEqual(commands.map((c) => c.name), ['compact']);
  const echoed = events(outs).filter((e) => e.type === 'assistant.text' && (e as { text: string }).text.includes('ignored echo'));
  assert.equal(echoed.length, 0);
});

test('usage_update is context and cost, and a missing one is not invented', () => {
  const { outs } = run();
  const context = outs.find((o) => o.kind === 'context') as Extract<AdapterOutput, { kind: 'context' }>;
  assert.deepEqual([context.contextTokens, context.contextWindow], [1200, 200000]);
  const result = outs.find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.equal(result.result.outcome, 'completed');
  assert.equal(result.result.totalCostUsd, 0.02);
  assert.equal(result.result.usage, undefined, 'context size is not reported as a turn token total');
  assert.equal(result.result.answers, 'turn-1');

  const root = tmpDir('tb-cursor-norm-');
  const bare = new CursorNormalizer(fileContext(root, root, root));
  bare.begin('t');
  const done = bare.finish('end_turn');
  const r = done.find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.equal(r.result.usage, undefined);
  assert.equal(r.result.totalCostUsd, undefined);
});

test('stop reasons and an auth line in the reply', () => {
  const root = tmpDir('tb-cursor-norm-');
  const n = new CursorNormalizer(fileContext(root, root, root));
  n.begin('t');
  n.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Error: [unauthenticated] Backend rejected authentication.' } });
  const failed = n.finish('end_turn').find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.equal(failed.result.outcome, 'failed');
  assert.equal(failed.result.errorKind, 'auth');

  const cancelled = new CursorNormalizer(fileContext(root, root, root));
  cancelled.begin('t');
  const stop = cancelled.finish('cancelled').find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.equal(stop.result.outcome, 'interrupted');

  const limited = new CursorNormalizer(fileContext(root, root, root));
  const hit = limited.finish('max_tokens').find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.equal(hit.result.errorKind, 'contextWindow');
});

test('tool names and effort', () => {
  const known = new Set(['list_threads']);
  assert.equal(protocolToolName('end_turn', known), 'mcp__threadbear__end_turn');
  assert.equal(protocolToolName('list_threads', known), 'mcp__threadbear__list_threads');
  assert.equal(protocolToolName('read', known), 'read');
  assert.equal(effortNote('high', false)?.includes('effort'), true);
  assert.equal(effortNote('high', true), undefined);
  assert.equal(effortNote(undefined, false), undefined);
  assert.deepEqual(commandsOf([{ name: 'compact', description: 'Shorter' }]), [{ name: 'compact', description: 'Shorter', source: 'cli' }]);
});
