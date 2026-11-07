// JSON-RPC over the stdin/stdout of `agent acp`. Newline-delimited, which is
// how this build answers: one initialize line in, one result line out.
// The agent also sends requests (session/request_permission) that need a
// response, and notifications (session/update) that do not.
import type { Readable, Writable } from 'node:stream';

export type AcpProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
};

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class AcpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
  }
}

export class AcpConnection {
  private buf = '';
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private closed = false;
  private proc: AcpProcess;
  private handlers: {
    notification(method: string, params: unknown): void;
    request(id: number | string, method: string, params: unknown): Promise<unknown>;
  };

  constructor(
    proc: AcpProcess,
    handlers: {
      notification(method: string, params: unknown): void;
      request(id: number | string, method: string, params: unknown): Promise<unknown>;
    },
  ) {
    this.proc = proc;
    this.handlers = handlers;
    proc.stdout.on('data', (chunk: Buffer | string) => this.onData(String(chunk)));
    proc.stdout.on('end', () => this.fail(new Error('Cursor ACP closed its output.')));
    proc.on('exit', (code, signal) => this.fail(new Error(`Cursor ACP exited (${signal || code || 'closed'}).`)));
    proc.on('error', (err) => this.fail(err));
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Cursor ACP is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Cursor ACP ${method} timed out.`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  failRequest(id: number | string, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(text: string): void {
    this.buf += text;
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.onLine(line);
      nl = this.buf.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg.id;
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (method && (typeof id === 'number' || typeof id === 'string')) {
      void this.handlers
        .request(id, method, msg.params)
        .then((result) => this.respond(id, result))
        .catch((err: Error) => this.failRequest(id, -32000, err.message || 'request failed'));
      return;
    }
    if (method) {
      this.handlers.notification(method, msg.params);
      return;
    }
    if (typeof id === 'number' || typeof id === 'string') {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as { code?: unknown; message?: unknown };
        pending.reject(new AcpError(typeof e.code === 'number' ? e.code : -1, typeof e.message === 'string' ? e.message : 'Cursor ACP request failed.'));
      } else pending.resolve(msg.result);
    }
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
