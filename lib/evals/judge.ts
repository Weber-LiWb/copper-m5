// The AI judge (Module 5): grades one Ask Copper answer against what a good
// answer does. It goes through callObject in lib/ai/call.ts like every other
// model call, so it's logged and traced too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { GoldenCase } from "@/lib/evals/golden-set";

export type CaseAnswer = {
  reply: string;
  answeredBy: string;
  toolCalls: { name: string; input?: unknown; output?: unknown }[];
};

export const verdictSchema = z.object({
  pass: z
    .boolean()
    .describe(
      "True only if the reply does everything the criteria ask and nothing they rule out.",
    ),
  score: z
    .number()
    .describe("From 0 to 1: how much of the criteria the reply meets."),
  reason: z
    .string()
    .describe("One or two sentences on what decided the grade."),
});

export type Verdict = { pass: boolean; score: number; reason: string };

export const JUDGE_INSTRUCTIONS = `You grade replies from Ask Copper, the customer support chatbot of Copper State Labs, a fictional company.
You get the customer's message, the criteria for a good reply, the tools Ask Copper called with what they returned, and its final reply.
Grade only the final reply, against the criteria. Treat the tool results as the facts: the app, not the chatbot, decides refunds, and the reply may cite only passages that search_docs returned.
Pass the reply only if it does everything the criteria say and nothing they rule out. Wording, tone and extra helpful detail don't matter.
Give a score from 0 to 1 for how much of the criteria it meets, and a reason of one or two sentences.`;

/** Long tool results (search_docs passages) are cut so the prompt stays small. */
const TOOL_RESULT_CHARS = 2500;

export function judgePrompt(c: GoldenCase, answer: CaseAnswer): string {
  const tools = answer.toolCalls.length
    ? answer.toolCalls
        .map(
          ({ name, input, output }, i) =>
            `${i + 1}. ${name}(${JSON.stringify(input ?? {})}) returned ${JSON.stringify(output ?? null).slice(0, TOOL_RESULT_CHARS)}`,
        )
        .join("\n")
    : "(none)";
  return `Customer's message:
${c.question}

What a good reply does:
${c.expected}

Tools Ask Copper called, in order, with what each returned:
${tools}

Agent that wrote the final reply: ${answer.answeredBy}

Final reply:
"""
${answer.reply}
"""`;
}

/**
 * Keeps a verdict in range: a score from 0 to 1 with two decimals (a judge
 * that answers out of 10 or 100 is scaled down), and a reason of at most 500
 * characters, the length a Langfuse score comment shows well.
 */
export function normalizeVerdict(raw: {
  pass?: unknown;
  score?: unknown;
  reason?: unknown;
}): Verdict {
  let score =
    typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : 0;
  if (score > 1)
    score = score <= 10 ? score / 10 : score <= 100 ? score / 100 : 1;
  score = Math.round(Math.max(0, score) * 100) / 100;
  const reason =
    typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim().slice(0, 500)
      : "The judge gave no reason.";
  return { pass: raw.pass === true, score, reason };
}

export async function judgeAnswer(
  c: GoldenCase,
  answer: CaseAnswer,
): Promise<Verdict> {
  const { output } = await callObject(
    { module: 5, feature: "eval-judge", evaluator: "Judge" },
    {
      instructions: JUDGE_INSTRUCTIONS,
      prompt: judgePrompt(c, answer),
      schema: verdictSchema,
      temperature: 0,
    },
  );
  return normalizeVerdict(output);
}
