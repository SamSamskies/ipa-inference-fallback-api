import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler from "../api/inference.js";
import { clientQuota } from "../lib/client-quota.js";

const providerIds = ["ollama", "gemini", "replit"];
const envNames = ["INFERENCE_FALLBACK_ENABLED", "DEFAULT_INFERENCE_PROVIDER",
  ...providerIds.flatMap((id) => [`${id.toUpperCase()}_API_KEY`, `${id.toUpperCase()}_MODEL`])];
const originalFetch = globalThis.fetch;
let previous;
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  delete process.env.DEFAULT_INFERENCE_PROVIDER;
  for (const id of providerIds) {
    process.env[`${id.toUpperCase()}_API_KEY`] = `private-${id}-key`;
    process.env[`${id.toUpperCase()}_MODEL`] = "ignored-environment-model";
  }
  globalThis.fetch = () => { throw new Error("Unexpected upstream request"); };
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
  };
  await handler({
    method, url: `/api/inference?provider=${provider}${query}`,
    headers: { host: "example.test", origin: "https://example.test", "x-inference-client": crypto.randomUUID() },
    body,
  }, res);
  return res;
}

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
        assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/backend%2Fmodel%3Atag:generateContent?key=private-gemini-key");
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
    assert.deepEqual(res.body, { content: "OK", model: "backend/model:tag" });
    assert.equal(calls, 1);
  });

  test(`${provider}: configuration probes remain independent of model selection`, async () => {
    const res = await call(provider, { method: "GET" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true });
  });
}
