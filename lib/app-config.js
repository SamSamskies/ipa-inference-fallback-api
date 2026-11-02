import { apps } from "./apps.js";
import { inferenceError } from "./inference-response.js";
import { getProvider } from "./providers/registry.js";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalidConfig = () => inferenceError(503, "invalid_app_config");

/** Validate server configuration without reading or including any secret values. */
export function validateAppRegistry(registry) {
  if (!record(registry)) throw invalidConfig();
  const usedEnvNames = new Set();
  function envName(value) {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value) || usedEnvNames.has(value)) {
      throw invalidConfig();
    }
    usedEnvNames.add(value);
  }
  for (const [id, app] of Object.entries(registry)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || !record(app) ||
      typeof app.name !== "string" || !app.name.trim() || typeof app.enabled !== "boolean" ||
      !record(app.providers)) throw invalidConfig();
    envName(app.authSecretEnv);
    for (const [providerId, config] of Object.entries(app.providers)) {
      if (!getProvider(providerId) || !record(config) ||
        (config.enabled !== undefined && typeof config.enabled !== "boolean")) throw invalidConfig();
      envName(config.apiKeyEnv);
      if (config.maxTokensEnv !== undefined) {
        if (providerId !== "replit") throw invalidConfig();
        envName(config.maxTokensEnv);
      }
    }
  }
}

/**
 * Resolve settings for a trusted, authenticated app ID. This is not authentication:
 * the HTTP boundary must verify the app secret before calling this function (#5).
 * Never use this with an unverified request header or fall back to global settings.
 */
export function createAppConfigResolver(registry = apps, env = process.env) {
  validateAppRegistry(registry);
  // Retain an immutable snapshot so later caller mutations cannot bypass validation.
  const snapshot = structuredClone(registry);
  return function resolve(appId, selectedProvider) {
    if (typeof appId !== "string" || !Object.hasOwn(snapshot, appId)) {
      throw inferenceError(403, "unknown_app");
    }
    const app = snapshot[appId];
    if (!app.enabled) throw inferenceError(403, "app_disabled");
    const providerId = typeof selectedProvider === "string" ? selectedProvider.trim().toLowerCase() : "";
    const adapter = getProvider(providerId);
    if (!adapter) throw inferenceError(400, "invalid_provider");
    if (!Object.hasOwn(app.providers, providerId)) throw inferenceError(403, "provider_not_allowed");
    const config = app.providers[providerId];
    if (config.enabled === false) throw inferenceError(503, "provider_disabled");
    const apiKey = env[config.apiKeyEnv]?.trim() || "";
    if (!apiKey) throw inferenceError(503, "missing_api_key");
    const rawMaxTokens = config.maxTokensEnv ? env[config.maxTokensEnv]?.trim() : "";
    const maxTokens = rawMaxTokens ? Number(rawMaxTokens) : undefined;
    if (maxTokens !== undefined && (!/^\d+$/.test(rawMaxTokens) ||
      !Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw invalidConfig();
    return {
      appId, providerId, adapter, apiKey,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  };
}

export const resolveAppProviderConfig = createAppConfigResolver();
