import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Page } from 'playwright-core';

/**
 * Result-size guard coverage for the browser inspection tools
 * (browser_evaluate / browser_console / browser_network /
 * browser_response_body / browser_screenshot).
 *
 * The fake server here mirrors what the real lane does: src/mcp/index.ts
 * wraps every server.tool() handler with wrapHandlerWithResultCap at
 * registration, so the collected handler is wrapped the same way and these
 * tests exercise the composed behaviour — schema-declared maxBytes reaching
 * the guard, default-cap truncation, the hard-bound clamp, and the
 * screenshot image ceiling.
 */

const { mockSendRpc, getPage, resolveWorkspaceBackend } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      resolveWorkspaceBackend,
      drainLocalLifecycle: () => [],
    }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';
import { wrapHandlerWithResultCap } from '../../resultCap';
import { attachPageCapture } from '../pageCapture';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text?: string; data?: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, wrapHandlerWithResultCap(handler) as ToolHandler);
    },
  };
  registerInspectionTools(server as never, browserToolDeps);
  return tools;
}

const tools = collectTools();
const evaluateTool = tools.get('browser_evaluate');
const consoleTool = tools.get('browser_console');
const network = tools.get('browser_network');
const responseBody = tools.get('browser_response_body');
const screenshot = tools.get('browser_screenshot');
for (const t of [evaluateTool, consoleTool, network, responseBody, screenshot]) {
  if (!t) throw new Error('inspection tools failed to register');
}

interface FakePage extends EventEmitter {
  url: () => string;
}
type FakePageWithScreenshot = FakePage & { screenshot?: () => Promise<Buffer> };

function makePage(url = 'about:blank'): FakePage {
  const page = new EventEmitter() as FakePage;
  page.url = () => url;
  return page;
}

function asPage(page: FakePage): Page {
  return page as unknown as Page;
}

function consoleMessage(level: string, text: string) {
  return { type: () => level, text: () => text };
}

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  getPage.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('builtin');
  getPage.mockResolvedValue(null);
});

describe('browser_evaluate — text cap honours maxBytes', () => {
  const HUNDRED_KIB = 100 * 1024;

  function routeRpc(value: string): void {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.evaluate') return { value };
      throw new Error(`rpc-down: ${method}`);
    });
  }

  it('truncates a big return value at the 64 KiB default with the raise-path marker', async () => {
    routeRpc('x'.repeat(2 * HUNDRED_KIB));

    const result = await evaluateTool!({ expression: '1' });

    expect(result.isError).toBeFalsy();
    // Total = payload + the world note the RPC lane appends; assert the shown
    // count and the payload size class, not the exact total.
    expect(result.content[0].text).toMatch(
      /\[truncated: 65536 of 2\d{5} bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );
  });

  it('clamps an over-bound maxBytes to 512 KiB instead of rejecting or running unbounded', async () => {
    routeRpc('y'.repeat(600 * 1024));

    const result = await evaluateTool!({ expression: '1', maxBytes: 500 * 1024 * 1024 });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(
      /\[truncated: 524288 of 6\d{5} bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );
  });

  it('serves a raised cap undamaged when the value fits under it', async () => {
    const payload = 'z'.repeat(150_000);
    routeRpc(payload);

    const result = await evaluateTool!({ expression: '1', maxBytes: 200_000 });

    expect(result.isError).toBeFalsy();
    // The RPC lane appends a world note; the payload itself must survive whole.
    expect(result.content[0].text).toContain(payload);
    expect(result.content[0].text).not.toContain('[truncated:');
  });
});

describe('browser_console — text cap honours maxBytes (eager capture path)', () => {
  it('truncates a chatty page at the default and raises with maxBytes', async () => {
    const page = makePage();
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    getPage.mockResolvedValue(asPage(page));
    attachPageCapture(asPage(page));
    // Many small entries, each under the capture layer's per-entry bound, so
    // the aggregate — not one entry — is what crosses the result cap.
    for (let i = 0; i < 200; i++) {
      page.emit('console', consoleMessage('log', `line ${i} ${'c'.repeat(900)}`));
    }

    const capped = await consoleTool!({});
    expect(capped.content[0].text).toMatch(
      /\[truncated: 65536 of \d+ bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );

    const raised = await consoleTool!({ maxBytes: 400_000 });
    expect(raised.content[0].text).toContain('line 0 ');
    expect(raised.content[0].text).toContain('line 199 ');
    expect(raised.content[0].text).not.toContain('[truncated:');
  });
});

describe('browser_network — text cap honours maxBytes', () => {
  it('truncates a huge request log at the default cap', async () => {
    const page = makePage();
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    getPage.mockResolvedValue(asPage(page));
    attachPageCapture(asPage(page));
    for (let i = 0; i < 200; i++) {
      page.emit('request', {
        url: () => `https://x.test/api/${i}?blob=${'u'.repeat(900)}`,
        method: () => 'GET',
      });
    }

    const result = await network!({});

    expect(result.content[0].text).toMatch(
      /\[truncated: 65536 of \d+ bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );
  });
});

describe('browser_response_body — text cap honours maxBytes', () => {
  it('truncates a giant body at the default cap with the raise-path marker', async () => {
    mockSendRpc.mockImplementation(async (method: string) => {
      if (method === 'browser.responseBody.get') return { body: 'b'.repeat(3 * 100 * 1024) };
      throw new Error(`rpc-down: ${method}`);
    });

    const result = await responseBody!({ urlPattern: '*api*' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(
      /\[truncated: 65536 of 307200 bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );
  });
});

describe('browser_screenshot — explicit image ceiling', () => {
  function chromePageWithScreenshot(png: Buffer): FakePageWithScreenshot {
    const page = makePage() as FakePageWithScreenshot;
    page.screenshot = async () => png;
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    getPage.mockResolvedValue(asPage(page));
    return page;
  }

  it('refuses an oversized PNG with guidance instead of downscaling it', async () => {
    // 3 MiB of PNG -> 4 MiB of base64, over the 2 MiB ceiling.
    chromePageWithScreenshot(Buffer.alloc(3 * 1024 * 1024, 7));

    const result = await screenshot!({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /browser_screenshot refused: the PNG encodes to 4\.0 MiB of base64, over the 2 MiB ceiling\./,
    );
  });

  it('passes an under-ceiling capture through with the image intact', async () => {
    const png = Buffer.alloc(64 * 1024, 7);
    chromePageWithScreenshot(png);

    const result = await screenshot!({});

    expect(result.isError).toBeFalsy();
    const image = result.content.find((part) => part.type === 'image');
    expect(image?.data).toBe(png.toString('base64'));
  });
});
