/** Hosted IPA fallback; provider-native behavior lives in lib/providers. */
import { clientQuota } from "../lib/client-quota.js";
import { authenticateApp, requestProviderKey } from "../lib/app-auth.js";
import { resolveAppProviderConfig } from "../lib/app-config.js";
import { envInt } from "../lib/env.js";
import { capabilitiesForModel, getProvider } from "../lib/providers/registry.js";
import { applyCapabilities, MAX_BODY_BYTES, normalizeModel, normalizeRequest } from "../lib/inference-request.js";
import { prepareRequestImages } from "../lib/inference-images.js";
import { sendInferenceError, withSources } from "../lib/inference-response.js";
import { requestTimeoutMs } from "../lib/timeouts.js";
import { fallbackEnabled, providerRequestConfig } from "../lib/service-config.js";
import { applyCors, INFERENCE_CLIENT_HEADER, originAllowed } from "../lib/http.js";

// Preserve the existing DNS test seam while image handling lives in a shared helper.
export { imageFetchDns } from "../lib/inference-images.js";

const DEFAULT_CLIENT_DAILY = 50;
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

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let appId;
  try {
    appId = authenticateApp(req);
  } catch (error) {
    sendInferenceError(res, error);
    return;
  }

  const requestedProviders = new URL(
    req.url || "/api/inference", "http://localhost"
  ).searchParams.getAll("provider");
  const providerId = requestedProviders[0]?.trim().toLowerCase();
  if (requestedProviders.length !== 1 || !getProvider(providerId)) {
    res.status(400).json({ error: "invalid_provider" });
    return;
  }

  let selected;
  let apiKey;
  let maxTokens;
  try {
    selected = resolveAppProviderConfig(appId, providerId);
    apiKey = requestProviderKey(req);
    ({ maxTokens } = providerRequestConfig(providerId));
  } catch (error) {
    sendInferenceError(res, error);
    return;
  }
  const { adapter } = selected;

  if (req.headers.origin && !originAllowed(req)) {
    res.status(403).json({ error: "forbidden_origin" });
    return;
  }

  if (req.method === "GET") {
    if (fallbackEnabled()) {
      res.status(200).json({ ok: true });
      return;
    }
    res.status(503).json({
      ok: false,
      error: "disabled",
    });
    return;
  }

  if (!fallbackEnabled()) {
    res.status(503).json({
      error: "disabled",
    });
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
  let model;
  let capabilities;
  try {
    request = normalizeRequest(body);
    model = normalizeModel(body?.model);
    capabilities = capabilitiesForModel(adapter, model);
    request = applyCapabilities(request, capabilities);
  } catch (error) {
    sendInferenceError(res, error);
    return;
  }

  const clientId = clientToken(req);
  if (!clientId) {
    res.status(400).json({ error: "missing_client_token" });
    return;
  }
  const scopedClientId = JSON.stringify([appId, clientId]);
  const reservation = await clientQuota.tryConsume(scopedClientId, clientDailyLimit());
  if (typeof reservation === "string") {
    res.status(429).json({ error: reservation });
    return;
  }

  let release;
  const signal = AbortSignal.timeout(requestTimeoutMs());
  try {
    release = adapter.acquire?.(scopedClientId);
    const prepared = await prepareRequestImages(request, signal, capabilities);
    const result = await adapter.generate(prepared, { model, apiKey, signal, maxTokens });
    await clientQuota.commit(reservation);
    res.status(200).json({
      content: withSources(result.content, result.sources).replaceAll(apiKey, "[redacted]"),
      model: result.model.replaceAll(apiKey, "[redacted]"),
      provider: providerId,
    });
  } catch (error) {
    await clientQuota.release(reservation);
    sendInferenceError(res, error, signal);
  } finally {
    release?.();
  }
}
