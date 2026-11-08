// Turns ACP `session/update` notifications into protocol events. Pure apart
// from the file helpers, so a recorded update stream can be replayed in tests.
// Shapes follow the Agent Client Protocol (sessionUpdate discriminator) and
// the updates this Cursor build sends (agent_message_chunk, tool_call,
// tool_call_update). usage_update is mapped when the agent actually sends
// one; a turn with none does not get a made-up token count.
import type { EffortLevel, EventBody, ImageRef, PlanEntry, ToolKind } from '../../protocol.ts';
import type { AdapterOutput, TurnResult } from '../types.ts';
import type { NormalizerContext } from '../context.ts';
import { truncateResultText } from '../context.ts';
import { diffLines } from '../../diff.ts';
import { toolKind, toolTitle } from '../../tools.ts';
import type { SlashCommand } from '../../slash-commands.ts';

type Any = Record<string, any>;

const TOOL_KIND: Record<string, ToolKind> = {
  read: 'read',
  edit: 'edit',
  delete: 'other',
  move: 'other',
  search: 'search',
  execute: 'command',
  think: 'other',
  fetch: 'web',
  switch_mode: 'other',
  other: 'other',
};

type OpenText = { itemId: string; kind: 'assistant.text' | 'reasoning'; text: string };
type OpenTool = { name: string; title: string; input: Record<string, unknown>; kind: ToolKind; emitted: boolean; live?: string };

export type CursorNormalizerOptions = {
  // Threadbear tool names, so a call of one is `mcp__threadbear__<name>`
  // (end_turn is how the runner closes a turn).
  threadbearTools?: Iterable<string>;
};

export class CursorNormalizer {
  private ctx: NormalizerContext;
  private tools: Set<string>;
  private n = 0;
  private texts = new Map<string, OpenText>();
  private open = new Map<string, OpenTool>();
  private commands: SlashCommand[] = [];
  private costUsd?: number;
  private turnUsage?: Record<string, number>;
  private errorKind?: TurnResult['errorKind'];
  private errorText?: string;
  private started = Date.now();
  private runnerId?: string;

  constructor(ctx: NormalizerContext, opts: CursorNormalizerOptions = {}) {
    this.ctx = ctx;
    this.tools = new Set(opts.threadbearTools ?? []);
  }

  // The runner message this prompt answers.
  begin(runnerId?: string): void {
    this.runnerId = runnerId;
    this.started = Date.now();
    this.texts.clear();
    this.errorKind = undefined;
    this.errorText = undefined;
  }

  slashCommands(): SlashCommand[] {
    return this.commands;
  }

  handleUpdate(update: Any): AdapterOutput[] {
    const out: AdapterOutput[] = [];
    const kind = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : '';
    switch (kind) {
      case 'user_message_chunk':
        break;
      case 'agent_message_chunk':
        this.chunk('assistant.text', update, out);
        break;
      case 'agent_thought_chunk':
        this.chunk('reasoning', update, out);
        break;
      case 'tool_call':
        this.flushTexts(out);
        this.tool(update, true, out);
        break;
      case 'tool_call_update':
        this.tool(update, false, out);
        break;
      case 'plan':
        this.plan(update, out);
        break;
      case 'available_commands_update':
        this.commands = commandsOf(update.availableCommands);
        break;
      case 'usage_update':
        this.usage(update, out);
        break;
      case 'session_info_update':
      case 'current_mode_update':
      case 'config_option_update':
        break;
      default:
        break;
    }
    return out;
  }

  // The session/prompt response. Closes any text still streaming and the turn.
  // A string is the stop reason. An object is the session/prompt result:
  // this build (2026.11.05) returns only `{ stopReason }`, and the session
  // presenter never sends usage_update. If a result does carry usage, or a
  // usage_update arrived, it is recorded. Nothing is filled in otherwise.
  finish(stopOrResult?: string | Any): AdapterOutput[] {
    const body = typeof stopOrResult === 'object' && stopOrResult ? stopOrResult : undefined;
    const stopReason = typeof stopOrResult === 'string' ? stopOrResult : typeof body?.stopReason === 'string' ? body.stopReason : undefined;
    const reported = usageFrom(body);
    if (reported.costUsd !== undefined) this.costUsd = reported.costUsd;
    const usage = reported.usage ?? this.turnUsage;
    const out: AdapterOutput[] = [];
    this.flushTexts(out);
    for (const [id, tool] of this.open) {
      if (!tool.emitted) this.emitCall(id, tool, out);
      out.push(this.resultEvent(id, stopReason === 'cancelled' ? false : true, stopReason === 'cancelled' ? 'Cancelled.' : ''));
    }
    this.open.clear();
    const stop = stopReason || 'end_turn';
    let outcome: TurnResult['outcome'] = 'completed';
    let error: string | undefined;
    let errorKind = this.errorKind;
    if (stop === 'cancelled') outcome = 'interrupted';
    else if (stop === 'max_tokens') {
      outcome = 'failed';
      error = 'The model hit its output limit.';
      errorKind = 'contextWindow';
    } else if (stop === 'refusal') {
      outcome = 'failed';
      error = 'The model refused to continue.';
    } else if (stop !== 'end_turn' && stop !== 'max_turn_requests') {
      outcome = 'failed';
      error = this.errorText || `The turn stopped (${stop}).`;
    } else if (this.errorKind) {
      outcome = 'failed';
      error = this.errorText;
    }
    const result: TurnResult = {
      outcome,
      durationMs: Math.max(0, Date.now() - this.started),
      ...(this.runnerId ? { answers: this.runnerId } : {}),
      ...(this.costUsd !== undefined ? { totalCostUsd: this.costUsd } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
      ...(errorKind ? { errorKind } : {}),
    };
    out.push({ kind: 'result', result });
    return out;
  }

  private chunk(kind: OpenText['kind'], update: Any, out: AdapterOutput[]): void {
    const text = blockText(update.content);
    if (!text) return;
    this.noteError(text);
    const key = typeof update.messageId === 'string' && update.messageId ? update.messageId : kind;
    let cur = this.texts.get(key);
    if (!cur) {
      cur = { itemId: `c${++this.n}`, kind, text: '' };
      this.texts.set(key, cur);
    }
    cur.text += text;
    out.push({ kind: 'delta', delta: { type: kind === 'reasoning' ? 'reasoning.delta' : 'assistant.text.delta', itemId: cur.itemId, text } });
  }

  private flushTexts(out: AdapterOutput[]): void {
    for (const cur of this.texts.values()) {
      if (!cur.text) continue;
      const event: EventBody = cur.kind === 'reasoning' ? { type: 'reasoning', itemId: cur.itemId, text: cur.text } : { type: 'assistant.text', itemId: cur.itemId, text: cur.text };
      out.push({ kind: 'event', event });
    }
    this.texts.clear();
  }

  private tool(update: Any, fresh: boolean, out: AdapterOutput[]): void {
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!id) return;
    const prev = this.open.get(id);
    const input = inputOf(update.rawInput) ?? prev?.input ?? {};
    const named = cursorToolIdentity(update, this.tools, this.ctx.cwd);
    const name = named.name || prev?.name || 'tool';
    const kind = named.kind !== 'other' ? named.kind : prev?.kind || named.kind;
    const title = named.title || prev?.title || toolTitle(name, input, this.ctx.cwd);
    const tool: OpenTool = { name: name || prev?.name || 'tool', title, input, kind, emitted: prev?.emitted ?? false, live: prev?.live };
    const status = typeof update.status === 'string' ? update.status : fresh ? 'pending' : '';
    if (!tool.emitted && (fresh || status === 'in_progress' || status === 'completed' || status === 'failed')) {
      this.emitCall(id, tool, out);
      tool.emitted = true;
    }
    this.diffs(id, update.content, out);
    if (status === 'completed' || status === 'failed') {
      const ok = status === 'completed';
      const text = contentText(update.content) || outputText(update.rawOutput);
      const images = this.images(update.content);
      out.push(this.resultEvent(id, ok, text, images));
      this.open.delete(id);
      return;
    }
    this.liveOutput(id, tool, update.content, out);
    this.open.set(id, tool);
  }

  // ACP agents (OpenCode) send running output as a cumulative snapshot in
  // each in_progress update; the app appends deltas, so send the new tail.
  // A snapshot that doesn't extend the last (e.g. a truncated window) is
  // skipped; the final result replaces the live text anyway.
  private liveOutput(id: string, tool: OpenTool, content: unknown, out: AdapterOutput[]): void {
    if (!tool.emitted || tool.kind !== 'command') return;
    const text = contentText(content);
    const prev = tool.live ?? '';
    if (!text || text.length <= prev.length || !text.startsWith(prev)) return;
    tool.live = text;
    out.push({ kind: 'delta', delta: { type: 'tool.output.delta', itemId: id, text: text.slice(prev.length) } });
  }

  private emitCall(id: string, tool: OpenTool, out: AdapterOutput[]): void {
    out.push({
      kind: 'event',
      event: { type: 'tool.call', itemId: id, name: tool.name || 'tool', kind: tool.kind, title: tool.title || tool.name || 'tool', input: tool.input },
    });
  }

  private resultEvent(id: string, ok: boolean, text: string, images: ImageRef[] = []): AdapterOutput {
    return { kind: 'event', event: { type: 'tool.result', itemId: id, ok, ...truncateResultText(text, id, this.ctx), images } };
  }

  private diffs(id: string, content: unknown, out: AdapterOutput[]): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Any;
      if (b.type !== 'diff' || typeof b.path !== 'string') continue;
      const oldText = typeof b.oldText === 'string' ? b.oldText : '';
      const newText = typeof b.newText === 'string' ? b.newText : '';
      const hunks = diffLines(oldText, newText);
      if (hunks.length) out.push({ kind: 'event', event: { type: 'edit.diff', itemId: id, path: b.path, hunks } });
    }
  }

  private images(content: unknown): ImageRef[] {
    if (!Array.isArray(content)) return [];
    const images: ImageRef[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const inner = (block as Any).type === 'content' ? (block as Any).content : block;
      if (!inner || inner.type !== 'image' || typeof inner.data !== 'string') continue;
      try {
        images.push(this.ctx.saveImage(inner.data, typeof inner.mimeType === 'string' ? inner.mimeType : 'image/png', 'tool'));
      } catch {
        // a tool picture that won't decode is left out of the row
      }
    }
    return images;
  }

  private plan(update: Any, out: AdapterOutput[]): void {
    const entries: PlanEntry[] = [];
    if (!Array.isArray(update.entries)) return;
    for (const row of update.entries) {
      if (!row || typeof row !== 'object') continue;
      const text = typeof row.content === 'string' ? row.content : '';
      if (!text) continue;
      const status = row.status === 'in_progress' || row.status === 'completed' ? row.status : 'pending';
      entries.push({ text, status });
    }
    out.push({ kind: 'event', event: { type: 'plan.updated', entries } });
  }

  private usage(update: Any, out: AdapterOutput[]): void {
    const used = numberOf(update.used);
    const size = numberOf(update.size);
    if (used !== undefined) out.push({ kind: 'context', contextTokens: used, ...(size !== undefined ? { contextWindow: size } : {}) });
    const amount = update.cost && typeof update.cost === 'object' ? numberOf((update.cost as Any).amount) : undefined;
    const currency = update.cost && typeof update.cost === 'object' ? (update.cost as Any).currency : undefined;
    if (amount !== undefined && (currency === 'USD' || currency === 'usd')) this.costUsd = amount;
    const reported = usageFrom(update);
    if (reported.usage) this.turnUsage = { ...this.turnUsage, ...reported.usage };
    if (reported.costUsd !== undefined) this.costUsd = reported.costUsd;
  }

  private noteError(text: string): void {
    if (/unauthenticated|authentication required|not logged in/i.test(text)) {
      this.errorKind = 'auth';
      this.errorText = text.trim();
    } else if (/usage limit|rate limit/i.test(text)) {
      this.errorKind = 'usageLimit';
      this.errorText = text.trim();
    } else if (/ECONN|ENOTFOUND|network|getaddrinfo/i.test(text)) {
      this.errorKind = 'network';
      this.errorText = text.trim();
    }
  }
}

export function commandsOf(list: unknown): SlashCommand[] {
  if (!Array.isArray(list)) return [];
  const out: SlashCommand[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const name = typeof (row as Any).name === 'string' ? (row as Any).name.trim() : '';
    if (!name) continue;
    const description = typeof (row as Any).description === 'string' ? (row as Any).description : undefined;
    out.push({ name, ...(description ? { description } : {}), source: 'cli' });
  }
  return out;
}

// Cursor's ACP tool_call often has a kind and a title and no `name` (the
// presenter sends toolCallId, title, kind, rawInput). Without a name the
// row was "tool". Kind and title pick the same names Claude's tools use.
export function cursorToolIdentity(update: Any, threadbear: Set<string>, cwd: string): { name: string; kind: ToolKind; title: string } {
  const input = inputOf(update.rawInput) ?? {};
  const acpKind = (typeof update.kind === 'string' && TOOL_KIND[update.kind]) || 'other';
  const given = typeof update.name === 'string' ? update.name.trim() : '';
  const titleIn = typeof update.title === 'string' ? update.title.trim() : '';
  let name = given && given !== 'tool' ? given : '';
  if (!name) {
    const fromTitle = /^(Read|Edit|Write|Bash|Grep|Glob|LS|Delete|WebFetch|WebSearch|end_turn)\b/i.exec(titleIn);
    if (fromTitle) name = fromTitle[1];
    else if (/^task$/i.test(titleIn) || (typeof input.subagent_type === 'string' && typeof input.prompt === 'string')) name = 'Task'; // OpenCode's helper tool, reported as kind think
    else if (/end[_ ]?turn/i.test(`${titleIn} ${given}`)) name = 'end_turn';
    else if (acpKind === 'command' || typeof input.command === 'string') name = 'Bash';
    else if (acpKind === 'read') name = 'Read';
    else if (acpKind === 'edit') name = typeof input.fileText === 'string' || typeof input.contents === 'string' ? 'Write' : 'Edit';
    else if (acpKind === 'search') name = typeof input.pattern === 'string' || typeof input.query === 'string' ? 'Grep' : 'Glob';
    else if (acpKind === 'web') name = 'WebFetch';
    else if (isEndTurnInput(input)) name = 'end_turn';
  }
  name = protocolToolName(name, threadbear);
  const kind: ToolKind = name.startsWith('mcp__') ? 'mcp' : toolKind(name) !== 'other' ? toolKind(name) : acpKind;
  const title = titleIn && titleIn !== 'tool' ? titleIn : toolTitle(name || 'tool', input, cwd);
  return { name: name || 'tool', kind, title: title || name || 'tool' };
}

function isEndTurnInput(input: Record<string, unknown>): boolean {
  return typeof input.summary === 'string' || typeof input.headline === 'string' || typeof input.needs === 'string';
}

// Threadbear's own tools arrive under their bare name. The runner only
// treats end_turn as the turn's close when it is `mcp__threadbear__end_turn`.
export function protocolToolName(name: string, threadbear: Set<string>): string {
  const bare = name
    .replace(/^mcp__threadbear__/, '')
    .replace(/^threadbear__/, '')
    .replace(/^threadbear[/_]/, '');
  if (!bare || bare === name && !threadbear.has(bare) && bare !== 'end_turn') return name;
  if (threadbear.has(bare) || bare === 'end_turn') return `mcp__threadbear__${bare}`;
  return name;
}

function inputOf(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const b = block as Any;
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return '';
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Any;
    const inner = b.type === 'content' ? b.content : b;
    const text = blockText(inner);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

function outputText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as Any;
  if (typeof r.text === 'string') return r.text;
  const fromContent = contentText(r.content);
  if (fromContent) return fromContent;
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Token fields the prompt result might carry. This CLI's processPrompt
// returns only stopReason; these are read when a build does send them.
export function usageFrom(body: Any | undefined): { usage?: Record<string, number>; costUsd?: number } {
  if (!body) return {};
  const bag = (body.usage && typeof body.usage === 'object' ? body.usage : body._meta && typeof body._meta === 'object' && (body._meta as Any).usage) as Any | undefined;
  const src = bag && typeof bag === 'object' ? bag : body;
  const input = numberOf(src.inputTokens) ?? numberOf(src.input_tokens);
  const output = numberOf(src.outputTokens) ?? numberOf(src.output_tokens);
  const cached = numberOf(src.cachedInputTokens) ?? numberOf(src.cache_read_input_tokens);
  const usage = input !== undefined || output !== undefined ? { ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}), ...(cached !== undefined ? { cachedInputTokens: cached } : {}) } : undefined;
  const cost = numberOf(src.total_cost_usd) ?? numberOf(body.totalCostUsd);
  return { ...(usage ? { usage } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
}

// Kept so a model effort, when ACP has nowhere to put it, is named in one
// place. The adapter emits the note; this build has no separate effort field
// on session/prompt (effort is a model parameter the CLI did not advertise
// on initialize).
export const EFFORT_UNSUPPORTED = "Cursor doesn't take an effort level on this session, so this thread uses the model's own.";

export function effortNote(effort: EffortLevel | undefined, applied: boolean): string | undefined {
  if (!effort || applied) return undefined;
  return EFFORT_UNSUPPORTED;
}
