import { checkRateLimit } from "@vercel/firewall";
import { inferenceError } from "./inference-response.js";

const RULE_ID = "inference-app";
const CHECK_TIMEOUT_MS = 1000;

/**
 * Vercel owns the counters, which are shared across instances within a region.
 * This admission budget counts attempts, not successful responses, and is never
 * refunded. Local development keeps the existing process-local controls only.
 */
export function createAppRateLimit({ check = checkRateLimit, env = process.env } = {}) {
  return async function admit(appId) {
    if (env.VERCEL !== "1" || env.VERCEL_ENV === "development") return;

    // The SDK silently allows development-mode calls. Never take that path on
    // Vercel, and never use the incoming Host header as its outbound destination.
    const host = env.VERCEL_URL;
    const window = env.INFERENCE_RATE_LIMIT_WINDOW_SECONDS?.trim() || "60";
    const seconds = Number(window);
    if (env.NODE_ENV !== "production" || typeof host !== "string" ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i.test(host) ||
        !/^\d+$/.test(window) || !Number.isSafeInteger(seconds) || seconds < 10 || seconds > 600) {
      throw inferenceError(503, "rate_limit_unavailable", { retryAfter: 5 });
    }

    let result;
    try {
      result = await check(RULE_ID, {
        // The SDK forwards supplied headers. Give it only a trusted deployment
        // host: never request headers, cookies, app secrets, or provider keys.
        headers: { host },
        rateLimitKey: JSON.stringify(["ipa-inference", "app", appId]),
        timeout: CHECK_TIMEOUT_MS,
      });
    } catch {
      throw inferenceError(503, "rate_limit_unavailable", { retryAfter: 5 });
    }
    // A missing rule returns { rateLimited: false, error: 'not-found' }.
    // Treat it as a configuration failure, never as permission to generate.
    if (result?.error === "blocked" && result.rateLimited === true) {
      throw inferenceError(429, "rate_limited", { retryAfter: seconds });
    }
    if (result?.error || typeof result?.rateLimited !== "boolean") {
      throw inferenceError(503, "rate_limit_unavailable", { retryAfter: 5 });
    }
    if (result.rateLimited) {
      // The SDK exposes no remaining-window/Retry-After value. Waiting a full
      // configured window is conservative; keep this setting in sync with WAF.
      throw inferenceError(429, "rate_limited", { retryAfter: seconds });
    }
  };
}

export const appRateLimit = { admit: createAppRateLimit() };
