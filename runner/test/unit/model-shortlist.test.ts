// Pool model shortlists: the menu clients see is cut to a pool's shortlist,
// while the stored list (small jobs, the librarian) stays whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, loadConfig } from '../../src/config.ts';
import { cleanIds, parseShortlists, reportedAccounts, shortlistModels } from '../../src/model-shortlist.ts';
import { pickCursorSmallModel } from '../../src/models/cursor-pool.ts';
import { ErrorCode, type Account, type ModelChoice, type Pool, type RpcError } from '../../src/protocol.ts';
import { SettingsService, settingsMethods } from '../../src/settings.ts';
import { ACCOUNTS, FakeAccounts, FakeAdapter, makeHarness, tmpDir } from '../helpers/fakes.ts';

const m = (id: string, model = id): ModelChoice => ({ id, model, title: id });
const ids = (list: ModelChoice[] | undefined) => (list ?? []).map((x) => x.id);

const offered = [m('opus'), m('haiku'), m('sonnet'), m('fable')];

test('shortlistModels: no list shows everything, in the CLI order', () => {
  assert.deepEqual(shortlistModels(offered, []), offered);
});

test('shortlistModels: the listed ids in the order given, skipping ids the CLI no longer offers', () => {
  assert.deepEqual(ids(shortlistModels(offered, ['sonnet', 'gone', 'opus', 'sonnet'])), ['sonnet', 'opus']);
});

test('shortlistModels: matches the full id too', () => {
  assert.deepEqual(ids(shortlistModels([m('opus', 'claude-opus-5-5'), m('haiku')], ['claude-opus-5-5'])), ['opus']);
});

test('shortlistModels: the current and default models stay, after the listed ones, once each', () => {
  assert.deepEqual(ids(shortlistModels(offered, ['haiku', 'sonnet'], ['fable', 'haiku', 'opus', 'nope'])), ['haiku', 'sonnet', 'fable', 'opus']);
});

test('shortlistModels: a list that matches nothing leaves the menu whole', () => {
  assert.deepEqual(shortlistModels(offered, ['gone'], ['opus']), offered);
});

test('parseShortlists: reads pool ids to id lists, drops blanks and repeats, names what it ignored', () => {
  assert.deepEqual(cleanIds([' a ', '', 'b', 'a', 3]), ['a', 'b']);
  assert.equal(cleanIds('a'), undefined);
  const r = parseShortlists({ cursor: [' auto ', 'auto', 'composer-2.5'], claude: [], ' ': ['x'], codex: 'gpt' });
  assert.deepEqual(r.shortlists, { cursor: ['auto', 'composer-2.5'] });
  assert.equal(r.error, 'models.shortlist: codex must be a list of model ids');
  assert.match(parseShortlists(['x']).error ?? '', /must map a pool id/);
  assert.deepEqual(parseShortlists(undefined), {});
  assert.deepEqual(parseShortlists({}), {});
});

const cursor: Account = { id: 'cursor-main', provider: 'cursor', title: 'Cursor', configDir: '/c', defaultModel: 'auto', models: [m('gpt-sol'), m('mini'), m('composer'), m('auto')] };
const claude: Account = { ...ACCOUNTS[0]!, models: offered };
const pools: Pool[] = [
  { id: 'cursor', title: 'Cursor', accountIds: ['cursor-main'] },
  { id: 'work', title: 'Work', accountIds: ['claude-main', 'cursor-main'] },
  { id: 'plain', title: 'Plain', accountIds: ['claude-main'] },
];

test('reportedAccounts: only accounts in a shortlisted pool change, and the stored lists are untouched', () => {
  const accounts = [claude, cursor];
  assert.equal(reportedAccounts(accounts, { pools, keep: () => [] }), accounts);
  assert.equal(reportedAccounts(accounts, { pools, shortlists: { plain: [] }, keep: () => [] }), accounts);
  const skipped: [string, string[]][] = [];
  const out = reportedAccounts(accounts, {
    pools,
    shortlists: { cursor: ['composer', 'missing', 'gpt-sol'] },
    keep: (a) => [a.defaultModel ?? ''],
    onSkipped: (pool, gone) => skipped.push([pool, gone]),
  });
  assert.equal(out[0], claude);
  assert.deepEqual(ids(out[1]!.models), ['composer', 'gpt-sol', 'auto']);
  assert.deepEqual(ids(cursor.models), ['gpt-sol', 'mini', 'composer', 'auto']);
  assert.deepEqual(skipped, [['cursor', ['missing']]]);
});

test('reportedAccounts: a login in two shortlisted pools shows both pools picks, and a mixed pool is not noise', () => {
  const skipped: string[][] = [];
  const out = reportedAccounts([claude, cursor], {
    pools,
    shortlists: { cursor: ['mini'], work: ['sonnet', 'composer'] },
    keep: () => [],
    onSkipped: (_p, gone) => skipped.push(gone),
  });
  assert.deepEqual(ids(out[0]!.models), ['sonnet']);
  assert.deepEqual(ids(out[1]!.models), ['mini', 'composer']);
  assert.deepEqual(skipped, []);
});

function setup(extra: { shortlist?: Record<string, string[]> } = {}) {
  const home = tmpDir();
  ensureHome(home);
  const cfg = { pools: [{ id: 'cur', title: 'Cursor', accountIds: ['cursor-main'] }], models: { pool: 'claude', privateFolders: [] as string[], ...(extra.shortlist ? { shortlist: extra.shortlist } : {}) } };
  const debug: Record<string, unknown>[] = [];
  const h = makeHarness(home, cfg, {
    accounts: new FakeAccounts([...ACCOUNTS, { id: 'cursor-main', provider: 'cursor', title: 'Cursor', configDir: '/c' }]),
    log: { info() {}, warn() {}, error() {}, debug: (_m, e) => void debug.push(e ?? {}) },
  });
  h.runner.adapters.cursor = new FakeAdapter('cursor');
  h.runner.learnAccount('cursor-main', { models: cursor.models!, defaultModel: 'auto' });
  const menu = () => ids(h.runner.hello().accounts.find((a) => a.id === 'cursor-main')?.models);
  const svc = new SettingsService({ config: h.cfg, publish: () => {}, poolIds: () => h.runner.listPools().pools.map((p) => p.id), menuChanged: () => h.runner.accountsChanged() });
  return { h, home, menu, debug, svc, methods: settingsMethods(svc) };
}

test('runner: with no shortlist every menu is whole, as before', () => {
  const s = setup();
  assert.deepEqual(s.menu(), ['gpt-sol', 'mini', 'composer', 'auto']);
  assert.equal(s.svc.get().models.shortlist, undefined);
});

test('runner: a shortlist cuts the menu, keeps threads models, and small jobs still see the full list', () => {
  const s = setup({ shortlist: { cur: ['composer', 'gpt-sol', 'gone'] } });
  assert.deepEqual(s.menu(), ['composer', 'gpt-sol', 'auto']);
  const full = s.h.runner.accounts.get('cursor-main')!.models!;
  assert.deepEqual(ids(full), ['gpt-sol', 'mini', 'composer', 'auto']);
  assert.equal(pickCursorSmallModel(full), 'mini');
  assert.equal(s.debug.filter((e) => e.poolId === 'cur').length, 1);
  s.h.runner.hello();
  s.h.runner.hello();
  assert.equal(s.debug.filter((e) => e.poolId === 'cur').length, 1, 'said once');

  s.h.runner.create({ text: 'hi', accountId: 'cursor-main', model: 'mini' });
  assert.deepEqual(s.menu(), ['composer', 'gpt-sol', 'auto', 'mini']);
  s.h.clock.advance(5_000);
  const sent = s.h.notes.filter((n) => n.method === 'accounts.updated');
  const last = sent.at(-1);
  assert.ok(last && last.method === 'accounts.updated');
  assert.deepEqual(ids(last.params.accounts.find((a) => a.id === 'cursor-main')?.models), ['composer', 'gpt-sol', 'auto', 'mini']);
});

test('settings: a pool shortlist saves to runner.json, applies at once, and tells clients', () => {
  const s = setup();
  const before = s.h.notes.length;
  const r = s.methods['settings.update']({ models: { shortlist: { cur: [' composer ', 'gpt-sol', 'composer'] } } }) as { settings: any };
  assert.deepEqual(r.settings.models.shortlist, { cur: ['composer', 'gpt-sol'] });
  assert.deepEqual(s.menu(), ['composer', 'gpt-sol', 'auto']);
  s.h.clock.advance(5_000);
  assert.ok(s.h.notes.slice(before).some((n) => n.method === 'accounts.updated'));
  const file = path.join(s.home, 'runner.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).models.shortlist, { cur: ['composer', 'gpt-sol'] });
  assert.deepEqual(loadConfig({ THREADBEAR_HOME: s.home }).models.shortlist, { cur: ['composer', 'gpt-sol'] });

  s.methods['settings.update']({ models: { privateFolders: [] } });
  assert.deepEqual(s.h.cfg.models.shortlist, { cur: ['composer', 'gpt-sol'] }, 'other model settings leave it be');

  s.methods['settings.update']({ models: { shortlist: { cur: [] } } });
  assert.equal(s.h.cfg.models.shortlist, undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).models.shortlist, undefined);
  assert.deepEqual(s.menu(), ['gpt-sol', 'mini', 'composer', 'auto'], 'empty means every model');
});

test('settings: a bad shortlist is refused and changes nothing', () => {
  const s = setup({ shortlist: { cur: ['auto'] } });
  for (const bad of [{ shortlist: ['x'] }, { shortlist: { cur: 'auto' } }, { shortlist: { cur: [1] } }, { shortlist: { nope: ['auto'] } }]) {
    assert.throws(() => s.methods['settings.update']({ models: bad }), (e: RpcError) => e.code === ErrorCode.badParams, JSON.stringify(bad));
  }
  assert.deepEqual(s.h.cfg.models.shortlist, { cur: ['auto'] });
});
