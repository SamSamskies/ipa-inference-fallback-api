import assert from "node:assert/strict";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler from "../api/inference.js";
import { clientQuota } from "../lib/client-quota.js";

const providerIds = ["ollama", "gemini", "replit"];
const envNames = ["REPLIT_MAX_TOKENS", "TRENDINGNOSTR_APP_SECRET", "INFERENCE_FALLBACK_ENABLED", "DEFAULT_INFERENCE_PROVIDER",
  ...providerIds.flatMap((id) => [`${id.toUpperCase()}_API_KEY`, `${id.toUpperCase()}_MODEL`])];
const originalFetch = globalThis.fetch;
let previous;
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  delete process.env.REPLIT_MAX_TOKENS;
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  delete process.env.DEFAULT_INFERENCE_PROVIDER;
  for (const id of providerIds) {
    process.env[`${id.toUpperCase()}_API_KEY`] = `private-${id}-key`;
    process.env[`${id.toUpperCase()}_MODEL`] = "ignored-environment-model";
  }
  globalThis.fetch = () => { throw new Error("Unexpected upstream request"); };
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

const messages = [{ role: "user", content: "Hello" }];
async function call(provider, { method = "POST", body = { messages, webSearch: false }, query = "" } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; },
    end() { return this; },
  };
  await handler({
    method, url: provider === undefined ? "/api/inference" : `/api/inference?provider=${provider}${query}`,
    headers: { ...appHeaders(`private-${provider}-key`), host: "example.test", origin: "https://example.test", "x-inference-client": crypto.randomUUID() },
    body,
  }, res);
  return res;
}

test("GET and POST require an explicit provider despite legacy defaults or a body provider", async () => {
  const quota = mock.method(clientQuota, "tryConsume", () => { throw new Error("Must select provider first"); });
  for (const legacyDefault of [undefined, "", "replit", "ollama", "gemini", "invalid"]) {
    if (legacyDefault === undefined) delete process.env.DEFAULT_INFERENCE_PROVIDER;
    else process.env.DEFAULT_INFERENCE_PROVIDER = legacyDefault;
    for (const method of ["GET", "POST"]) {
      const res = await call(undefined, { method,
        body: { provider: "replit", model: "backend/model", messages, webSearch: false },
      });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: "invalid_provider" });
    }
  }
  assert.equal(quota.mock.callCount(), 0);
});

test("CORS preflight needs no provider or model", async () => {
  const res = await call(undefined, { method: "OPTIONS", body: undefined });
  assert.equal(res.statusCode, 204);
});

test("unsupported HTTP methods remain method_not_allowed without a provider", async () => {
  const res = await call(undefined, { method: "PUT" });
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: "method_not_allowed" });
});

for (const provider of providerIds) {
  test(`${provider}: model is required in the body before quota or upstream work`, async () => {
    const quota = mock.method(clientQuota, "tryConsume", () => { throw new Error("Must validate model first"); });
    for (const model of [undefined, null, false, 42, [], {}, "", "  ", "two models", "model\nname", "x\u0000y", "x".repeat(201)]) {
      const body = { messages, webSearch: false, ...(model === undefined ? {} : { model }) };
      const res = await call(provider, { body, query: "&model=query-model" });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { error: "invalid_model" });
    }
    assert.equal(quota.mock.callCount(), 0);
  });

  test(`${provider}: JSON request model is trimmed and forwarded without an environment override`, async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (provider === "gemini") {
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/backend%2Fmodel%3Atag:generateContent");
        assert.equal(init.headers["x-goog-api-key"], "private-gemini-key");
        return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
      }
      assert.equal(JSON.parse(init.body).model, "backend/model:tag");
      assert.equal(init.headers.Authorization, `Bearer private-${provider}-key`);
      return provider === "ollama" ? Response.json({ message: { role: "assistant", content: "OK" } })
        : Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    };
    const res = await call(provider, {
      query: "&model=ignored-query-model",
      body: JSON.stringify({ model: " backend/model:tag ", messages, webSearch: false }),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { content: "OK", model: "backend/model:tag", provider });
    assert.equal(calls, 1);
  });

  test(`${provider}: configuration probes remain independent of model selection`, async () => {
    const res = await call(provider, { method: "GET" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });
}
