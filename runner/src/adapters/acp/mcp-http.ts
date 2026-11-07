// Threadbear's tools for an ACP session (Cursor `agent acp`, OpenCode
// `opencode acp`). Both advertise MCP over `http` and `sse`, so the session
// is handed an SSE endpoint on 127.0.0.1 (the 2024-11-05 transport: a GET
// that sends an `endpoint` event, then POSTs whose answers come back on
// that stream). The same port also answers a streamable-HTTP POST at
// /mcp/<token>, which is the `http` transport.
import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../codex/tools.ts';

export type McpEndpoint = { url: string; name: string; type: 'http' | 'sse'; headers: [] };

export class ThreadbearMcp {
  readonly endpoint: McpEndpoint;
  private server: http.Server;
  private closeSse: () => void;

  private constructor(server: http.Server, endpoint: McpEndpoint, closeSse: () => void) {
    this.server = server;
    this.endpoint = endpoint;
    this.closeSse = closeSse;
  }

  static async start(tools: ToolDefinition[], instructions: string): Promise<ThreadbearMcp> {
    const token = crypto.randomBytes(16).toString('hex');
    const toolsByName = new Map(tools.map((t) => [t.name, t]));
    let sse: http.ServerResponse | null = null;
    const pending: string[] = [];
    const writeSse = (event: string, data: string) => {
      const frame = `event: ${event}\ndata: ${data}\n\n`;
      if (sse && !sse.writableEnded) sse.write(frame);
      else pending.push(frame);
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === `/sse/${token}`) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        sse = res;
        for (const frame of pending.splice(0)) res.write(frame);
        const port = (server.address() as { port: number } | null)?.port ?? 0;
        res.write(`event: endpoint\ndata: http://127.0.0.1:${port}/message/${token}\n\n`);
        req.on('close', () => {
          if (sse === res) sse = null;
        });
        return;
      }
      if (req.method === 'POST' && (url.pathname === `/message/${token}` || url.pathname === `/mcp/${token}`)) {
        const raw = await readBody(req);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          res.writeHead(400).end();
          return;
        }
        const result = await handleMcp(msg, toolsByName, instructions);
        if (result === undefined) {
          res.writeHead(202).end();
          return;
        }
        const body = JSON.stringify(result);
        if (url.pathname.startsWith('/mcp/')) {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': token });
          res.end(body);
          return;
        }
        writeSse('message', body);
        res.writeHead(202).end();
        return;
      }
      res.writeHead(404).end();
    });
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const endpoint: McpEndpoint = { type: 'http', name: 'threadbear', url: `http://127.0.0.1:${port}/mcp/${token}`, headers: [] };
    return new ThreadbearMcp(server, endpoint, () => sse?.end());
  }

  stop(): void {
    this.closeSse();
    this.server.close();
  }
}

async function handleMcp(msg: Record<string, unknown>, tools: Map<string, ToolDefinition>, instructions: string): Promise<unknown | undefined> {
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const hasId = typeof id === 'number' || typeof id === 'string';
  if (!hasId) return undefined;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
  try {
    if (method === 'initialize') {
      const version = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05';
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'threadbear', version: '0.1.0' },
        ...(instructions ? { instructions } : {}),
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') {
      return ok(id, { tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t) })) });
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = tools.get(name);
      if (!tool) return ok(id, { content: [{ type: 'text', text: `No threadbear tool called ${name}.` }], isError: true });
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
      const parsed = z.object(tool.inputSchema as Record<string, z.ZodType>).safeParse(args);
      if (!parsed.success) return ok(id, { content: [{ type: 'text', text: z.prettifyError(parsed.error) }], isError: true });
      const result = await tool.handler(parsed.data, {});
      const content = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: '' }];
      return ok(id, { content, ...(result?.isError ? { isError: true } : {}) });
    }
    return err(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return err(id, -32000, e instanceof Error ? e.message : String(e));
  }
}

function ok(id: number | string, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

function err(id: number | string, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonSchema(t: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(t.inputSchema as Record<string, z.ZodType>)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
