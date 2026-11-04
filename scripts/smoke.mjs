import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import handler from "../api/inference.js";
import providersHandler from "../api/providers.js";
import { apps, getApp } from "../lib/apps.js";
import { providers } from "../lib/providers/registry.js";
import { loadLocalEnvFallback } from "../lib/env.js";
import { INFERENCE_APP_HEADER, INFERENCE_PROVIDER_KEY_HEADER } from "../lib/http.js";
import { requestProviderKey } from "../lib/app-auth.js";
import { smokeTimeoutMs } from "../lib/timeouts.js";
import { normalizeModel } from "../lib/inference-request.js";

const HELP = `Usage: npm run smoke -- --app ${Object.keys(apps).join("|")} --provider ${Object.keys(providers).join("|")} --model MODEL [--url ENDPOINT] [--checks] [--vision | --web-search]

By default, start a temporary local server.
--app selects the app secret from its registered *_APP_SECRET environment setting.
Set INFERENCE_SMOKE_PROVIDER_KEY in the caller environment or local .env.local.
App and provider credentials are sent only in headers; never as CLI arguments.
--provider is required and is sent in the query parameter.
--model is required and is sent in the inference request body.
Use --url to test an HTTPS endpoint (HTTP is allowed only for loopback development).
Runs a configuration probe and a short generation with web search disabled.
--checks also verifies discovery, auth failures, validation, and credential non-disclosure.
--vision sends an inline red square and checks the reported color.
--web-search requires search support and checks for a source URL in the answer.
Run vision and search separately to verify each feature independently.
For protected deployments, set VERCEL_AUTOMATION_BYPASS_SECRET in the caller environment.
`;

// Deterministic 64x64 RGB red PNG; no external image host or image-fetch dependency.
const RED_SQUARE = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

const PUBLIC_ERRORS = new Set([
  "unauthorized_app", "invalid_app_config", "invalid_provider_config", "provider_not_allowed", "provider_disabled",
  "missing_api_key", "invalid_api_key", "disabled", "invalid_provider", "invalid_model",
  "invalid_json", "invalid_request", "missing_client_token", "forbidden_origin",
  "payload_too_large", "client_limit", "client_capacity", "rate_limited", "quota_exhausted",
  "search_quota", "provider_error", "model_unavailable", "provider_auth", "provider_busy", "rate_limit_unavailable",
  "unsupported_capability", "image_unavailable",
]);
function publicError(message) {
  return Object.assign(new Error(message), { safeToPrint: true });
}

async function startLocalServer() {
  const server = createServer(async (req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => res.end(JSON.stringify(value));
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      req.body = Buffer.concat(chunks).toString("utf8");
      const route = new URL(req.url, "http://localhost").pathname;
      await (route === "/api/providers" ? providersHandler : handler)(req, res);
    } catch {
      res.status(500).json({ error: "local_server_error" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function request(url, init, expected = {}) {
  const response = await fetch(url, { ...init, redirect: "error" });
  let body;
  try {
    body = await response.json();
  } catch {
    throw publicError(`${init.method} returned HTTP ${response.status} without a JSON response.`);
  }
  if (response.status !== (expected.status ?? 200) || (expected.error && body?.error !== expected.error)) {
    // Only print known endpoint error codes, never raw provider errors or keys.
    const code = PUBLIC_ERRORS.has(body?.error)
      ? body.error : "unexpected_error";
    const retryAfter = response.headers.get("retry-after");
    const retry = retryAfter && /^\d+$/.test(retryAfter) ? ` Retry after ${retryAfter}s.` : "";
    throw publicError(`${init.method} returned HTTP ${response.status}: ${code}.${retry}`);
  }
  return body;
}

async function checkDeployment(url, headers, signal, model, assertPrivate) {
  const discoveryUrl = new URL("providers", url);
  discoveryUrl.search = "";
  const authHeaders = { ...headers };
  delete authHeaders[INFERENCE_PROVIDER_KEY_HEADER];
  const discovery = await request(discoveryUrl, { method: "GET", headers: authHeaders, signal });
  assertPrivate(discovery);
  const provider = url.searchParams.get("provider");
  if (!discovery?.providers?.some((entry) => entry.id === provider)) {
    throw publicError("Discovery did not include the selected provider.");
  }
  const post = { method: "POST", signal, headers: {
    ...headers, "Content-Type": "application/json", "X-Inference-Client": randomUUID(),
  }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Check validation." }], webSearch: false }) };
  const selector = new URL(url);
  selector.searchParams.delete("provider");
  const duplicate = new URL(url);
  duplicate.searchParams.append("provider", provider);
  const missingKey = { ...headers };
  delete missingKey[INFERENCE_PROVIDER_KEY_HEADER];
  const unauthenticatedHeaders = headers["x-vercel-protection-bypass"]
    ? { "x-vercel-protection-bypass": headers["x-vercel-protection-bypass"] } : {};
  // All these fail before admission, image downloads, or upstream generation.
  for (const [target, init, expected] of [
    [url, { method: "GET", headers: unauthenticatedHeaders, signal }, { status: 401, error: "unauthorized_app" }],
    [url, { ...post, headers: { ...post.headers, Authorization: "Bearer deliberately-invalid-smoke-secret" } }, { status: 401, error: "unauthorized_app" }],
    [discoveryUrl, { method: "GET", headers: unauthenticatedHeaders, signal }, { status: 401, error: "unauthorized_app" }],
    [selector, { method: "GET", headers, signal }, { status: 400, error: "invalid_provider" }],
    [duplicate, { method: "GET", headers, signal }, { status: 400, error: "invalid_provider" }],
    [url, { method: "GET", headers: missingKey, signal }, { status: 400, error: "missing_api_key" }],
    [url, { ...post, body: "{" }, { status: 400, error: "invalid_json" }],
    [url, { ...post, body: JSON.stringify({ messages: [{ role: "user", content: "Check validation." }] }) }, { status: 400, error: "invalid_model" }],
  ]) assertPrivate(await request(target, init, expected));
  console.log("Discovery, authentication, provider selector, and validation checks passed.");
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      provider: { type: "string" }, model: { type: "string" },
      app: { type: "string" },
      checks: { type: "boolean" }, vision: { type: "boolean" }, "web-search": { type: "boolean" },
      url: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch {
    throw publicError("Invalid arguments. Use npm run smoke -- --help for usage.");
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.vision && values["web-search"]) throw publicError("Run --vision and --web-search separately.");
  const provider = values.provider?.trim().toLowerCase();
  if (!Object.hasOwn(providers, provider)) {
    throw publicError(`--provider is required: choose ${Object.keys(providers).join(", ")}.`);
  }

  const appId = values.app;
  const app = getApp(appId);
  if (!app?.enabled) throw publicError(`--app is required: choose ${Object.keys(apps).join(", ")}.`);
  loadLocalEnvFallback(["INFERENCE_SMOKE_PROVIDER_KEY"], { exact: true });
  const appSecret = process.env[app.authSecretEnv]?.trim();
  if (!appSecret || appSecret.length > 4000 || !/^[\x21-\x7e]+$/.test(appSecret) || appSecret.includes(",")) {
    throw publicError(`Set a valid ${app.authSecretEnv} in the caller environment.`);
  }
  let providerKey;
  try {
    providerKey = requestProviderKey({ headers: {
      [INFERENCE_PROVIDER_KEY_HEADER.toLowerCase()]: process.env.INFERENCE_SMOKE_PROVIDER_KEY,
    } });
  } catch {
    throw publicError("Set a valid INFERENCE_SMOKE_PROVIDER_KEY in the caller environment.");
  }
  const credentialHeaders = {
    [INFERENCE_APP_HEADER]: appId,
    Authorization: `Bearer ${appSecret}`,
    [INFERENCE_PROVIDER_KEY_HEADER]: providerKey,
  };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) credentialHeaders["x-vercel-protection-bypass"] = bypass;
  const assertPrivate = (body) => {
    const serialized = JSON.stringify(body);
    if ([appSecret, providerKey, bypass].filter(Boolean).some((secret) => serialized.includes(secret))) {
      throw publicError("Response exposed a credential; details suppressed.");
    }
  };
  let model;
  try {
    model = normalizeModel(values.model);
  } catch {
    throw publicError("--model is required: use a model ID of 1–200 characters without whitespace or control characters.");
  }

  let server;
  try {
    let url;
    if (values.url !== undefined) {
      try {
        url = new URL(values.url);
      } catch {
        throw publicError("--url must be an absolute HTTP(S) endpoint URL.");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw publicError("--url must be an HTTP(S) endpoint URL without embedded credentials.");
      }
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        throw publicError("--url must use HTTPS outside loopback development.");
      }
    } else {
      server = await startLocalServer();
      url = new URL(`http://127.0.0.1:${server.address().port}/api/inference`);
    }
    url.searchParams.set("provider", provider);

    const signal = AbortSignal.timeout(smokeTimeoutMs());
    const started = Date.now();
    const probe = await request(url, { method: "GET", signal, headers: credentialHeaders });
    if (probe?.ok !== true) throw publicError("GET returned an invalid configuration probe.");
    if (values.checks) {
      assertPrivate(probe);
      await checkDeployment(url, credentialHeaders, signal, model, assertPrivate);
    }
    console.log("Configuration probe passed.");

    const webSearch = values["web-search"] === true;
    const content = values.vision ? [
      { type: "image", mediaType: "image/png", data: RED_SQUARE },
      { type: "text", text: "What is the dominant color in this image? Reply in English with only the color name." },
    ] : webSearch ? "Use web search to find the official Vercel CLI documentation. Reply in one sentence and cite its HTTPS URL."
      : "Reply with exactly: smoke test OK";

    const result = await request(url, {
      method: "POST", signal,
      headers: {
        ...credentialHeaders,
        "Content-Type": "application/json",
        "X-Inference-Client": randomUUID(),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        webSearch,
        ...(values.vision ? { requiredCapabilities: ["vision"] } : webSearch ? { requiredCapabilities: ["webSearch"] } : {}),
        options: { reasoningEffort: "none", temperature: 0 },
      }),
    });
    if (typeof result?.content !== "string" || !result.content.trim() ||
      typeof result.model !== "string" || !result.model.trim() || result.provider !== provider) {
      throw publicError("POST returned an invalid inference response; expected nonempty content/model and the selected provider.");
    }
    if (values.checks) assertPrivate(result);
    if (values.vision && !/\bred\b/i.test(result.content)) throw publicError("Vision response did not identify the red square.");
    if (webSearch && !/https:\/\/[^\s)]+/i.test(result.content)) throw publicError("Search response did not include an HTTPS source URL.");
    console.log(`Smoke test passed (${Date.now() - started}ms).`);
    const redact = (value) => [appSecret, providerKey, bypass].filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
    console.log(`Model: ${redact(result.model)}`);
    console.log(`Response: ${redact(result.content.trim())}`);
  } finally {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  }
}

main().catch((error) => {
  const message = error?.name === "TimeoutError" ? `Request timed out after ${smokeTimeoutMs() / 1000} seconds.`
    : error?.message === "fetch failed" ? "Could not reach the endpoint. Check --url and whether its server is running."
      : error?.safeToPrint ? error.message : "Request failed. Check endpoint connectivity and credentials.";
  console.error(`Smoke test failed: ${message}`);
  process.exitCode = 1;
});
