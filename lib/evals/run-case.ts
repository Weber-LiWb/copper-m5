// Runs one golden-set question through Ask Copper on the Support page (a
// fresh Refund Console with the golden limit) and measures it from the
// ai_calls rows its calls log: cost, requests, and any error.
// An API error or a stream Google cut off is an error, retried and never
// judged. A reply the model chose not to write fails without asking the judge.
import { type AiCallRow, watchAiCalls } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import {
  AGENT_NAMES,
  FALLBACK_REPLY,
  toolCallsOf,
} from "@/lib/copper/assistant/progress";
import type { Variant } from "@/lib/copper/assistant/variants";
import { GOLDEN_LIMIT_USD, type GoldenCase } from "@/lib/evals/golden-set";
import type { CaseAnswer } from "@/lib/evals/judge";
import type { CaseResult } from "@/lib/evals/summary";

export type CaseRun = CaseResult & CaseAnswer & { agents: string[] };

export const CUT_OFF = "Gemini cut the reply off (no finish reason)";

export async function runCase(
  c: GoldenCase,
  variant: Variant,
  sessionId: string,
): Promise<CaseRun> {
  const rows: AiCallRow[] = [];
  const stop = watchAiCalls((row) => rows.push(row));
  const started = performance.now();
  try {
    const { progress } = await askCopper({
      messages: [{ role: "user", content: c.question }],
      useTools: true,
      desk: { limitUsd: GOLDEN_LIMIT_USD, refunds: [] },
      sessionId,
      variant,
    });
    const final = await finalValue(progress);
    const latencyMs = Math.round(performance.now() - started);
    const failed = rows.find((row) => !row.ok);
    const cutOff = rows.some((row) => row.finish_reasons?.includes(null));
    const error = failed
      ? (failed.error ?? "A model call failed.")
      : cutOff
        ? CUT_OFF
        : final.status !== "done"
          ? "The agent stopped with an error."
          : undefined;
    const ok = !error;
    const noReply = ok && final.reply === FALLBACK_REPLY;
    const agents = [
      final.steps.find((s) => s.type === "handoff")?.from ?? final.agent,
      ...final.steps.flatMap((s) => (s.type === "handoff" ? [s.to] : [])),
    ].map((agent) => AGENT_NAMES[agent ?? "copper"]);
    return {
      id: c.id,
      status: ok ? "answered" : "error",
      reply: final.reply,
      answeredBy: AGENT_NAMES[final.agent ?? "copper"],
      agents,
      toolCalls: toolCallsOf(final),
      ...(ok && { latencyMs }),
      costUsd: rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      ...(error && { error }),
      ...(noReply && {
        verdict: {
          pass: false,
          score: 0,
          reason: `No reply: the model stopped without writing one (Google's finish reasons: ${rows.flatMap((r) => r.finish_reasons ?? []).join(", ")}).`,
        },
      }),
    };
  } finally {
    stop();
  }
}
