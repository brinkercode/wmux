// Unit coverage for the shared tool-result size guard (src/mcp/resultCap.ts).
//
// The guard is the one place every TEXT tool result passes through, so its
// contract is pinned directly: cap at the boundary with a visible marker that
// names the raise path, never split a UTF-8 codepoint, leave non-text content
// untouched, clamp a caller's maxBytes to the hard maximum instead of
// rejecting it.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESULT_CAP_BYTES,
  MAX_RESULT_CAP_BYTES,
  capText,
  capToolResultText,
  clampResultCapBytes,
  wrapHandlerWithResultCap,
} from '../resultCap';

const MIB = 1024 * 1024;

describe('clampResultCapBytes', () => {
  it('returns the default for absent, non-numeric, or non-positive input', () => {
    expect(clampResultCapBytes(undefined)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(null)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes('65536')).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(0)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(-1)).toBe(DEFAULT_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(Number.NaN)).toBe(DEFAULT_RESULT_CAP_BYTES);
  });

  it('raises the cap up to the hard bound and not beyond', () => {
    expect(clampResultCapBytes(1000)).toBe(1000);
    expect(clampResultCapBytes(MAX_RESULT_CAP_BYTES)).toBe(MAX_RESULT_CAP_BYTES);
    expect(clampResultCapBytes(100 * MIB)).toBe(MAX_RESULT_CAP_BYTES);
    // A float is floored, not rejected.
    expect(clampResultCapBytes(1000.9)).toBe(1000);
  });
});

describe('capText', () => {
  it('passes through text already within the cap unchanged', () => {
    expect(capText('small', DEFAULT_RESULT_CAP_BYTES)).toBe('small');
  });

  it('truncates oversized text head+tail and marks the cut with the raise path', () => {
    const input = `${'a'.repeat(200_000)}MIDDLE${'b'.repeat(200_000)}`;
    const capped = capText(input, DEFAULT_RESULT_CAP_BYTES);
    expect(capped).not.toBe(input);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThan(
      DEFAULT_RESULT_CAP_BYTES + 200,
    );
    // Marker states what fraction survived and how to ask for more.
    expect(capped).toMatch(
      /\[truncated: \d+ of \d+ bytes shown; pass maxBytes to raise, up to 512 KiB\]/,
    );
    // Head and tail survive; only the middle is dropped.
    expect(capped.startsWith('aaa')).toBe(true);
    expect(capped.endsWith('bbb')).toBe(true);
    expect(capped).not.toContain('MIDDLE');
  });

  it('never cuts inside a UTF-8 codepoint', () => {
    // 3-byte codepoints; a cut at a byte multiple of 3 would be clean, so use
    // a cap offset by one byte to force the boundary walk.
    const input = '한'.repeat(100_000);
    const capped = capText(input, DEFAULT_RESULT_CAP_BYTES + 1);
    expect(capped).not.toContain('�');
  });
});

describe('capToolResultText', () => {
  it('caps text blocks but leaves image content untouched', () => {
    const image = 'A'.repeat(3 * MIB);
    const result = {
      content: [
        { type: 'image' as const, data: image, mimeType: 'image/png' },
        { type: 'text' as const, text: 'x'.repeat(200_000) },
      ],
    };
    const capped = capToolResultText(result, DEFAULT_RESULT_CAP_BYTES);
    expect(capped.content[0]).toEqual({ type: 'image', data: image, mimeType: 'image/png' });
    expect((capped.content[1] as { text: string }).text).toMatch(/\[truncated: /);
  });

  it('returns the same object when nothing needed capping', () => {
    const result = { content: [{ type: 'text' as const, text: 'fine' }] };
    expect(capToolResultText(result, DEFAULT_RESULT_CAP_BYTES)).toBe(result);
  });

  it('passes non-result values through', () => {
    expect(capToolResultText(undefined, DEFAULT_RESULT_CAP_BYTES)).toBeUndefined();
  });
});

describe('wrapHandlerWithResultCap', () => {
  it('caps a sync handler result using the default cap', () => {
    const wrapped = wrapHandlerWithResultCap(
      (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: `${input.value}`.repeat(100_000) }],
      }),
    );
    const result = wrapped({ value: 'x' }) as { content: { text: string }[] };
    expect(result.content[0]?.text).toMatch(/\[truncated: /);
  });

  it('honours maxBytes from the first argument for an async handler', async () => {
    const wrapped = wrapHandlerWithResultCap(
      async (input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: 'y'.repeat(150_000) }],
      }),
    );
    const within = (await wrapped({ maxBytes: 200_000 })) as { content: { text: string }[] };
    expect(within.content[0]?.text).toBe('y'.repeat(150_000));

    // Above the hard maximum: clamped to it, not rejected and not unbounded.
    // 600 KB of payload with a 100 MB request is served at 512 KiB.
    const wrappedBig = wrapHandlerWithResultCap(
      async (_input: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: 'z'.repeat(600_000) }],
      }),
    );
    const clamped = (await wrappedBig({ maxBytes: 500 * MIB })) as { content: { text: string }[] };
    expect(clamped.content[0]?.text).toMatch(
      /\[truncated: 524288 of 600000 bytes shown/,
    );
  });

  it('lets thrown errors pass through untouched', async () => {
    const wrapped = wrapHandlerWithResultCap(async (_input: Record<string, unknown>) => {
      throw new Error('boom');
    });
    await expect(wrapped({})).rejects.toThrow('boom');
  });
});
