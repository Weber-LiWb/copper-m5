// Langfuse tracing (Module 5). lib/ai/call.ts traces every model call here:
// each agent is an observation holding its model calls (generations, with
// tokens and cost) and its tool calls. A chat turn wraps them in one trace,
// grouped by the chat's session. Without the three Langfuse keys, nothing is
// traced and every helper just runs the code it wraps.
import { AsyncLocalStorage } from "node:async_hooks";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  type LangfuseGeneration,
  type LangfuseSpan,
  type LangfuseSpanAttributes,
  propagateAttributes,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LanguageModelUsage, Telemetry, ToolSet } from "ai";
import type { ModelId } from "@/lib/ai/models";
import { costDetails } from "@/lib/ai/pricing";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim() &&
    process.env.LANGFUSE_BASE_URL?.trim(),
  );
}

type Exporter = {
  processor: LangfuseSpanProcessor;
  provider: NodeTracerProvider;
};

// One exporter per process, kept on globalThis so a dev-server reload doesn't
// register a second one.
const shared = globalThis as typeof globalThis & { __copperTracing?: Exporter };

/** Starts sending traces to Langfuse (once). False when the keys aren't set. */
export function startTracing(): boolean {
  if (!isTracingConfigured()) return false;
  if (!shared.__copperTracing) {
    const processor = new LangfuseSpanProcessor();
    const provider = new NodeTracerProvider({ spanProcessors: [processor] });
    provider.register();
    shared.__copperTracing = { processor, provider };
  }
  return true;
}

/** Sends any traces still waiting. Call when a turn or a script ends. */
export async function flushTracing(): Promise<void> {
  await shared.__copperTracing?.processor.forceFlush();
}

/** Sends what's left and stops the exporter, so a script can exit. */
export async function stopTracing(): Promise<void> {
  await shared.__copperTracing?.provider.shutdown();
  delete shared.__copperTracing;
}

/** What this file uses of a Langfuse span, agent, tool, chain or evaluator. */
type LangfuseObservation = {
  traceId: string;
  update(attributes: LangfuseSpanAttributes): unknown;
  end(): void;
  startObservation: LangfuseSpan["startObservation"];
};

// The observation that new calls nest under: the turn, or the tool that is
// running (search_docs embeds its query inside its own tool span).
const current = new AsyncLocalStorage<LangfuseObservation>();

function child(
  name: string,
  attributes: LangfuseSpanAttributes,
  asType: "agent" | "evaluator" | "embedding" | "span",
): LangfuseObservation {
  // The SDK has one overload per type, and only passes the type through.
  const options = { asType } as { asType: "span" };
  const parent = current.getStore();
  return parent
    ? parent.startObservation(name, attributes, options)
    : startObservation(name, attributes, options);
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export type Turn = {
  /** Records the reply and anything learned while answering. */
  update(attributes: {
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): void;
  traceId?: string;
};

export type TurnInfo = {
  name: string;
  sessionId?: string;
  input: unknown;
  tags?: string[];
  metadata?: Record<string, string>;
};

/** Runs one chat turn as one trace: every call inside nests under it. */
export async function traceTurn<T>(
  info: TurnInfo,
  run: (turn: Turn) => Promise<T>,
): Promise<T> {
  if (!startTracing()) return run({ update() {} });
  return startActiveObservation(
    info.name,
    (root) =>
      propagateAttributes(
        {
          traceName: info.name,
          sessionId: info.sessionId,
          tags: info.tags,
          metadata: info.metadata,
        },
        () => {
          root.update({ input: info.input, metadata: info.metadata });
          return current.run(root, () =>
            run({
              update: (attributes) => root.update(attributes),
              traceId: root.traceId,
            }),
          );
        },
      ),
    { asType: "chain" },
  );
}

export function usageDetails(usage: LanguageModelUsage) {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return { input, output, total: input + output };
}

/** One generation per model request, with its tokens and cost (lib/ai/pricing.ts). */
function generations(parent: LangfuseObservation, model: ModelId): Telemetry {
  let generation: LangfuseGeneration | undefined;
  return {
    onLanguageModelCallStart(event) {
      generation = parent.startObservation(
        event.modelId,
        {
          model: event.modelId,
          input: { instructions: event.instructions, messages: event.messages },
        },
        { asType: "generation" },
      );
    },
    onLanguageModelCallEnd(event) {
      const usage = usageDetails(event.usage);
      generation?.update({
        output: event.content,
        usageDetails: usage,
        costDetails: costDetails(model, usage.input, usage.output),
        metadata: { finishReason: event.finishReason },
      });
      generation?.end();
      generation = undefined;
    },
    onError(event) {
      generation?.update({
        level: "ERROR",
        statusMessage: errorMessage((event as { error?: unknown }).error),
      });
      generation?.end();
      generation = undefined;
    },
  };
}

/** Each tool call becomes a tool observation inside the agent. */
function traceTools<TOOLS extends ToolSet>(
  tools: TOOLS,
  parent: LangfuseObservation,
): TOOLS {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      return [
        name,
        {
          ...tool,
          execute: async (input: unknown, options: unknown) => {
            const span = parent.startObservation(
              name,
              { input },
              { asType: "tool" },
            );
            try {
              const output = await current.run(span, () =>
                (execute as (i: unknown, o: unknown) => unknown)(
                  input,
                  options,
                ),
              );
              span.update({ output });
              return output;
            } catch (error) {
              span.update({
                level: "ERROR",
                statusMessage: errorMessage(error),
              });
              throw error;
            } finally {
              span.end();
            }
          },
        },
      ];
    }),
  ) as TOOLS;
}

export type CallSpan = {
  telemetry?: { functionId: string; integrations: Telemetry };
  tools<TOOLS extends ToolSet | undefined>(tools: TOOLS): TOOLS;
  end(output?: unknown, metadata?: Record<string, unknown>): void;
  fail(error: unknown): void;
};

const UNTRACED: CallSpan = {
  tools: (tools) => tools,
  end() {},
  fail() {},
};

export type CallTrace = {
  /** What Langfuse calls it: the agent's name, like "Copper", or the feature. */
  name: string;
  type: "agent" | "evaluator" | "span";
  model: ModelId;
  input: unknown;
  metadata: Record<string, unknown>;
};

/** Opens the observation for one call in lib/ai/call.ts. End it once. */
export function traceCall(call: CallTrace): CallSpan {
  if (!startTracing()) return UNTRACED;
  const span = child(
    call.name,
    { input: call.input, metadata: call.metadata },
    call.type,
  );
  let open = true;
  const close = (attributes: Record<string, unknown>) => {
    if (!open) return;
    open = false;
    span.update(attributes);
    span.end();
  };
  return {
    telemetry: {
      functionId: call.name,
      integrations: generations(span, call.model),
    },
    tools: (tools) => (tools ? traceTools(tools, span) : tools),
    end: (output, metadata) => close({ output, metadata }),
    fail: (error) =>
      close({ level: "ERROR", statusMessage: errorMessage(error) }),
  };
}

/** An embedding call (search_docs). Google reports no tokens, so no cost. */
export function traceEmbedding(info: {
  name: string;
  model: string;
  count: number;
}): { end(): void; fail(error: unknown): void } {
  if (!startTracing()) return UNTRACED;
  const span = child(
    info.name,
    { input: { texts: info.count }, metadata: { model: info.model } },
    "embedding",
  );
  return {
    end: () => span.end(),
    fail: (error) => {
      span.update({ level: "ERROR", statusMessage: errorMessage(error) });
      span.end();
    },
  };
}
