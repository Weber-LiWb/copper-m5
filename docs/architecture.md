# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order amount with an auto-refund limit you can
change: at or under it, the refund goes through; over it, the refund waits on
the Refund Console until a person clicks Approve or Reject, and the Refund
agent tells the customer.

| Piece | Where | What it does |
|---|---|---|
| Orders and the rule | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004). `requestRefund()` decides: `refunded` at or under the limit, `needs_approval` over it; an order already decided keeps its status; `not_found` for unknown numbers |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn (`hasToolCall`); the other agent answers the same conversation. The agent that ends a turn answers the next message |
| Refund agent | `lib/copper/assistant/instructions.ts` (`REFUND_AGENT_INSTRUCTIONS`), `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund`, built on the desk the chat sends. Copper can't use these |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The auto-refund limit ($50 to start), the refunds waiting for approval with Approve and Reject, and the orders with their status. State lives in the page: a reload starts fresh |
| Chat panel | `components/copper/ask-copper.tsx` | With `support`, sends the desk (limit and refunds so far) and the current agent with each message, puts each `request_refund` decision on the console, and sends the console's "[Refund Console] A supervisor approved …" note to the Refund agent, which tells the customer. Shows each handoff as its own station |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question → Copper → `transfer_to_refund_agent` → Refund agent
→ `request_refund` → the app compares the amount with the limit → refunded,
or waiting on the Refund Console → Approve or Reject → console note → Refund
agent tells the customer.

**Decisions and trade-offs:** The refund decision is code, so the model can't
argue past the limit. Two agents keep refund tools away from Copper. A real
handoff (the other agent answers) rather than an agent called as a tool keeps
one voice per reply. The console's state lives in the browser and goes with
each message, so there's nothing to set up and nothing stored on the server;
the cost is that a reload forgets every refund.

**Risks and open questions:** A customer can claim a supervisor already
approved; the Refund agent must still ask the app. Setting the limit to 0
sends every refund to a person. A real app needs a database so refunds
survive a reload and several supervisors see the same queue.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5: Safe to ship (CI, tracing, evals, single vs multi agent)

**Summary:** Every pull request runs the tests on three operating systems and
a golden-set evaluation graded by an AI judge, and `main` only takes pull
requests whose checks pass. Every chat turn is traced in Langfuse: which agent
answered, its tool calls, and the tokens, cost and time of each model call.
The same golden set compares the two agents with one Support agent that does
everything. Langfuse is the only eval and monitoring tool.

| Piece | Where | What it does |
|---|---|---|
| Tracing | `lib/ai/tracing.ts`, `lib/ai/call.ts` | With `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` set, each call in `call.ts` opens an observation named after its agent (`agent` in the call info). Inside it, an AI SDK telemetry integration adds one generation per model request with its tokens and its cost from `lib/ai/pricing.ts`, and each tool call is a tool observation (search_docs's embedding nests inside it). Without the keys nothing is traced and calls behave as before |
| Chat turns | `lib/copper/assistant/ask.ts`, `components/copper/ask-copper.tsx` | `askCopper()` wraps each turn in one `ask-copper` trace with the question, the reply and who answered. The panel sends one session id per conversation, so Langfuse groups a chat's turns into a session |
| Single agent | `lib/copper/assistant/variants.ts`, `instructions.ts` (`SUPPORT_AGENT_INSTRUCTIONS`), `tools.ts` (`supportAgentTools`) | `variant: "single"` answers with one Support agent: Copper's instructions plus the Refund agent's refund rules (the same text), every tool, no handoff. The app always uses `"multi"` |
| Golden set | `lib/evals/golden-set.ts` | 10 Support page questions, each with what a good answer does: #1002 refunded automatically, #1003 and #1004 waiting for approval (one with a customer claiming it was approved), the order list, three document questions with citations, one not in the documents, one off-topic. Every case runs with a $100 limit and no refunds yet |
| AI judge | `lib/evals/judge.ts` | `judgeAnswer()` calls `callObject` with the question, the criteria, the tool calls and their results, and the reply; it returns pass, a score from 0 to 1 and a reason |
| Eval runner | `scripts/eval.ts` (`npm run eval`), `lib/evals/run-case.ts`, `lib/evals/summary.ts` | Syncs the golden set to the Langfuse dataset `copper-golden-set` and runs it as one dataset run (`--variant multi\|single`, `--run-name`). Each case is a trace; `passed` and `judge_score` go to Langfuse as scores, and the run gets `pass_rate`, `total_cost_usd` and `avg_latency_s`. Prints a Markdown table, writes it to the GitHub job summary and exits 1 under `--threshold` (0.8) |
| Judge calibration | `lib/evals/judge-calibration.ts`, `scripts/calibrate-judge.ts` (`npm run calibrate-judge`) | 8 replies with known grades (a good and a bad one for four kinds of case), run through the judge as the Langfuse dataset `judge-calibration/copper-judge`; `judge-output-correct` per item and `judge_accuracy` per run |
| Retries | `lib/ai/retry-fetch.ts` | With `AI_RETRY_SERVER_ERRORS` set (the eval sets 4), a request that gets a 5xx is sent again after a wait; a 429 never is. Each `ai_calls` row counts every attempt (`requests`) and the time lost to them (`lost_ms`) |
| Public traces | `scripts/share-trace.ts` (`npm run share-trace -- <trace id>`) | Makes one trace public, so its link opens without a Langfuse login |
| CI | `.github/workflows/ci.yml`, `.github/workflows/eval.yml` | `ci.yml` (from the starter): lint, typecheck, tests and build on Linux, macOS and Windows, on every push and pull request, with no secrets. `eval.yml`: the golden set on the multi-agent app, on pull requests only, on Linux, with the Gemini and Langfuse keys from the repo's Actions secrets |
| Branch protection | GitHub settings for `main` | Pull requests only, no direct pushes, and the `check` jobs and `eval` must pass, for admins too |
| AI calls | `{ module: 5, feature: "support-agent" }`, `{ module: 5, feature: "eval-judge" }` | The Support agent (eval only) and the judge: one call per case, about 600 input tokens and $0.0003 each on Gemini 3.5 Flash-Lite |

**Data flow:** question → `askCopper()` opens the turn's trace → each agent's
`callStream` → agent observation → generations (tokens, cost) and tool
observations → reply → the trace is flushed to Langfuse. For the eval:
`npm run eval` → dataset `copper-golden-set` → one trace per case → the judge
grades the reply → scores on the trace and the run → Markdown summary → exit
code → the pull request's `eval` check.

**Decisions and trade-offs:** A small telemetry integration of our own
instead of `@langfuse/vercel-ai-sdk`, which pulls in a different `ai` version
through `@ai-sdk/otel`; ours names each agent, nests tools under it and sets
the cost from `pricing.ts`, so cost never shows 0 for a model Langfuse doesn't
price. The app keeps Langfuse's tracer to itself (`setLangfuseTracerProvider`)
instead of registering it globally: registered globally, it also switched on
Next.js's own fetch tracing, and Gemini's streamed replies were cut off
mid-sentence (2 of 2 turns; 0 of 1 with tracing off, 0 of 1 with the fix).
The eval scripts register it globally, which Langfuse's experiment runner
needs. The eval is its own workflow on pull requests only: it spends live
Gemini calls, so it runs once per push on one OS rather than six times, and a
push never reports a skipped `eval` that could satisfy branch protection.
Gemini 3.5 Flash-Lite answered 503 "high demand" to a fifth to a third of
requests while this was built, so the eval retries each failed request on its
own (not the whole case) and leaves that time out of the latency; the AI
SDK's own retries are off there (`AI_MAX_RETRIES=0`) because they would retry
a quota error (429) too, which instead stops the run. A run also stops when a
5xx outlasts its retries or after 60 requests, and a stopped run writes no
pass rate. Cases are paced about 30 seconds apart after each trace ends, so
the pacing never counts as latency. The judge is the
same model as the agents, which keeps it cheap and inside one key's free tier,
but it shares the agents' blind spots.

**Single vs multi agent (2026-11-25, same 10 cases, model and judge):**

| Variant | Pass rate | Total cost (agents) | Average latency per case |
|---|---|---|---|
| Multi-agent (Copper + Refund agent) | 9/10 (90%) | $0.0205 | 9.1 s |
| Single Support agent | 10/10 (100%) | $0.0221 | 7.4 s |

The one difference in quality is the order question: Copper hands off only
refunds, and only the Refund agent can see orders, so Copper answered without
the order list. The single agent skips the handoff call, so it's faster; its
longer instructions and tool list make each call a little dearer. Costs are
at Google's paid list prices; on the free tier they cost nothing.

**Risks and open questions:** The judge is a model: it can be wrong or vary
between runs, so the gate is a pass rate with a threshold, and each score has
a reason to check. Ten cases is a small sample, so a one-case difference
between variants is within noise. Traces include the customer's messages and
the order list. Emails, phone numbers and card numbers are masked before
export (`maskPii`); a real app would also set a retention period. Each pull request push spends about 40
Gemini requests.
