// Finding the OpenCode CLI and reading what it prints without a session.
// A thread itself is an ACP session (`opencode acp`), not `opencode run`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelChoice } from '../../protocol.ts';
import { VERSION_RE } from '../../updates/exec.ts';

const ANSI = /\u001b\[[0-9;]*m/g;

function stripCliText(text: string): string {
  return text.replace(ANSI, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

export type OpenCodeBinaryOptions = {
  explicit?: string;
  home?: string;
  pathEnv?: string;
};

// ~/.opencode/bin/opencode, then ~/.local/bin/opencode, then PATH.
export function findOpenCodeBinary(o: OpenCodeBinaryOptions = {}): string | undefined {
  if (o.explicit && fs.existsSync(o.explicit)) return o.explicit;
  const home = o.home ?? os.homedir();
  for (const candidate of [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return which('opencode', o.pathEnv ?? process.env.PATH ?? '');
}

function which(name: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next dir
    }
  }
  return undefined;
}

export type OpenCodeStatus = { loggedIn: boolean; email?: string; credentialCount: number };

// `opencode auth list` prints how many credentials are in auth.json. The
// CLI still runs with built-in free models when that count is zero.
export function parseOpenCodeAuthList(stdout: string): OpenCodeStatus {
  const text = stripCliText(stdout);
  const count = Number(text.match(/(\d+)\s+credentials?/i)?.[1] ?? '0');
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  return { loggedIn: true, credentialCount: Number.isFinite(count) ? count : 0, ...(email ? { email } : {}) };
}

// One line per model: "provider/model-id" from `opencode models`.
export function parseOpenCodeModels(stdout: string): { models: ModelChoice[]; defaultModel?: string } {
  const text = stripCliText(stdout).trim();
  if (!text) return { models: [] };
  const models: ModelChoice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const id = raw.replace(/^[\s*•✓✔\-–—]+/, '').trim();
    if (!id || /^opencode\s+models/i.test(id) || /^tip:/i.test(id)) continue;
    if (models.some((m) => m.id === id)) continue;
    const title = id.includes('/') ? id.split('/').slice(1).join('/').replace(/-/g, ' ') : id;
    const named = title.replace(/\b\w/g, (c) => c.toUpperCase());
    models.push({ id, model: id, title: `${id.split('/')[0] ?? 'model'}/${named}` });
  }
  if (models.length) {
    const flash = models.find((m) => /flash|mini|beam/i.test(m.id));
    return { models, defaultModel: flash?.id ?? models[0]!.id };
  }
  return { models: [] };
}

type Any = Record<string, unknown>;

// session/new's configOptions: model select with { value, name } rows.
export function modelsFromSessionConfig(configOptions: unknown): { models: ModelChoice[]; defaultModel?: string } {
  if (!Array.isArray(configOptions)) return { models: [] };
  const modelOption = configOptions.find((row) => row && typeof row === 'object' && (row as Any).id === 'model') as Any | undefined;
  if (!modelOption) return { models: [] };
  const options = Array.isArray(modelOption.options) ? modelOption.options : [];
  const models: ModelChoice[] = [];
  for (const row of options) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Any;
    const id = stringOf(r.value) || stringOf(r.name);
    if (!id || models.some((m) => m.id === id)) continue;
    const title = stringOf(r.name) || id;
    models.push({ id, model: id, title });
  }
  const current = stringOf(modelOption.currentValue);
  return { models, ...(current ? { defaultModel: current } : {}) };
}

function stringOf(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

export function versionFromOpenCodePath(bin: string): string | undefined {
  const parts = bin.split(path.sep);
  for (const part of parts) if (VERSION_RE.test(part)) return part;
  return undefined;
}

export type CommandResult = { code: number; stdout: string; stderr: string };

export function runOpenCode(bin: string, args: string[], timeoutMs = 20_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export async function openCodeVersion(bin: string): Promise<string | undefined> {
  const fromPath = versionFromOpenCodePath(bin);
  if (fromPath) return fromPath;
  const r = await runOpenCode(bin, ['--version'], 10_000);
  if (r.code !== 0) return undefined;
  return (r.stdout + r.stderr).match(VERSION_RE)?.[0];
}

export async function openCodeStatus(bin: string): Promise<OpenCodeStatus | null> {
  const r = await runOpenCode(bin, ['auth', 'list'], 15_000);
  if (r.code !== 0 && !r.stdout.trim()) return null;
  return parseOpenCodeAuthList(`${r.stdout}\n${r.stderr}`);
}

export async function openCodeModels(bin: string): Promise<{ models: ModelChoice[]; defaultModel?: string }> {
  const listed = await runOpenCode(bin, ['models'], 30_000);
  return parseOpenCodeModels(`${listed.stdout}\n${listed.stderr}`);
}
