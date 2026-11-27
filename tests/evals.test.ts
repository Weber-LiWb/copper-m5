// @vitest-environment node
// Module 5: the golden set, the AI judge, the pass-rate gate CI uses, and
// picking the single- or multi-agent variant. The model is mocked.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeError } from "@/lib/ai/call";
import { parseVariant } from "@/lib/copper/assistant/variants";
import { getOrders } from "@/lib/copper/orders";
import {
  GOLDEN_LIMIT_USD,
  GOLDEN_SET,
  type GoldenCase,
} from "@/lib/evals/golden-set";
import { judgePrompt, normalizeVerdict } from "@/lib/evals/judge";
import {
  type CaseResult,
  isQuotaError,
  meetsThreshold,
  parseThreshold,
  summarize,
  summaryMarkdown,
} from "@/lib/evals/summary";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the golden set", () => {
  it("has about ten cases with unique ids and what a good answer does", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(8);
    expect(GOLDEN_SET.length).toBeLessThanOrEqual(12);
    expect(new Set(GOLDEN_SET.map((c) => c.id)).size).toBe(GOLDEN_SET.length);
    for (const c of GOLDEN_SET) {
      expect(c.question.trim()).not.toBe("");
      expect(c.expected.split(/\s+/).length).toBeGreaterThan(8);
    }
  });

  it("covers auto refunds, approvals, orders, documents, not-in-docs and off-topic", () => {
    const categories = new Set(GOLDEN_SET.map((c) => c.category));
    for (const category of [
      "refund-auto",
      "refund-approval",
      "orders",
      "docs",
      "not-in-docs",
      "off-topic",
    ])
      expect(categories).toContain(category);
    const text = GOLDEN_SET.map((c) => c.question).join(" ");
    for (const order of ["1002", "1003", "1004"]) expect(text).toContain(order);
  });

  it("puts #1002 under the limit and #1003 and #1004 over it", () => {
    const amount = (id: string) =>
      getOrders().find((o) => o.id === id)!.amountUsd;
    expect(amount("1002")).toBeLessThanOrEqual(GOLDEN_LIMIT_USD);
    expect(amount("1003")).toBeGreaterThan(GOLDEN_LIMIT_USD);
    expect(amount("1004")).toBeGreaterThan(GOLDEN_LIMIT_USD);
  });
});

describe("the judge", () => {
  const c = GOLDEN_SET[0];

  it("keeps the verdict in range", () => {
    expect(
      normalizeVerdict({ pass: true, score: 0.926, reason: " Good. " }),
    ).toEqual({ pass: true, score: 0.93, reason: "Good." });
    expect(normalizeVerdict({ pass: false, score: 8, reason: "x" }).score).toBe(
      0.8,
    );
    expect(
      normalizeVerdict({ pass: false, score: 75, reason: "x" }).score,
    ).toBe(0.75);
    expect(normalizeVerdict({ score: -2 })).toEqual({
      pass: false,
      score: 0,
      reason: "The judge gave no reason.",
    });
    expect(normalizeVerdict({ pass: "yes", score: Number.NaN }).pass).toBe(
      false,
    );
    expect(
      normalizeVerdict({ pass: true, score: 1, reason: "r".repeat(900) })
        .reason,
    ).toHaveLength(500);
  });

  it("shows the judge the question, the criteria, the tool results and the reply", () => {
    const prompt = judgePrompt(c, {
      reply: "Your $79 is refunded.",
      answeredBy: "Refund agent",
      toolCalls: [
        {
          name: "request_refund",
          input: { orderId: "1002" },
          output: { status: "refunded", amountUsd: 79 },
        },
      ],
    });
    expect(prompt).toContain(c.question);
    expect(prompt).toContain(c.expected);
    expect(prompt).toContain('request_refund({"orderId":"1002"}) returned');
    expect(prompt).toContain('"status":"refunded"');
    expect(prompt).toContain("Agent that wrote the final reply: Refund agent");
    expect(prompt).toContain("Your $79 is refunded.");
    expect(
      judgePrompt(c, { reply: "Hi", answeredBy: "Copper", toolCalls: [] }),
    ).toContain("(none)");
  });

  it("grades through callObject in lib/ai/call.ts, logged as the eval judge", async () => {
    const generate = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ pass: true, score: 0.9, reason: "Refunded." }),
        },
      ],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: {
          total: 800,
          noCache: 800,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 40, text: 40, reasoning: undefined },
      },
      warnings: [],
    }));
    model = new MockLanguageModelV4({ doGenerate: generate });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.resetModules();
    const { judgeAnswer } = await import("@/lib/evals/judge");
    const verdict = await judgeAnswer(c, {
      reply: "Your $79 is refunded.",
      answeredBy: "Refund agent",
      toolCalls: [],
    });
    expect(verdict).toEqual({ pass: true, score: 0.9, reason: "Refunded." });
    const row = JSON.parse(
      info.mock.calls.find(([tag]) => tag === "[ai_calls]")![1] as string,
    );
    expect(row).toMatchObject({
      module: 5,
      feature: "eval-judge",
      ok: true,
      requests: 1,
    });
    expect(row.cost_usd).toBeGreaterThan(0);
  });
});

describe("the pass-rate gate", () => {
  const cases = GOLDEN_SET.slice(0, 4) as GoldenCase[];
  const result = (id: string, pass: boolean, extra = {}): CaseResult => ({
    id,
    status: "answered",
    verdict: { pass, score: pass ? 1 : 0.4, reason: "" },
    latencyMs: 2000,
    costUsd: 0.001,
    requests: 3,
    ...extra,
  });

  it("divides by the whole set, so a case with no result counts as a fail", () => {
    const summary = summarize(cases, [
      result(cases[0].id, true),
      result(cases[1].id, true),
      result(cases[2].id, false),
    ]);
    expect(summary).toMatchObject({
      total: 4,
      passed: 2,
      passRate: 0.5,
      requests: 9,
      avgLatencyMs: 2000,
    });
    expect(summary.avgScore).toBeCloseTo((1 + 1 + 0.4) / 4);
    expect(summary.totalCostUsd).toBeCloseTo(0.003);
  });

  it("leaves errors out of the latency but keeps their cost", () => {
    const summary = summarize(cases, [
      result(cases[0].id, true, { latencyMs: 1000 }),
      {
        id: cases[1].id,
        status: "error",
        costUsd: 0.002,
        requests: 1,
        error: "429",
      },
    ]);
    expect(summary.avgLatencyMs).toBe(1000);
    expect(summary.totalCostUsd).toBeCloseTo(0.003);
    expect(summary.passed).toBe(1);
  });

  it("ignores results for cases outside the set", () => {
    expect(summarize(cases, [result("other", true)]).passed).toBe(0);
  });

  it("reads thresholds and compares at the boundary", () => {
    expect(parseThreshold(undefined)).toBe(0.8);
    expect(parseThreshold("0.7")).toBe(0.7);
    expect(parseThreshold("90%")).toBeCloseTo(0.9);
    expect(() => parseThreshold("1.5")).toThrow();
    expect(() => parseThreshold("most")).toThrow();
    expect(meetsThreshold(8 / 10, 0.8)).toBe(true);
    expect(meetsThreshold(0.7 + 0.1, 0.8)).toBe(true);
    expect(meetsThreshold(7 / 10, 0.8)).toBe(false);
  });

  it("writes a Markdown summary with the pass rate and one row per case", () => {
    const results = [result(cases[0].id, true), result(cases[1].id, false)];
    const markdown = summaryMarkdown({
      title: "Golden-set eval: multi-agent",
      runName: "ci-pr1",
      model: "google/gemini-3.5-flash-lite",
      threshold: 0.8,
      cases,
      results,
      summary: summarize(cases, results),
      judgeRequests: 2,
      judgeCostUsd: 0.0005,
      url: "https://cloud.langfuse.com/project/p/experiments/e",
    });
    expect(markdown).toContain("**Pass rate: 1/4 (25%)**");
    expect(markdown).toContain("**failed**");
    expect(markdown).toContain(`| ${cases[0].id} | pass | 1.00 |`);
    expect(markdown).toContain(`| ${cases[1].id} | fail | 0.40 |`);
    expect(markdown).toContain(`| ${cases[3].id} | not run |`);
    expect(markdown).toContain("https://cloud.langfuse.com/project/p");
  });

  it("recognizes Gemini quota errors", () => {
    expect(isQuotaError("429 Resource has been exhausted")).toBe(true);
    expect(
      isQuotaError(
        "You exceeded your current quota GenerateRequestsPerDayPerProjectPerModel-FreeTier",
      ),
    ).toBe(true);
    expect(isQuotaError("500 Internal error")).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it("describes a failed call with its status and Google's quota id", () => {
    const error = Object.assign(new Error("Resource has been exhausted"), {
      statusCode: 429,
      responseBody:
        '{"error":{"details":[{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}}',
    });
    expect(describeError(error)).toBe(
      "429 Resource has been exhausted GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
    );
    expect(describeError("boom")).toBe("boom");
  });
});

describe("variants", () => {
  it("defaults to the two agents and reads single or multi", () => {
    expect(parseVariant(undefined)).toBe("multi");
    expect(parseVariant("")).toBe("multi");
    expect(parseVariant("single")).toBe("single");
    expect(parseVariant(" Multi ")).toBe("multi");
    expect(() => parseVariant("both")).toThrow(/single|multi/);
  });
});

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

describe("running one case", () => {
  const finish: StreamPart = {
    type: "finish",
    finishReason: { unified: "stop", raw: "STOP" },
    usage: {
      inputTokens: {
        total: 1000,
        noCache: 1000,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 100, text: 100, reasoning: undefined },
    },
  };

  it("asks with the golden limit, and adds up the requests and cost", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream<StreamPart>([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "I only help with Copper." },
          { type: "text-end", id: "t" },
          finish,
        ]),
      }),
    });
    vi.resetModules();
    const { runCase } = await import("@/lib/evals/run-case");
    const run = await runCase(GOLDEN_SET.at(-1)!, "multi", "run-1");
    expect(run).toMatchObject({
      status: "answered",
      reply: "I only help with Copper.",
      answeredBy: "Copper",
      agents: ["Copper"],
      requests: 1,
    });
    expect(run.costUsd).toBeGreaterThan(0);
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a failed call as an error, with no latency and no verdict", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error("Resource has been exhausted"), {
          statusCode: 429,
        });
      },
    });
    vi.resetModules();
    const { runCase } = await import("@/lib/evals/run-case");
    const run = await runCase(GOLDEN_SET[0], "single", "run-1");
    expect(run.status).toBe("error");
    expect(run.latencyMs).toBeUndefined();
    expect(isQuotaError(run.error)).toBe(true);
  });
});

describe("retrying a busy Gemini", () => {
  it("retries a 503 but never a quota error", async () => {
    const { isTransientError, retrying } = await import("@/lib/evals/retry");
    expect(
      isTransientError("503 This model is currently experiencing high demand."),
    ).toBe(true);
    expect(isTransientError("fetch failed")).toBe(true);
    expect(isTransientError("429 Resource has been exhausted")).toBe(false);
    expect(isTransientError("400 Invalid argument")).toBe(false);
    expect(isTransientError(undefined)).toBe(false);

    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const answers = ["503 high demand", "503 high demand", undefined];
    const tries = await retrying(
      async () => answers.shift(),
      (error) => error,
      { retries: 2, waitMs: 100, sleep },
    );
    expect(tries).toEqual(["503 high demand", "503 high demand", undefined]);
    expect(waits).toEqual([100, 200]);

    const quota = await retrying(
      async () => "429 quota",
      (error) => error,
      { retries: 2, waitMs: 100, sleep },
    );
    expect(quota).toHaveLength(1);

    const giveUp = await retrying(
      async () => "503 high demand",
      (error) => error,
      { retries: 1, waitMs: 100, sleep },
    );
    expect(giveUp).toHaveLength(2);
  });
});

describe("telling Gemini's glitches from wrong answers", () => {
  const usage = {
    inputTokens: {
      total: 900,
      noCache: 900,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 30, text: 30, reasoning: undefined },
  };
  const streaming = (parts: StreamPart[]) =>
    new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(parts) }),
    });

  it("logs Google's raw finish reasons on each ai_calls row", async () => {
    model = streaming([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hi." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "STOP" }, usage },
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.resetModules();
    const { runCase } = await import("@/lib/evals/run-case");
    await runCase(GOLDEN_SET.at(-1)!, "multi", "run-1");
    const row = JSON.parse(
      info.mock.calls.find(([tag]) => tag === "[ai_calls]")![1] as string,
    );
    expect(row.finish_reasons).toEqual(["STOP"]);
  });

  it("treats a stream with no finish reason as cut off: an error worth a retry", async () => {
    model = streaming([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "I've" },
      { type: "text-end", id: "t" },
    ]);
    vi.resetModules();
    const { CUT_OFF, runCase } = await import("@/lib/evals/run-case");
    const { isTransientError } = await import("@/lib/evals/retry");
    const run = await runCase(GOLDEN_SET[0], "multi", "run-1");
    expect(run).toMatchObject({ status: "error", error: CUT_OFF });
    expect(run.verdict).toBeUndefined();
    expect(isTransientError(run.error)).toBe(true);
  });

  it("fails a turn the model ended without a reply, without asking the judge", async () => {
    model = streaming([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "Thinking about it" },
      { type: "reasoning-end", id: "r" },
      {
        type: "finish",
        finishReason: { unified: "other", raw: "OTHER" },
        usage,
      },
    ]);
    vi.resetModules();
    const { runCase } = await import("@/lib/evals/run-case");
    const run = await runCase(GOLDEN_SET[0], "multi", "run-1");
    expect(run.status).toBe("answered");
    expect(run.verdict).toMatchObject({ pass: false, score: 0 });
    expect(run.verdict!.reason).toContain("OTHER");
  });

  it("counts errors and never-run cases as ungraded", () => {
    const cases = GOLDEN_SET.slice(0, 3);
    const summary = summarize(cases, [
      {
        id: cases[0].id,
        status: "answered",
        verdict: { pass: true, score: 1, reason: "" },
        latencyMs: 1,
        costUsd: 0,
        requests: 1,
      },
      {
        id: cases[1].id,
        status: "error",
        costUsd: 0,
        requests: 1,
        error: "503",
      },
    ]);
    expect(summary).toMatchObject({ passed: 1, errors: 2, total: 3 });
  });
});

describe("calibrating the judge", () => {
  it("has good and bad replies, with known grades, for real golden cases", async () => {
    const { CALIBRATION, caseFor } =
      await import("@/lib/evals/judge-calibration");
    expect(CALIBRATION.filter((e) => e.pass).length).toBe(
      CALIBRATION.filter((e) => !e.pass).length,
    );
    expect(new Set(CALIBRATION.map((e) => e.id)).size).toBe(CALIBRATION.length);
    for (const example of CALIBRATION) {
      expect(caseFor(example).id).toBe(example.caseId);
      expect(example.why).not.toBe("");
    }
  });
});

describe("retrying one request after a 5xx", () => {
  const reply = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 200 ? "{}" : "busy", { status, headers });

  it("retries a 503 per request, counts every try and keeps the time it lost", async () => {
    const { countingFetch } = await import("@/lib/ai/retry-fetch");
    const responses = [
      reply(503),
      reply(503, { "retry-after": "1" }),
      reply(200),
    ];
    const waits: number[] = [];
    const stats = { attempts: 0, lostMs: 0 };
    const send = countingFetch(stats, {
      retries: 4,
      fetch: async () => responses.shift()!,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const response = await send("https://example.test", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(stats.attempts).toBe(3);
    expect(waits).toEqual([4000, 1000]);
    expect(stats.lostMs).toBeGreaterThanOrEqual(0);
  });

  it("never retries a quota error, and gives up after the last retry", async () => {
    const { countingFetch } = await import("@/lib/ai/retry-fetch");
    const sleep = async () => {};
    const quota = { attempts: 0, lostMs: 0 };
    const quotaResponse = await countingFetch(quota, {
      retries: 4,
      fetch: async () => reply(429),
      sleep,
    })("https://example.test");
    expect(quotaResponse.status).toBe(429);
    expect(quota.attempts).toBe(1);

    const busy = { attempts: 0, lostMs: 0 };
    const busyResponse = await countingFetch(busy, {
      retries: 2,
      fetch: async () => reply(503),
      sleep,
    })("https://example.test");
    expect(busyResponse.status).toBe(503);
    expect(busy.attempts).toBe(3);

    const off = { attempts: 0, lostMs: 0 };
    await countingFetch(off, {
      retries: 0,
      fetch: async () => reply(503),
      sleep,
    })("https://example.test");
    expect(off.attempts).toBe(1);
  });

  it("reads AI_RETRY_SERVER_ERRORS, off unless set", async () => {
    const { serverErrorRetries } = await import("@/lib/ai/retry-fetch");
    vi.stubEnv("AI_RETRY_SERVER_ERRORS", "");
    expect(serverErrorRetries()).toBe(0);
    vi.stubEnv("AI_RETRY_SERVER_ERRORS", "4");
    expect(serverErrorRetries()).toBe(4);
    vi.stubEnv("AI_RETRY_SERVER_ERRORS", "lots");
    expect(serverErrorRetries()).toBe(0);
  });
});
