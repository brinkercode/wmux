import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  defineWmuxTool,
  registerWmuxTools,
  selectWmuxTools,
  toolInputSchema,
  type WmuxOperationContext,
  type WmuxToolProfile,
  type WmuxToolSpec,
} from '../toolCatalog';

function makeTool(
  name: string,
  profiles: readonly WmuxToolProfile[] = ['full'],
): WmuxToolSpec {
  return defineWmuxTool({
    name,
    description: `${name} description`,
    inputSchema: {
      value: z.string().describe('Value'),
    },
    profiles,
    invoke: async ({ value }, context) => ({
      content: [
        {
          type: 'text',
          text:
            `${value}:${context.principal.kind}:` +
            `${Object.isFrozen(context)}:${Object.isFrozen(context.principal)}`,
        },
      ],
    }),
  });
}

describe('typed wmux tool catalog', () => {
  it('preserves declaration order while selecting an immutable profile', () => {
    const fullOnly = makeTool('full_only');
    const shared = makeTool('shared', ['full', 'commander']);
    const commander = selectWmuxTools([fullOnly, shared], 'commander');

    expect(commander.map((spec) => spec.name)).toEqual(['shared']);
    expect(Object.isFrozen(commander)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.profiles)).toBe(true);
    expect(Object.isFrozen(shared.inputSchema)).toBe(true);
  });

  it('freezes plain descriptors at the registry boundary even when the helper is bypassed', () => {
    const inputSchema = { value: z.string() };
    const profiles: WmuxToolProfile[] = ['full'];
    const plainSpec: WmuxToolSpec = {
      name: 'plain',
      description: 'Plain descriptor',
      inputSchema,
      profiles,
      invoke: async ({ value }) => ({
        content: [{ type: 'text', text: String(value) }],
      }),
    };

    selectWmuxTools([plainSpec], 'full');

    expect(Object.isFrozen(plainSpec)).toBe(true);
    expect(Object.isFrozen(inputSchema)).toBe(true);
    expect(Object.isFrozen(profiles)).toBe(true);
  });

  it('fails before filtering when any profile contains a duplicate name', () => {
    const duplicate = makeTool('duplicate', ['full', 'commander']);
    expect(() => selectWmuxTools([duplicate, duplicate], 'core')).toThrow(
      'duplicate wmux tool name: duplicate',
    );
  });

  it('selects core independently of commander and keeps declaration order', () => {
    const fullOnly = makeTool('full_only');
    const coreOnly = makeTool('core_only', ['full', 'core']);
    const shared = makeTool('shared', ['full', 'core', 'commander']);
    const specs = [fullOnly, coreOnly, shared];

    expect(selectWmuxTools(specs, 'core').map((spec) => spec.name)).toEqual([
      'core_only',
      'shared',
    ]);
    // commander stays the narrower surface: core membership never widens it.
    expect(selectWmuxTools(specs, 'commander').map((spec) => spec.name)).toEqual([
      'shared',
    ]);
    expect(selectWmuxTools(specs, 'full').map((spec) => spec.name)).toEqual([
      'full_only',
      'core_only',
      'shared',
    ]);
  });

  it('requires full to remain the catalog superset', () => {
    expect(() => makeTool('commander_only', ['commander'])).toThrow(
      'the full profile must remain a superset',
    );
  });

  it('registers only the legacy wire fields and injects explicit operation context', async () => {
    const registrations: Array<{
      name: string;
      config: Record<string, unknown>;
      handler: (input: Record<string, unknown>) => unknown;
    }> = [];
    const server = {
      registerTool: (
        name: string,
        config: Record<string, unknown>,
        handler: (input: Record<string, unknown>) => unknown,
      ) => {
        registrations.push({ name, config, handler });
        return { name };
      },
    };
    const context: WmuxOperationContext = {
      principal: { kind: 'unattributed' },
    };
    const fullOnly = makeTool('full_only');
    const shared = makeTool('shared', ['full', 'commander']);

    const registered = registerWmuxTools(
      server as never,
      [fullOnly, shared],
      { profile: 'commander', context },
    );

    expect(registrations.map(({ name }) => name)).toEqual(['shared']);
    expect(registrations[0]?.config).toEqual({
      description: 'shared description',
      inputSchema: shared.inputSchema,
    });
    expect(registrations[0]?.config).not.toHaveProperty('title');
    expect(registrations[0]?.config).not.toHaveProperty('annotations');
    expect(registrations[0]?.config).not.toHaveProperty('outputSchema');
    (context.principal as { kind: string }).kind = 'forged';
    await expect(registrations[0]?.handler({ value: 'ok' })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok:unattributed:true:true' }],
    });
    expect(Object.isFrozen(registered)).toBe(true);
  });

  it('registers a strictInput tool with a schema that names the unknown key and the valid ones', () => {
    const spec = defineWmuxTool({
      name: 'strict_tool',
      description: 'Strict tool',
      inputSchema: {
        value: z.string(),
        count: z.number().optional(),
      },
      strictInput: true,
      profiles: ['full'],
      invoke: async (input) => ({
        content: [{ type: 'text', text: input.value }],
      }),
    });
    const schema = toolInputSchema(spec);
    expect(schema).toBeInstanceOf(z.ZodObject);

    const rejected = (schema as z.ZodObject).safeParse({ value: 'a', valeu: 'b' });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0]?.message).toBe(
      'unknown option "valeu"; valid: value, count',
    );

    // Known keys keep their exact meaning, optional ones included.
    expect((schema as z.ZodObject).safeParse({ value: 'a', count: 2 })).toEqual({
      success: true,
      data: { value: 'a', count: 2 },
    });
    // A wrong type still reads as a type error, not an unknown option.
    const typeError = (schema as z.ZodObject).safeParse({ value: 1 });
    expect(typeError.error?.issues[0]?.message).toContain('expected string');
  });

  it('tells a no-option tool apart from one whose options were all misspelled', () => {
    const spec = defineWmuxTool({
      name: 'no_option_tool',
      description: 'No option tool',
      inputSchema: {},
      strictInput: true,
      profiles: ['full'],
      invoke: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const schema = toolInputSchema(spec) as z.ZodObject;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ session: 'x' }).error?.issues[0]?.message).toBe(
      'unknown option "session"; this tool takes no options',
    );
  });

  it('leaves a tool that did not opt in on the SDK default raw shape', () => {
    const spec = makeTool('lenient_tool');
    expect(toolInputSchema(spec)).toBe(spec.inputSchema);
  });

  it('preserves literal names and exact Zod input inference at the authoring boundary', () => {
    const spec = defineWmuxTool({
      name: 'typed_tool',
      description: 'Typed tool',
      inputSchema: {
        value: z.string(),
        direction: z.enum(['horizontal', 'vertical']),
      },
      profiles: ['full'],
      invoke: async (input) => {
        expectTypeOf(input).toEqualTypeOf<{
          value: string;
          direction: 'horizontal' | 'vertical';
        }>();
        return { content: [{ type: 'text', text: input.value }] };
      },
    });

    expectTypeOf(spec.name).toEqualTypeOf<'typed_tool'>();
  });
});
