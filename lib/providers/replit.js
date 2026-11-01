import { inferenceError, retryAfterSeconds } from "../inference-response.js";

const CHAT_URL = "https://samsamskies-inference.replit.app/api/v1/chat/completions";

function httpError(response) {
  if (response.status === 401 || response.status === 403) return inferenceError(502, "provider_auth");
  if (response.status === 404) return inferenceError(502, "model_unavailable");
  if (response.status === 402) return inferenceError(429, "quota_exhausted");
  if (response.status === 429) {
    return inferenceError(429, "rate_limited", { retryAfter: retryAfterSeconds(response.headers.get("retry-after")) });
  }
  return response.status >= 500 ? inferenceError(503, "provider_busy") : inferenceError();
}

/** Map prepared images to data URLs required by the fixed gateway. */
function toMessages(request) {
  const messages = request.messages.map((turn) => {
    const parts = turn.parts.flatMap((part) => {
      if (part.image?.data) return [{
        type: "image_url",
        image_url: { url: `data:${part.image.mediaType};base64,${part.image.data}` },
      }];
      return typeof part.text === "string" && part.text ? [{ type: "text", text: part.text }] : [];
    });
    return {
      role: turn.role,
      content: parts.length === 0 ? "" : parts.every((part) => part.type === "text")
        ? parts.map((part) => part.text).join("\n\n") : parts,
    };
  });
  if (request.system) messages.unshift({ role: "system", content: request.system });
  return messages;
}

function extractSources(message) {
  if (!Array.isArray(message.annotations)) return [];
  const sources = new Map();
  for (const annotation of message.annotations) {
    if (annotation?.type !== "url_citation") continue;
    const citation = annotation.url_citation;
    const uri = typeof citation?.url === "string" ? citation.url.trim() : "";
    try {
      if (!["http:", "https:"].includes(new URL(uri).protocol)) continue;
    } catch {
      continue;
    }
    const title = typeof citation.title === "string" && citation.title.trim() ? citation.title.trim() : uri;
    if (!sources.has(uri)) sources.set(uri, { title, uri });
  }
  return [...sources.values()];
}

/** Non-streaming OpenAI-compatible request through the fixed Replit/OpenRouter gateway. */
/** @type {import("./registry.js").Generate} */
export async function generate(request, { model, apiKey, signal, maxTokens }) {
  const { options, webSearch } = request;
  const body = { model, messages: toMessages(request), stream: false };
  if (maxTokens >= 1) body.max_tokens = maxTokens;
  if (webSearch) body.tools = [{ type: "openrouter:web_search" }];
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.reasoningEffort && options.reasoningEffort !== "auto") {
    body.reasoning_effort = options.reasoningEffort;
  }
  async function post() {
    signal.throwIfAborted();
    return fetch(CHAT_URL, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  }
  let response = await post();
  if (!response.ok && (response.status === 400 || response.status === 422)) {
    let detail = "";
    try { detail = JSON.stringify(await response.json()); } catch { /* unreadable error */ }
    // Match Bridge's best-effort controls: retry once only for rejected options.
    const rejectedReasoning = body.reasoning_effort !== undefined && /reasoning|effort/i.test(detail) &&
      /unsupported|not supported|supported values|mandatory.*cannot be disabled/i.test(detail);
    const rejectedTemperature = body.temperature !== undefined && /temperature/i.test(detail) &&
      /unsupported|not support|only the default|deprecated/i.test(detail);
    if (rejectedReasoning || rejectedTemperature) {
      if (rejectedReasoning) delete body.reasoning_effort;
      if (rejectedTemperature) delete body.temperature;
      response = await post();
    }
  }
  if (!response.ok) throw httpError(response);
  const data = await response.json();
  const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
  const message = choice?.message;
  if (data?.error || !message || message.role !== "assistant" || choice.finish_reason === "error" ||
    (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))) {
    throw inferenceError();
  }
  const content = typeof message.content === "string" ? message.content.trim()
    : Array.isArray(message.content) ? message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("").trim() : "";
  if (!content) throw inferenceError();
  return {
    content,
    model: typeof data.model === "string" && data.model.trim() ? data.model.trim() : model,
    sources: extractSources(message),
  };
}
