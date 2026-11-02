import { apps } from "../lib/apps.js";
import { createAppAuthenticator } from "../lib/app-auth.js";
import { createAppConfigResolver } from "../lib/app-config.js";
import { applyCors, originAllowed } from "../lib/http.js";
import { sendInferenceError } from "../lib/inference-response.js";
import { capabilitiesForModel } from "../lib/providers/registry.js";
import { fallbackEnabled, providerRequestConfig } from "../lib/service-config.js";

// Explicit serialization prevents adapter internals or registry secrets leaking.
function publicCapabilities(capabilities) {
  return {
    vision: capabilities.vision === true,
    webSearch: capabilities.webSearch === true,
    reasoning: capabilities.reasoning === true,
  };
}

export function createProvidersHandler(registry = apps) {
  const authenticate = createAppAuthenticator(registry);
  const resolve = createAppConfigResolver(registry);
  const snapshot = structuredClone(registry);
  return async function handler(req, res) {
    applyCors(res, req);
    if (req.method === "OPTIONS") {
      res.status(req.headers.origin && !originAllowed(req) ? 403 : 204).end();
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    try {
      const appId = authenticate(req);
      if (req.headers.origin && !originAllowed(req)) {
        res.status(403).json({ error: "forbidden_origin" });
        return;
      }
      if (!fallbackEnabled()) {
        res.status(503).json({ error: "disabled" });
        return;
      }
      const providers = [];
      for (const [id, config] of Object.entries(snapshot[appId].providers)) {
        if (config.enabled === false) continue;
        const { adapter } = resolve(appId, id);
        try {
          providerRequestConfig(id);
        } catch (error) {
          if (error?.message === "invalid_provider_config" && error?.status === 503) continue;
          throw error;
        }
        providers.push({
          id,
          capabilities: publicCapabilities(adapter.capabilities),
          models: Object.keys(adapter.models).map((model) => ({
            id: model,
            capabilities: publicCapabilities(capabilitiesForModel(adapter, model)),
          })),
        });
      }
      res.status(200).json({ providers });
    } catch (error) {
      sendInferenceError(res, error);
    }
  };
}

export default createProvidersHandler();
