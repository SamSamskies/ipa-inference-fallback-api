import { inferenceError } from "./inference-response.js";

/** Service policy only. Caller payloads and app registry settings cannot override it. */
export function replitMaxTokens() {
  const raw = process.env.REPLIT_MAX_TOKENS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw inferenceError(503, "invalid_provider_config");
  }
  return value;
}
