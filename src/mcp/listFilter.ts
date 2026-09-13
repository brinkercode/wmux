/**
 * tools/list diet: drop named tools from the listing while keeping them
 * callable.
 *
 * The MCP SDK couples the two — one `enabled` flag gates both tools/list
 * membership and tools/call dispatch — so "unlisted but callable" has no
 * first-class support. This helper wraps the low-level server's existing
 * ListToolsRequestSchema handler: the SDK still serializes every registered
 * tool's schema exactly as before, and the wrapper filters the finished page
 * by name. tools/call is untouched, so a hidden tool keeps dispatching to its
 * real handler.
 *
 * The names come from src/shared/unlistedTools.ts (UNLISTED_TOOLS), the SSOT
 * the profile manifests and drift tests also read.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** The handler map Protocol.setRequestHandler writes into (private in the
 *  SDK's types; read once here to capture the handler being wrapped). */
type HandlerMap = Map<
  string,
  (request: never, extra: never) => Promise<{ tools?: Array<{ name?: unknown }> }>
>;

export function unlistToolsFromListing(
  server: McpServer,
  hidden: ReadonlySet<string>,
): void {
  if (hidden.size === 0) return;
  const protocol = server.server as unknown as {
    _requestHandlers: HandlerMap;
    setRequestHandler: McpServer['server']['setRequestHandler'];
  };
  // The map key is the protocol method literal the SDK derives from the
  // schema's method field ('tools/list').
  const original = protocol._requestHandlers.get('tools/list');
  if (!original) {
    // The SDK installs the list handler lazily, on the first tool
    // registration. This is called after every registration site has run, so
    // a missing handler means the SDK changed shape — fail loudly rather
    // than silently listing tools the baseline says are gone.
    throw new Error('wmux-mcp: tools/list handler missing; cannot apply the unlisted-tools filter');
  }
  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request as never, extra as never);
    const tools = result.tools ?? [];
    return {
      ...result,
      tools: tools.filter((tool) => {
        const name = tool.name;
        return !(typeof name === 'string' && hidden.has(name));
      }),
    };
  });
}
