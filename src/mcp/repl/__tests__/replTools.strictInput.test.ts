import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The schema-level tests next door assert what `toolInputSchema()` builds.
 * They cannot see the thing that actually has to hold: that the SDK still
 * validates a CALL against that object. The SDK floats (`^1.27.1`), and the
 * path from a registered spec to a rejected call runs through its raw-shape
 * heuristic — if a future release stops recognising a strict object and falls
 * back to the stripping default, every schema-only assertion here stays green
 * while unknown options are silently dropped again. So this one goes over a
 * real transport: registered through registerReplTools, called with
 * `tools/call`, asserted on what the caller actually receives.
 *
 * Note the shape of that reply: the SDK turns its own InvalidParams McpError
 * into an `isError` tool result rather than a JSON-RPC protocol error, so the
 * `-32602` and the message reach the model as text. That text is what a model
 * reads, so that is what this asserts.
 *
 * The only mock is the REPL registry, at the process boundary the handler
 * calls through. Schema validation, the strict object, and the SDK's dispatch
 * all run unmocked.
 */
const { mockAcquire } = vi.hoisted(() => ({ mockAcquire: vi.fn() }));

vi.mock('../replRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../replRegistry')>();
  return {
    ...actual,
    getReplRegistry: () => ({ acquire: mockAcquire }),
  };
});

// Imported after the mock is registered (vi.mock is hoisted regardless of
// source order).
import { registerReplTools } from '../tools';

async function connect(): Promise<Client> {
  const server = new McpServer(
    { name: 'wmux-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerReplTools(server, {
    profile: 'full',
    context: { principal: { kind: 'unattributed' } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function firstText(result: Record<string, unknown>): string {
  const content = result.content as
    | ReadonlyArray<{ type: string; text?: string }>
    | undefined;
  return content?.[0]?.text ?? '';
}

describe('repl_run over a real MCP transport', () => {
  it('fails the call with InvalidParams instead of dropping an unknown option', async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'repl_run',
        arguments: { code: '1 + 1', timeoutMs: 500 },
      });

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('-32602');
      expect(firstText(result)).toContain(
        'unknown option "timeoutMs"; valid: code, session, timeout, cwd',
      );
      // The handler must not have run: a dropped option would have executed
      // the snippet under the default timeout and returned a plausible result.
      expect(mockAcquire).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('still runs a call that uses only documented options', async () => {
    mockAcquire.mockReturnValue({
      session: {
        cwd: '/tmp',
        withheldCredentials: [],
        run: async () => ({
          ok: true,
          result: { text: '2', truncated: false },
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
          elapsedMs: 1,
        }),
      },
      created: false,
    });
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'repl_run',
        arguments: { code: '1 + 1', session: 'a', timeout: 500, cwd: '/tmp' },
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('session a · ok');
      expect(mockAcquire).toHaveBeenCalledWith('a', '/tmp');
    } finally {
      await client.close();
    }
  });
});
