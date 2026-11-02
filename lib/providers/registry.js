import { generate as generateOllama } from "./ollama.js";
import { generate as generateGemini } from "./gemini.js";
import { generate as generateReplit } from "./replit.js";
import { ollamaLimiter } from "../ollama-limits.js";

/**
 * @typedef {{vision: boolean, webSearch: boolean, reasoning: boolean}} Capabilities
 * @typedef {{content: string, model: string, sources: {title: string, uri: string}[]}} GenerationResult
 * @typedef {{model: string, apiKey: string, signal: AbortSignal, maxTokens?: number}} GenerationConfig
 * @typedef {(request: import("../inference-request.js").NormalizedRequest, config: GenerationConfig) => Promise<GenerationResult>} Generate
 * @typedef {object} ProviderAdapter
 * @property {string} id
 * @property {Capabilities} capabilities Transport defaults for configurable models; not live model discovery.
 * @property {Record<string, Partial<Capabilities>>} models Exact model overrides, owned by the server.
 * @property {Generate} generate Receives normalized messages with prepared images; never reads credentials/models from env.
 * @property {(clientId: string) => (() => void)} [acquire] Optional request admission; release in the handler's finally block.
 */

// All three transports retain their existing best-effort vision/search/reasoning
// behavior for arbitrary requested models. Add model-specific restrictions here
// when deploying a model that does not support an optional capability.
const capabilities = Object.freeze({ vision: true, webSearch: true, reasoning: true });

/** @type {Readonly<Record<string, ProviderAdapter>>} */
export const providers = Object.freeze({
  ollama: {
    id: "ollama",
    capabilities,
    models: { "gemma4:cloud": capabilities, "gemma4:31b": capabilities },
    generate: generateOllama,
    acquire: (clientId) => ollamaLimiter.begin(clientId),
  },
  gemini: {
    id: "gemini",
    capabilities,
    models: { "gemma-4-31b-it": capabilities },
    generate: generateGemini,
  },
  replit: {
    id: "replit",
    capabilities,
    models: { "google/gemma-4-26b-a4b-it": capabilities },
    generate: generateReplit,
  },
});

export function getProvider(id) {
  return Object.hasOwn(providers, id) ? providers[id] : undefined;
}

/** Exact model settings override transport defaults, without mutating metadata. */
export function capabilitiesForModel(adapter, model) {
  return {
    ...adapter.capabilities,
    ...(Object.hasOwn(adapter.models, model) ? adapter.models[model] : {}),
  };
}
