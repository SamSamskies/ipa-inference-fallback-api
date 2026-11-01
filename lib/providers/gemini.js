import { scheduler } from "node:timers/promises";
import { inferenceError, retryAfterSeconds } from "../inference-response.js";

/** Provider-native content and role mapping stays inside the adapter. */
function toContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: message.parts.map((part) => typeof part.text === "string" ? { text: part.text } : {
      inlineData: { mimeType: part.image.mediaType, data: part.image.data },
    }),
  }));
}

/** @type {import("./registry.js").Generate} */
export async function generate(request, { model, apiKey, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const { options, webSearch } = request;
  const generationConfig = {};
  const thinkingConfig = thinkingConfigForEffort(model, options.reasoningEffort);
  if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const body = { contents: toContents(request.messages) };
  if (webSearch) body.tools = [{ googleSearch: {} }];
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  async function post() {
    signal.throwIfAborted();
    return fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
  }
  let response = await post();
  // One capacity retry, sharing the image/generation deadline.
  if ([500, 502, 503].includes(response.status)) {
    let error = null;
    try { error = await response.json(); } catch { /* unreadable error */ }
    if (!looksLikeCapacityError(error, response.status)) {
      logProviderError(response.status, error);
      throw geminiProviderFailure(response.status, error);
    }
    console.warn("[api/inference] provider capacity; retrying once", {
      http: response.status, status: error?.error?.status,
      message: geminiErrorMessage(error)?.slice(0, 200),
    });
    try {
      await scheduler.wait(800, { signal });
      response = await post();
    } catch {
      throw inferenceError(503, "provider_busy");
    }
  }
  if (response.status === 429) {
    let quota = "rate";
    let error = null;
    try {
      error = await response.json();
      quota = classifyGemini429(error);
      console.warn("[api/inference] provider 429", {
        kind: quota, webSearch, quotaIds: collectQuotaIds(error),
        message: geminiErrorMessage(error)?.slice(0, 200),
      });
    } catch {
      console.warn("[api/inference] provider 429", { kind: quota, webSearch, unreadable: true });
    }
    const code = quota === "daily" ? (webSearch ? "search_quota" : "quota_exhausted") : "rate_limited";
    throw inferenceError(429, code, { retryAfter: geminiRetryAfter(response, error) });
  }
  if (!response.ok) {
    let error = null;
    try { error = await response.json(); } catch { /* unreadable error */ }
    if (looksLikeCapacityError(error, response.status)) {
      console.warn("[api/inference] provider capacity", {
        http: response.status, message: geminiErrorMessage(error)?.slice(0, 200),
      });
      throw inferenceError(503, "provider_busy");
    }
    logProviderError(response.status, error);
    throw geminiProviderFailure(response.status, error);
  }
  const data = await response.json();
  const content = extractGeminiText(data);
  if (!content) throw inferenceError();
  return { content, model, sources: extractGroundingSources(data) };
}

function logProviderError(http, error) {
  console.warn("[api/inference] provider error", {
    http, status: error?.error?.status, message: geminiErrorMessage(error)?.slice(0, 200),
  });
}

const RETRYABLE_GEMINI_STATUS = new Set([
  "INTERNAL",
  "UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
  "DEADLINE_EXCEEDED",
  "ABORTED",
  "UNKNOWN",
]);

function looksLikeCapacityError(errJson, httpStatus) {
  if (httpStatus !== 500 && httpStatus !== 503 && httpStatus !== 502) {
    return false;
  }
  const providerStatus =
    errJson && typeof errJson === "object" ? errJson?.error?.status : null;
  // Gemini often returns opaque 500 INTERNAL / "Internal error encountered"
  // under load; treat like capacity rather than a hard provider failure.
  if (providerStatus === "INTERNAL" || providerStatus === "UNAVAILABLE") {
    return true;
  }
  const text = collectStrings(errJson).join(" ");
  return /high demand|try again later|temporarily|UNAVAILABLE|overloaded|capacity|internal error/i.test(
    text
  );
}

function isHardGeminiProviderStatus(status) {
  return typeof status === "string" && status.length > 0 && !RETRYABLE_GEMINI_STATUS.has(status);
}

function geminiProviderFailure(httpStatus, errJson) {
  const providerStatus = errJson && typeof errJson === "object" ? errJson.error?.status : undefined;
  const busy = httpStatus >= 500 && !isHardGeminiProviderStatus(providerStatus);
  return inferenceError(busy ? 503 : 400, busy ? "provider_busy" : "provider_error", {
    details: { http: httpStatus, ...(providerStatus ? { providerStatus } : {}) },
  });
}

/** Map IPA `reasoningEffort` onto Gemini thinking knobs. Omit for auto/absent. */
function thinkingConfigForEffort(model, effort) {
  if (effort == null || effort === "auto") return undefined;
  if (/\b2\.5\b/.test(model)) {
    if (effort === "none") return { thinkingBudget: 0 };
    if (effort === "low") return { thinkingBudget: 1024 };
    if (effort === "medium") return { thinkingBudget: 8192 };
    return { thinkingBudget: -1 };
  }
  if (/^gemma-/i.test(model)) {
    return { thinkingLevel: effort === "none" ? "minimal" : "high" };
  }
  return { thinkingLevel: effort === "none" ? "minimal" : effort };
}

function geminiRetryAfter(response, errJson) {
  const header = typeof response.headers?.get === "function"
    ? response.headers.get("retry-after")
    : undefined;
  if (header?.trim()) return retryAfterSeconds(header, { protobuf: true });
  let delay;
  walkObjects(errJson, (record) => {
    if (delay || typeof record.retryDelay !== "string") return;
    if (record.retryDelay.trim()) delay = record.retryDelay;
  });
  return retryAfterSeconds(delay, { protobuf: true });
}

function classifyGemini429(body) {
  // RESOURCE_EXHAUSTED covers both short-window RPM/TPM limits and daily/plan
  // quotas. Prefer explicit quota signals; default to rate (retry soon).
  const haystack = `${collectStrings(body).join(" ")} ${collectQuotaIds(body).join(" ")}`;
  if (
    /PerMinute|per_minute|per minute|RequestsPerMinute|_rpm\b|TokensPerMinute|_tpm\b/i.test(
      haystack
    )
  ) {
    return "rate";
  }
  // Opaque "check billing" / "exceeded your current quota" is Gemini's usual
  // daily/plan message when PerDay is absent (common for Search Grounding).
  if (
    /PerDay|per_day|per day|RequestsPerDay|_rpd\b|exceeded your current quota|billing details/i.test(
      haystack
    )
  ) {
    return "daily";
  }
  return "rate";
}

function collectQuotaIds(value) {
  const ids = [];
  walkObjects(value, (record) => {
    if (typeof record.quotaId === "string" && record.quotaId.trim()) {
      ids.push(record.quotaId);
    }
  });
  return ids;
}

function collectStrings(value) {
  const parts = [];
  const visit = (node) => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) visit(child);
    }
  };
  visit(value);
  return parts;
}

function walkObjects(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    visit(value);
    for (const child of Object.values(value)) walkObjects(child, visit);
  }
}

function geminiErrorMessage(value) {
  if (!value || typeof value !== "object") return undefined;
  const error = value.error;
  if (!error || typeof error !== "object") return undefined;
  const message = error.message;
  return typeof message === "string" ? message : undefined;
}

function extractGeminiText(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = data.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = candidates[0]?.content;
  if (!content || typeof content !== "object") return null;
  const parts = content.parts;
  if (!Array.isArray(parts)) return null;
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.thought === true) continue;
    if (typeof part.text === "string") chunks.push(part.text);
  }
  const joined = chunks.join("").trim();
  return joined || null;
}

function extractGroundingSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set();
  const sources = [];
  for (const chunk of chunks) {
    const web = chunk?.web;
    const uri = typeof web?.uri === "string" ? web.uri.trim() : "";
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const title =
      typeof web.title === "string" && web.title.trim()
        ? web.title.trim()
        : uri;
    sources.push({ title, uri });
  }
  return sources;
}
