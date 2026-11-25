// npm run eval -- --variant multi --threshold 0.8
// Runs the golden set (lib/evals/golden-set.ts) through Ask Copper as one
// Langfuse dataset run: each case is a trace, the AI judge's pass and score
// go to Langfuse as scores, and the run gets its pass rate, cost and latency.
// It prints a summary (and writes it to the GitHub Actions job summary) and
// exits non-zero when the pass rate is under the threshold.
//
// Options: --variant multi|single (default multi), --threshold 0.8 or 80%,
// --run-name NAME (default: variant and time), --cases id,id (a subset, for a
// smoke test), --gap-seconds 30 (the least time from one case's start to the
// next, so calls stay under Gemini's per-minute limit).
import { appendFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { LangfuseClient } from "@langfuse/client";
import { type AiCallRow, watchAiCalls } from "@/lib/ai/call";
import { defaultModel } from "@/lib/ai/models";
import { startTracing, stopTracing, traceTurn } from "@/lib/ai/tracing";
import {
  parseVariant,
  VARIANT_LABELS,
  type Variant,
} from "@/lib/copper/assistant/variants";
import { GOLDEN_SET, type GoldenCase } from "@/lib/evals/golden-set";
import { judgeAnswer } from "@/lib/evals/judge";
import { isTransientError, retrying } from "@/lib/evals/retry";
import { type CaseRun, runCase } from "@/lib/evals/run-case";
import {
  isQuotaError,
  meetsThreshold,
  parseThreshold,
  summarize,
  summaryMarkdown,
} from "@/lib/evals/summary";

const DATASET = "copper-golden-set";
/** Retries for a 503 "high demand", per case or judge call and per run. */
const RETRIES = 2;
const RUN_RETRIES = 4;
const RETRY_WAIT_MS = 20_000;
const REQUIRED = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
// A quota error should stop the run, not be retried with more calls.
process.env.AI_MAX_RETRIES ??= "0";

const { values: args } = parseArgs({
  options: {
    variant: { type: "string" },
    threshold: { type: "string" },
    "run-name": { type: "string" },
    cases: { type: "string" },
    "gap-seconds": { type: "string" },
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Adds or updates the dataset's items, only where the golden set changed. */
async function syncDataset(langfuse: LangfuseClient) {
  try {
    await langfuse.api.datasets.get(DATASET);
  } catch {
    await langfuse.api.datasets.create({
      name: DATASET,
      description:
        "Ask Copper's golden set: Support page questions and what a good answer does (lib/evals/golden-set.ts).",
    });
  }
  const existing = await langfuse.dataset.get(DATASET);
  for (const c of GOLDEN_SET) {
    const id = `copper-golden-${c.id}`;
    const input = { question: c.question };
    const item = existing.items.find((i) => i.id === id);
    if (
      item &&
      JSON.stringify(item.input) === JSON.stringify(input) &&
      item.expectedOutput === c.expected
    )
      continue;
    await langfuse.api.datasetItems.create({
      datasetName: DATASET,
      id,
      input,
      expectedOutput: c.expected,
      metadata: { caseId: c.id, category: c.category },
    });
  }
  return langfuse.dataset.get(DATASET);
}

async function main() {
  const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Set ${missing.join(", ")} in .env.local (or the repo's Actions secrets).`,
    );
  const variant: Variant = parseVariant(
    args.variant ?? process.env.EVAL_VARIANT,
  );
  const threshold = parseThreshold(
    args.threshold ?? process.env.EVAL_THRESHOLD,
  );
  const gapMs =
    Number(args["gap-seconds"] ?? process.env.EVAL_GAP_SECONDS ?? 30) * 1000;
  const wanted = args.cases?.split(",").map((id) => id.trim());
  const cases: GoldenCase[] = wanted
    ? GOLDEN_SET.filter((c) => wanted.includes(c.id))
    : GOLDEN_SET;
  if (!cases.length)
    throw new Error(`No golden-set case matches ${args.cases}.`);
  const model = defaultModel();
  const runName =
    args["run-name"] ??
    `${variant}-agent ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  // Everything that can fail without spending a Gemini call goes first.
  const langfuse = new LangfuseClient();
  await langfuse.api.projects.get().catch((error) => {
    throw new Error(
      `Langfuse refused the keys (check LANGFUSE_BASE_URL's region): ${error instanceof Error ? error.message : error}`,
    );
  });
  startTracing();
  const dataset = await syncDataset(langfuse);
  const itemId = (c: GoldenCase) => `copper-golden-${c.id}`;
  const items = cases.flatMap(
    (c) => dataset.items.find((item) => item.id === itemId(c)) ?? [],
  );

  const all: AiCallRow[] = [];
  watchAiCalls((row) => all.push(row));
  const results = new Map<string, CaseRun>();
  const startedAt = new Map<string, number>();
  let stopped: string | undefined;
  let retriesLeft = RUN_RETRIES;
  const retryOptions = (what: string) => ({
    retries: Math.min(RETRIES, retriesLeft),
    waitMs: RETRY_WAIT_MS,
    onRetry: (error: string, attempt: number) => {
      retriesLeft--;
      console.log(`  ${what} retry ${attempt} after: ${error}`);
    },
  });
  // Pacing happens in the evaluator, after the case's trace has ended, so it
  // never counts toward the latency Langfuse shows.
  const pace = async (c: GoldenCase) => {
    if (stopped || c.id === cases.at(-1)?.id) return;
    const waited = performance.now() - (startedAt.get(c.id) ?? 0);
    await sleep(Math.max(0, gapMs - waited));
  };
  // A run that keeps failing measures Gemini's load, not Ask Copper, so once
  // the run's retries are spent, the next transient error stops it.
  const stopIfStuck = (error: string | undefined) => {
    if (isQuotaError(error)) stopped = `Gemini quota error: ${error}`;
    else if (isTransientError(error) && retriesLeft <= 0)
      stopped = `Gemini kept failing after ${RUN_RETRIES} retries: ${error}`;
  };
  const caseOf = (id: string | undefined) => {
    const c = cases.find((g) => itemId(g) === id);
    if (!c) throw new Error(`Unknown dataset item ${id}.`);
    return c;
  };

  console.log(
    `Running ${cases.length} cases as ${VARIANT_LABELS[variant]} on ${model}, run "${runName}".`,
  );
  const experiment = await langfuse.experiment.run({
    name: "Ask Copper golden set",
    runName,
    description: `${VARIANT_LABELS[variant]} on ${model}, judged by ${model}.`,
    metadata: { variant, model, judge: model, threshold },
    data: items,
    maxConcurrency: 1,
    task: async (item) => {
      if (stopped) throw new Error(`Skipped: ${stopped}`);
      const c = caseOf("id" in item ? item.id : undefined);
      startedAt.set(c.id, performance.now());
      const tries = await retrying(
        () => runCase(c, variant, runName),
        (r) => (r.status === "error" ? r.error : undefined),
        retryOptions(c.id),
      );
      // Cost counts every try, as Langfuse does; latency is the last try's.
      const run: CaseRun = {
        ...tries.at(-1)!,
        costUsd: tries.reduce((sum, t) => sum + t.costUsd, 0),
        requests: tries.reduce((sum, t) => sum + t.requests, 0),
      };
      results.set(c.id, run);
      console.log(
        `${c.id}: ${run.status}, ${run.answeredBy}, ${run.requests} requests${tries.length > 1 ? ` in ${tries.length} tries` : ""}${run.error ? `, ${run.error}` : ""}`,
      );
      if (run.status === "error") stopIfStuck(run.error);
      return {
        reply: run.reply,
        answeredBy: run.answeredBy,
        agents: run.agents,
        toolCalls: run.toolCalls,
        status: run.status,
        latencyMs: run.latencyMs,
        costUsd: run.costUsd,
        ...(run.error && { error: run.error }),
      };
    },
    evaluators: [
      async ({ metadata }) => {
        const c = cases.find((g) => g.id === metadata?.caseId);
        const run = c && results.get(c.id);
        if (!c || !run) return [];
        if (run.status !== "answered" || stopped) {
          await pace(c);
          return [
            {
              name: "passed",
              value: 0,
              dataType: "BOOLEAN",
              comment: `Not judged: ${run.error ?? stopped}`,
            },
          ];
        }
        // No reply to grade: runCase already failed it, without a judge call.
        if (run.verdict) {
          console.log(`  no reply: ${run.verdict.reason}`);
          await pace(c);
          return [
            {
              name: "passed",
              value: 0,
              dataType: "BOOLEAN",
              comment: run.verdict.reason,
            },
          ];
        }
        const judge = () => {
          const before = all.length;
          return traceTurn(
            {
              name: "eval-judge",
              sessionId: runName,
              input: { case: c.id, reply: run.reply },
              tags: ["judge", `${variant}-agent`],
            },
            async (turn) => {
              const verdict = await judgeAnswer(c, run);
              turn.update({ output: verdict });
              return verdict;
            },
          )
            .then((verdict) => ({ verdict, error: undefined }))
            .catch((error) => ({
              verdict: undefined,
              error:
                all.slice(before).find((row) => !row.ok)?.error ??
                String(error),
            }));
        };
        const judged = (
          await retrying(judge, (r) => r.error, retryOptions(`${c.id} judge`))
        ).at(-1)!;
        if (!judged.verdict) {
          const message = judged.error ?? "no verdict";
          run.status = "error";
          run.error = `Judge failed: ${message}`;
          stopIfStuck(message);
          await pace(c);
          return [
            {
              name: "passed",
              value: 0,
              dataType: "BOOLEAN",
              comment: run.error,
            },
          ];
        }
        run.verdict = judged.verdict;
        console.log(
          `  judge: ${run.verdict.pass ? "pass" : "fail"} (${run.verdict.score}) ${run.verdict.reason}`,
        );
        await pace(c);
        return [
          {
            name: "passed",
            value: run.verdict.pass ? 1 : 0,
            dataType: "BOOLEAN",
            comment: run.verdict.reason,
          },
          {
            name: "judge_score",
            value: run.verdict.score,
            dataType: "NUMERIC",
            comment: run.verdict.reason,
          },
        ];
      },
    ],
    runEvaluators: [
      async () => {
        const summary = summarize(cases, [...results.values()]);
        return [
          {
            name: "pass_rate",
            value: summary.passRate,
            comment: `${summary.passed}/${summary.total} cases passed`,
          },
          {
            name: "total_cost_usd",
            value: summary.totalCostUsd,
            comment: "The agents' calls, priced with lib/ai/pricing.ts",
          },
          {
            name: "avg_latency_s",
            value: summary.avgLatencyMs / 1000,
            comment: "Per answered case; no pacing, retries or judge",
          },
        ];
      },
    ],
  });

  await langfuse.flush();
  await stopTracing();

  const caseIds = new Set(cases.map((c) => c.id));
  const judgeRows = all.filter((row) => row.feature === "eval-judge");
  const summary = summarize(
    cases,
    [...results.values()].filter((r) => caseIds.has(r.id)),
  );
  const markdown = summaryMarkdown({
    title: `Golden-set eval: ${VARIANT_LABELS[variant]}`,
    runName,
    model,
    threshold,
    cases,
    results: [...results.values()],
    summary,
    judgeRequests: judgeRows.reduce((sum, row) => sum + row.requests, 0),
    judgeCostUsd: judgeRows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    url: experiment.experimentUrl,
    stopped,
  });
  console.log(`\n${markdown}`);
  console.log(
    `Gemini requests this run: ${all.reduce((sum, row) => sum + row.requests, 0)}`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  const passed = !stopped && meetsThreshold(summary.passRate, threshold);
  const line = `Pass rate ${summary.passed}/${summary.total} (threshold ${Math.round(threshold * 100)}%)`;
  if (process.env.GITHUB_ACTIONS)
    console.log(
      `::${passed ? "notice" : "error"} title=Golden-set eval::${line}`,
    );
  process.exitCode = passed ? 0 : 1;
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await stopTracing().catch(() => {});
  process.exitCode = 1;
});
