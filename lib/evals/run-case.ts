// Runs one golden-set question through Ask Copper on the Support page (a
// fresh Refund Console with the golden limit) and measures it from the
// ai_calls rows its calls log: cost, requests, and any error.
import { type AiCallRow, watchAiCalls } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { AGENT_NAMES, toolCallsOf } from "@/lib/copper/assistant/progress";
import type { Variant } from "@/lib/copper/assistant/variants";
import { GOLDEN_LIMIT_USD, type GoldenCase } from "@/lib/evals/golden-set";
import type { CaseAnswer } from "@/lib/evals/judge";
import type { CaseResult } from "@/lib/evals/summary";

export type CaseRun = CaseResult & CaseAnswer & { agents: string[] };

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
    const ok = final.status === "done" && !failed;
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
      ...(!ok && {
        error: failed?.error ?? "The agent stopped with an error.",
      }),
    };
  } finally {
    stop();
  }
}
