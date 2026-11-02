import { appEnvNames } from "./apps.js";
import { loadLocalEnvFallback } from "./env.js";
import { replitMaxTokens } from "./replit-limits.js";

loadLocalEnvFallback([
  "INFERENCE_FALLBACK_ENABLED", "INFERENCE_CLIENT_DAILY_LIMIT", "INFERENCE_REQUEST_TIMEOUT_MS",
  "OLLAMA_REQUESTS_PER_MINUTE", "OLLAMA_CLIENT_REQUESTS_PER_MINUTE", "OLLAMA_MAX_CONCURRENT",
  "REPLIT_MAX_TOKENS", ...appEnvNames(),
], { exact: true });

export function fallbackEnabled() {
  return !["0", "false", "off"].includes(
    (process.env.INFERENCE_FALLBACK_ENABLED ?? "").trim().toLowerCase()
  );
}

/** Both inference and discovery apply the same local provider policy checks. */
export function providerRequestConfig(providerId) {
  return providerId === "replit" ? { maxTokens: replitMaxTokens() } : {};
}
