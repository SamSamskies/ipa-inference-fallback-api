import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler from "../api/inference.js";
import { providers } from "../lib/providers/registry.js";
import { clientQuota } from "../lib/client-quota.js";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";

const envNames = ["TRENDINGNOSTR_APP_SECRET", "INFERENCE_FALLBACK_ENABLED", "REPLIT_MAX_TOKENS"];
let previous;
let time = Date.now();
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  envNames.forEach((name) => delete process.env[name]);
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
  time += 120_000;
  mock.method(Date, "now", () => time);
  mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream call"); });
});
afterEach(() => {
  mock.restoreAll();
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

async function call(provider = "replit", body = {}, token = crypto.randomUUID()) {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; },
  };
  await handler({ method: "POST", url: `/api/inference?provider=${provider}`,
    headers: { ...appHeaders(), "x-inference-client": token },
    body: { model: "contract-model", messages: [{ role: "user", content: "Hello" }], webSearch: false, ...body },
  }, res);
  return res;
}

function success(provider) {
  if (provider === "gemini") return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  const message = { role: "assistant", content: "OK" };
  return Response.json(provider === "ollama" ? { message } : { choices: [{ message }] });
}

test("malformed or contradictory capability requirements fail before quota and network work", async () => {
  const quota = mock.method(clientQuota, "tryConsume", () => { throw new Error("Must validate first"); });
  for (const requiredCapabilities of [null, true, "vision", {}, ["unknown"], ["constructor"], [null],
    ["vision", "vision"], ["vision", "webSearch", "reasoning", "vision"]]) {
    const res = await call("replit", { requiredCapabilities });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "invalid_request" });
  }
  for (const body of [{ requiredCapabilities: ["webSearch"], webSearch: false },
    { requiredCapabilities: ["reasoning"], options: { reasoningEffort: "none" } }]) {
    assert.deepEqual((await call("replit", body)).body, { error: "invalid_request" });
  }
  assert.equal(quota.mock.callCount(), 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

for (const [id, adapter] of Object.entries(providers)) {
  test(`${id}: unsupported requirements and image inputs fail before quota, downloads or generation`, async () => {
    const quota = mock.method(clientQuota, "tryConsume", () => { throw new Error("Must validate first"); });
    adapter.models["contract-model"] = { vision: false, webSearch: false, reasoning: false };
    try {
      for (const capability of ["vision", "webSearch", "reasoning"]) {
        const res = await call(id, { requiredCapabilities: [capability], webSearch: true });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { error: "unsupported_capability", capability });
      }
      for (const image of [{ type: "image", url: "https://127.0.0.1/private.png" },
        { type: "image", mediaType: "image/png", data: "AQID" }]) {
        const res = await call(id, { capabilities: { vision: true },
          messages: [{ role: "user", content: [image, { type: "text", text: "Describe" }] }],
        });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { error: "unsupported_capability", capability: "vision" });
      }
      assert.equal(quota.mock.callCount(), 0);
      assert.equal(globalThis.fetch.mock.callCount(), 0);
    } finally {
      delete adapter.models["contract-model"];
    }
  });

  test(`${id}: required vision rejects partial image loss, releases quota, and preserves optional URL fallback`, async () => {
    const release = mock.method(clientQuota, "release");
    const body = { requiredCapabilities: ["vision"], messages: [{ role: "user", content: [
      { type: "image", mediaType: "image/png", data: "AQID" },
      { type: "image", url: "https://127.0.0.1/private.png" },
      { type: "text", text: "Describe" },
    ] }] };
    const token = crypto.randomUUID();
    const res = await call(id, body, token);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "image_unavailable" });
    assert.equal(globalThis.fetch.mock.callCount(), 0);
    assert.equal(release.mock.callCount(), 1);
    mock.method(globalThis, "fetch", async (_url, init) => {
      assert.ok(init.body.includes("AQID"));
      assert.ok(init.body.includes("https://127.0.0.1/private.png"));
      return success(id);
    });
    const fallback = await call(id, { ...body, requiredCapabilities: [] }, token);
    assert.equal(fallback.statusCode, 200);
    assert.deepEqual(fallback.body, { content: "OK", model: "contract-model", provider: id });
  });

  test(`${id}: supported requirements reach the provider without dropping images or controls`, async () => {
    mock.method(globalThis, "fetch", async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(init.body.includes("AQID"));
      assert.equal(body.tools.length, 1);
      if (id === "ollama") assert.equal(body.think, true);
      if (id === "replit") assert.equal(body.reasoning_effort, "high");
      if (id === "gemini") assert.ok(body.generationConfig.thinkingConfig);
      return success(id);
    });
    const res = await call(id, { model: id === "gemini" ? "gemini-2.5-flash" : "contract-model",
      requiredCapabilities: ["vision", "webSearch", "reasoning"], webSearch: true,
      options: { reasoningEffort: "high" }, messages: [{ role: "user", content: [
        { type: "image", mediaType: "image/png", data: "AQID" }, { type: "text", text: "Describe" },
      ] }],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.provider, id);
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });
}

test("Replit does not drop required reasoning on rejected options, even if temperature is also rejected", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "reasoning_effort and temperature unsupported" } }, { status: 422 }));
  const release = mock.method(clientQuota, "release");
  const res = await call("replit", { requiredCapabilities: ["reasoning"], options: { reasoningEffort: "high", temperature: 0 } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "unsupported_capability", capability: "reasoning" });
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.equal(release.mock.callCount(), 1);
});

test("Replit can retry an optional temperature while retaining required reasoning", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.reasoning_effort, "high");
    if (++calls === 1) return Response.json({ error: { message: "temperature unsupported" } }, { status: 400 });
    assert.equal(body.temperature, undefined);
    return success("replit");
  });
  assert.equal((await call("replit", { requiredCapabilities: ["reasoning"], options: { reasoningEffort: "high", temperature: 0 } })).statusCode, 200);
  assert.equal(calls, 2);
});
