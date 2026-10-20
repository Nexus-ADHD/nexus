/**
 * command-schema.ts — the strict OpenAI Structured-Outputs schema for the
 * command-router call (NEX-317).
 *
 * Replaces legacy `response_format: { type: 'json_object' }` (JSON mode, which
 * the model can still violate) with constrained decoding: the sampler cannot
 * emit a shape the schema forbids. `coerceAction` stays the runtime validator
 * (ranges / enums / cross-field), so this is defense in depth, not a replacement.
 *
 * OpenAI strict-mode rules encoded here (verified against the Structured Outputs
 * guide + Codex review, NEX-317):
 *   - the root is an object (not an array); the payload is `{ actions: [...] }`;
 *   - EVERY property is listed in `required` — optionality is expressed by making
 *     the value nullable (`type: ['x', 'null']`), never by omitting it;
 *   - every object sets `additionalProperties: false`;
 *   - a nullable ENUM is `type: ['string','null']` + `null` included in `enum`;
 *   - a nullable OBJECT (recurrence) uses nested `anyOf: [ {object…}, {null} ]`
 *     rather than `type: ['object','null']` — the guide documents nested anyOf but
 *     shows no nullable-object example, so this is the lower-400-risk form.
 *
 * A malformed strict schema makes OpenAI return 400, which would dead-end EVERY
 * AI-routed capture — so (a) `command-schema.test.ts` asserts strict-well-
 * formedness, (b) `generateProposal` falls open to `json_object` on a schema 400,
 * and (c) the live proxy smoke is a pre-merge gate (only a real call proves it).
 */

// Mirrors ProposedActionType (recurrence.ts) and ALLOWED_TYPES (command-types.ts).
const ACTION_TYPES = [
  'calendar_add',
  'inbox_add',
  'align',
  'recurring_add',
  'todo_add',
  'recurring_todo_add',
] as const;

const nullableString = { type: ['string', 'null'] } as const;
const nullableInt = { type: ['integer', 'null'] } as const;
const nullableIntArray = { type: ['array', 'null'], items: { type: 'integer' } } as const;
const nullableStringArray = { type: ['array', 'null'], items: { type: 'string' } } as const;

const recurrenceSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['frequency', 'interval', 'daysOfWeek'],
      properties: {
        frequency: { type: 'string', enum: ['daily', 'weekly'] },
        interval: nullableInt,
        daysOfWeek: nullableIntArray,
      },
    },
    { type: 'null' },
  ],
} as const;

const actionSchema = {
  type: 'object',
  additionalProperties: false,
  // Strict mode: ALL properties must be required; optionals are nullable above.
  required: [
    'type',
    'title',
    'startISO',
    'endISO',
    'description',
    'daysOfWeek',
    'time',
    'preferredTimeBlock',
    'timesPerDay',
    'nextAction',
    'dateStr',
    'confidence',
    'missingFields',
    'explanation',
    'interval',
    'recurrence',
  ],
  properties: {
    type: { type: 'string', enum: [...ACTION_TYPES] },
    title: { type: 'string' },
    startISO: nullableString,
    endISO: nullableString,
    description: nullableString,
    daysOfWeek: nullableIntArray,
    time: nullableString,
    preferredTimeBlock: {
      type: ['string', 'null'],
      enum: ['morning', 'afternoon', 'evening', 'night', null],
    },
    timesPerDay: nullableInt,
    nextAction: nullableString,
    dateStr: nullableString,
    // NON-nullable on purpose: confidence is always present (prompt rule 12) and
    // GATES safety (low → retry; non-high → no auto-execute). A schema-valid
    // `confidence: null` would coerce to `undefined` and slip past both the low
    // and high tier checks, letting an uncertain action auto-execute (Greptile
    // NEX-317). Forcing one of the three closes that at the decode boundary.
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    missingFields: nullableStringArray,
    explanation: nullableString,
    interval: nullableInt,
    recurrence: recurrenceSchema,
  },
} as const;

/**
 * The value for `response_format.json_schema`. Pass as:
 *   response_format: { type: 'json_schema', json_schema: COMMAND_ACTIONS_JSON_SCHEMA }
 */
export const COMMAND_ACTIONS_JSON_SCHEMA = {
  name: 'command_actions',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['actions'],
    properties: {
      actions: { type: 'array', items: actionSchema },
    },
  },
} as const;
