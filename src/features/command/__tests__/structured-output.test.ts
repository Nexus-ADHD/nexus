import { describe, expect, it } from 'vitest';
import { buildCommandResponseFormat, isSchemaValidation400, fallbackBudgetMs } from '../structured-output';

const SCHEMA = { name: 'command_actions', strict: true, schema: { type: 'object' } };

describe('buildCommandResponseFormat', () => {
  it('uses strict json_schema (exact wrapper) for an OpenAI-routable model', () => {
    const rf = buildCommandResponseFormat('gpt-5.4', SCHEMA);
    expect(rf).toEqual({ type: 'json_schema', json_schema: SCHEMA });
    // The wrapper the API expects: strict + name live INSIDE json_schema.
    if (rf.type === 'json_schema') {
      expect(rf.json_schema.name).toBe('command_actions');
      expect(rf.json_schema.strict).toBe(true);
    }
  });

  it('falls back to json_object for a non-OpenAI model (Anthropic route drops response_format)', () => {
    expect(buildCommandResponseFormat('claude-sonnet-5', SCHEMA)).toEqual({ type: 'json_object' });
    expect(buildCommandResponseFormat('gemini-2.5', SCHEMA)).toEqual({ type: 'json_object' });
  });
});

describe('isSchemaValidation400', () => {
  it('is true only for a 400 that names response_format / json_schema / schema', () => {
    expect(
      isSchemaValidation400(new Error('AI request failed (400): Invalid schema for response_format')),
    ).toBe(true);
    expect(isSchemaValidation400(new Error('AI request failed (400): bad json_schema'))).toBe(true);
  });

  it('is false for non-schema errors (auth / outage / timeout / generic 400)', () => {
    expect(isSchemaValidation400(new Error('AI request failed (401): Missing authorization'))).toBe(false);
    expect(isSchemaValidation400(new Error('AI request failed (500): upstream error'))).toBe(false);
    expect(isSchemaValidation400(new Error('AI request failed (400): rate limited'))).toBe(false);
    expect(isSchemaValidation400(new Error('Request timed out'))).toBe(false);
    expect(isSchemaValidation400(null)).toBe(false);
    expect(isSchemaValidation400('some string')).toBe(false);
  });
});

describe('fallbackBudgetMs', () => {
  it('returns the remaining budget when at least the floor is left', () => {
    expect(fallbackBudgetMs(3000, 15000, 1000)).toBe(12000);
    expect(fallbackBudgetMs(14000, 15000, 1000)).toBe(1000); // exactly the floor
  });

  it('returns null when less than the floor remains (a retry would overshoot the deadline)', () => {
    expect(fallbackBudgetMs(14500, 15000, 1000)).toBeNull();
    expect(fallbackBudgetMs(15000, 15000, 1000)).toBeNull();
    expect(fallbackBudgetMs(16000, 15000, 1000)).toBeNull(); // already over
  });
});
