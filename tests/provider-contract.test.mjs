import assert from "node:assert/strict";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler from "../api/inference.js";
import { applyCapabilities, normalizeRequest } from "../lib/inference-request.js";
import { prepareRequestImages } from "../lib/inference-images.js";
import { sendInferenceError } from "../lib/inference-response.js";
import { capabilitiesForModel, getProvider, providers } from "../lib/providers/registry.js";

const originalFetch = globalThis.fetch;
const envNames = ["TRENDINGNOSTR_APP_SECRET", "REPLIT_MAX_TOKENS", "INFERENCE_FALLBACK_ENABLED",
  "OLLAMA_API_KEY", "GEMINI_API_KEY", "REPLIT_API_KEY"];
let previous;
let time = Date.now();
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  for (const name of envNames) process.env[name] = "wrong-global-value";
  time += 120_000; // Expire the process-local Ollama limiter between contracts.
  mock.method(Date, "now", () => time);
  globalThis.fetch = () => { throw new Error("Unexpected network call"); };
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

const fixtures = {
  ollama: {
    success: (content = "Answer") => Response.json({ message: { role: "assistant", content } }),
    assertRequest(url, init, model, key) {
      assert.equal(url, "https://ollama.com/api/chat");
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.equal(JSON.parse(init.body).model, model);
    },
  },
  gemini: {
    success: (content = "Answer") => Response.json({ candidates: [{ content: { parts: [{ text: content }] } }] }),
    assertRequest(url, init, model, key) {
      assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.headers["x-goog-api-key"], key);
    },
  },
  replit: {
    success: (content = "Answer") => Response.json({ choices: [{ message: { role: "assistant", content } }] }),
    assertRequest(url, init, model, key) {
      assert.equal(url, "https://samsamskies-inference.replit.app/api/v1/chat/completions");
      assert.equal(init.headers.Authorization, `Bearer ${key}`);
      assert.equal(JSON.parse(init.body).model, model);
    },
  },
};

function request() {
  return normalizeRequest({
    messages: [
      { role: "system", content: "Answer in French." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Bonjour" },
      { role: "user", content: [
        { type: "image", mediaType: "image/png", data: "AQID" },
        { type: "text", text: "Describe this" },
      ] },
    ],
    webSearch: false,
    options: { reasoningEffort: "none", temperature: 0 },
  });
}

function response() {
  return {
    headers: {}, statusCode: 200, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("registry is a fixed allowlist with provider and exact-model capability metadata", () => {
  assert.deepEqual(Object.keys(providers).sort(), ["gemini", "ollama", "replit"]);
  for (const id of ["missing", "toString", "constructor", "__proto__", "https://custom.test"]) {
    assert.equal(getProvider(id), undefined);
  }
  for (const adapter of Object.values(providers)) {
    assert.equal(typeof adapter.generate, "function");
    assert.deepEqual(capabilitiesForModel(adapter, Object.keys(adapter.models)[0]),
      { vision: true, webSearch: true, reasoning: true });
    assert.deepEqual(capabilitiesForModel(adapter, "constructor"), adapter.capabilities);
    const customized = { ...adapter, models: { "text-only": { vision: false, reasoning: false } } };
    assert.deepEqual(capabilitiesForModel(customized, "text-only"),
      { vision: false, webSearch: true, reasoning: false });
    assert.deepEqual(capabilitiesForModel(customized, "unknown-model"), adapter.capabilities);
  }
});

for (const [id, adapter] of Object.entries(providers)) {
  const fixture = fixtures[id];
  test(`${id} adapter accepts the common request, explicit credentials/model, and deadline without mutation`, async () => {
    const normalized = request();
    const before = structuredClone(normalized);
    const signal = AbortSignal.timeout(1000);
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      fixture.assertRequest(url, init, "app/model", "app-key");
      assert.equal(init.signal, signal);
      const body = JSON.parse(init.body);
      if (id === "gemini") {
        assert.deepEqual(body.contents.map((message) => message.role), ["user", "model", "user"]);
        assert.equal(body.systemInstruction.parts[0].text, "Answer in French.");
        assert.deepEqual(body.contents.at(-1).parts[0], { inlineData: { mimeType: "image/png", data: "AQID" } });
      } else {
        assert.deepEqual(body.messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
        assert.equal(body.messages[0].content, "Answer in French.");
        if (id === "ollama") assert.deepEqual(body.messages.at(-1).images, ["AQID"]);
        else {
          assert.equal(body.messages.at(-1).content[0].image_url.url, "data:image/png;base64,AQID");
          assert.equal(body.max_tokens, 4096);
        }
      }
      return fixture.success("  Answer  ");
    };
    assert.deepEqual(await adapter.generate(normalized,
      { model: "app/model", apiKey: "app-key", signal, maxTokens: 4096 }),
    { content: "Answer", model: "app/model", sources: [] });
    assert.equal(calls, 1);
    assert.deepEqual(normalized, before);
  });

  test(`${id} concurrent app configurations stay isolated from each other and process env`, async () => {
    const normalized = request();
    const signal = AbortSignal.timeout(1000);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const which = id === "gemini" ? init.headers["x-goog-api-key"] : init.headers.Authorization.slice(7);
      const index = which === "key-a" ? "a" : "b";
      fixture.assertRequest(url, init, `model-${index}`, `key-${index}`);
      const body = JSON.parse(init.body);
      if (id === "replit") assert.equal(body.max_tokens, index === "a" ? 1024 : undefined);
      seen.push(index);
      await Promise.resolve();
      return fixture.success(`Answer ${index}`);
    };
    const results = await Promise.all(["a", "b"].map((index) => adapter.generate(normalized, {
      model: `model-${index}`, apiKey: `key-${index}`, signal,
      ...(index === "a" ? { maxTokens: 1024 } : {}),
    })));
    assert.deepEqual(seen.sort(), ["a", "b"]);
    assert.deepEqual(results.map(({ content, model }) => ({ content, model })), [
      { content: "Answer a", model: "model-a" }, { content: "Answer b", model: "model-b" },
    ]);
  });

  test(`${id} malformed replies and transport failures share the sanitized error boundary`, async () => {
    for (const reply of [fixture.success(""), Response.json(null), new Response("private upstream detail")]) {
      globalThis.fetch = async () => reply;
      await assert.rejects(() => adapter.generate(request(), {
        model: "app-model", apiKey: "app-key", signal: AbortSignal.timeout(1000),
      }), (error) => {
        const res = response();
        sendInferenceError(res, error);
        assert.equal(res.statusCode, 502);
        assert.deepEqual(res.body, { error: "provider_error" });
        return true;
      });
    }
    globalThis.fetch = async () => { throw new Error("private transport detail with key"); };
    await assert.rejects(() => adapter.generate(request(), {
      model: "app-model", apiKey: "app-key", signal: AbortSignal.timeout(1000),
    }), (error) => {
      const res = response();
      sendInferenceError(res, error);
      assert.deepEqual(res.body, { error: "provider_error" });
      return true;
    });
  });

  test(`${id} aborted deadlines stop before contacting the provider`, async () => {
    const signal = AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return fixture.success(); };
    await assert.rejects(() => adapter.generate(request(), { model: "app-model", apiKey: "app-key", signal }),
      (error) => {
        const res = response();
        sendInferenceError(res, error, signal);
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: "provider_busy" });
        return true;
      });
    assert.equal(calls, 0);
  });

  test(`${id} endpoint applies server model capability restrictions before image fetching and generation`, async () => {
    const model = "restricted-model";
    adapter.models[model] = { vision: false, webSearch: false, reasoning: false };
    delete process.env.INFERENCE_FALLBACK_ENABLED;
    const hint = "The first user message includes the note's images before the text. Look at those images when they matter.";
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      fixture.assertRequest(url, init, model, "app-key");
      const body = JSON.parse(init.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.think, undefined);
      assert.equal(body.reasoning_effort, undefined);
      assert.equal(body.generationConfig?.thinkingConfig, undefined);
      assert.ok(!init.body.includes("AQID"));
      assert.ok(!init.body.includes(hint));
      assert.ok(init.body.includes("https://127.0.0.1/photo.png"));
      assert.ok(init.body.includes("Answer in French."));
      return fixture.success();
    };
    try {
      const res = response();
      await handler({
        method: "POST", url: `/api/inference?provider=${id}`,
        headers: { ...appHeaders("app-key"), host: "example.test", origin: "https://example.test", "x-inference-client": crypto.randomUUID() },
        body: {
          model, apiKey: "client-key", capabilities: { vision: true, webSearch: true, reasoning: true },
          webSearch: true, options: { reasoningEffort: "high", temperature: 0 },
          messages: [{ role: "system", content: `Answer in French.\n${hint}` },
            { role: "user", content: [
              { type: "image", mediaType: "image/png", data: "AQID" },
              { type: "image", url: "https://127.0.0.1/photo.png" },
              { type: "text", text: "Describe this" },
            ] }],
        },
      }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { content: "Answer", model });
      assert.equal(calls, 1);
    } finally {
      delete adapter.models[model];
    }
  });
}

test("capability filtering and image preparation leave the normalized request reusable", async () => {
  const normalized = request();
  const before = structuredClone(normalized);
  const capabilities = { vision: false, webSearch: false, reasoning: false };
  const prepared = await prepareRequestImages(applyCapabilities(normalized, capabilities),
    AbortSignal.timeout(1000), capabilities);
  assert.equal(prepared.messages.at(-1).parts.length, 1);
  assert.deepEqual(prepared.options, { temperature: 0 });
  assert.deepEqual(normalized, before);
});
