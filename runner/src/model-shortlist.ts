// A pool's model shortlist. runner.json `models.shortlist` maps a pool id to
// the model ids its menu shows, in that order. No entry, or an empty list,
// shows every model the CLI offers. Only the copy of the account list that
// goes to clients is filtered (Runner.reportedAccounts); the stored list
// stays whole, so small jobs and the librarian pick from all of it.
import type { Account, ModelChoice, Pool } from './protocol.ts';

export type Shortlists = Record<string, string[]>;

// One list of ids: trimmed, blanks and repeats dropped, order kept.
export function cleanIds(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: string[] = [];
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// runner.json models.shortlist. Entries that aren't a list of strings are
// ignored (and named in `error`), so a typo shows the full menu rather than
// stopping the runner. An empty list is the same as no entry.
export function parseShortlists(raw: unknown): { shortlists?: Shortlists; error?: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'models.shortlist must map a pool id to a list of model ids' };
  const shortlists: Shortlists = {};
  const bad: string[] = [];
  for (const [key, list] of Object.entries(raw)) {
    const pool = key.trim();
    const ids = cleanIds(list);
    if (!pool) continue;
    if (!ids) bad.push(pool);
    else if (ids.length) shortlists[pool] = ids;
  }
  return {
    ...(Object.keys(shortlists).length ? { shortlists } : {}),
    ...(bad.length ? { error: `models.shortlist: ${bad.join(', ')} must be a list of model ids` } : {}),
  };
}

// The shortlisted models of `offered`, in the order of `shortlist`, then the
// `keep` ids (a thread's model, the default) that the shortlist left out.
// Ids the CLI doesn't offer are skipped. Nothing left means no shortlist
// applies: a list that matches nothing must not empty the menu.
export function shortlistModels(offered: readonly ModelChoice[], shortlist: readonly string[], keep: readonly string[] = []): ModelChoice[] {
  if (!shortlist.length) return [...offered];
  const byId = new Map<string, ModelChoice>();
  for (const m of offered) {
    if (!byId.has(m.id)) byId.set(m.id, m);
    if (!byId.has(m.model)) byId.set(m.model, m);
  }
  const out: ModelChoice[] = [];
  const add = (id: string) => {
    const m = byId.get(id);
    if (m && !out.includes(m)) out.push(m);
  };
  shortlist.forEach(add);
  if (!out.length) return [...offered];
  keep.forEach(add);
  return out;
}

// The account list as clients see it. An account takes the shortlists of the
// pools it is in, joined in pool order (a pool with no shortlist adds nothing
// and takes nothing away), so a login in two pools shows both pools' picks.
// Accounts in no shortlisted pool come back as the same objects.
export function reportedAccounts(
  accounts: Account[],
  opts: {
    pools: Pool[];
    shortlists?: Shortlists;
    keep: (account: Account) => readonly string[];
    onSkipped?: (poolId: string, ids: string[]) => void;
  },
): Account[] {
  const { pools, shortlists } = opts;
  if (!shortlists) return accounts;
  const listed = pools.filter((p) => shortlists[p.id]?.length);
  if (!listed.length) return accounts;
  for (const pool of listed) {
    const ids = new Set(accounts.filter((a) => pool.accountIds.includes(a.id)).flatMap((a) => a.models ?? []).flatMap((m) => [m.id, m.model]));
    const gone = ids.size ? shortlists[pool.id]!.filter((id) => !ids.has(id)) : [];
    if (gone.length) opts.onSkipped?.(pool.id, gone);
  }
  return accounts.map((account) => {
    if (!account.models?.length) return account;
    const wanted = listed.filter((p) => p.accountIds.includes(account.id)).flatMap((p) => shortlists[p.id]!);
    if (!wanted.length) return account;
    const models = shortlistModels(account.models, wanted, opts.keep(account));
    return models.length === account.models.length && models.every((m, i) => m === account.models![i]) ? account : { ...account, models };
  });
}
