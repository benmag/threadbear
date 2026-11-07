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

function stripCliText(text: string): string {
  return text.replace(ANSI, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

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

// The CLI's stand-in for "whatever you have selected" shows up as `default`
// or `default[]` on an ACP session. The models command calls that same
// choice `auto` ("Auto"). One id, so the menu doesn't read "default[]".
export function canonicalCursorModel(id: string): string {
  const bare = id.trim();
  if (!bare || /^default(?:\[[^\]]*\])?$/i.test(bare)) return 'auto';
  return bare;
}

export function cursorModelTitle(id: string, title?: string): string {
  const canon = canonicalCursorModel(id);
  const named = title?.trim();
  if (canon === 'auto' && (!named || named === id || /^default(?:\[[^\]]*\])?$/i.test(named) || /^auto$/i.test(named))) return 'Auto';
  return named || canon;
}

// `agent models` prints one line per model: "<id> - <name> (current, default)",
// under an "Available models" header, then a "Tip:" line. Colours and a
// leading tick are stripped. Also accepts the JSON list an ACP session/new
// `models` field holds ({ modelId, name } or { id, name }).
export function parseCursorModels(stdout: string): { models: ModelChoice[]; defaultModel?: string } {
  const text = stripCliText(stdout).trim();
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
    const line = raw.replace(/^[\s*•✓✔\-–—]+/, '').trim();
    if (!line || /^available models$/i.test(line) || /^tip:/i.test(line) || /^no models/i.test(line)) continue;
    const split = line.split(/\s+[-–—]\s+/);
    const idPart = split[0]?.trim() ?? '';
    if (!idPart || /\s/.test(idPart)) continue;
    const rest = split.slice(1).join(' - ').trim();
    const flagged = /^(.*?)(?:\s+\(([^)]*)\))?$/.exec(rest);
    const title = cursorModelTitle(idPart, (flagged?.[1] ?? '').trim() || undefined);
    const id = canonicalCursorModel(idPart);
    if (models.some((m) => m.id === id)) continue;
    models.push({ id, model: id, title });
    const flags = flagged?.[2] ?? '';
    if (/\bdefault\b/i.test(flags) || id === 'auto') defaultModel = defaultModel ?? id;
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
  const currentRaw =
    typeof (root.models as { currentModelId?: unknown } | undefined)?.currentModelId === 'string'
      ? (root.models as { currentModelId: string }).currentModelId
      : typeof root.currentModelId === 'string'
        ? root.currentModelId
        : undefined;
  const current = currentRaw ? canonicalCursorModel(currentRaw) : undefined;
  const models: ModelChoice[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const rawId = stringOf(r.modelId) || stringOf(r.id) || stringOf(r.displayModelId) || stringOf(r.value);
    if (!rawId) continue;
    const id = canonicalCursorModel(rawId);
    if (models.some((m) => m.id === id)) continue;
    const title = cursorModelTitle(id, stringOf(r.name) || stringOf(r.displayName) || stringOf(r.title));
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
  // A login prints the list on stdout. Some failures still print it and
  // exit non-zero; either stream counts when it has model lines.
  const fromCommand = parseCursorModels(`${listed.stdout}\n${listed.stderr}`);
  if (fromCommand.models.length) return fromCommand;
  const flag = await runCursor(bin, ['--list-models'], 30_000);
  return parseCursorModels(`${flag.stdout}\n${flag.stderr}`);
}
