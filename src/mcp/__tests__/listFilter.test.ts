import { describe, it, expect, vi, afterEach } from 'vitest';
import { unlistToolsFromListing } from '../listFilter';

/**
 * The filter reaches into the SDK's PRIVATE `_requestHandlers` map (#1302).
 * When an SDK upgrade renames or restructures that field the filter must
 * degrade to the unfiltered listing (one warning, server still boots) —
 * never throw and kill every MCP connection at startup.
 */

/** Minimal stand-in for McpServer exposing only what the filter touches. */
function fakeServer(requestHandlers?: Map<string, unknown>) {
  let wrapped: ((request: unknown, extra: unknown) => Promise<unknown>) | undefined;
  return {
    server: {
      _requestHandlers: requestHandlers,
      setRequestHandler: (_schema: unknown, handler: (request: unknown, extra: unknown) => Promise<unknown>) => {
        wrapped = handler;
      },
    },
    /** Invoke the wrapper the filter installed, if any. */
    callWrapped: (request: unknown) => {
      if (!wrapped) throw new Error('no wrapper installed');
      return wrapped(request, undefined);
    },
    hasWrapper: () => wrapped !== undefined,
  };
}

const HIDDEN = new Set(['a2a_task_send']);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unlistToolsFromListing — SDK-shape fallback', () => {
  it('warns once and does NOT wrap when _requestHandlers is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer(); // the field itself is gone (SDK upgrade)
    expect(() => unlistToolsFromListing(server as never, HIDDEN)).not.toThrow();
    expect(server.hasWrapper()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('unfiltered');
  });

  it('warns once and does NOT wrap when the tools/list slot is empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer(new Map()); // map exists, no handler installed
    expect(() => unlistToolsFromListing(server as never, HIDDEN)).not.toThrow();
    expect(server.hasWrapper()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still filters when the handler slot is present (fallback is the deviation)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = async () => ({
      tools: [{ name: 'send_message' }, { name: 'a2a_task_send' }],
    });
    const server = fakeServer(new Map([['tools/list', original]]));
    unlistToolsFromListing(server as never, HIDDEN);
    expect(server.hasWrapper()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    const result = (await server.callWrapped({})) as {
      tools: Array<{ name: string }>;
    };
    expect(result.tools.map((t) => t.name)).toEqual(['send_message']);
  });
});
