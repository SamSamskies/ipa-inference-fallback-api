const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
// Keep 10 seconds below vercel.json's 180-second function limit.
const MAX_REQUEST_TIMEOUT_MS = 170_000;
const SMOKE_TIMEOUT_BUFFER_MS = 30_000;

export function requestTimeoutMs() {
  const value = Number(process.env.INFERENCE_REQUEST_TIMEOUT_MS?.trim());
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_REQUEST_TIMEOUT_MS)
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function smokeTimeoutMs() {
  return requestTimeoutMs() + SMOKE_TIMEOUT_BUFFER_MS;
}
