// @vitest-environment node
// Module 5: every chat turn is one Langfuse trace. Each agent is an
// observation holding its model calls (generations, with tokens and cost) and
// its tool calls; search_docs's embedding sits inside its tool. Langfuse and
// the model are mocked, so this needs no keys and makes no calls.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import {
  convertArrayToReadableStream,
  MockEmbeddingModelV4,
  MockLanguageModelV4,
} from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { costDetails } from "@/lib/ai/pricing";

type Node = {
  name: string;
  type: string;
  attributes: Record<string, unknown>[];
  children: Node[];
  ended: boolean;
};

const langfuse = vi.hoisted(() => {
  const roots: Node[] = [];
  const propagated: Record<string, unknown>[] = [];
  const node = (name: string, type: string, attributes: unknown): Node => ({
    name,
    type,
    attributes: attributes ? [attributes as Record<string, unknown>] : [],
    children: [],
    ended: false,
  });
  const observation = (n: Node): unknown => ({
    traceId: "trace-1",
    update(attributes: Record<string, unknown>) {
      n.attributes.push(attributes);
    },
    end() {
      n.ended = true;
    },
    startObservation(
      name: string,
      attributes: unknown,
      options?: { asType?: string },
    ) {
      const child = node(name, options?.asType ?? "span", attributes);
      n.children.push(child);
      return observation(child);
    },
  });
  return {
    roots,
    propagated,
    flushed: { count: 0 },
    startObservation(
      name: string,
      attributes: unknown,
      options?: { asType?: string },
    ) {
      const root = node(name, options?.asType ?? "span", attributes);
      roots.push(root);
      return observation(root);
    },
    async startActiveObservation(
      name: string,
      run: (o: unknown) => Promise<unknown>,
      options?: { asType?: string },
    ) {
      const root = node(name, options?.asType ?? "span", undefined);
      roots.push(root);
      try {
        return await run(observation(root));
      } finally {
        root.ended = true;
      }
    },
  };
});

vi.mock("@langfuse/tracing", () => ({
  startObservation: langfuse.startObservation,
  startActiveObservation: langfuse.startActiveObservation,
  propagateAttributes: (
    params: Record<string, unknown>,
    run: () => unknown,
  ) => {
    langfuse.propagated.push(params);
    return run();
  },
}));
vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class {
    async forceFlush() {
      langfuse.flushed.count++;
    }
  },
}));
vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    register() {}
    async shutdown() {}
  },
}));

let model: MockLanguageModelV4;
const embeddingModel = new MockEmbeddingModelV4({
  doEmbed: async ({ values }) => ({
    embeddings: values.map(() => Array.from({ length: 768 }, () => 0.1)),
    warnings: [],
  }),
});
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () =>
    Object.assign(() => model, { embedding: () => embeddingModel }),
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 500,
      noCache: 500,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

async function ask(
  request: Partial<
    Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0]
  >,
) {
  vi.resetModules();
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  const progress = await finalValue(
    (
      await askCopper({
        messages: [{ role: "user", content: "Refund order 1002, please." }],
        useTools: true,
        desk: { limitUsd: 100, refunds: [] },
        sessionId: "chat-1",
        ...request,
      })
    ).progress,
  );
  // The trace is flushed just after the reply is done.
  await vi.waitFor(() => expect(langfuse.flushed.count).toBeGreaterThan(0));
  return progress;
}

/** name (type) for each observation, nested, to compare trees at a glance. */
function outline(node: Node): unknown {
  const label = `${node.name} (${node.type})`;
  return node.children.length ? { [label]: node.children.map(outline) } : label;
}

const merged = (node: Node) => Object.assign({}, ...node.attributes);

function everyNode(node: Node): Node[] {
  return [node, ...node.children.flatMap(everyNode)];
}

const LANGFUSE_ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
  LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
};

beforeEach(() => {
  langfuse.roots.length = 0;
  langfuse.propagated.length = 0;
  langfuse.flushed.count = 0;
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("tracing with Langfuse keys", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(LANGFUSE_ENV))
      vi.stubEnv(name, value);
  });

  it("traces a refund turn: Copper hands off, the Refund agent refunds, with tokens and cost", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund order 1002" }),
      calls("request_refund", { orderId: "1002" }),
      says("Your $79 is refunded to your original payment."),
    );
    const progress = await ask({});
    expect(progress.agent).toBe("refund");

    expect(langfuse.roots).toHaveLength(1);
    const [turn] = langfuse.roots;
    expect(outline(turn)).toEqual({
      "ask-copper (chain)": [
        {
          "Copper (agent)": [
            "llm-call (generation)",
            "transfer_to_refund_agent (tool)",
          ],
        },
        {
          "Refund agent (agent)": [
            "llm-call (generation)",
            "request_refund (tool)",
            "llm-call (generation)",
          ],
        },
      ],
    });
    expect(everyNode(turn).every((n) => n.ended)).toBe(true);

    expect(langfuse.propagated[0]).toMatchObject({
      traceName: "ask-copper",
      sessionId: "chat-1",
      userId: "maya-reyes",
      tags: ["multi-agent", "support-page"],
    });
    expect(merged(turn)).toMatchObject({
      input: "Refund order 1002, please.",
      output: "Your $79 is refunded to your original payment.",
      metadata: {
        answeredBy: "Refund agent",
        agents: ["Copper", "Refund agent"],
      },
    });

    const refundAgent = turn.children[1];
    const generation = merged(refundAgent.children[0]);
    expect(generation.usageDetails).toEqual({
      input: 500,
      output: 50,
      total: 550,
    });
    expect(generation.costDetails).toEqual(
      costDetails("google/gemini-3.5-flash-lite", 500, 50),
    );
    expect((generation.costDetails as { total: number }).total).toBeGreaterThan(
      0,
    );
    expect(merged(refundAgent.children[1])).toMatchObject({
      input: { orderId: "1002" },
      output: { status: "refunded", amountUsd: 79 },
    });
  });

  it("nests search_docs's embedding inside its tool call", async () => {
    model = modelStreaming(
      calls("search_docs", { query: "Copper Home warranty" }),
      says("Two years [Copper State Labs Terms and Conditions, p. 3]."),
    );
    await ask({
      messages: [{ role: "user", content: "How long is the warranty?" }],
    });
    const copper = langfuse.roots[0].children[0];
    expect(outline(copper)).toEqual({
      "Copper (agent)": [
        "llm-call (generation)",
        { "search_docs (retriever)": ["search-docs (embedding)"] },
        "llm-call (generation)",
      ],
    });
  });

  it("traces the single-agent variant as one Support agent with every tool", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1002" }),
      says("Your $79 is refunded."),
    );
    const progress = await ask({ variant: "single" });
    expect(progress.agent).toBe("support");
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(outline(langfuse.roots[0])).toEqual({
      "ask-copper (chain)": [
        {
          "Support agent (agent)": [
            "llm-call (generation)",
            "request_refund (tool)",
            "llm-call (generation)",
          ],
        },
      ],
    });
    expect(langfuse.propagated[0]).toMatchObject({
      tags: ["single-agent", "support-page"],
    });
  });

  it("marks a failed model call as an error and still ends every observation", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("429 Resource has been exhausted");
      },
    });
    const progress = await ask({});
    expect(progress.status).toBe("error");
    const turn = langfuse.roots[0];
    expect(everyNode(turn).every((n) => n.ended)).toBe(true);
    expect(merged(turn.children[0])).toMatchObject({
      level: "ERROR",
      statusMessage: expect.stringContaining("429"),
    });
  });
});

describe("without Langfuse keys", () => {
  it("answers exactly as before and traces nothing", async () => {
    for (const name of Object.keys(LANGFUSE_ENV)) vi.stubEnv(name, "");
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund" }),
      calls("request_refund", { orderId: "1002" }),
      says("Refunded."),
    );
    vi.resetModules();
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const { isTracingConfigured } = await import("@/lib/ai/tracing");
    const progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order 1002" }],
          useTools: true,
          desk: { limitUsd: 100, refunds: [] },
        })
      ).progress,
    );
    expect(isTracingConfigured()).toBe(false);
    expect(progress).toMatchObject({ status: "done", agent: "refund" });
    expect(langfuse.roots).toEqual([]);
    expect(langfuse.propagated).toEqual([]);
  });
});

describe("what leaves the server", () => {
  it("masks emails, phone numbers and card numbers, leaving order numbers and prices", async () => {
    const { maskPii } = await import("@/lib/ai/tracing");
    expect(
      maskPii(
        "Email maya@example.com or call 480-555-0199 about #1002 ($79), card 4242 4242 4242 4242.",
      ),
    ).toBe("Email [email] or call [phone] about #1002 ($79), card [card].");
    expect(
      maskPii({
        messages: [{ role: "user", content: "it's 4111111111111111" }],
        total: 79,
        id: "call_16768731073866553080",
        when: "2026-11-05",
      }),
    ).toEqual({
      messages: [{ role: "user", content: "it's [card]" }],
      total: 79,
      id: "call_16768731073866553080",
      when: "2026-11-05",
    });
    expect(maskPii("order 1234567890123")).toBe("order 1234567890123");
  });

  it("labels traces with an environment, so tests stay out of production", async () => {
    const { tracingEnvironment } = await import("@/lib/ai/tracing");
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(tracingEnvironment()).toBe("development");
    vi.stubEnv("NODE_ENV", "production");
    expect(tracingEnvironment()).toBe("production");
    vi.stubEnv("CI", "true");
    expect(tracingEnvironment()).toBe("ci");
    vi.stubEnv("LANGFUSE_TRACING_ENVIRONMENT", "staging");
    expect(tracingEnvironment()).toBe("staging");
  });
});
