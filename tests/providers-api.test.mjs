import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler, { createProvidersHandler } from "../api/providers.js";
import { apps } from "../lib/apps.js";
import { providers } from "../lib/providers/registry.js";
import { clientQuota } from "../lib/client-quota.js";
import { TEST_APP_SECRET } from "./helpers/app-request.mjs";

const envNames = ["TRENDINGNOSTR_APP_SECRET", "ADVANCEDNOSTRSEARCH_APP_SECRET", "INFERENCE_FALLBACK_ENABLED", "REPLIT_MAX_TOKENS"];
let previous;
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  envNames.forEach((name) => delete process.env[name]);
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
  process.env.ADVANCEDNOSTRSEARCH_APP_SECRET = "private-other-app-secret";
  mock.method(globalThis, "fetch", () => { throw new Error("Discovery must not contact upstream"); });
  mock.method(clientQuota, "tryConsume", () => { throw new Error("Discovery must not reserve quota"); });
});
afterEach(() => {
  mock.restoreAll();
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

async function call({ target = handler, method = "GET", headers = {}, rawHeaders } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; }, end() {},
  };
  await target({ method, url: "/api/providers", rawHeaders, headers: {
    host: "example.test", "x-inference-app": "trendingnostr", authorization: `Bearer ${TEST_APP_SECRET}`, ...headers,
  } }, res);
  return res;
}

test("discovery needs only app authentication and returns explicit public metadata without upstream work", async () => {
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body.providers.map((provider) => provider.id), ["ollama", "gemini", "replit"]);
  for (const provider of res.body.providers) {
    assert.deepEqual(Object.keys(provider), ["id", "capabilities", "models"]);
    assert.deepEqual(provider.capabilities, { vision: true, webSearch: true, reasoning: true });
    for (const model of provider.models) {
      assert.deepEqual(Object.keys(model), ["id", "capabilities"]);
      assert.deepEqual(model.capabilities, provider.capabilities);
    }
  }
  assert.doesNotMatch(JSON.stringify(res.body), /private-|APP_SECRET|authSecretEnv|https:|generate|defaultProvider/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("discovery filters per-app allowlists and disabled entries from an immutable snapshot", async () => {
  const registry = structuredClone(apps);
  delete registry.trendingnostr.providers.gemini;
  registry.trendingnostr.providers.ollama.enabled = false;
  registry.advancednostrsearch.providers = { gemini: { enabled: true } };
  const target = createProvidersHandler(registry);
  registry.trendingnostr.providers.replit.enabled = false;
  assert.deepEqual((await call({ target })).body.providers.map((p) => p.id), ["replit"]);
  assert.deepEqual((await call({ target, headers: {
    "x-inference-app": "advancednostrsearch", authorization: "Bearer private-other-app-secret",
  } })).body.providers.map((p) => p.id), ["gemini"]);
  assert.equal((await call({ target, headers: { "x-inference-app": "advancednostrsearch" } })).statusCode, 401);
});

test("discovery serializes effective model overrides without leaking extra adapter fields", async () => {
  providers.replit.models["text-only"] = { vision: false, privateKey: "private-model-key" };
  try {
    const provider = (await call()).body.providers.find((p) => p.id === "replit");
    assert.deepEqual(provider.models.find((m) => m.id === "text-only"), {
      id: "text-only", capabilities: { vision: false, webSearch: true, reasoning: true },
    });
    assert.doesNotMatch(JSON.stringify(provider), /private/);
  } finally {
    delete providers.replit.models["text-only"];
  }
});

test("discovery rejects missing, forged, disabled, unconfigured and ambiguous app credentials", async () => {
  for (const headers of [{ authorization: undefined }, { "x-inference-app": undefined },
    { "x-inference-app": "unknown" }, { "x-inference-app": "__proto__" },
    { authorization: "Bearer private-other-app-secret" }, { authorization: ["Bearer secret"] }]) {
    const res = await call({ headers });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "unauthorized_app" });
  }
  for (const name of ["Authorization", "X-Inference-App"]) {
    assert.equal((await call({ rawHeaders: [name, "first", name, "second"] })).statusCode, 401);
  }
  const registry = structuredClone(apps);
  registry.trendingnostr.enabled = false;
  assert.equal((await call({ target: createProvidersHandler(registry) })).statusCode, 401);
  delete process.env.TRENDINGNOSTR_APP_SECRET;
  assert.equal((await call()).statusCode, 401);
});

test("discovery honors global disable, invalid Replit policy, and empty provider lists", async () => {
  for (const invalid of ["0", "bad", "1.5"]) {
    process.env.REPLIT_MAX_TOKENS = invalid;
    assert.deepEqual((await call()).body.providers.map((p) => p.id), ["ollama", "gemini"]);
  }
  process.env.REPLIT_MAX_TOKENS = "8192";
  assert.equal((await call()).body.providers.length, 3);
  const registry = structuredClone(apps);
  registry.trendingnostr.providers = {};
  assert.deepEqual((await call({ target: createProvidersHandler(registry) })).body, { providers: [] });
  for (const disabled of ["false", "0", "OFF"]) {
    process.env.INFERENCE_FALLBACK_ENABLED = disabled;
    const res = await call();
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "disabled" });
    assert.equal((await call({ headers: { authorization: undefined } })).statusCode, 401);
  }
});

test("discovery preserves restrictive CORS and credential-free preflight", async () => {
  const local = await call({ headers: { origin: "http://localhost:3000" } });
  assert.equal(local.statusCode, 200);
  assert.equal(local.headers["Access-Control-Allow-Origin"], "http://localhost:3000");
  assert.equal(local.headers.Vary, "Origin");
  assert.equal((await call({ headers: { origin: "https://foreign.test" } })).statusCode, 403);
  const preflight = await call({ method: "OPTIONS", headers: { authorization: undefined, origin: "https://example.test" } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Headers"], "Content-Type, X-Inference-Client");
  assert.equal((await call({ method: "OPTIONS", headers: { origin: "https://foreign.test" } })).statusCode, 403);
  assert.equal((await call({ method: "POST" })).statusCode, 405);
});
