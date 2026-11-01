/** Hosted IPA fallback; provider-native behavior lives in lib/providers. */
import { clientQuota } from "../lib/client-quota.js";
import { envInt, loadLocalEnvFallback } from "../lib/env.js";
import { resolveProviderConfig } from "../lib/provider-config.js";
import { getProvider } from "../lib/providers/registry.js";
import { applyCapabilities, MAX_BODY_BYTES, normalizeRequest } from "../lib/inference-request.js";
import { prepareRequestImages } from "../lib/inference-images.js";
import { sendInferenceError, withSources } from "../lib/inference-response.js";
import { requestTimeoutMs } from "../lib/timeouts.js";
import { applyCors, INFERENCE_CLIENT_HEADER, originAllowed } from "../lib/http.js";

// Preserve the existing DNS test seam while image handling lives in a shared helper.
export { imageFetchDns } from "../lib/inference-images.js";

const DEFAULT_CLIENT_DAILY = 50;
loadLocalEnvFallback(["DEFAULT_INFERENCE_PROVIDER", "INFERENCE_", "GEMINI_", "OLLAMA_", "REPLIT_"]);

function defaultProviderId() {
  return process.env.DEFAULT_INFERENCE_PROVIDER?.trim().toLowerCase() || "ollama";
}

function fallbackEnabled(apiKey) {
  const flag = (process.env.INFERENCE_FALLBACK_ENABLED ?? "").trim().toLowerCase();
  if (["0", "false", "off"].includes(flag)) return false;
  return Boolean(apiKey);
}

function clientDailyLimit() {
  return envInt("INFERENCE_CLIENT_DAILY_LIMIT", DEFAULT_CLIENT_DAILY);
}

function readBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body == null) return "";
  return JSON.stringify(req.body);
}

function clientToken(req) {
  const header = req.headers[INFERENCE_CLIENT_HEADER.toLowerCase()];
  return typeof header === "string" ? header.trim() : "";
}

export default async function handler(req, res) {
  applyCors(res, req);

  if (req.method === "OPTIONS") {
    if (req.headers.origin && !originAllowed(req)) {
      res.status(403).end();
      return;
    }
    res.status(204).end();
    return;
  }

  const requestedProviders = new URL(
    req.url || "/api/inference", "http://localhost"
  ).searchParams.getAll("provider");
  const explicitProvider = requestedProviders.length > 0;
  const providerId = explicitProvider
    ? requestedProviders[0].trim().toLowerCase()
    : defaultProviderId();
  if (requestedProviders.length > 1 || !getProvider(providerId)) {
    res.status(explicitProvider ? 400 : 503).json({ error: "invalid_provider" });
    return;
  }

  const selected = resolveProviderConfig(providerId);
  const { adapter, apiKey, model, capabilities, maxTokens } = selected;

  if (req.method === "GET") {
    if (fallbackEnabled(apiKey)) {
      res.status(200).json({ ok: true });
      return;
    }
    res.status(503).json({
      ok: false,
      error: apiKey ? "disabled" : "missing_api_key",
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!fallbackEnabled(apiKey)) {
    res.status(503).json({
      error: apiKey ? "disabled" : "missing_api_key",
    });
    return;
  }

  if (!originAllowed(req)) {
    res.status(403).json({ error: "forbidden_origin" });
    return;
  }

  const contentLength = Number(req.headers["content-length"] || "0");
  if (contentLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  let body;
  try {
    const text = readBody(req);
    if (text.length > MAX_BODY_BYTES) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    body =
      typeof req.body === "object" && req.body != null
        ? req.body
        : JSON.parse(text);
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  let request;
  try {
    request = normalizeRequest(body);
  } catch (error) {
    sendInferenceError(res, error);
    return;
  }

  const clientId = clientToken(req);
  if (!clientId) {
    res.status(400).json({ error: "missing_client_token" });
    return;
  }
  const reservation = await clientQuota.tryConsume(clientId, clientDailyLimit());
  if (typeof reservation === "string") {
    res.status(429).json({ error: reservation });
    return;
  }

  let release;
  const signal = AbortSignal.timeout(requestTimeoutMs());
  try {
    release = adapter.acquire?.(clientId);
    const prepared = await prepareRequestImages(applyCapabilities(request, capabilities), signal, capabilities);
    const result = await adapter.generate(prepared, { model, apiKey, signal, maxTokens });
    await clientQuota.commit(reservation);
    res.status(200).json({ content: withSources(result.content, result.sources), model: result.model });
  } catch (error) {
    await clientQuota.release(reservation);
    sendInferenceError(res, error, signal);
  } finally {
    release?.();
  }
}
