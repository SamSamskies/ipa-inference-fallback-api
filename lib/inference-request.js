import { inferenceError } from "./inference-response.js";

export const MAX_BODY_BYTES = 100_000;
const MAX_PROMPT_CHARS = 60_000;
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const REASONING_EFFORTS = new Set(["auto", "none", "low", "medium", "high"]);

/**
 * @typedef {{text: string} | {image: {url?: string, mediaType: string, data?: string}}} Part
 * @typedef {{role: "user" | "assistant", parts: Part[]}} Message
 * @typedef {{reasoningEffort?: "auto" | "none" | "low" | "medium" | "high", temperature?: number}} Options
 * @typedef {{system: string, messages: Message[], options: Options, webSearch: boolean}} NormalizedRequest
 */

export function guessImageMime(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    if (/\.(jpg|jpeg|jfif)$/.test(path)) return "image/jpeg";
  } catch { /* Default for URLs without a recognizable image extension. */ }
  return "image/jpeg";
}

export function normalizeImageMime(raw) {
  if (typeof raw !== "string") return undefined;
  const mime = raw.trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return IMAGE_MEDIA_TYPES.has(mime) ? mime : undefined;
}

function normalizeParts(content) {
  if (typeof content === "string") return content.trim() ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (part == null || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text.trim()) parts.push({ text: part.text });
      continue;
    }
    if (part.type !== "image") continue;
    if (typeof part.url === "string" && part.url.trim()) {
      parts.push({ image: {
        url: part.url.trim(),
        mediaType: normalizeImageMime(part.mediaType) || guessImageMime(part.url),
      } });
      continue;
    }
    const mediaType = normalizeImageMime(part.mediaType);
    const data = typeof part.data === "string" ? part.data.trim() : "";
    if (mediaType && data) parts.push({ image: { mediaType, data } });
  }
  return parts;
}

function normalizeMessages(messages) {
  let system = "";
  const turns = [];
  for (const msg of messages) {
    if (msg == null || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.trim()) system = system ? `${system}\n\n${content}` : content;
      continue;
    }
    const parts = normalizeParts(msg.content);
    if (!parts.length) continue;
    // Preserve the existing handling of unknown non-system roles as user turns.
    const role = msg.role === "assistant" ? "assistant" : "user";
    const prev = turns.at(-1);
    if (prev?.role === role) {
      if (prev.parts.length === 1 && typeof prev.parts[0].text === "string" &&
          parts.length === 1 && typeof parts[0].text === "string") {
        prev.parts[0].text += `\n\n${parts[0].text}`;
      } else {
        prev.parts.push(...parts);
      }
    } else {
      turns.push({ role, parts });
    }
  }
  if (turns[0]?.role !== "user" || turns.at(-1)?.role !== "user") return null;
  return { system: system.trim(), messages: turns };
}

function parseWebSearch(value) {
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  if (typeof value === "string") {
    const flag = value.trim().toLowerCase();
    if (["0", "false", "off"].includes(flag)) return false;
    if (["1", "true", "on"].includes(flag)) return true;
  }
  return null;
}

function parseInferenceOptions(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const options = {};
  if ("reasoningEffort" in raw && raw.reasoningEffort !== undefined) {
    if (typeof raw.reasoningEffort !== "string" || !REASONING_EFFORTS.has(raw.reasoningEffort)) return null;
    options.reasoningEffort = raw.reasoningEffort;
  }
  if ("temperature" in raw && raw.temperature !== undefined) {
    if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature) ||
        raw.temperature < 0 || raw.temperature > 2) return null;
    options.temperature = raw.temperature;
  }
  return options;
}

/** Validate the public IPA payload once, independently of the selected provider. */
export function normalizeRequest(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) throw inferenceError(400, "invalid_request");
  const prompt = normalizeMessages(body.messages);
  if (!prompt) throw inferenceError(400, "invalid_request");
  let chars = prompt.system.length;
  for (const message of prompt.messages) {
    for (const part of message.parts) chars += (part.text ?? part.image?.url ?? part.image?.data ?? "").length;
  }
  if (chars > MAX_PROMPT_CHARS) throw inferenceError(413, "payload_too_large");
  const options = parseInferenceOptions(body.options);
  const webSearch = parseWebSearch(body.webSearch);
  if (options === null || webSearch === null) throw inferenceError(400, "invalid_request");
  return { ...prompt, options, webSearch };
}

/** Disable unsupported optional controls using server-owned model capabilities. */
export function applyCapabilities(request, capabilities) {
  return {
    ...request,
    webSearch: capabilities.webSearch && request.webSearch,
    options: capabilities.reasoning ? request.options : { temperature: request.options.temperature },
    messages: capabilities.vision ? request.messages : request.messages.map((message) => ({
      ...message,
      // URLs survive as text during image preparation; inline bytes have no text fallback.
      parts: message.parts.filter((part) => !part.image?.data),
    })),
  };
}
