import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Clamp coverage for the caller-set extraction sizes on the extraction tools:
 * browser_smart_snapshot's maxContentLength (ceiling 100000) and
 * browser_extract_text's maxLength (ceiling 524288). Over-limit requests are
 * served at the ceiling, not rejected — the assertions read the options the
 * underlying extractors were actually handed.
 */

const { mockSendRpc, getPage, mockGetSmartSnapshot, mockExtractMarkdown } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  mockGetSmartSnapshot: vi.fn(),
  mockExtractMarkdown: vi.fn(),
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
      drainLocalLifecycle: () => [],
    }),
  },
}));

vi.mock('../dom-intelligence', () => ({
  getSmartSnapshot: mockGetSmartSnapshot,
  getSmartSnapshotViaEval: mockGetSmartSnapshot,
  smartPageToken: () => 'tok',
}));

vi.mock('../markdown-extractor', () => ({
  extractMarkdown: mockExtractMarkdown,
  extractStructuredData: vi.fn(async () => []),
}));

vi.mock('../page-eval', () => ({
  resolveEvaluator: vi.fn(async () => vi.fn()),
  rpcEvaluator: vi.fn(),
}));

import { registerExtractionTools } from '../tools/extraction';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerExtractionTools(server as never, browserToolDeps);
  return tools;
}

const tools = collectTools();
const smartSnapshot = tools.get('browser_smart_snapshot');
const extractText = tools.get('browser_extract_text');
if (!smartSnapshot || !extractText) throw new Error('extraction tools failed to register');

// Any truthy Page routes to the mocked getSmartSnapshot.
const fakePage = { url: () => 'https://example.test/a' };

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  getPage.mockReset();
  getPage.mockResolvedValue(fakePage);
  mockGetSmartSnapshot.mockReset();
  mockGetSmartSnapshot.mockResolvedValue({ title: 'Page', url: 'https://example.test/a', elements: [], content: 'x' });
  mockExtractMarkdown.mockReset();
  mockExtractMarkdown.mockResolvedValue('markdown');
});

describe('browser_smart_snapshot — maxContentLength clamp', () => {
  it('serves an over-limit request at the 100000 ceiling instead of rejecting it', async () => {
    const result = await smartSnapshot({ maxContentLength: 9_999_999 });

    expect(result.isError).toBeFalsy();
    expect(mockGetSmartSnapshot).toHaveBeenCalledWith(
      fakePage,
      expect.objectContaining({ maxContentLength: 100_000 }),
    );
  });

  it('leaves an in-range request untouched', async () => {
    await smartSnapshot({ maxContentLength: 5000 });

    expect(mockGetSmartSnapshot).toHaveBeenCalledWith(
      fakePage,
      expect.objectContaining({ maxContentLength: 5000 }),
    );
  });
});

describe('browser_extract_text — maxLength clamp', () => {
  it('serves an over-limit request at the 524288 ceiling instead of rejecting it', async () => {
    const result = await extractText({ maxLength: 9_999_999 });

    expect(result.isError).toBeFalsy();
    expect(mockExtractMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxLength: 524_288 }),
    );
  });

  it('leaves an omitted maxLength omitted and an in-range one untouched', async () => {
    await extractText({});
    expect(mockExtractMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxLength: undefined }),
    );

    await extractText({ maxLength: 1000 });
    expect(mockExtractMarkdown).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ maxLength: 1000 }),
    );
  });
});
