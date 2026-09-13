import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * End-to-end coverage for the dispatch-layer result-size guard on the legacy
 * server.tool() lane (src/mcp/index.ts): the wrapper installed on the McpServer
 * instance must cap oversized TEXT results of tools registered through
 * server.tool — here terminal_read / terminal_read_events — honour the
 * per-call maxBytes raise, and clamp over-limit limit params instead of
 * rejecting them.
 *
 * Same harness as paneGetMetadataCrossWorkspace.test.ts: a real McpServer via
 * createWmuxServer() over an in-memory transport pair; the only mock is
 * wmux-client's sendRpc, at the RPC boundary the tools actually call through.
 */

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

import { createWmuxServer } from '../index';

const HUNDRED_KIB = 100 * 1024;

async function connectClient() {
  const server = createWmuxServer({
    envWorkspaceHint: '',
    envPtyHint: '',
    commanderToken: undefined,
    commanderMode: false,
    coreMode: false,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, close: async () => client.close() };
}

/**
 * sendRpc routing:
 *  - 'a2a.resolve.identity' answers with a verified PID-map hit, so
 *    resolveTerminalRoute() returns a concrete workspace+pty without any real
 *    daemon (the summary noted this shape as a verified hit).
 *  - 'input.readScreen' / 'terminal.readEvents' are the calls under test; the
 *    latter echoes its params back so clamps are assertable on the wire.
 */
function installSendRpcRouting(screenText: () => string): void {
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.resolve.identity') {
      return { resolved: { workspaceId: 'ws-test', ptyId: 'pty-1' } };
    }
    if (method === 'input.readScreen') {
      return screenText();
    }
    if (method === 'terminal.readEvents') {
      return { events: [], echoed: params };
    }
    throw new Error(`rpc-down: ${method}`);
  });
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args }) as {
    isError?: boolean;
    content: { type: 'text'; text: string }[];
  };
  return { isError: result.isError, text: result.content[0]?.text ?? '' };
}

function readScreenCalls(): Record<string, unknown>[] {
  return mockSendRpc.mock.calls
    .filter(([method]) => method === 'input.readScreen')
    .map(([, params]) => params as Record<string, unknown>);
}

function readEventsCalls(): Record<string, unknown>[] {
  return mockSendRpc.mock.calls
    .filter(([method]) => method === 'terminal.readEvents')
    .map(([, params]) => params as Record<string, unknown>);
}

describe('result-size guard on the legacy server.tool lane (terminal tools)', () => {
  let screenText = '';

  beforeEach(() => {
    mockSendRpc.mockReset();
    screenText = '';
    installSendRpcRouting(() => screenText);
  });

  it('truncates an oversized terminal_read result at the 64 KiB default and marks the cut', async () => {
    screenText = 'x'.repeat(6 * HUNDRED_KIB);
    const { client, close } = await connectClient();
    try {
      const res = await callTool(client, 'terminal_read', {});
      expect(res.isError).toBeFalsy();
      expect(res.text.length).toBeLessThan(HUNDRED_KIB);
      // The marker counts inside the cap, so slightly under 64 KiB is shown.
      expect(res.text).toMatch(
        /\[truncated: \d+ of 614400 bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
      );
    } finally {
      await close();
    }
  });

  it('raises the cap with maxBytes and clamps it at the 512 KiB hard bound, not beyond', async () => {
    screenText = 'y'.repeat(3 * HUNDRED_KIB); // 300 KiB: over default, under the bound
    const { client, close } = await connectClient();
    try {
      const raised = await callTool(client, 'terminal_read', { maxBytes: 400 * 1024 });
      // Undamaged: no marker, full payload.
      expect(raised.text).toBe('y'.repeat(3 * HUNDRED_KIB));

      // 600 KiB payload with maxBytes far over the hard bound: served at
      // 512 KiB, clamped not rejected.
      screenText = 'z'.repeat(600 * 1024);
      const clamped = await callTool(client, 'terminal_read', { maxBytes: 100 * 1024 * 1024 });
      expect(clamped.text.length).toBeLessThan(600 * 1024);
      expect(clamped.text).toMatch(
        /\[truncated: \d+ of 614400 bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
      );
    } finally {
      await close();
    }
  });

  it('clamps an over-limit tail_lines instead of rejecting the call', async () => {
    screenText = 'ok';
    const { client, close } = await connectClient();
    try {
      const res = await callTool(client, 'terminal_read', { tail_lines: 999_999 });
      expect(res.isError).toBeFalsy();
      expect(readScreenCalls()[0]?.tail_lines).toBe(20_000);
    } finally {
      await close();
    }
  });

  it('clamps an over-limit terminal_read_events limit instead of rejecting the call', async () => {
    const { client, close } = await connectClient();
    try {
      const res = await callTool(client, 'terminal_read_events', { limit: 5000 });
      expect(res.isError).toBeFalsy();
      expect(readEventsCalls()[0]?.limit).toBe(1024);
    } finally {
      await close();
    }
  });
});
