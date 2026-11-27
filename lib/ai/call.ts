import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany, generateText, Output, streamText, type ToolSet } from "ai";
import type { z } from "zod";
import {
  defaultModel,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MODELS,
  type ModelId,
} from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import { countingFetch, type FetchStats } from "@/lib/ai/retry-fetch";
import {
  errorMessage,
  traceCall,
  traceEmbedding,
  type CallSpan,
} from "@/lib/ai/tracing";

// Every model call in the app goes through this file, so each one is logged
// with its tokens, cost and how long it took. The log goes to the terminal
// running the app, as a line starting "[ai_calls]".
// Module 5: each call is also traced in Langfuse (lib/ai/tracing.ts) when the
// Langfuse keys are set: the agent, its model calls and its tool calls.

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "Set up AI to use this feature: add GOOGLE_GENERATIVE_AI_API_KEY to .env.local.",
    );
    this.name = "AiNotConfiguredError";
  }
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

/** Which module and feature made the call, for the ai_calls log. */
export type CallInfo = {
  module: number;
  feature: string;
  model?: ModelId;
  /** The agent making the call, as Langfuse names it (Module 5), like "Copper". */
  agent?: string;
  /** Set instead of `agent` when the call grades answers, like the eval judge. */
  evaluator?: string;
  /** Tools that search documents, which Langfuse shows as retrievers. */
  retrievers?: readonly string[];
};

// Omit that keeps generateText's "prompt or messages" union intact.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type TextOptions = DistributiveOmit<
  Parameters<typeof generateText>[0],
  "model" | "output"
>;

export type AiCallRow = {
  module: number;
  feature: string;
  model: ModelId | typeof EMBEDDING_MODEL;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  ok: boolean;
  /**
   * HTTP requests the call sent: one per step (tool calls plus the reply),
   * plus any retried after a 5xx.
   */
  requests: number;
  /** Time lost to failed requests and the waits before retrying them. */
  lost_ms?: number;
  /**
   * Google's reason each step stopped, like "STOP". Null means the stream
   * ended with no reason at all: Google cut it off.
   */
  finish_reasons?: (string | null)[];
  /** Why it failed, like "429 Resource has been exhausted". */
  error?: string;
  created_at: string;
};

/** A fresh count of one call's HTTP requests (lib/ai/retry-fetch.ts). */
const newStats = (): FetchStats => ({ attempts: 0, lostMs: 0 });

function google(stats: FetchStats) {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!googleKey) throw new AiNotConfiguredError();
  return createGoogleGenerativeAI({
    apiKey: googleKey,
    fetch: countingFetch(stats),
  });
}

function languageModel(model: ModelId, stats: FetchStats) {
  const entry = MODELS.find((m) => m.id === model);
  const id =
    entry && "googleId" in entry
      ? entry.googleId
      : model.slice("google/".length);
  return google(stats)(id);
}

const watchers = new Set<(row: AiCallRow) => void>();

/**
 * Calls `watcher` with every ai_calls row from now on, so the eval can count
 * requests and cost and notice a quota error. Returns a function that stops it.
 */
export function watchAiCalls(watcher: (row: AiCallRow) => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Prints one line per model call, so the cost and time are visible. */
async function logCall(row: AiCallRow): Promise<void> {
  console.info("[ai_calls]", JSON.stringify(row));
  for (const watcher of watchers) watcher(row);
}

/** The status code and message of a failed call, plus Google's quota id if any. */
export function describeError(error: unknown): string {
  const status = (error as { statusCode?: unknown })?.statusCode;
  const body = String(
    (error as { responseBody?: unknown })?.responseBody ?? "",
  );
  const quota = body.match(/"quotaId":\s*"([^"]+)"/)?.[1];
  return [typeof status === "number" ? status : "", errorMessage(error), quota]
    .filter(Boolean)
    .join(" ");
}

/**
 * AI_MAX_RETRIES overrides the AI SDK's 2 automatic retries. The eval sets it
 * to 0 so a quota error stops the run instead of quietly spending calls.
 */
function maxRetries(): number | undefined {
  const value = process.env.AI_MAX_RETRIES?.trim();
  const retries = Number(value);
  return value && Number.isInteger(retries) && retries >= 0
    ? retries
    : undefined;
}

type Usage = { inputTokens?: number; outputTokens?: number };

/** Builds the ai_calls row for a call that started at `started`. */
function rowFor(
  info: CallInfo,
  model: ModelId,
  started: number,
  stats: FetchStats,
) {
  return (
    ok: boolean,
    usage?: Usage,
    steps?: { rawFinishReason?: string }[],
    error?: unknown,
  ): AiCallRow => {
    const input = usage?.inputTokens ?? null;
    const output = usage?.outputTokens ?? null;
    return {
      module: info.module,
      feature: info.feature,
      model,
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        input !== null && output !== null
          ? costUsd(model, input, output)
          : null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      // A mocked model sends no HTTP requests, so count its steps instead.
      requests: stats.attempts || steps?.length || 1,
      ...(stats.lostMs > 0 && { lost_ms: Math.round(stats.lostMs) }),
      ...(steps && {
        finish_reasons: steps.map((s) => s.rawFinishReason ?? null),
      }),
      ...(error !== undefined && { error: describeError(error) }),
      created_at: new Date().toISOString(),
    };
  };
}

/** Opens the call's Langfuse observation (a no-op without Langfuse keys). */
function traceFor(
  info: CallInfo,
  model: ModelId,
  options: { prompt?: unknown; messages?: unknown },
): CallSpan {
  return traceCall({
    name: info.agent ?? info.evaluator ?? info.feature,
    type: info.agent ? "agent" : info.evaluator ? "evaluator" : "span",
    model,
    input: options.messages ?? options.prompt,
    metadata: { module: info.module, feature: info.feature, model },
    retrievers: info.retrievers,
  });
}

/** What every call adds to the AI SDK options: model, retries, tracing. */
function settings(
  model: ReturnType<typeof languageModel>,
  span: CallSpan,
  tools: ToolSet | undefined,
) {
  return {
    model,
    maxRetries: maxRetries(),
    tools: span.tools(tools),
    telemetry: span.telemetry,
  };
}

async function tracked<
  T extends {
    usage: Usage;
    steps: { rawFinishReason?: string }[];
    text: string;
  },
>(
  info: CallInfo,
  options: TextOptions,
  run: (call: ReturnType<typeof settings>) => Promise<T>,
): Promise<T> {
  const model = info.model ?? defaultModel();
  const stats = newStats();
  const row = rowFor(info, model, performance.now(), stats);
  // Checks the key before anything is traced.
  const languageModelFor = languageModel(model, stats);
  const span = traceFor(info, model, options);
  try {
    const result = await run(settings(languageModelFor, span, options.tools));
    span.end(result.text);
    await logCall(row(true, result.usage, result.steps));
    return result;
  } catch (error) {
    span.fail(error);
    if (!(error instanceof AiNotConfiguredError))
      await logCall(row(false, undefined, undefined, error));
    throw error;
  }
}

/** Generates text. Example: callText({ module: 3, feature: "support-answer" }, { prompt }) */
export async function callText(info: CallInfo, options: TextOptions) {
  return tracked(info, options, (call) =>
    generateText({ ...options, ...call }),
  );
}

/** Generates an object that matches a zod schema; read it from `result.output`. */
export async function callObject<Schema extends z.ZodType>(
  info: CallInfo,
  options: TextOptions & { schema: Schema },
) {
  const { schema, ...rest } = options;
  const result = await tracked(info, rest, (call) =>
    generateText({
      ...rest,
      ...call,
      output: Output.object({ schema }),
    }),
  );
  // Spreading `rest` loses generateText's output type; Output.object has
  // already validated it against `schema`, so restore the type here.
  return result as typeof result & { output: z.infer<Schema> };
}

/**
 * Embeds many texts in one go; read `result.embeddings` (same order as `values`).
 * Example: callEmbedMany({ module: 3, feature: "embed-docs" }, passages)
 */
export async function callEmbedMany(
  info: Omit<CallInfo, "model">,
  values: string[],
) {
  const started = performance.now();
  const stats = newStats();
  // Google doesn't report tokens for embeddings, so tokens and cost are null.
  const log = (ok: boolean, error?: unknown) =>
    logCall({
      module: info.module,
      feature: info.feature,
      model: EMBEDDING_MODEL,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      requests: stats.attempts || 1,
      ...(stats.lostMs > 0 && { lost_ms: Math.round(stats.lostMs) }),
      ...(error !== undefined && { error: describeError(error) }),
      created_at: new Date().toISOString(),
    });
  const embedder = google(stats).embedding(
    EMBEDDING_MODEL.slice("google/".length),
  );
  const span = traceEmbedding({
    name: info.feature,
    model: EMBEDDING_MODEL,
    count: values.length,
  });
  try {
    const result = await embedMany({
      model: embedder,
      values,
      maxRetries: maxRetries(),
      providerOptions: {
        google: { outputDimensionality: EMBEDDING_DIMENSIONS },
      },
      telemetry: { isEnabled: false },
    });
    span.end();
    await log(true);
    return result;
  } catch (error) {
    span.fail(error);
    if (!(error instanceof AiNotConfiguredError)) await log(false, error);
    throw error;
  }
}

type StreamOptions = DistributiveOmit<
  Parameters<typeof streamText>[0],
  "model" | "output" | "onFinish" | "onError" | "onAbort"
>;

/**
 * Streams a reply: read `result.fullStream` to see each step as it happens
 * (thinking, tool calls, tool results, text). Logged to ai_calls when it ends.
 * Example: callStream({ module: 2, feature: "ask-copper" }, { messages })
 */
export function callStream(info: CallInfo, options: StreamOptions) {
  const model = info.model ?? defaultModel();
  const stats = newStats();
  const row = rowFor(info, model, performance.now(), stats);
  const languageModelFor = languageModel(model, stats);
  const span = traceFor(info, model, options);
  return streamText({
    ...options,
    ...settings(languageModelFor, span, options.tools),
    onFinish: ({ totalUsage, steps, text }) => {
      // Google's own reason each step stopped (STOP, MAX_TOKENS, ...), which
      // the AI SDK folds into "other" when it has no name for it.
      span.end(text, {
        finishReasons: steps.map((s) => s.rawFinishReason ?? s.finishReason),
      });
      return logCall(row(true, totalUsage, steps));
    },
    onError: ({ error }) => {
      span.fail(error);
      return logCall(row(false, undefined, undefined, error));
    },
    onAbort: () => span.fail("aborted"),
  });
}

// Asking for some thinking (rather than letting the model decide) is what
// makes Gemini write a summary even for an easy question.
const THINKING = { includeThoughts: true, thinkingBudget: 1024 };

/**
 * Asks Gemini to include a summary of its thinking in the stream (as
 * reasoning parts). Other models ignore it. Pass as `providerOptions`.
 */
export const THOUGHT_SUMMARIES = {
  google: { thinkingConfig: THINKING },
};
