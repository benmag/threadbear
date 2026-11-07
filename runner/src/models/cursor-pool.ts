// One small-model call on a Cursor login: `agent -p` in ask mode, so it
// answers and does not edit. Used when the small-jobs pool has a Cursor
// login and no Claude one (or the pool is Cursor's). The prompt is the
// argument; there is no separate system-prompt flag on this CLI.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ModelChoice } from '../protocol.ts';
import type { CliResponse } from './claude-pool.ts';

export type CursorCall = {
  bin: string;
  model: string;
  system?: string;
  user: string;
  // This CLI has no --json-schema. The schema is written into the prompt
  // so classify and extract still come back as JSON.
  jsonSchema?: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  registry?: { add(pid: number, command: string): void; remove(pid: number): void };
};

const LIMIT = /usage limit|rate limit/i;

export function cursorCallArgs(model: string, prompt: string): string[] {
  return ['-p', '--trust', '--mode', 'ask', '--output-format', 'text', '--model', model, prompt];
}

export function cursorPrompt(system: string | undefined, user: string, jsonSchema?: Record<string, unknown>): string {
  const head = system?.trim();
  const schema = jsonSchema ? `Reply with JSON only, matching this schema:\n${JSON.stringify(jsonSchema)}` : '';
  return [head, schema, user].filter(Boolean).join('\n\n');
}

// A fast model from `agent models`: one whose id or title says fast, flash,
// mini or haiku, else Composer, else Auto. Opus, Codex and thinking models
// are last. `chosen` (runner.json models.cursorModel) wins when set.
export function pickCursorSmallModel(models: ModelChoice[], chosen?: string): string {
  if (chosen?.trim()) return chosen.trim();
  const rows = models.length ? models : [{ id: 'auto', model: 'auto', title: 'Auto' }];
  const score = (m: ModelChoice) => {
    const s = `${m.id} ${m.title}`.toLowerCase();
    if (/fast|flash|mini|haiku/.test(s)) return 0;
    if (/composer/.test(s)) return 1;
    if (m.id === 'auto') return 2;
    if (/opus|thinking|codex|gpt-/.test(s)) return 9;
    return 5;
  };
  return [...rows].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0]!.id;
}

export function readCursorReply(stdout: string, stderr: string, code: number | null): CliResponse {
  const text = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (text && code === 0) return { ok: true, text };
  const why = (stderr.trim() || text).split('\n').pop()?.slice(0, 200);
  return { ok: false, timedOut: false, limit: LIMIT.test(`${stderr}\n${stdout}`), message: why ? `cursor: ${why}` : `cursor exited ${code ?? 'on a signal'} with no answer` };
}

export function askCursor(req: CursorCall): Promise<CliResponse> {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(req.cwd, { recursive: true });
    } catch {
      // spawn says so below
    }
    const prompt = cursorPrompt(req.system, req.user, req.jsonSchema);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(req.bin, cursorCallArgs(req.model, prompt), { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ ok: false, timedOut: false, limit: false, message: `Couldn't start the Cursor CLI: ${(e as Error).message}` });
      return;
    }
    const pid = child.pid;
    if (pid) req.registry?.add(pid, req.bin);
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out += d));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    }, req.timeoutMs);
    timer.unref?.();
    const finish = (r: CliResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pid) req.registry?.remove(pid);
      resolve(r);
    };
    child.on('error', (e) => finish({ ok: false, timedOut: false, limit: false, message: `Couldn't start the Cursor CLI: ${e.message}` }));
    child.on('close', (code) => {
      if (timedOut) return finish({ ok: false, timedOut: true, limit: false, message: `Timed out after ${Math.round(req.timeoutMs / 1000)} s` });
      finish(readCursorReply(out, err, code));
    });
  });
}
