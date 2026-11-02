import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import handler from "../api/inference.js";
import { apps, getApp } from "../lib/apps.js";
import { providers } from "../lib/providers/registry.js";
import { loadLocalEnvFallback } from "../lib/env.js";
import { INFERENCE_APP_HEADER, INFERENCE_PROVIDER_KEY_HEADER } from "../lib/http.js";
import { requestProviderKey } from "../lib/app-auth.js";
import { smokeTimeoutMs } from "../lib/timeouts.js";
import { normalizeModel } from "../lib/inference-request.js";

const HELP = `Usage: npm run smoke -- --app ${Object.keys(apps).join("|")} --provider ${Object.keys(providers).join("|")} --model MODEL [--url ENDPOINT]

By default, start a temporary local server.
--app selects the app secret from its registered *_APP_SECRET environment setting.
Set INFERENCE_SMOKE_PROVIDER_KEY in the caller environment or local .env.local.
App and provider credentials are sent only in headers; never as CLI arguments.
--provider is required and is sent in the query parameter.
--model is required and is sent in the inference request body.
Use --url to test an HTTPS endpoint (HTTP is allowed only for loopback development).
Runs a configuration probe and a short generation with web search disabled.
`;

const PUBLIC_ERRORS = new Set([
  "unauthorized_app", "invalid_app_config", "invalid_provider_config", "provider_not_allowed", "provider_disabled",
  "missing_api_key", "invalid_api_key", "disabled", "invalid_provider", "invalid_model",
  "invalid_json", "invalid_request", "missing_client_token", "forbidden_origin",
  "payload_too_large", "client_limit", "client_capacity", "rate_limited", "quota_exhausted",
  "search_quota", "provider_error", "model_unavailable", "provider_auth", "provider_busy",
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
      await handler(req, res);
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

async function request(url, init) {
  const response = await fetch(url, { ...init, redirect: "error" });
  let body;
  try {
    body = await response.json();
  } catch {
    throw publicError(`${init.method} returned HTTP ${response.status} without a JSON response.`);
  }
  if (!response.ok) {
    // Only print known endpoint error codes, never raw provider errors or keys.
    const code = PUBLIC_ERRORS.has(body?.error)
      ? body.error : "unexpected_error";
    const retryAfter = response.headers.get("retry-after");
    const retry = retryAfter && /^\d+$/.test(retryAfter) ? ` Retry after ${retryAfter}s.` : "";
    throw publicError(`${init.method} returned HTTP ${response.status}: ${code}.${retry}`);
  }
  return body;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      provider: { type: "string" }, model: { type: "string" },
      app: { type: "string" },
      url: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch {
    throw publicError("Invalid arguments. Use npm run smoke -- --help for usage.");
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
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
    console.log("Configuration probe passed.");

    const result = await request(url, {
      method: "POST", signal,
      headers: {
        ...credentialHeaders,
        "Content-Type": "application/json",
        "X-Inference-Client": randomUUID(),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: smoke test OK" }],
        webSearch: false,
        options: { reasoningEffort: "none", temperature: 0 },
      }),
    });
    if (typeof result?.content !== "string" || !result.content.trim() ||
      typeof result.model !== "string" || !result.model.trim()) {
      throw publicError("POST returned an invalid inference response; expected nonempty content and model.");
    }
    console.log(`Smoke test passed (${Date.now() - started}ms).`);
    const redact = (value) => value.replaceAll(appSecret, "[redacted]").replaceAll(providerKey, "[redacted]");
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
