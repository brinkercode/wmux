import type {
  McpServer,
  RegisteredTool,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Launch-time tool surfaces. A server instance selects exactly one profile and
 * never widens it after initialization.
 */
export type WmuxToolProfile = 'full' | 'core' | 'commander';

/**
 * Catalog invocation identity. `unattributed` is deliberately powerless: the
 * catalog must never turn profile, MCP clientInfo, or annotations into auth.
 * A future authenticated transport principal needs a private, branded
 * constructor; Phase 1 intentionally has no public privileged variant.
 */
export interface WmuxOperationPrincipal {
  readonly kind: 'unattributed';
}

export interface WmuxOperationContext {
  readonly principal: WmuxOperationPrincipal;
}

type WmuxToolResult = CallToolResult | Promise<CallToolResult>;

/**
 * Runtime-erased catalog descriptor. Use defineWmuxTool() to retain literal
 * names and exact Zod inference while authoring a tool. The erasure happens
 * once at the registry boundary so heterogeneous specs can share one array.
 *
 * Effects, retries, locks, and downstream RPC declarations are intentionally
 * absent in the first migration slice. Those fields only become truthful after
 * argument-sensitive classifiers and daemon-observed closure tests exist.
 */
export interface WmuxToolSpec<Name extends string = string> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  /**
   * Reject unknown input keys instead of silently dropping them. Off by
   * default: every strict tool pays `"additionalProperties":false` in its
   * tools/list schema (29 bytes), and the full profile's byte budget cannot
   * absorb that for all of them at once.
   */
  readonly strictInput?: boolean;
  readonly profiles: readonly WmuxToolProfile[];
  readonly invoke: (
    input: Record<string, unknown>,
    context: WmuxOperationContext,
  ) => WmuxToolResult;
}

type WmuxToolDraft<Name extends string, Shape extends z.ZodRawShape> =
  Omit<WmuxToolSpec<Name>, 'inputSchema' | 'profiles' | 'invoke'> & {
    readonly inputSchema: Shape;
    readonly profiles: readonly WmuxToolProfile[];
    readonly invoke: (
      input: z.infer<z.ZodObject<Shape>>,
      context: WmuxOperationContext,
    ) => WmuxToolResult;
  };

export interface RegisterWmuxToolsOptions {
  readonly profile: WmuxToolProfile;
  readonly context: WmuxOperationContext;
}

const TOOL_PROFILES: ReadonlySet<WmuxToolProfile> = new Set([
  'full',
  'core',
  'commander',
]);

function assertValidToolSpec(spec: WmuxToolSpec): void {
  if (!spec.name.trim()) {
    throw new Error('wmux tool names must not be empty');
  }
  if (!spec.description.trim()) {
    throw new Error(`${spec.name}: description must not be empty`);
  }
  if (spec.profiles.length === 0) {
    throw new Error(`${spec.name}: at least one profile is required`);
  }
  if (!spec.profiles.includes('full')) {
    throw new Error(`${spec.name}: the full profile must remain a superset`);
  }
  if (new Set(spec.profiles).size !== spec.profiles.length) {
    throw new Error(`${spec.name}: duplicate profile`);
  }
  for (const profile of spec.profiles) {
    if (!TOOL_PROFILES.has(profile)) {
      throw new Error(`${spec.name}: unknown profile ${String(profile)}`);
    }
  }
}

function freezeWmuxToolSpec<Name extends string>(
  spec: WmuxToolSpec<Name>,
): WmuxToolSpec<Name> {
  // The container freeze is intentionally shallow. Zod nodes use immutable
  // builder methods and remain shared across broker connections.
  Object.freeze(spec.inputSchema);
  Object.freeze(spec.profiles);
  return Object.freeze(spec);
}

/**
 * Define and freeze one descriptor while preserving its literal name and exact
 * input type. Zod nodes are treated as immutable values; the raw shape
 * container itself is frozen so properties cannot be swapped after launch.
 */
export function defineWmuxTool<
  const Name extends string,
  const Shape extends z.ZodRawShape,
>(
  draft: WmuxToolDraft<Name, Shape>,
): WmuxToolSpec<Name> {
  const spec: WmuxToolSpec<Name> = {
    ...draft,
    inputSchema: Object.freeze(draft.inputSchema),
    profiles: Object.freeze([...draft.profiles]),
    // The SDK validates the Zod shape before invocation. This is the sole
    // heterogeneous-catalog erasure; each draft handler remains inferred.
    invoke: draft.invoke as unknown as WmuxToolSpec<Name>['invoke'],
  };
  assertValidToolSpec(spec);
  return freezeWmuxToolSpec(spec);
}

/**
 * Build the schema the SDK validates one call against.
 *
 * A raw shape becomes a stripping object: an agent that passes a misspelled or
 * unsupported option gets it silently dropped, reads a result produced without
 * it, and concludes the option did nothing. `strictInput` tools reject that
 * call instead, and the message names both the offending key and the keys that
 * would have worked, so the next attempt does not need another round trip.
 */
export function toolInputSchema(
  spec: Pick<WmuxToolSpec, 'inputSchema' | 'strictInput'>,
): z.ZodRawShape | z.ZodObject<z.ZodRawShape> {
  if (!spec.strictInput) {
    return spec.inputSchema;
  }
  const valid = Object.keys(spec.inputSchema);
  const tail = valid.length > 0
    ? `valid: ${valid.join(', ')}`
    : 'this tool takes no options';
  return z.strictObject(spec.inputSchema, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        // JSON.stringify, not bare quotes: a key containing a quote or a
        // newline has to read back as one key, not as broken punctuation.
        ? `unknown option ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}; ${tail}`
        // Every other issue keeps Zod's own wording; only the unknown-key
        // case has a message worth replacing.
        : undefined,
  });
}

/**
 * Select a deterministic profile without mutating the catalog or its order.
 * Duplicate names fail before filtering so a hidden collision cannot surface
 * later when a different immutable profile is selected.
 */
export function selectWmuxTools(
  specs: readonly WmuxToolSpec[],
  profile: WmuxToolProfile,
): readonly WmuxToolSpec[] {
  const names = new Set<string>();
  for (const spec of specs) {
    const frozenSpec = freezeWmuxToolSpec(spec);
    assertValidToolSpec(frozenSpec);
    if (names.has(frozenSpec.name)) {
      throw new Error(`duplicate wmux tool name: ${frozenSpec.name}`);
    }
    names.add(frozenSpec.name);
  }
  return Object.freeze(specs.filter((spec) => spec.profiles.includes(profile)));
}

/**
 * Current-SDK adapter. It preserves the exact legacy wire descriptor while
 * removing one deprecated server.tool() dependency. Authorization remains in
 * RpcRouter/PermissionEnforcer; this adapter only registers and invokes tools.
 */
export function registerWmuxTools(
  server: McpServer,
  specs: readonly WmuxToolSpec[],
  options: RegisterWmuxToolsOptions,
): readonly RegisteredTool[] {
  if (!TOOL_PROFILES.has(options.profile)) {
    throw new Error(`unknown wmux tool profile: ${String(options.profile)}`);
  }
  const context: WmuxOperationContext = Object.freeze({
    principal: Object.freeze({ ...options.context.principal }),
  });
  const selected = selectWmuxTools(specs, options.profile);
  return Object.freeze(
    selected.map((spec) =>
      server.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: toolInputSchema(spec),
        },
        (input: Record<string, unknown>) => spec.invoke(input, context),
      ),
    ),
  );
}
