// Finding the Cursor CLI and reading what it prints without a session.
// `agent` and `cursor-agent` are the same binary (the installer links both
// into ~/.local/bin). Login and the model list are separate short commands;
// a thread itself is an ACP session (acp.ts), not `agent -p`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelChoice } from '../../protocol.ts';
import { VERSION_RE } from '../../updates/exec.ts';

const ANSI = /\u001b\[[0-9;]*m/g;

export type CursorBinaryOptions = {
  // runner.json `cursorPath` or THREADBEAR_CURSOR_PATH, used as given.
  explicit?: string;
  home?: string;
  pathEnv?: string;
};

// ~/.local/bin/cursor-agent, then ~/.local/bin/agent, then PATH. A PATH
// `agent` counts only when it is the Cursor one (the name cursor-agent, or
// the file mentions Cursor): other tools install a bare `agent` too.
export function findCursorBinary(o: CursorBinaryOptions = {}): string | undefined {
  if (o.explicit && fs.existsSync(o.explicit)) return o.explicit;
  const home = o.home ?? os.homedir();
  const localAgent = path.join(home, '.local', 'bin', 'cursor-agent');
  const localAlias = path.join(home, '.local', 'bin', 'agent');
  if (fs.existsSync(localAgent)) return localAgent;
  if (fs.existsSync(localAlias) && looksLikeCursor(localAlias)) return localAlias;
  const pathEnv = o.pathEnv ?? process.env.PATH ?? '';
  const onPath = which('cursor-agent', pathEnv);
  if (onPath) return onPath;
  const alias = which('agent', pathEnv);
  if (alias && looksLikeCursor(alias)) return alias;
  return undefined;
}

function looksLikeCursor(bin: string): boolean {
  try {
    const real = fs.realpathSync(bin);
    if (real.includes(`${path.sep}cursor-agent${path.sep}`) || path.basename(real) === 'cursor-agent') return true;
    const head = fs.readFileSync(bin).subarray(0, 800).toString('utf8');
    return /cursor/i.test(head);
  } catch {
    return false;
  }
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

export type CursorStatus = { loggedIn: boolean; email?: string };

// `cursor-agent status` (this build, not logged in, exits 0): "Not logged in".
// A logged-in line names the account; the email is taken from it when present.
export function parseCursorStatus(stdout: string, code = 0): CursorStatus {
  const text = stdout.replace(ANSI, '').trim();
  if (/not logged in|logged out/i.test(text)) return { loggedIn: false };
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (/logged in/i.test(text) || email) return { loggedIn: true, ...(email ? { email } : {}) };
  if (code === 0 && text && !/authentication required|error|fail/i.test(text)) return { loggedIn: true, ...(email ? { email } : {}) };
  return { loggedIn: false };
}

// `agent models` prints one line per model: "<id> - <name> (current, default)".
// Colours are stripped. Also accepts a JSON list ({ models } or an array of
// { modelId, name }), which is what an ACP session/new `models` field holds.
// The text shape is from this build's models command; it was not run here
// (it exits asking for a login).
export function parseCursorModels(stdout: string): { models: ModelChoice[]; defaultModel?: string } {
  const text = stdout.replace(ANSI, '').trim();
  if (!text) return { models: [] };
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return modelsFromJson(JSON.parse(text));
    } catch {
      return { models: [] };
    }
  }
  const models: ModelChoice[] = [];
  let defaultModel: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^available models$/i.test(line) || /^tip:/i.test(line) || /^no models/i.test(line)) continue;
    const m = /^(\S+)(?:\s+-\s+(.*?))?(?:\s+\(([^)]*)\))?$/.exec(line);
    if (!m) continue;
    const id = m[1];
    if (!id || id.startsWith('-')) continue;
    const title = (m[2] ?? '').trim() || id;
    models.push({ id, model: id, title });
    const flags = m[3] ?? '';
    if (/\bdefault\b/i.test(flags)) defaultModel = id;
  }
  return { models, ...(defaultModel ? { defaultModel } : {}) };
}

function modelsFromJson(value: unknown): { models: ModelChoice[]; defaultModel?: string } {
  const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const list = Array.isArray(value)
    ? value
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray((root.models as { availableModels?: unknown } | undefined)?.availableModels)
        ? (root.models as { availableModels: unknown[] }).availableModels
        : Array.isArray(root.availableModels)
          ? root.availableModels
          : [];
  const current =
    typeof (root.models as { currentModelId?: unknown } | undefined)?.currentModelId === 'string'
      ? (root.models as { currentModelId: string }).currentModelId
      : typeof root.currentModelId === 'string'
        ? root.currentModelId
        : undefined;
  const models: ModelChoice[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = stringOf(r.modelId) || stringOf(r.id) || stringOf(r.displayModelId);
    if (!id) continue;
    const title = stringOf(r.name) || stringOf(r.displayName) || id;
    models.push({ id, model: id, title });
  }
  return { models, ...(current ? { defaultModel: current } : {}) };
}

function stringOf(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

export function versionFromCursorPath(bin: string): string | undefined {
  try {
    const real = fs.realpathSync(bin);
    const parts = real.split(path.sep);
    for (const part of parts) if (VERSION_RE.test(part)) return part;
  } catch {
    // missing, or not a link we can read
  }
  return undefined;
}

export type CommandResult = { code: number; stdout: string; stderr: string };

export function runCursor(bin: string, args: string[], timeoutMs = 20_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export async function cursorVersion(bin: string): Promise<string | undefined> {
  const fromPath = versionFromCursorPath(bin);
  if (fromPath) return fromPath;
  const r = await runCursor(bin, ['--version'], 10_000);
  if (r.code !== 0) return undefined;
  return (r.stdout + r.stderr).match(VERSION_RE)?.[0];
}

export async function cursorStatus(bin: string): Promise<CursorStatus> {
  const r = await runCursor(bin, ['status'], 15_000);
  return parseCursorStatus(`${r.stdout}\n${r.stderr}`, r.code);
}

export async function cursorModels(bin: string): Promise<{ models: ModelChoice[]; defaultModel?: string }> {
  const listed = await runCursor(bin, ['models'], 30_000);
  const fromCommand = parseCursorModels(listed.code === 0 ? listed.stdout : '');
  if (fromCommand.models.length) return fromCommand;
  const flag = await runCursor(bin, ['--list-models'], 30_000);
  return parseCursorModels(flag.code === 0 ? flag.stdout : '');
}
