// Gemini sometimes answers 503 "high demand" for a few seconds. With
// AI_RETRY_SERVER_ERRORS set (the eval sets it), a request that gets a 5xx or
// a network error is sent again after a wait; a 429 (quota) never is. Every
// attempt is counted, and the time the failed attempts and waits took is kept,
// so the eval can leave it out of the latency.

export type FetchStats = {
  /** HTTP requests sent, failed ones included. */
  attempts: number;
  /** Time spent on failed attempts and the waits after them. */
  lostMs: number;
};

const SERVER_ERRORS = new Set([500, 502, 503, 504]);

export function serverErrorRetries(): number {
  const retries = Number(process.env.AI_RETRY_SERVER_ERRORS?.trim());
  return Number.isInteger(retries) && retries > 0 ? retries : 0;
}

/** The wait before retry `n` (1, 2, ...): Google's Retry-After, or 4, 8, 16, 32 s. */
export function retryDelayMs(n: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds, 60) * 1000;
  return 2000 * 2 ** n;
}

export function countingFetch(
  stats: FetchStats,
  options: {
    retries?: number;
    fetch?: typeof globalThis.fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): typeof globalThis.fetch {
  const retries = options.retries ?? serverErrorRetries();
  const send = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (input, init) => {
    for (let n = 1; ; n++) {
      const started = performance.now();
      stats.attempts++;
      let response: Response;
      try {
        response = await send(input, init);
      } catch (error) {
        if (n > retries) throw error;
        await sleep(retryDelayMs(n, null));
        stats.lostMs += performance.now() - started;
        continue;
      }
      if (!SERVER_ERRORS.has(response.status) || n > retries) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(retryDelayMs(n, response.headers.get("retry-after")));
      stats.lostMs += performance.now() - started;
    }
  };
}
