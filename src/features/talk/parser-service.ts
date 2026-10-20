import { parseCommand } from './command-parser';
import { chatCompletion } from '../../utils/ai-client';
import { MODELS } from '../../utils/ai-models';
// Canonical command-parser prompt (4 few-shot examples) lives in
// src/ai/prompts.js, shared with the Node eval harness.
import { COMMAND_SYSTEM_PROMPT as SYSTEM_PROMPT } from '@/src/ai/prompts';

type ParsedInputError = {
  kind: 'error';
  message: string;
};

type ParsedCommandAction = {
  intent: string;
  summary: string;
  fields: Record<string, string | number>;
};

type ParsedInputSuccess = {
  kind: 'success';
  source: 'rules' | 'ai';
  commands: ParsedCommandAction[];
};

function toAction(parsed: any): ParsedCommandAction {
  if (parsed.intent === 'log_giving') {
    return {
      intent: parsed.intent,
      summary: `Donation to ${parsed.cause}`,
      fields: {
        amount: parsed.amount,
        cause: parsed.cause,
      },
    };
  }

  if (parsed.intent === 'log_gifted_product') {
    return {
      intent: parsed.intent,
      summary: `Gifted ${parsed.quantity} ${parsed.product}`,
      fields: {
        quantity: parsed.quantity,
        product: parsed.product,
      },
    };
  }

  if (parsed.intent === 'create_schedule_item') {
    return {
      intent: parsed.intent,
      summary: parsed.title,
      fields: {
        title: parsed.title,
        time: parsed.time,
      },
    };
  }

  if (parsed.intent === 'ask_what_matters_next') {
    return {
      intent: parsed.intent,
      summary: 'What matters next?',
      fields: {},
    };
  }

  return {
    intent: parsed.intent,
    summary: parsed.habit ?? parsed.habitTitle ?? 'Habit',
    fields: {
      habitTitle: parsed.habit ?? parsed.habitTitle ?? 'Habit',
    },
  };
}

async function parseWithAI(input: string, todayIso: string): Promise<ParsedInputSuccess | ParsedInputError> {
  try {
    const content = await chatCompletion(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Today is ${todayIso}. Message: ${input}` },
      ],
      {
        model: process.env.EXPO_PUBLIC_OPENAI_MODEL || MODELS.VOICE_PARSE,
        response_format: { type: 'json_object' },
      }
    );

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        kind: 'error',
        message: 'AI returned invalid JSON. Try rephrasing your message.',
      };
    }

    if (!parsed?.commands || !Array.isArray(parsed.commands) || parsed.commands.length === 0) {
      return {
        kind: 'error',
        message: 'AI could not extract any commands from that message.',
      };
    }

    // Normalize commands — ensure required fields exist
    const normalized: ParsedCommandAction[] = parsed.commands
      .filter((cmd: any) => cmd && typeof cmd.intent === 'string')
      .map((cmd: any) => ({
        intent: cmd.intent,
        summary: typeof cmd.summary === 'string' ? cmd.summary : cmd.intent,
        fields: cmd.fields && typeof cmd.fields === 'object' ? cmd.fields : {},
      }));

    if (normalized.length === 0) {
      return {
        kind: 'error',
        message: 'AI returned commands in an unexpected format.',
      };
    }

    return {
      kind: 'success',
      source: 'ai',
      commands: normalized,
    };
  } catch (error) {
    console.error('[parser-service] Unexpected error:', error);
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'AI parser failed unexpectedly.',
    };
  }
}

export async function parseInput(input: string, todayIso: string): Promise<ParsedInputSuccess | ParsedInputError> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: 'error', message: 'Please enter a command.' };
  }

  const aiResult = await parseWithAI(trimmed, todayIso);

  if (aiResult.kind === 'success' && aiResult.commands.length > 0) {
    return aiResult;
  }

  // Fallback to rule-based parser
  const parsed = parseCommand(trimmed);

  if (!parsed) {
    // Return the AI error if we have one, otherwise a generic message
    return aiResult.kind === 'error'
      ? aiResult
      : { kind: 'error', message: 'Could not understand that. Try being more specific.' };
  }

  return {
    kind: 'success',
    source: 'rules',
    commands: [toAction(parsed)],
  };
}

export type { ParsedInputSuccess, ParsedInputError, ParsedCommandAction };
