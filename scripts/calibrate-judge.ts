// npm run calibrate-judge
// Checks the AI judge against replies whose right grade is known
// (lib/evals/judge-calibration.ts), as a run on the Langfuse dataset
// judge-calibration/copper-judge. Each item gets a judge-output-correct score;
// the run gets the judge's accuracy. One judge call per example.
import { existsSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { type AiCallRow, watchAiCalls } from "@/lib/ai/call";
import { startTracing, stopTracing } from "@/lib/ai/tracing";
import {
  CALIBRATION,
  type CalibrationExample,
  caseFor,
} from "@/lib/evals/judge-calibration";
import { judgeAnswer, type Verdict } from "@/lib/evals/judge";
import { retrying } from "@/lib/evals/retry";
import { isQuotaError } from "@/lib/evals/summary";

const DATASET = "judge-calibration/copper-judge";
const GAP_MS = 8_000;

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.AI_MAX_RETRIES ??= "0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const langfuse = new LangfuseClient();
  await langfuse.api.projects.get();
  startTracing({ global: true });
  try {
    await langfuse.api.datasets.get(DATASET);
  } catch {
    await langfuse.api.datasets.create({
      name: DATASET,
      description:
        "Replies with known grades, to check Ask Copper's AI judge (lib/evals/judge-calibration.ts).",
    });
  }
  for (const example of CALIBRATION)
    await langfuse.api.datasetItems.create({
      datasetName: DATASET,
      id: `copper-judge-${example.id}`,
      input: { caseId: example.caseId, ...example.answer },
      expectedOutput: { pass: example.pass },
      metadata: { why: example.why },
    });
  const dataset = await langfuse.dataset.get(DATASET);
  const exampleOf = (id: string) =>
    CALIBRATION.find((e) => `copper-judge-${e.id}` === id)!;
  const items = CALIBRATION.flatMap(
    (e) => dataset.items.find((i) => i.id === `copper-judge-${e.id}`) ?? [],
  );

  const rows: AiCallRow[] = [];
  watchAiCalls((row) => rows.push(row));
  const verdicts = new Map<string, Verdict | string>();
  let stopped: string | undefined;

  const result = await langfuse.experiment.run({
    name: "Judge calibration",
    runName: `copper-judge ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    description: "Ask Copper's judge on replies with known grades.",
    data: items,
    maxConcurrency: 1,
    task: async (item) => {
      if (stopped) throw new Error(stopped);
      const example: CalibrationExample = exampleOf(
        "id" in item ? item.id : "",
      );
      const started = performance.now();
      const tries = await retrying(
        () =>
          judgeAnswer(caseFor(example), example.answer).catch(
            (error) => rows.findLast((row) => !row.ok)?.error ?? String(error),
          ),
        (r) => (typeof r === "string" ? r : undefined),
        { retries: 2, waitMs: 20_000 },
      );
      const verdict = tries.at(-1)!;
      verdicts.set(example.id, verdict);
      if (typeof verdict === "string" && isQuotaError(verdict))
        stopped = `Gemini quota error: ${verdict}`;
      await sleep(Math.max(0, GAP_MS - (performance.now() - started)));
      return verdict;
    },
    evaluators: [
      async ({ output, expectedOutput }) => ({
        name: "judge-output-correct",
        value:
          typeof output === "object" &&
          output.pass === (expectedOutput as { pass: boolean }).pass
            ? 1
            : 0,
        dataType: "BOOLEAN",
      }),
    ],
    runEvaluators: [
      async ({ itemResults }) => {
        const correct = itemResults.filter(
          (r) => r.evaluations[0]?.value === 1,
        ).length;
        return {
          name: "judge_accuracy",
          value: correct / CALIBRATION.length,
          comment: `${correct}/${CALIBRATION.length} grades match the labels`,
        };
      },
    ],
  });
  await langfuse.flush();
  await stopTracing();

  let correct = 0;
  console.log("| Example | Label | Judge | Match | Judge's reason |");
  console.log("|---|---|---|---|---|");
  for (const example of CALIBRATION) {
    const verdict = verdicts.get(example.id);
    const graded = typeof verdict === "object";
    const match = graded && verdict.pass === example.pass;
    if (match) correct++;
    console.log(
      `| ${example.id} | ${example.pass ? "pass" : "fail"} | ${graded ? (verdict.pass ? "pass" : "fail") : "error"} | ${match ? "yes" : "no"} | ${graded ? verdict.reason : (verdict ?? "not run")} |`,
    );
  }
  console.log(
    `\nJudge accuracy: ${correct}/${CALIBRATION.length}. Gemini requests: ${rows.reduce((s, r) => s + r.requests, 0)}.`,
  );
  if (stopped) console.log(`Stopped early: ${stopped}`);
  if (result.experimentUrl) console.log(`Langfuse: ${result.experimentUrl}`);
  process.exitCode = stopped ? 1 : 0;
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await stopTracing().catch(() => {});
  process.exitCode = 1;
});
