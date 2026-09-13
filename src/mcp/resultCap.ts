/**
 * Global result-size guard for MCP tool results.
 *
 * Several tools return data whose size the CALLER does not control (a console
 * ring, a network log, a full scrollback, a JSON.stringify of whatever a page
 * produced). One such call can drop several megabytes into the caller's
 * context and evict everything else. Every TEXT result therefore passes
 * through a head+tail cap at the dispatch layer — one implementation, shared
 * by the catalog lane (registerWmuxTools) and the legacy server.tool() lane —
 * so a tool that forgets its own bound is still bounded.
 *
 * Image/binary content is exempt from text truncation (the bytes are not
 * readable text and screenshots have their own explicit ceiling), and a tool
 * may declare a per-call `maxBytes` input so a caller that legitimately needs
 * more can raise the cap up to a hard maximum.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { truncateText } from './repl/truncate';

/** Default cap for a text tool result: 64 KiB. */
export const DEFAULT_RESULT_CAP_BYTES = 64 * 1024;
/** Hard maximum a caller can raise the text cap to with `maxBytes`: 512 KiB. */
export const MAX_RESULT_CAP_BYTES = 512 * 1024;
/**
 * Screenshot images ride as base64 outside the text cap; this ceiling bounds
 * the single image payload instead. Chosen to clear every ordinary viewport
 * capture (retina included) while keeping a runaway fullPage capture out of
 * the caller's context.
 */
export const MAX_SCREENSHOT_BASE64_BYTES = 2 * 1024 * 1024;

/**
 * Resolve the per-call cap from a tool input. Only inputs whose schema
 * declares `maxBytes` can carry one (a stripping schema drops unknown keys),
 * so this never widens a tool that did not opt in. Values are clamped, never
 * rejected — a caller asking for more than the hard maximum gets the maximum,
 * and anything non-numeric or non-positive gets the default.
 */
export function clampResultCapBytes(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_RESULT_CAP_BYTES;
  }
  return Math.min(Math.floor(requested), MAX_RESULT_CAP_BYTES);
}

/**
 * Marker naming the raise path, so an agent that hits the cap learns in the
 * same result how to ask for more — and where the ceiling is.
 */
function toolResultMarker(totalBytes: number): (elidedBytes: number) => string {
  return (elidedBytes) =>
    `\n[truncated: ${totalBytes - elidedBytes} of ${totalBytes} bytes shown; ` +
    'pass maxBytes to raise, up to 512 KiB]\n';
}

/** Cap one text string, head+tail, on UTF-8 codepoint boundaries. */
export function capText(text: string, capBytes: number): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= capBytes) return text;
  return truncateText(text, capBytes, toolResultMarker(totalBytes)).text;
}

/**
 * Cap every TEXT content block of a tool result in place (copy-on-write).
 * Image/audio/embedded-resource blocks are left untouched. Returns the same
 * object when nothing changed, so re-applying the guard (the catalog lane and
 * the legacy lane can both wrap one handler) stays a no-op.
 */
export function capToolResultText<T>(result: T, capBytes: number): T {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return result;
  let changed = false;
  const cappedContent = content.map((part) => {
    if (
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      const capped = capText(text, capBytes);
      if (capped !== text) {
        changed = true;
        return { ...part, text: capped };
      }
    }
    return part;
  });
  return changed ? { ...(result as object), content: cappedContent } as T : result;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Wrap a tool handler so its result passes through the text cap. The cap is
 * read from the FIRST argument (the parsed tool input), so a tool that
 * declares `maxBytes` controls its own ceiling per call. Works for both the
 * SDK's tool() and registerTool() callback shapes; thrown errors pass through
 * untouched for the SDK to render.
 */
export function wrapHandlerWithResultCap<Args extends unknown[], R>(
  handler: (...args: Args) => MaybePromise<R>,
): (...args: Args) => MaybePromise<R> {
  return function cappedHandler(this: unknown, ...args: Args): MaybePromise<R> {
    const cap = clampResultCapBytes((args[0] as { maxBytes?: unknown } | undefined)?.maxBytes);
    const outcome = handler.apply(this, args);
    if (
      outcome !== null &&
      typeof outcome === 'object' &&
      typeof (outcome as { then?: unknown }).then === 'function'
    ) {
      return (outcome as Promise<R>).then((resolved) => capToolResultText(resolved, cap));
    }
    return capToolResultText(outcome, cap);
  };
}
