import { describe, expect, it } from 'vitest';
import { COMMAND_ACTIONS_JSON_SCHEMA } from '../command-schema';

// A local-only check that the schema obeys OpenAI strict-mode structural rules.
// It CANNOT prove API acceptance (only a live call does — the documented pre-merge
// gate), but it catches the mistakes that would 400 every command: a missing
// additionalProperties:false, a `required` that doesn't list every property, or a
// nullable value/enum that forgot its null. (Codex NEX-317 findings #2, #4.)

type Node = Record<string, any>;

function walk(node: Node, path: string, visit: (n: Node, p: string) => void): void {
  if (!node || typeof node !== 'object') return;
  visit(node, path);
  if (node.properties) {
    for (const key of Object.keys(node.properties)) {
      walk(node.properties[key], `${path}.${key}`, visit);
    }
  }
  if (node.items) walk(node.items, `${path}[]`, visit);
  if (Array.isArray(node.anyOf)) {
    node.anyOf.forEach((branch: Node, i: number) => walk(branch, `${path}|anyOf[${i}]`, visit));
  }
}

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
]);

describe('COMMAND_ACTIONS_JSON_SCHEMA — OpenAI strict-mode well-formedness', () => {
  const root = COMMAND_ACTIONS_JSON_SCHEMA.schema as Node;

  it('is wrapped correctly: named, strict, object root with an actions array', () => {
    expect(COMMAND_ACTIONS_JSON_SCHEMA.name).toBe('command_actions');
    expect(COMMAND_ACTIONS_JSON_SCHEMA.strict).toBe(true);
    expect(root.type).toBe('object');
    expect(root.required).toEqual(['actions']);
    expect((root.properties as Node).actions.type).toBe('array');
  });

  it('every object lists additionalProperties:false and requires ALL its properties', () => {
    walk(root, 'schema', (n, p) => {
      const isObject = n.type === 'object' || (n.properties && n.type !== 'array');
      if (n.properties && isObject) {
        expect(n.additionalProperties, `${p} additionalProperties`).toBe(false);
        expect(new Set(n.required ?? []), `${p} required set`).toEqual(
          new Set(Object.keys(n.properties)),
        );
      }
    });
  });

  it('every nullable enum includes null; a non-null enum does not', () => {
    walk(root, 'schema', (n, p) => {
      if (!Array.isArray(n.enum)) return;
      const typeAllowsNull = Array.isArray(n.type) ? n.type.includes('null') : n.type === 'null';
      const enumHasNull = n.enum.includes(null);
      expect(enumHasNull, `${p} enum/type null agreement`).toBe(typeAllowsNull);
    });
  });

  it('uses only OpenAI-supported schema keywords', () => {
    walk(root, 'schema', (n, p) => {
      for (const key of Object.keys(n)) {
        expect(SUPPORTED_KEYWORDS.has(key), `${p} unsupported keyword "${key}"`).toBe(true);
      }
    });
  });

  it('constrains the action type to the six allowed types', () => {
    const action = (root.properties as Node).actions.items as Node;
    expect(action.properties.type.enum).toEqual([
      'calendar_add',
      'inbox_add',
      'align',
      'recurring_add',
      'todo_add',
      'recurring_todo_add',
    ]);
  });

  it('keeps confidence NON-nullable so it can always gate safety (never null→undefined)', () => {
    const action = (root.properties as Node).actions.items as Node;
    expect(action.properties.confidence.type).toBe('string');
    expect(action.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
  });
});
