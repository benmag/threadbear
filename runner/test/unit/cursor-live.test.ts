// The gaps a first Cursor-only thread showed: the model menu, a missing
// CLI banner, tool names with no `name`, and usage only when the CLI sends it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { canonicalCursorModel, parseCursorModels } from '../../src/adapters/cursor/cli.ts';
import { CursorNormalizer, cursorToolIdentity, usageFrom } from '../../src/adapters/cursor/normalize.ts';
import { fileContext } from '../../src/adapters/context.ts';
import type { AdapterOutput } from '../../src/adapters/types.ts';
import { missingCliBanner } from '../../src/runner.ts';
import { pickCursorSmallModel, cursorCallArgs, cursorPrompt } from '../../src/models/cursor-pool.ts';
import { tmpDir } from '../helpers/fakes.ts';

const SAMPLE = `
Available models
auto - Auto (current, default)
gpt-5.3-codex - Codex 5.3
composer-2.5 - Composer 2.5
claude-opus-5-thinking-high - Claude Opus 5 1M Thinking
Tip: switch with /model
`;

test('agent models lines become a menu, and default[] is Auto', () => {
  const listed = parseCursorModels(SAMPLE);
  assert.equal(listed.defaultModel, 'auto');
  assert.deepEqual(
    listed.models.map((m) => [m.id, m.title]),
    [
      ['auto', 'Auto'],
      ['gpt-5.3-codex', 'Codex 5.3'],
      ['composer-2.5', 'Composer 2.5'],
      ['claude-opus-5-thinking-high', 'Claude Opus 5 1M Thinking'],
    ],
  );
  assert.equal(canonicalCursorModel('default[]'), 'auto');
  assert.equal(canonicalCursorModel('default'), 'auto');
  const fromSession = parseCursorModels(
    JSON.stringify({
      models: {
        currentModelId: 'default[]',
        availableModels: [
          { modelId: 'default[]', name: 'default[]' },
          { modelId: 'composer-2.5', name: 'Composer 2.5' },
        ],
      },
    }),
  );
  assert.equal(fromSession.defaultModel, 'auto');
  assert.deepEqual(
    fromSession.models.map((m) => [m.id, m.title]),
    [
      ['auto', 'Auto'],
      ['composer-2.5', 'Composer 2.5'],
    ],
  );
});

test('a missing CLI is a banner only when that provider is in use, or nothing is', () => {
  const cursor = [{ provider: 'cursor' as const }];
  const claude = [{ provider: 'claude' as const }];
  assert.equal(missingCliBanner('claude', cursor), false);
  assert.equal(missingCliBanner('codex', cursor), false);
  assert.equal(missingCliBanner('claude', claude), true);
  assert.equal(missingCliBanner('codex', claude), false);
  assert.equal(missingCliBanner('claude', []), true);
  assert.equal(missingCliBanner('codex', []), false);
  assert.equal(missingCliBanner('cursor', claude), false);
  assert.equal(missingCliBanner('cursor', cursor), true);
});

test('a small job picks a fast Cursor model, and runner.json can name one', () => {
  const models = [
    { id: 'gpt-5.3-codex', model: 'gpt-5.3-codex', title: 'Codex 5.3' },
    { id: 'composer-2.5', model: 'composer-2.5', title: 'Composer 2.5' },
    { id: 'composer-2.5-fast', model: 'composer-2.5-fast', title: 'Composer Fast' },
    { id: 'auto', model: 'auto', title: 'Auto' },
    { id: 'claude-opus-5-thinking-high', model: 'claude-opus-5-thinking-high', title: 'Claude Opus 5 1M Thinking' },
  ];
  assert.equal(pickCursorSmallModel(models), 'composer-2.5-fast');
  assert.equal(pickCursorSmallModel(models, 'composer-2.5'), 'composer-2.5');
  assert.equal(pickCursorSmallModel([]), 'auto');
  assert.deepEqual(cursorCallArgs('auto', 'Name it'), ['-p', '--trust', '--mode', 'ask', '--output-format', 'text', '--model', 'auto', 'Name it']);
  assert.match(cursorPrompt('Say a title', 'the thread', { type: 'object' }), /JSON only/);
});

test('a Cursor tool call with no name is not called tool', () => {
  const root = tmpDir('tb-cursor-live-');
  const known = new Set(['end_turn', 'list_threads']);
  const read = cursorToolIdentity({ title: 'Read README', kind: 'read', rawInput: { path: 'README' } }, known, root);
  assert.equal(read.name, 'Read');
  assert.equal(read.kind, 'read');
  assert.equal(read.title, 'Read README');
  const bash = cursorToolIdentity({ title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } }, known, root);
  assert.equal(bash.name, 'Bash');
  assert.notEqual(bash.name, 'tool');
  const end = cursorToolIdentity({ title: 'end_turn', kind: 'other', rawInput: { summary: 'Done', needs: 'nothing' } }, known, root);
  assert.equal(end.name, 'mcp__threadbear__end_turn');
  assert.equal(end.kind, 'mcp');

  const n = new CursorNormalizer(fileContext(path.join(root, 'proj'), root, root), { threadbearTools: ['end_turn'] });
  n.begin('t');
  const outs: AdapterOutput[] = [];
  outs.push(
    ...n.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read README',
      kind: 'read',
      status: 'completed',
      rawInput: { path: 'README' },
      content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
    }),
  );
  const call = outs.find((o) => o.kind === 'event' && o.event.type === 'tool.call') as Extract<AdapterOutput, { kind: 'event' }>;
  assert.equal(call.event.type === 'tool.call' && call.event.name, 'Read');
});

test('usage is recorded only when the CLI sends it', () => {
  assert.deepEqual(usageFrom({ stopReason: 'end_turn' }), {});
  assert.deepEqual(usageFrom({ stopReason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4, total_cost_usd: 0.01 } }), {
    usage: { inputTokens: 3, outputTokens: 4 },
    costUsd: 0.01,
  });
  const root = tmpDir('tb-cursor-live-');
  const bare = new CursorNormalizer(fileContext(root, root, root));
  bare.begin('t');
  const none = bare.finish({ stopReason: 'end_turn' }).find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.equal(none.result.usage, undefined);
  assert.equal(none.result.totalCostUsd, undefined);

  const withUse = new CursorNormalizer(fileContext(root, root, root));
  withUse.begin('t');
  const some = withUse.finish({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 9, outputTokens: 2 } } }).find((o) => o.kind === 'result') as Extract<AdapterOutput, { kind: 'result' }>;
  assert.deepEqual(some.result.usage, { inputTokens: 9, outputTokens: 2 });
});
