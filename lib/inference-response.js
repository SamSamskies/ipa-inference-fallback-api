/** Errors carry only public, sanitized details; upstream bodies stay in adapters. */
export function inferenceError(status = 502, code = "provider_error", { retryAfter, details } = {}) {
  return Object.assign(new Error(code), { status, retryAfter, details });
}

export function sendInferenceError(res, error, signal) {
  if (error?.retryAfter) res.setHeader("Retry-After", String(error.retryAfter));
  const aborted = signal?.aborted;
  res.status(aborted ? 503 : error?.status || 502).json({
    error: aborted ? "provider_busy" : error?.status ? error.message : "provider_error",
    ...(!aborted && error?.status ? error.details : {}),
  });
}

export function withSources(text, sources) {
  if (sources.length === 0) return text;
  if (sources.every((source) => text.includes(source.uri))) return text;
  const lines = sources.map((source) => `- [${source.title}](${source.uri})`);
  return `${text}\n\nSources:\n${lines.join("\n")}`;
}

/** Retry-After seconds / HTTP date, also accepting Gemini's protobuf delay. */
export function retryAfterSeconds(value, { protobuf = false } = {}) {
  if (value == null) return 60;
  const raw = String(value).trim();
  if (!raw) return 60;
  const protoDelay = /^(\d+(?:\.\d+)?)s$/i.exec(raw);
  if (protobuf && protoDelay) return Math.max(1, Math.ceil(Number(protoDelay[1])));
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : 60;
}
