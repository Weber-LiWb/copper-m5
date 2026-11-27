"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
// Module 5: each turn is one Langfuse trace, grouped by the chat's session.
// The eval can ask for the single-agent variant: one Support agent with every
// tool and no handoff. The app always uses the two agents.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { flushTracing, traceTurn } from "@/lib/ai/tracing";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  SUPPORT_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import {
  type Agent,
  AGENT_NAMES,
  FALLBACK_REPLY,
  type Progress,
  type ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  supportAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Variant } from "@/lib/copper/assistant/variants";
import { CUSTOMER, type Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
  /** The chat this turn belongs to, so Langfuse groups its turns (Module 5). */
  sessionId?: string;
  /** Two agents (the app) or one Support agent (Module 5's comparison). */
  variant?: Variant;
};

export type AskCopperResult = { progress: Live<Progress> };

/** search_docs looks passages up, so Langfuse shows it as a retriever. */
const RETRIEVERS = ["search_docs"];

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

/** One agent's call: its instructions and only its own tools. */
function agentCall(agent: Agent, messages: ChatMessage[], desk?: Desk) {
  if (agent === "support" && desk)
    return callStream(
      {
        module: 5,
        feature: "support-agent",
        agent: AGENT_NAMES.support,
        retrievers: RETRIEVERS,
      },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: SUPPORT_AGENT_INSTRUCTIONS,
        tools: supportAgentTools(desk),
        stopWhen: STOP,
      },
    );
  if (agent === "refund" && desk)
    return callStream(
      { module: 4, feature: "refund-agent", agent: AGENT_NAMES.refund },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(desk),
        stopWhen: STOP,
      },
    );
  return callStream(
    {
      module: 2,
      feature: "ask-copper",
      agent: AGENT_NAMES.copper,
      retrievers: RETRIEVERS,
    },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: desk
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: desk
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

/** Who answers first in this variant. */
function firstAgent(variant: Variant, agent: Agent, handoffs: boolean): Agent {
  if (!handoffs) return "copper";
  if (variant === "single") return "support";
  return agent === "support" ? "copper" : agent;
}

export async function askCopper({
  messages,
  useTools,
  desk,
  agent = "copper",
  sessionId,
  variant = "multi",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const first = firstAgent(variant, agent, Boolean(desk && useTools));
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handoff;
  }

  // Read the stream in the background, so the panel gets the first update now.
  let started = false;
  const answer = async () => {
    started = true;
    try {
      if (!useTools) {
        // Without tools, send no instructions either: "always use your
        // tools" with no tools makes the model answer with nothing.
        await follow(
          "copper",
          callStream(
            { module: 2, feature: "ask-copper" },
            { messages, providerOptions: THOUGHT_SUMMARIES },
          ),
        );
      } else {
        let current = first;
        for (let handoffs = 0; ; handoffs++) {
          const next = await follow(
            current,
            agentCall(current, messages, desk),
          );
          if (!next || next === current || handoffs >= MAX_HANDOFFS) break;
          progress.steps.push({ type: "handoff", from: current, to: next });
          progress.agent = current = next;
          progress.reply = "";
          call++;
          update(snapshot());
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = FALLBACK_REPLY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = FALLBACK_REPLY;
    }
  };

  void traceTurn(
    {
      name: "ask-copper",
      sessionId,
      // The Support page is Maya Reyes's account; the home page has no customer.
      userId: desk ? CUSTOMER.toLowerCase().replace(/\s+/g, "-") : undefined,
      input: messages.at(-1)?.content,
      tags: [
        variant === "single" ? "single-agent" : "multi-agent",
        desk ? "support-page" : "home-page",
      ],
      metadata: { variant, page: desk ? "support" : "home" },
    },
    async (turn) => {
      await answer();
      const agents = [
        first,
        ...progress.steps.flatMap((step) =>
          step.type === "handoff" ? [step.to] : [],
        ),
      ];
      turn.update({
        output: progress.reply,
        metadata: {
          answeredBy: AGENT_NAMES[progress.agent ?? "copper"],
          agents: agents.map((a) => AGENT_NAMES[a]),
          status: progress.status,
        },
      });
    },
  )
    // Tracing must never cost the customer their answer.
    .catch(async () => {
      if (!started) await answer();
    })
    .finally(() => {
      done(snapshot());
      void flushTracing().catch(() => {});
    });

  return { progress: live };
}
