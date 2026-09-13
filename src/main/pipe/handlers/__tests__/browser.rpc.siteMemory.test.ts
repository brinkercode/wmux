// Per-site memory is fail-closed on scope in BOTH enforcement modes, like the
// action cache: the store is new, so there is no working behaviour a shadow
// fallback would preserve, and the fallback would let any caller read another
// workspace's browsing failures just by naming it.
//
// The flag contract is the other half. It is judged HERE — the MCP process is
// a separate process and cannot read session settings — and the three methods
// answer to it differently on purpose.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcContext } from '../../../../shared/rpc';
import { RpcRouter } from '../../RpcRouter';
import { registerBrowserRpc } from '../browser.rpc';
import { SiteMemoryStore } from '../../../browser-session/SiteMemoryStore';
import { __resetWorkspaceClaimTrustForTesting } from '../../../workspace/workspaceClaimTrust';

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn(() => null) },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

// The handlers reach the process-wide store through getSiteMemoryStore(); point
// it at a temp tree so the test never writes into the real ~/.wmux.
let dir: string;
let store: SiteMemoryStore;
vi.mock('../../../browser-session/SiteMemoryStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../browser-session/SiteMemoryStore')>();
  return { ...mod, getSiteMemoryStore: () => store };
});

const SITE_METHODS = [
  'browser.siteMemory.list',
  'browser.siteMemory.record',
  'browser.siteMemory.forget',
] as const;

function register(enabled: boolean | null): RpcRouter {
  const router = new RpcRouter();
  const webviewCdpManager = {
    getTarget: vi.fn(() => null),
    listTargets: vi.fn(() => []),
    getCdpPort: vi.fn(() => 18800),
    waitForTarget: vi.fn(),
    ensureAwake: vi.fn(async () => null),
    setCaptureCleanup: vi.fn(),
    setCaptureAttach: vi.fn(),
    withAutomationLease: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()),
    acquireRpcLease: vi.fn(() => 'lease-1'),
    renewRpcLease: vi.fn(() => true),
    releaseRpcLease: vi.fn(() => true),
  };
  registerBrowserRpc(
    router,
    (() => null) as unknown as () => BrowserWindow | null,
    webviewCdpManager as never,
    undefined,
    undefined,
    () => 'enforce',
    undefined,
    () => enabled,
  );
  return router;
}

/** A wire caller that has claimed nothing — the 'legacy' lane. */
function legacyCtx(): RpcContext {
  return { origin: 'local', externalWire: true, clientName: 'some-plugin' };
}

/** The renderer. wmux itself, so it is trusted with the workspace it names. */
function operatorCtx(): RpcContext {
  return { origin: 'local', operator: true };
}

async function dispatch(
  router: RpcRouter,
  method: string,
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
) {
  const res = await router.dispatch({ id: '1', method: method as never, params }, ctx as never);
  return res as { ok: boolean; error?: string; result?: Record<string, unknown> };
}

const FAILURE = {
  domain: 'example.com',
  urlKey: 'https://example.com/login',
  what: 'login flow, step 2',
  cause: 'no element matched the stored axis',
  tryInstead: 're-record this page',
  source: 'replay',
  workspaceId: 'ws-1',
};

beforeEach(() => {
  __resetWorkspaceClaimTrustForTesting();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sitemem-rpc-'));
  store = new SiteMemoryStore(dir);
});

afterEach(async () => {
  await store.drain();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('browser.siteMemory RPC', () => {
  it('refuses an unverified workspace scope', async () => {
    const router = register(true);
    for (const method of SITE_METHODS) {
      const res = await dispatch(router, method, { ...FAILURE }, legacyCtx());
      expect(res.ok, method).toBe(false);
      expect(res.error, method).toMatch(/workspace/i);
    }
  });

  it('lists only the requested domain', async () => {
    const router = register(true);
    await dispatch(router, 'browser.siteMemory.record', { ...FAILURE }, operatorCtx());
    await dispatch(
      router,
      'browser.siteMemory.record',
      { ...FAILURE, domain: 'other.test', urlKey: 'https://other.test/x' },
      operatorCtx(),
    );

    const one = await dispatch(
      router,
      'browser.siteMemory.list',
      { domain: 'example.com', workspaceId: 'ws-1' },
      operatorCtx(),
    );
    expect((one.result?.['memory'] as { domain: string } | null)?.domain).toBe('example.com');

    const all = await dispatch(
      router,
      'browser.siteMemory.list',
      { workspaceId: 'ws-1' },
      operatorCtx(),
    );
    expect((all.result?.['records'] as unknown[]).length).toBe(2);
  });

  it('records nothing and never throws while siteMemoryEnabled is false', async () => {
    const router = register(false);
    const res = await dispatch(router, 'browser.siteMemory.record', { ...FAILURE }, operatorCtx());
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ ok: true, skipped: true });
    // Nothing reached disk, so nothing can be served later either.
    expect(store.get('ws-1', 'example.com')).toBeNull();
  });

  it('list returns empty while siteMemoryEnabled is false', async () => {
    const on = register(true);
    await dispatch(on, 'browser.siteMemory.record', { ...FAILURE }, operatorCtx());
    expect(store.get('ws-1', 'example.com')).not.toBeNull();

    const off = register(false);
    const res = await dispatch(
      off,
      'browser.siteMemory.list',
      { domain: 'example.com', workspaceId: 'ws-1' },
      operatorCtx(),
    );
    expect(res.result).toEqual({ records: [], memory: null });
  });

  it('forget still works while siteMemoryEnabled is false', async () => {
    const on = register(true);
    await dispatch(on, 'browser.siteMemory.record', { ...FAILURE }, operatorCtx());

    // Turning the feature off must not strand what it already recorded.
    const off = register(false);
    const res = await dispatch(
      off,
      'browser.siteMemory.forget',
      { domain: 'example.com', workspaceId: 'ws-1' },
      operatorCtx(),
    );
    expect(res.result).toEqual({ removed: 1 });
    expect(store.get('ws-1', 'example.com')).toBeNull();
  });

  it('refuses an entry carrying a credential and counts the refusal', async () => {
    const router = register(true);
    const res = await dispatch(
      router,
      'browser.siteMemory.record',
      { ...FAILURE, cause: 'server said QUJDREVGR0hJSktMTU5PUFFSU1RVVld' },
      operatorCtx(),
    );
    expect(res.result?.['ok']).toBe(false);
    expect(store.refusedEntries()).toBe(1);
    expect(store.get('ws-1', 'example.com')).toBeNull();
  });
  it('normalises the urlKey itself rather than trusting the caller', async () => {
    const router = register(true);
    await dispatch(
      router,
      'browser.siteMemory.record',
      // A caller that sends a raw href, query string and all.
      { ...FAILURE, urlKey: 'https://example.com/login/?next=/admin&token=abc123#top' },
      operatorCtx(),
    );
    const record = store.get('ws-1', 'example.com');
    expect(record?.failures[0]?.urlKey).toBe('https://example.com/login');
  });

  it('stores no urlKey at all when the path is a magic link', async () => {
    const router = register(true);
    await dispatch(
      router,
      'browser.siteMemory.record',
      { ...FAILURE, urlKey: 'https://example.com/reset/QUJDREVGR0hJSktMTU5PUFFSU1RVVld' },
      operatorCtx(),
    );
    const record = store.get('ws-1', 'example.com');
    // The failure is kept; the page it happened on is not storable.
    expect(record?.failures).toHaveLength(1);
    expect(record?.failures[0]?.urlKey).toBe('');
  });
});
