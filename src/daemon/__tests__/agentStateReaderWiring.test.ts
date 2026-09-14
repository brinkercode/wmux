// Wiring guard for the daemon's canonical agent-state reader.
//
// `readDaemonAgentState` answers `daemon.getAgentName`, `daemon.getAgentState`
// and `/api/workspaces`. A resumed or named Claude session draws no banner, so
// the detector never names it while the hook and process tiers already know
// the agent (#1303). If a missing detector name ever short-circuits the reader
// again, those panes lose their name on every surface at once.
//
// Source-shape assertions, following agentProcessExitWiring.test.ts: the
// reader is a closure inside `registerRpcHandlers`, which cannot be
// constructed in a unit test. The name decision itself is covered in
// canonicalAgent.test.ts (reportedAgentName).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('readDaemonAgentState wiring (#1303)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  function readerBody(): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes('const readDaemonAgentState = (id: string)'));
    if (startIdx < 0) throw new Error('readDaemonAgentState not found');
    const endIdx = lines.findIndex((l, i) => i > startIdx && l === '  };');
    return lines.slice(startIdx, endIdx > 0 ? endIdx : lines.length).join('\n');
  }

  it('consults canonical identity even when the detector has no name', () => {
    const body = readerBody();
    const rawIdx = body.indexOf('const rawName = ');
    const canonicalIdx = body.indexOf('canonicalIdentityFor(agentProcessTracker, id, screenSlug)');
    expect(rawIdx).toBeGreaterThan(-1);
    expect(canonicalIdx).toBeGreaterThan(rawIdx);
    // The only exit before canonical identity is the missing-session guard.
    const between = body.slice(rawIdx, canonicalIdx);
    expect(between.match(/\breturn\b/g)).toHaveLength(1);
    expect(between).toMatch(/if \(!session\) return \{ agentName: null, \.\.\.state \};/);
  });

  it('derives the screen slug only from a detector name', () => {
    expect(readerBody()).toMatch(/const screenSlug = rawName \? agentDisplayToSlug\(rawName\) : undefined;/);
  });

  it('reports the name through reportedAgentName with the canonical answer', () => {
    expect(readerBody()).toMatch(
      /return \{ agentName: reportedAgentName\(\{ rawName, screenSlug, canonical \}\), \.\.\.state \};/,
    );
  });

  it('serves every agent-state caller from the same reader', () => {
    // #1163: the remote roster row must appear exactly when a local one would.
    expect(src).toMatch(/readAgentStateForWeb = readDaemonAgentState;/);
    for (const method of ['daemon.getAgentName', 'daemon.getAgentState']) {
      const at = src.indexOf(`pipeServer.onRpc('${method}'`);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, src.indexOf('});', at))).toMatch(/return readDaemonAgentState\(id\);/);
    }
  });
});
