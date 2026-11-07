// OpenCode-only paths: model listing, missing CLI banner, shared ACP tool names, usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { modelsFromSessionConfig, parseOpenCodeAuthList, parseOpenCodeModels } from '../../src/adapters/opencode/cli.ts';
import { CursorNormalizer, cursorToolIdentity, usageFrom } from '../../src/adapters/cursor/normalize.ts';
import { fileContext } from '../../src/adapters/context.ts';
import type { AdapterOutput } from '../../src/adapters/types.ts';
import { missingCliBanner } from '../../src/runner.ts';
import { pickOpenCodeSmallModel, openCodePrompt } from '../../src/models/opencode-pool.ts';
import { tmpDir } from '../helpers/fakes.ts';

const SAMPLE = `opencode/beam-free
opencode/big-pickle
opencode/deepseek-v4.1-flash-free
`;

test('opencode models lines become a menu', () => {
  const listed = parseOpenCodeModels(SAMPLE);
  assert.ok(listed.models.length >= 3);
  assert.ok(listed.models.some((m) => m.id === 'opencode/beam-free'));
  assert.ok(listed.defaultModel);
});

test('session configOptions become a model menu', () => {
  const listed = modelsFromSessionConfig([
    {
      id: 'model',
      currentValue: 'opencode/big-pickle',
      options: [
        { value: 'opencode/beam-free', name: 'OpenCode/Beam Free' },
        { value: 'opencode/big-pickle', name: 'OpenCode/Big Pickle' },
      ],
    },
  ]);
  assert.equal(listed.defaultModel, 'opencode/big-pickle');
  assert.deepEqual(
    listed.models.map((m) => m.id),
    ['opencode/beam-free', 'opencode/big-pickle'],
  );
});

test('auth list reports credential count without reading tokens', () => {
  const status = parseOpenCodeAuthList('0 credentials\n');
  assert.equal(status.loggedIn, true);
  assert.equal(status.credentialCount, 0);
});

test('a missing CLI is a banner only when that provider is in use, or nothing is', () => {
  const opencode = [{ provider: 'opencode' as const }];
  const claude = [{ provider: 'claude' as const }];
  assert.equal(missingCliBanner('claude', opencode), false);
  assert.equal(missingCliBanner('opencode', opencode), true);
  assert.equal(missingCliBanner('opencode', claude), false);
});

test('a small job picks a fast OpenCode model', () => {
  const models = [
    { id: 'opencode/big-pickle', model: 'opencode/big-pickle', title: 'Big Pickle' },
    { id: 'opencode/deepseek-v4.1-flash-free', model: 'opencode/deepseek-v4.1-flash-free', title: 'Flash' },
  ];
  assert.equal(pickOpenCodeSmallModel(models), 'opencode/deepseek-v4.1-flash-free');
  assert.equal(pickOpenCodeSmallModel(models, 'opencode/beam-free'), 'opencode/beam-free');
  assert.match(openCodePrompt('Say a title', 'the thread', { type: 'object' }), /JSON only/);
});

test('ACP tool rows still get proper names', () => {
  const root = tmpDir('tb-opencode-live-');
  const known = new Set(['end_turn', 'list_threads']);
  const read = cursorToolIdentity({ title: 'Read README', kind: 'read', rawInput: { path: 'README' } }, known, root);
  assert.equal(read.name, 'Read');
  const end = cursorToolIdentity({ title: 'end_turn', kind: 'other', rawInput: { summary: 'Done', needs: 'nothing' } }, known, root);
  assert.equal(end.name, 'mcp__threadbear__end_turn');
  const n = new CursorNormalizer(fileContext(path.join(root, 'proj'), root, root), { threadbearTools: ['end_turn'] });
  n.begin('t');
  const outs = n.handleUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Read README',
    kind: 'read',
    status: 'completed',
    rawInput: { path: 'README' },
    content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
  });
  const call = outs.find((o) => o.kind === 'event' && o.event.type === 'tool.call') as Extract<AdapterOutput, { kind: 'event' }>;
  assert.equal(call.event.type === 'tool.call' && call.event.name, 'Read');
});

test('usage is recorded only when the CLI sends it', () => {
  assert.deepEqual(usageFrom({ stopReason: 'end_turn' }), {});
  assert.deepEqual(usageFrom({ stopReason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4, total_cost_usd: 0.01 } }), {
    usage: { inputTokens: 3, outputTokens: 4 },
    costUsd: 0.01,
  });
});
