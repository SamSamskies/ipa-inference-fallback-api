import { envInt } from "./env.js";
import { capabilitiesForModel, getProvider, providers } from "./providers/registry.js";

// Kept as the configuration index used by the smoke CLI and existing consumers.
export const PROVIDER_CONFIG = Object.fromEntries(
  Object.entries(providers).map(([id, adapter]) => [id, adapter.config]),
);

/** Resolve one request's server-owned settings before calling its adapter. */
export function resolveProviderConfig(id) {
  const adapter = getProvider(id);
  if (!adapter) return undefined;
  const { keyEnv, modelEnv, defaultModel, maxTokensEnv } = adapter.config;
  const model = process.env[modelEnv]?.trim() || defaultModel;
  return {
    adapter,
    model,
    apiKey: process.env[keyEnv]?.trim() || "",
    capabilities: capabilitiesForModel(adapter, model),
    ...(maxTokensEnv ? { maxTokens: envInt(maxTokensEnv, undefined) } : {}),
  };
}
