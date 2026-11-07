// Opening an ACP session: resume via session/load when supported, else
// session/new. load's result often omits sessionId (the client sent it).
import type { AcpConnection } from './connection.ts';
import { SessionNotFoundError } from '../types.ts';

type Any = Record<string, unknown>;

export type OpenAcpSessionOpts = {
  resume: boolean;
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
  /** From initialize agentCapabilities.loadSession. */
  loadSession: boolean;
  /** Shown when session/new returns no id, e.g. "Cursor". */
  agentLabel: string;
};

export async function openAcpSession(conn: AcpConnection, opts: OpenAcpSessionOpts): Promise<{ created: Any; sessionId: string }> {
  if (opts.resume && opts.loadSession) {
    try {
      const loaded = (await conn.request(
        'session/load',
        { sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: opts.mcpServers },
        60_000,
      )) as Any;
      const sessionId =
        typeof loaded?.sessionId === 'string' && loaded.sessionId.trim() ? loaded.sessionId.trim() : opts.sessionId;
      return { created: loaded, sessionId };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/not found|no such session|unknown session|does not exist/i.test(message)) throw new SessionNotFoundError(message);
      // load failed for another reason: start fresh so the thread can run
    }
  }
  const created = (await conn.request('session/new', { cwd: opts.cwd, mcpServers: opts.mcpServers }, 60_000)) as Any;
  const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : '';
  if (!sessionId) throw new Error(`${opts.agentLabel} did not return a session id.`);
  return { created, sessionId };
}
