// One small-model call on an OpenCode login: `opencode run` with a model
// id, for Librarian classify/extract/summarize jobs on the OpenCode pool.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ModelChoice } from '../protocol.ts';
import type { CliResponse } from './claude-pool.ts';
import { stripModelSuffix } from '../accounts.ts';

export type OpenCodeCall = {
  bin: string;
  model: string;
  system?: string;
  user: string;
  jsonSchema?: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
  registry?: { add(pid: number, command: string): void; remove(pid: number): void };
};

const LIMIT = /usage limit|rate limit/i;

export function openCodePrompt(system: string | undefined, user: string, jsonSchema?: Record<string, unknown>): string {
  const head = system?.trim();
  const schema = jsonSchema ? `Reply with JSON only, matching this schema:\n${JSON.stringify(jsonSchema)}` : '';
  return [head, schema, user].filter(Boolean).join('\n\n');
}

export function openCodeCliModelId(id: string): string {
  return stripModelSuffix(id.trim());
}

export function pickOpenCodeSmallModel(models: ModelChoice[], chosen?: string): string {
  if (chosen?.trim()) return openCodeCliModelId(chosen);
  const rows = models.length ? models : [{ id: 'opencode/beam-free', model: 'opencode/beam-free', title: 'Beam Free' }];
  const score = (m: ModelChoice) => {
    const s = `${m.id} ${m.title}`.toLowerCase();
    if (/flash|mini|beam|small/i.test(s)) return 0;
    if (/free/i.test(s)) return 1;
    return 5;
  };
  return [...rows].sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))[0]!.id;
}

export function readOpenCodeReply(stdout: string, stderr: string, code: number | null): CliResponse {
  // `--format json` prints one event per line; the reply is the text parts.
  let text = '';
  let errMsg = '';
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; part?: { text?: string }; error?: { data?: { message?: string }; name?: string } };
      if (ev.type === 'text' && ev.part?.text) text += ev.part.text;
      else if (ev.type === 'error') errMsg = ev.error?.data?.message ?? ev.error?.name ?? 'error';
    } catch {
      // not an event
    }
  }
  text = text.trim();
  if (text && code === 0) return { ok: true, text };
  const why = (errMsg || stderr.trim() || stdout.trim()).split('\n').pop()?.slice(0, 200);
  return { ok: false, timedOut: false, limit: LIMIT.test(`${stderr}\n${stdout}`), message: why ? `opencode: ${why}` : `opencode exited ${code ?? 'on a signal'} with no answer` };
}

export function askOpenCode(req: OpenCodeCall): Promise<CliResponse> {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(req.cwd, { recursive: true });
    } catch {
      // spawn says so below
    }
    const prompt = openCodePrompt(req.system, req.user, req.jsonSchema);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(req.bin, ['run', '-m', openCodeCliModelId(req.model), '--format', 'json', prompt], { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ ok: false, timedOut: false, limit: false, message: `Couldn't start OpenCode: ${(e as Error).message}` });
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
    child.on('error', (e) => finish({ ok: false, timedOut: false, limit: false, message: `Couldn't start OpenCode: ${e.message}` }));
    child.on('close', (code) => {
      if (timedOut) return finish({ ok: false, timedOut: true, limit: false, message: `Timed out after ${Math.round(req.timeoutMs / 1000)} s` });
      finish(readOpenCodeReply(out, err, code));
    });
  });
}
