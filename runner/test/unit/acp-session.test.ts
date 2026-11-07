import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AcpConnection, type AcpProcess } from '../../src/adapters/acp/connection.ts';
import { openAcpSession } from '../../src/adapters/acp/session.ts';
import { SessionNotFoundError } from '../../src/adapters/types.ts';

type Msg = Record<string, any>;

class FakeAcp extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function conn(fake: FakeAcp): AcpConnection {
  let buf = '';
  fake.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(fake, JSON.parse(line) as Msg);
      nl = buf.indexOf('\n');
    }
  });
  return new AcpConnection(fake as unknown as AcpProcess, { notification: () => {}, request: async () => ({}) }, { label: 'test' });
}

function reply(fake: FakeAcp, id: number, result: unknown): void {
  fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function err(fake: FakeAcp, id: number, message: string): void {
  fake.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message } }) + '\n');
}

const NEW_SESSION = {
  sessionId: 'fresh',
  modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
};

let loadEchoId = true;

function onLine(fake: FakeAcp, msg: Msg): void {
  if (msg.method === 'session/load') {
    if (loadEchoId) reply(fake, msg.id, { ...NEW_SESSION, sessionId: 'chat-1' });
    else reply(fake, msg.id, { modes: NEW_SESSION.modes });
  } else if (msg.method === 'session/new') reply(fake, msg.id, NEW_SESSION);
  else reply(fake, msg.id, {});
}

test('resume: load without sessionId uses the client session id', async () => {
  loadEchoId = false;
  const fake = new FakeAcp();
  const c = conn(fake);
  const opened = await openAcpSession(c, {
    resume: true,
    sessionId: 'chat-kept',
    cwd: '/tmp',
    mcpServers: [],
    loadSession: true,
    agentLabel: 'Cursor',
  });
  assert.equal(opened.sessionId, 'chat-kept');
});

test('resume: loadSession false opens a new session', async () => {
  loadEchoId = true;
  const fake = new FakeAcp();
  const c = conn(fake);
  const opened = await openAcpSession(c, {
    resume: true,
    sessionId: 'chat-kept',
    cwd: '/tmp',
    mcpServers: [],
    loadSession: false,
    agentLabel: 'Cursor',
  });
  assert.equal(opened.sessionId, 'fresh');
});

test('resume: a missing session throws SessionNotFoundError', async () => {
  const fake = new FakeAcp();
  let buf = '';
  fake.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const msg = JSON.parse(line) as Msg;
        if (msg.method === 'session/load') err(fake, msg.id, 'no such session');
      }
      nl = buf.indexOf('\n');
    }
  });
  const c = new AcpConnection(fake as unknown as AcpProcess, { notification: () => {}, request: async () => ({}) }, { label: 'test' });
  await assert.rejects(
    () =>
      openAcpSession(c, {
        resume: true,
        sessionId: 'gone',
        cwd: '/tmp',
        mcpServers: [],
        loadSession: true,
        agentLabel: 'Cursor',
      }),
    (e: unknown) => e instanceof SessionNotFoundError,
  );
});

test('resume: load error falls back to session/new', async () => {
  const fake = new FakeAcp();
  let buf = '';
  fake.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const msg = JSON.parse(line) as Msg;
        if (msg.method === 'session/load') err(fake, msg.id, 'internal error');
        else if (msg.method === 'session/new') reply(fake, msg.id, NEW_SESSION);
      }
      nl = buf.indexOf('\n');
    }
  });
  const c = new AcpConnection(fake as unknown as AcpProcess, { notification: () => {}, request: async () => ({}) }, { label: 'test' });
  const opened = await openAcpSession(c, {
    resume: true,
    sessionId: 'chat-kept',
    cwd: '/tmp',
    mcpServers: [],
    loadSession: true,
    agentLabel: 'Cursor',
  });
  assert.equal(opened.sessionId, 'fresh');
});
