// npm run share-trace -- <trace id>
// Makes one Langfuse trace public, so anyone with its link can open it without
// logging in to Langfuse (Module 5 asks for a public refund conversation).
// Langfuse marks a trace public when any of its spans says so, so this adds a
// zero-length "share-trace" span at the start of the trace's first
// observation, which leaves the trace's latency as it was. No model calls.
import { existsSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { startObservation } from "@langfuse/tracing";
import { startTracing, stopTracing } from "@/lib/ai/tracing";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

async function main() {
  const traceId = process.argv[2]?.trim();
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId))
    throw new Error("Usage: npm run share-trace -- <32-character trace id>");
  if (!startTracing({ global: true }))
    throw new Error("Set the three LANGFUSE_ variables in .env.local first.");

  const langfuse = new LangfuseClient();
  const { data } = await langfuse.api.observations.getMany({
    traceId,
    limit: 100,
  });
  const root = data.find((o) => !o.parentObservationId) ?? data[0];
  if (!root) throw new Error(`Trace ${traceId} has no observations yet.`);

  const at = new Date(root.startTime);
  const span = startObservation(
    "share-trace",
    { metadata: { reason: "Make this trace public" } },
    {
      parentSpanContext: { traceId, spanId: root.id, traceFlags: 1 },
      startTime: at,
    },
  );
  span.setTraceAsPublic();
  span.end(at);
  await stopTracing();

  console.log(`Public: ${await langfuse.getTraceUrl(traceId)}`);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await stopTracing().catch(() => {});
  process.exitCode = 1;
});
