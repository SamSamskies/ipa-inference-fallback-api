import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler, { imageFetchDns } from "../api/inference.js";

// Client-supplied fixtures; application prompt builders stay in the frontends.
const SYSTEM_PROMPT_IMAGES_LINE =
  "The first user message includes the note's images before the text. Look at those images when they matter.";

const originalFetch = globalThis.fetch;
const originalLookupAll = imageFetchDns.lookupAll;
const envNames = [
  "DEFAULT_INFERENCE_PROVIDER",
  "INFERENCE_API_KEY",
  "GEMINI_API_KEY",
  "INFERENCE_FALLBACK_ENABLED",
  "GEMINI_FALLBACK_ENABLED",
  "INFERENCE_CLIENT_DAILY_LIMIT",
  "INFERENCE_MODEL",
  "GEMINI_MODEL",
  "GEMINI_CLIENT_DAILY_LIMIT",
];
let previousEnv;
beforeEach(() => {
  previousEnv = Object.fromEntries(
    envNames.map((key) => [key, process.env[key]]),
  );
  envNames.forEach((key) => delete process.env[key]);
  process.env.INFERENCE_API_KEY = "test-key-not-a-credential";
  process.env.DEFAULT_INFERENCE_PROVIDER = "gemini";
  process.env.INFERENCE_MODEL = "test-model";
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "50";
  globalThis.fetch = () => {
    throw new Error("Unexpected network call in test");
  };
  imageFetchDns.lookupAll = async () => [
    { address: "203.0.113.10", family: 4 },
  ];
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  imageFetchDns.lookupAll = originalLookupAll;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function mockPinnedHttpsImage(bytes, contentType = "image/png") {
  const calls = [];
  mock.method(https, "request", (options, onResponse) => {
    calls.push(options);
    const req = new EventEmitter();
    req.end = () =>
      queueMicrotask(() => {
        const incoming = new EventEmitter();
        incoming.statusCode = 200;
        incoming.headers = { "content-type": contentType };
        incoming.destroy = () => {};
        onResponse(incoming);
        incoming.emit("data", Buffer.from(bytes));
        incoming.emit("end");
      });
    return req;
  });
  return calls;
}
const messages = [
  { role: "system", content: "Explain the note" },
  { role: "user", content: "What is Nostr?" },
];
async function call({
  method = "POST",
  origin = "https://example.test",
  token = crypto.randomUUID(),
  body = { messages, webSearch: false },
  headers = {},
  url = "/api/inference",
} = {}) {
  const req = {
    method,
    url,
    headers: { host: "example.test", origin, "x-inference-client": token, ...headers },
    body,
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
  await handler(req, res);
  return res;
}
function success(content = "Nostr is an open protocol.") {
  return Response.json({
    candidates: [{ content: { parts: [{ text: content }] } }],
  });
}

test("missing hosted configuration reports unavailable without contacting a provider", async () => {
  delete process.env.INFERENCE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const response = await call({ method: "GET" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "missing_api_key");
});

test("hosted endpoint rejects other origins, missing client tokens, and malformed input", async () => {
  assert.equal(
    (await call({ origin: "https://unrelated.test" })).statusCode,
    403,
  );
  assert.equal((await call({ token: "" })).body.error, "missing_client_token");
  assert.equal((await call({ body: { messages: [] } })).statusCode, 400);
  assert.equal((await call({ body: "{" })).body.error, "invalid_json");
  assert.equal(
    (await call({ body: { messages, options: { temperature: 10 } } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call({
        body: { messages: [{ role: "user", content: "x".repeat(61000) }] },
      })
    ).statusCode,
    413,
  );
});

test("hosted request honors web search, separates the system prompt, and includes sources", async () => {
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://generativelanguage.googleapis.com/"));
    assert.ok(url.includes("test-model"));
    const body = JSON.parse(options.body);
    assert.equal(body.systemInstruction.parts[0].text, "Explain the note");
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.deepEqual(body.contents, [
      { role: "user", parts: [{ text: "What is Nostr?" }] },
    ]);
    return Response.json({
      candidates: [
        {
          content: { parts: [{ text: "Nostr is an open protocol." }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: "Nostr", uri: "https://nostr.com" } },
            ],
          },
        },
      ],
    });
  };
  const response = await call({ body: { messages, webSearch: true } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body.content, /\[Nostr\]\(https:\/\/nostr.com\)/);
  assert.equal(response.body.model, "test-model");
  assert.equal(response.headers["Cache-Control"], "no-store");
});

test("hosted image redirects discard the previous body before the next hop", async () => {
  const destroyed = [];
  const imageCalls = [];
  mock.method(https, "request", (options, onResponse) => {
    const index = imageCalls.length;
    imageCalls.push(options);
    const req = new EventEmitter();
    req.end = () =>
      queueMicrotask(() => {
        const incoming = new EventEmitter();
        incoming.destroy = () => {
          destroyed[index] = true;
        };
        if (index === 0) {
          incoming.statusCode = 302;
          incoming.headers = {
            location: "https://cdn.example.test/photo.png",
          };
          onResponse(incoming);
          return;
        }
        incoming.statusCode = 200;
        incoming.headers = { "content-type": "image/png" };
        onResponse(incoming);
        incoming.emit("data", Buffer.from([1, 2, 3]));
        incoming.emit("end");
      });
    return req;
  });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.contents[0].parts[0], {
      inlineData: { mimeType: "image/png", data: "AQID" },
    });
    return success("An image.");
  };
  const response = await call({
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", url: "https://images.example.test/old.png" },
            { type: "text", text: "Describe this" },
          ],
        },
      ],
      webSearch: false,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(imageCalls.length, 2);
  assert.equal(destroyed[0], true);
  assert.equal(imageCalls[0].headers.Host, "images.example.test");
  assert.equal(imageCalls[1].headers.Host, "cdn.example.test");
});

test("hosted image input becomes inline bytes and web search can be disabled", async () => {
  const imageCalls = mockPinnedHttpsImage(new Uint8Array([1, 2, 3]));
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.contents[0].parts[0], {
      inlineData: { mimeType: "image/png", data: "AQID" },
    });
    return success("An image.");
  };
  const response = await call({
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", url: "https://images.example.test/photo.png" },
            { type: "text", text: "Describe this" },
          ],
        },
      ],
      webSearch: false,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(imageCalls[0].hostname, "203.0.113.10");
  assert.equal(imageCalls[0].headers.Host, "images.example.test");
  assert.equal(imageCalls[0].servername, "images.example.test");
  assert.equal(imageCalls[0].headers["User-Agent"], "ipa-inference-fallback-api/1.0");
});

test("hosted image fetch does not request hostnames that resolve to private addresses", async () => {
  imageFetchDns.lookupAll = async () => [
    { address: "127.0.0.1", family: 4 },
  ];
  const imageRequests = mock.method(https, "request", () => {
    throw new Error("must not fetch a private image");
  });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    const body = JSON.parse(options.body);
    assert.equal(
      body.systemInstruction.parts[0].text,
      "Explain a public Nostr note.",
    );
    assert.deepEqual(body.contents[0].parts, [
      { text: "Describe this\n\nhttps://127.0.0.1.nip.io/photo.png" },
    ]);
    return success("An image.");
  };
  const response = await call({
    body: {
      messages: [
        {
          role: "system",
          content: `Explain a public Nostr note.\n${SYSTEM_PROMPT_IMAGES_LINE}`,
        },
        {
          role: "user",
          content: [
            { type: "image", url: "https://127.0.0.1.nip.io/photo.png" },
            { type: "text", text: "Describe this" },
          ],
        },
      ],
      webSearch: false,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(imageRequests.mock.callCount(), 0);
  assert.match(calls[0], /^https:\/\/generativelanguage\.googleapis\.com\//);
});

test("successful requests consume the browser allowance", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return success();
  };
  const token = crypto.randomUUID();
  assert.equal((await call({ token })).statusCode, 200);
  assert.equal((await call({ token })).body.error, "client_limit");
  assert.equal(calls, 1);
});

test("provider errors release the allowance so the user can retry", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  const token = crypto.randomUUID();
  globalThis.fetch = async () => {
    throw new Error("Network unavailable");
  };
  assert.equal((await call({ token })).statusCode, 502);
  globalThis.fetch = async () => success();
  assert.equal((await call({ token })).statusCode, 200);
});

test("hosted lightweight reasoning maps to Gemma's minimal setting", async () => {
  process.env.INFERENCE_MODEL = "gemma-4-31b-it";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.generationConfig.thinkingConfig, {
      thinkingLevel: "minimal",
    });
    assert.ok(options.signal instanceof AbortSignal);
    return success();
  };
  const response = await call({
    body: { messages, webSearch: false, options: { reasoningEffort: "none" } },
  });
  assert.equal(response.statusCode, 200);
});

test("provider timeout returns a retryable error and releases the allowance", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  const originalTimeout = AbortSignal.timeout;
  const token = crypto.randomUUID();
  try {
    AbortSignal.timeout = () =>
      AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
    globalThis.fetch = async (_url, options) => {
      options.signal.throwIfAborted();
      return success();
    };
    const response = await call({ token });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error, "provider_busy");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  globalThis.fetch = async () => success();
  assert.equal((await call({ token })).statusCode, 200);
});

test("Gemini preserves response language instructions and explicit follow-up requests", async () => {
  const languagePrompt = "Respond in the browser language (es-MX), unless the user requests another language.";
  const conversation = [
    { role: "system", content: languagePrompt },
    { role: "user", content: "A trending Nostr note:\nNote: Hello Nostr!" },
    { role: "assistant", content: "Es un saludo a la comunidad." },
    { role: "user", content: "Reply in French: what is a relay?" },
  ];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.systemInstruction.parts[0].text, languagePrompt);
    assert.equal(body.contents.at(-1).parts[0].text, "Reply in French: what is a relay?");
    return success("Un relais transmet les événements.");
  };
  const response = await call({ body: { messages: conversation, webSearch: false } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.content, "Un relais transmet les événements.");
});

test("probe, preflight and method handling preserve the HTTP contract", async () => {
  const probe = await call({ method: "GET" });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probe.body, { ok: true });
  const preflight = await call({ method: "OPTIONS" });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Origin"], "https://example.test");
  assert.equal(preflight.headers["Access-Control-Allow-Headers"], "Content-Type, X-Inference-Client");
  assert.equal((await call({ method: "OPTIONS", origin: "https://other.test" })).statusCode, 403);
  assert.equal((await call({ method: "OPTIONS", origin: undefined, headers: { origin: undefined } })).statusCode, 204);
  assert.equal((await call({ method: "PUT" })).body.error, "method_not_allowed");
  assert.equal((await call({ headers: { origin: undefined } })).body.error, "forbidden_origin");
});

test("invalid JSON values, conversations and options fail before calling a provider", async () => {
  for (const body of ["null", "true", "42", '"text"', "[]", {},
    { messages: "hello" }, { messages: [null] },
    { messages: [{ role: "system", content: "only system" }] },
    { messages: [{ role: "assistant", content: "starts with assistant" }] },
    { messages: [...messages, { role: "assistant", content: "ends with assistant" }] },
    ...[[], "bad", { reasoningEffort: "extreme" }, { reasoningEffort: 1 },
      { temperature: -1 }, { temperature: "0.5" }, { temperature: NaN },
      { temperature: Infinity }].map((options) => ({ messages, options })),
  ]) {
    const response = await call({ body });
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.body.error, "invalid_request");
  }
  assert.equal((await call({ headers: { "content-length": "100001" } })).statusCode, 413);
  assert.equal((await call({ body: " ".repeat(100001) })).statusCode, 413);
});

test("Gemini reasoning maps across model families and auto omits thinking config", async () => {
  for (const [model, effort, expected] of [
    ["gemini-2.5-flash", "none", { thinkingBudget: 0 }],
    ["gemini-2.5-flash", "low", { thinkingBudget: 1024 }],
    ["gemini-2.5-flash", "medium", { thinkingBudget: 8192 }],
    ["gemini-2.5-flash", "high", { thinkingBudget: -1 }],
    ["gemma-4-31b-it", "low", { thinkingLevel: "high" }],
    ["gemini-3-flash-preview", "none", { thinkingLevel: "minimal" }],
    ["gemini-3-flash-preview", "medium", { thinkingLevel: "medium" }],
    ["gemini-3-flash-preview", "auto", undefined],
    ["gemini-3-flash-preview", undefined, undefined],
  ]) {
    process.env.GEMINI_MODEL = model;
    globalThis.fetch = async (_url, init) => {
      const config = JSON.parse(init.body).generationConfig;
      assert.deepEqual(config.thinkingConfig, expected);
      assert.equal(config.temperature, 0);
      return success();
    };
    assert.equal((await call({ body: { messages, webSearch: false,
      options: { reasoningEffort: effort, temperature: 0 } } })).statusCode, 200);
  }
});

test("Gemini retries capacity once with the same payload and deadline", async () => {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    return calls.length === 1
      ? Response.json({ error: { status: "INTERNAL", message: "Internal error encountered" } }, { status: 500 })
      : success();
  };
  assert.equal((await call()).statusCode, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].signal, calls[1].signal);
});

test("persistent Gemini capacity failures stop after one retry and release daily quota", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  let calls = 0;
  const token = crypto.randomUUID();
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
  };
  const response = await call({ token });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "provider_busy");
  assert.equal(calls, 2);
  globalThis.fetch = async () => success();
  assert.equal((await call({ token })).statusCode, 200);
});

test("Gemini quota classification distinguishes search, daily and minute limits", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  const token = crypto.randomUUID();
  for (const [webSearch, detail, expected] of [
    [true, { quotaId: "RequestsPerDay" }, "search_quota"],
    [false, { quotaId: "RequestsPerDay" }, "quota_exhausted"],
    [false, { message: "exceeded your current quota; check billing details" }, "quota_exhausted"],
    [false, { quotaId: "RequestsPerMinute", message: "check billing details" }, "rate_limited"],
    [false, {}, "rate_limited"],
    [false, null, "rate_limited"],
  ]) {
    globalThis.fetch = async () => detail === null
      ? new Response("not json", { status: 429 })
      : Response.json({ error: { details: [detail] } }, { status: 429 });
    const response = await call({ token, body: { messages, webSearch } });
    assert.equal(response.statusCode, 429);
    assert.equal(response.body.error, expected);
  }
  globalThis.fetch = async () => success();
  assert.equal((await call({ token })).statusCode, 200);
});

test("malformed Gemini replies and provider failures release the daily allowance", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  const token = crypto.randomUUID();
  for (const response of [new Response("not json"), Response.json(null),
    Response.json({ candidates: [] }),
    Response.json({ candidates: [{ content: { parts: [null, { thought: true, text: "hidden" }] } }] }),
    Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 }),
    new Response("opaque failure", { status: 502 }),
  ]) {
    globalThis.fetch = async () => response;
    const result = await call({ token });
    assert.equal(result.body.error, response.status >= 500 ? "provider_busy" : "provider_error");
    assert.equal(result.statusCode, response.status >= 500 ? 503 : response.status === 400 ? 400 : 502);
  }
  globalThis.fetch = async () => success();
  assert.equal((await call({ token })).statusCode, 200);
});

test("Gemini inline images survive and thought text never enters the answer", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: "image/jpeg", data: "AQID" } });
    assert.equal(body.systemInstruction.parts[0].text, SYSTEM_PROMPT_IMAGES_LINE);
    return Response.json({ candidates: [{ content: { parts: [
      { text: "private reasoning", thought: true }, null, { text: "Visible answer" },
    ] } }] });
  };
  const response = await call({ body: { webSearch: false, messages: [
    { role: "system", content: SYSTEM_PROMPT_IMAGES_LINE },
    { role: "user", content: [{ type: "image", mediaType: "image/jpg", data: "AQID" }] },
  ] } });
  assert.equal(response.body.content, "Visible answer");
});

test("unsafe image URLs and mixed DNS answers fall back to text without image requests", async () => {
  const requests = mock.method(https, "request", () => { throw new Error("unsafe image request"); });
  imageFetchDns.lookupAll = async () => [
    { address: "203.0.113.10", family: 4 }, { address: "10.0.0.1", family: 4 },
  ];
  for (const url of ["https://localhost/a.png", "http://169.254.169.254/a.png",
    "https://[::1]/a.png", "https://[::ffff:7f00:1]/a.png",
    "https://user:pass@example.test/a.png", "file:///etc/passwd", "https://mixed.test/a.png",
  ]) {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.contents[0].parts, [{ text: `Describe this\n\n${url}` }]);
      return success();
    };
    assert.equal((await call({ body: { webSearch: false, messages: [{ role: "user", content: [
      { type: "image", url }, { type: "text", text: "Describe this" },
    ] }] } })).statusCode, 200);
  }
  assert.equal(requests.mock.callCount(), 0);
});

test("image redirects cannot pivot to private networks and discard the response body", async () => {
  let destroyed = false;
  const request = mock.method(https, "request", (_options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const incoming = new EventEmitter();
      incoming.statusCode = 302;
      incoming.headers = { location: "http://169.254.169.254/latest/meta-data" };
      incoming.destroy = () => { destroyed = true; };
      onResponse(incoming);
    });
    return req;
  });
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).contents[0].parts,
      [{ text: "https://images.example.test/photo.png" }]);
    return success();
  };
  const response = await call({ body: { webSearch: false, messages: [{ role: "user",
    content: [{ type: "image", url: "https://images.example.test/photo.png" }] }] } });
  assert.equal(response.statusCode, 200);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(destroyed, true);
});

test("empty and oversized fetched images fall back to text", async () => {
  for (const length of [0, 4_000_001]) {
    mockPinnedHttpsImage(new Uint8Array(length));
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).contents[0].parts,
        [{ text: "https://images.example.test/photo.png" }]);
      return success();
    };
    assert.equal((await call({ body: { webSearch: false, messages: [{ role: "user",
      content: [{ type: "image", url: "https://images.example.test/photo.png" }] }] } })).statusCode, 200);
    mock.restoreAll();
  }
});
