// The eval's numbers (Module 5): pass rate, cost and speed for one run, the
// pass/fail gate CI uses, and the Markdown table CI shows in the pull
// request's checks.
import type { GoldenCase } from "@/lib/evals/golden-set";
import type { Verdict } from "@/lib/evals/judge";

export type CaseResult = {
  id: string;
  /**
   * answered: judged, pass or fail. error: the agent's or the judge's call
   * failed (a 503, a reply cut off), so there's no grade; it counts as not
   * passed.
   */
  status: "answered" | "error";
  answeredBy?: string;
  verdict?: Verdict;
  /** The agent's time to answer, without pacing, retries or the judge. */
  latencyMs?: number;
  /** The agent's calls only; the judge's are counted separately. */
  costUsd: number;
  requests: number;
  error?: string;
};

export type RunSummary = {
  total: number;
  passed: number;
  /** Cases with no grade: an API error, a cut-off reply, or never run. */
  errors: number;
  /** passed / total. A case with no result (skipped, crashed) counts as failed. */
  passRate: number;
  avgScore: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  requests: number;
};

export function summarize(
  cases: GoldenCase[],
  results: CaseResult[],
): RunSummary {
  const byId = new Map(results.map((r) => [r.id, r]));
  const ran = cases.flatMap((c) => byId.get(c.id) ?? []);
  const passed = ran.filter((r) => r.verdict?.pass).length;
  const answered = ran.filter((r) => r.latencyMs !== undefined);
  const total = cases.length;
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    total,
    passed,
    errors: total - ran.filter((r) => r.status === "answered").length,
    passRate: total ? passed / total : 0,
    avgScore: total ? sum(ran.map((r) => r.verdict?.score ?? 0)) / total : 0,
    totalCostUsd: sum(ran.map((r) => r.costUsd)),
    avgLatencyMs: answered.length
      ? sum(answered.map((r) => r.latencyMs!)) / answered.length
      : 0,
    requests: sum(ran.map((r) => r.requests)),
  };
}

/** Reads a threshold like "0.8" or "80%" as a fraction from 0 to 1. */
export function parseThreshold(value: string | undefined, fallback = 0.8) {
  const text = value?.trim();
  if (!text) return fallback;
  const number = text.endsWith("%")
    ? Number(text.slice(0, -1)) / 100
    : Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1)
    throw new Error(`Threshold "${value}" must be from 0 to 1, or a percent.`);
  return number;
}

export function meetsThreshold(passRate: number, threshold: number) {
  // 0.7 + 0.1 is 0.7999999999999999, so allow for rounding.
  return passRate + 1e-9 >= threshold;
}

/** A Gemini quota or rate-limit error: the run stops instead of retrying. */
export function isQuotaError(text: string | undefined): boolean {
  return Boolean(
    text && /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i.test(text),
  );
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (value: number) => `$${value.toFixed(4)}`;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function summaryMarkdown(run: {
  title: string;
  runName: string;
  model: string;
  threshold: number;
  cases: GoldenCase[];
  results: CaseResult[];
  summary: RunSummary;
  judgeRequests: number;
  judgeCostUsd: number;
  url?: string;
  stopped?: string;
}): string {
  const { summary } = run;
  const gate = meetsThreshold(summary.passRate, run.threshold)
    ? "passed"
    : "failed";
  const byId = new Map(run.results.map((r) => [r.id, r]));
  const rows = run.cases.map((c) => {
    const r = byId.get(c.id);
    const result = !r
      ? "not run"
      : r.status === "error"
        ? "error"
        : r.verdict?.pass
          ? "pass"
          : "fail";
    return `| ${c.id} | ${result} | ${r?.verdict ? r.verdict.score.toFixed(2) : "–"} | ${r?.answeredBy ?? "–"} | ${r?.latencyMs !== undefined ? seconds(r.latencyMs) : "–"} | ${r ? usd(r.costUsd) : "–"} | ${cell(r?.verdict?.reason ?? r?.error ?? "")} |`;
  });
  return [
    `## ${run.title}`,
    "",
    `**Pass rate: ${summary.passed}/${summary.total} (${percent(summary.passRate)})**, threshold ${percent(run.threshold)}: **${gate}**${summary.errors ? ` · ${summary.errors} not graded (errors)` : ""}`,
    "",
    `Run \`${run.runName}\` · model and judge \`${run.model}\` · average judge score ${summary.avgScore.toFixed(2)}`,
    "",
    `Total cost ${usd(summary.totalCostUsd)} · average latency ${seconds(summary.avgLatencyMs)} per case (the agents only: no pacing, retries or judge)`,
    "",
    `Gemini requests: ${summary.requests} by the agents, ${run.judgeRequests} by the judge (${usd(run.judgeCostUsd)})`,
    ...(run.stopped ? ["", `**Stopped early:** ${run.stopped}`] : []),
    ...(run.url ? ["", `Langfuse: ${run.url}`] : []),
    "",
    "| Case | Result | Score | Answered by | Latency | Cost | Judge's reason |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
