import { inferenceError } from "../inference-response.js";
import { ollamaLimiter, rateLimitError } from "../ollama-limits.js";

const API_BASE = "https://ollama.com/api";
const MAX_SEARCHES = 2;
const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information. Cite useful result URLs in your answer.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

async function post(path, body, key, signal) {
  signal.throwIfAborted();
  ollamaLimiter.consumeRequest();
  const response = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    // Do not forward credentials to redirects from the hosted API.
    redirect: "error",
    signal,
  });
  if (response.status === 429) {
    const retryAfter = ollamaLimiter.cooldown(response.headers.get("retry-after"));
    throw rateLimitError(retryAfter, path === "web_search" ? "search_quota" : "rate_limited");
  }
  if (!response.ok) {
    if (path === "chat" && response.status === 404) {
      throw inferenceError(502, "model_unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw inferenceError(502, "provider_auth");
    }
    throw inferenceError(
      response.status >= 500 ? 503 : 502,
      response.status >= 500 ? "provider_busy" : "provider_error",
    );
  }
  return response.json();
}

/** Map prepared, provider-neutral messages to native Ollama chat. */
function toMessages(request) {
  const messages = request.messages.map((turn) => {
    const text = turn.parts.filter((part) => typeof part.text === "string").map((part) => part.text);
    const images = turn.parts.filter((part) => part.image?.data).map((part) => part.image.data);
    return { role: turn.role, content: text.join("\n\n"), ...(images.length ? { images } : {}) };
  });
  if (request.system) messages.unshift({ role: "system", content: request.system });
  return messages;
}

/** @type {import("./registry.js").Generate} */
export async function generate(request, { model, apiKey, signal }) {
  const { options, webSearch } = request;
  const messages = toMessages(request);
  const body = {
    // :cloud is the app/CLI alias; ollama.com uses the catalog's API tag.
    model: model === "gemma4:cloud" ? "gemma4:31b" : model,
    messages,
    stream: false,
    options: { num_predict: 2048, ...(options.temperature === undefined ? {} : { temperature: options.temperature }) },
  };
  if (options.reasoningEffort && options.reasoningEffort !== "auto") {
    body.think = options.reasoningEffort !== "none";
  }
  let searches = 0;
  const sources = new Map();
  // At most two searches and three chat calls, within one shared timeout.
  for (let round = 0; round <= MAX_SEARCHES; round++) {
    const data = await post("chat", {
      ...body,
      ...(webSearch && searches < MAX_SEARCHES ? { tools: [SEARCH_TOOL] } : {}),
    }, apiKey, signal);
    const message = data?.message;
    if (data?.error || !message || message.role !== "assistant") throw inferenceError();
    const calls = message.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) {
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (!text) throw inferenceError();
      return { content: text, model: body.model, sources: [...sources.values()] };
    }
    if (!webSearch || searches >= MAX_SEARCHES || calls.length > MAX_SEARCHES - searches) {
      throw inferenceError();
    }
    messages.push(message);
    for (const call of calls) {
      const query = call?.function?.arguments?.query;
      if (call?.function?.name !== "web_search" || typeof query !== "string" || !query.trim() || query.length > 1000) {
        throw inferenceError();
      }
      searches++;
      const result = await post("web_search", { query: query.trim(), max_results: 3 }, apiKey, signal);
      if (!Array.isArray(result?.results)) throw inferenceError();
      const results = result.results.slice(0, 3).flatMap((item) => {
        if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
        const title = typeof item.title === "string" ? item.title.slice(0, 300) : item.url;
        sources.set(item.url, { title, uri: item.url });
        return [{ title, url: item.url, content: typeof item.content === "string" ? item.content.slice(0, 4000) : "" }];
      });
      messages.push({ role: "tool", tool_name: "web_search", content: JSON.stringify({ results }) });
    }
  }
  throw inferenceError();
}
