// Gemini sometimes answers 503 "high demand" for a few seconds. The eval
// retries those a couple of times; a quota error (429) is never retried, so
// the run stops instead of spending more calls.
import { isQuotaError } from "@/lib/evals/summary";

/** Worth one more try: a 5xx, an overloaded model, or a reply cut off mid-stream. */
export function isTransientError(text: string | undefined): boolean {
  if (!text || isQuotaError(text)) return false;
  return /\b50[0234]\b|high demand|overloaded|unavailable|timed? ?out|ECONNRESET|fetch failed|cut the reply off/i.test(
    text,
  );
}

export type RetryOptions = {
  /** Retries after the first try. */
  retries: number;
  /** Wait before retry n is `waitMs * n`. */
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: string, attempt: number) => void;
};

/**
 * Runs `attempt` until `errorOf` finds no error, the error isn't transient,
 * or the retries run out. Returns every result, last one last, so callers can
 * add up what all the tries cost and time only the last one.
 */
export async function retrying<T>(
  attempt: () => Promise<T>,
  errorOf: (result: T) => string | undefined,
  options: RetryOptions,
): Promise<T[]> {
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const results: T[] = [];
  for (let n = 0; ; n++) {
    const result = await attempt();
    results.push(result);
    const error = errorOf(result);
    if (!error || !isTransientError(error) || n >= options.retries)
      return results;
    options.onRetry?.(error, n + 1);
    await sleep(options.waitMs * (n + 1));
  }
}
