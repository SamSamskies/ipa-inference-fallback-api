import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import handler, { imageFetchDns } from "../api/inference.js";
import { appRateLimit, createAppRateLimit } from "../lib/app-rate-limit.js";
import { clientQuota } from "../lib/client-quota.js";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";

const deployed = {
  VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production",
  VERCEL_URL: "test-deployment.vercel.app",
};
afterEach(() => mock.restoreAll());

test("local runs and vercel dev skip the external gate", async () => {
  for (const env of [{}, { NODE_ENV: "production" }, { ...deployed, VERCEL_ENV: "development", NODE_ENV: "development" }]) {
    await createAppRateLimit({ env, check() { assert.fail("Unexpected WAF call"); } })("trendingnostr");
  }
});

test("app admission sends only the trusted host and a stable app key to the SDK", async () => {
  const calls = [];
  const admit = createAppRateLimit({ env: deployed, check: async (...args) => {
    calls.push(args);
    return { rateLimited: false };
  } });
  await admit("trendingnostr");
  await admit("trendingnostr");
  await admit("advancednostrsearch");
  assert.deepEqual(calls[0], ["inference-app", {
    headers: { host: deployed.VERCEL_URL },
    rateLimitKey: JSON.stringify(["ipa-inference", "app", "trendingnostr"]), timeout: 1000,
  }]);
  assert.deepEqual(calls[1], calls[0]);
  assert.notEqual(calls[2][1].rateLimitKey, calls[0][1].rateLimitKey);
});

test("deployed functions reject configurations that would skip or misdirect the SDK check", async () => {
  for (const overrides of [
    { NODE_ENV: "development" }, { NODE_ENV: undefined }, { VERCEL_URL: undefined },
    { VERCEL_URL: "attacker.test" }, { VERCEL_URL: "https://project.vercel.app" },
    { VERCEL_URL: "project.vercel.app@attacker.test" }, { VERCEL_URL: "project.vercel.app/path" },
    { INFERENCE_RATE_LIMIT_WINDOW_SECONDS: "0" }, { INFERENCE_RATE_LIMIT_WINDOW_SECONDS: "9" },
    { INFERENCE_RATE_LIMIT_WINDOW_SECONDS: "601" }, { INFERENCE_RATE_LIMIT_WINDOW_SECONDS: "1e2" },
    { INFERENCE_RATE_LIMIT_WINDOW_SECONDS: "60.5" }, { INFERENCE_RATE_LIMIT_WINDOW_SECONDS: "Infinity" },
  ]) {
    const admit = createAppRateLimit({ env: { ...deployed, ...overrides }, check() { assert.fail("Unexpected WAF call"); } });
    await assert.rejects(admit("trendingnostr"), { status: 503, message: "rate_limit_unavailable", retryAfter: 5 });
  }
});

test("enforced limits and firewall blocks return a conservative full-window retry", async () => {
  for (const result of [{ rateLimited: true }, { rateLimited: true, error: "blocked" }]) {
    for (const [window, seconds] of [[undefined, 60], ["", 60], ["10", 10], [" 600 ", 600]]) {
      const admit = createAppRateLimit({ env: { ...deployed, INFERENCE_RATE_LIMIT_WINDOW_SECONDS: window }, check: async () => result });
      await assert.rejects(admit("trendingnostr"), { status: 429, message: "rate_limited", retryAfter: seconds });
    }
  }
});

test("missing rules, malformed replies, transport failures, and timeouts fail closed", async () => {
  for (const result of [undefined, null, {}, { rateLimited: "false" },
    { rateLimited: false, error: "not-found" }, { rateLimited: false, error: "blocked" },
    { rateLimited: true, error: "private-upstream-secret" }]) {
    await assert.rejects(createAppRateLimit({ env: deployed, check: async () => result })("trendingnostr"),
      { status: 503, message: "rate_limit_unavailable", retryAfter: 5 });
  }
  for (const error of [new Error("private-provider-key"), new DOMException("private-timeout-detail", "TimeoutError")]) {
    await assert.rejects(createAppRateLimit({ env: deployed, check: async () => { throw error; } })("trendingnostr"),
      { status: 503, message: "rate_limit_unavailable", retryAfter: 5 });
  }
});

test("real SDK uses the trusted deployment URL, strips request secrets, and honors its timeout", async () => {
  const saved = Object.fromEntries(["NODE_ENV", "VERCEL_AUTOMATION_BYPASS_SECRET", "RATE_LIMIT_SECRET"].map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "production";
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  delete process.env.RATE_LIMIT_SECRET;
  try {
    const calls = [];
    mock.method(globalThis, "fetch", async (url, init) => {
      calls.push({ url, headers: Object.fromEntries(init.headers), redirect: init.redirect });
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(null, { status: 204 });
    });
    await createAppRateLimit({ env: deployed })("trendingnostr");
    assert.equal(calls[0].url, `https://${deployed.VERCEL_URL}/.well-known/vercel/rate-limit-api/inference-app`);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].headers["x-rr-host"], deployed.VERCEL_URL);
    assert.ok(Object.keys(calls[0].headers).filter((key) => key.startsWith("x-rr-")).every((key) => key === "x-rr-host"));

    mock.method(globalThis, "fetch", (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    // Keep the event loop alive: AbortSignal.timeout's timer is unref'ed.
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await assert.rejects(createAppRateLimit({ env: deployed })("trendingnostr"),
        { status: 503, message: "rate_limit_unavailable" });
    } finally { clearTimeout(keepAlive); }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

function setup(check) {
  const saved = Object.fromEntries(["TRENDINGNOSTR_APP_SECRET", "ADVANCEDNOSTRSEARCH_APP_SECRET", "INFERENCE_FALLBACK_ENABLED", "REPLIT_MAX_TOKENS", "INFERENCE_CLIENT_DAILY_LIMIT"].map((key) => [key, process.env[key]]));
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
  process.env.ADVANCEDNOSTRSEARCH_APP_SECRET = TEST_APP_SECRET;
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "50";
  delete process.env.REPLIT_MAX_TOKENS;
  mock.method(appRateLimit, "admit", createAppRateLimit({ env: deployed, check }));
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

async function call({ app = "trendingnostr", provider = "gemini", token = crypto.randomUUID(), body, headers = {}, run = handler } = {}) {
  const req = { method: "POST", url: `/api/inference?provider=${provider}`,
    headers: { ...appHeaders("private-provider-key", app), host: "attacker.test", "x-inference-client": token, ...headers },
    body: body ?? { model: "test-model", messages: [{ role: "user", content: "private-prompt" }], webSearch: false },
  };
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end() {} };
  await run(req, res);
  return res;
}
const success = () => Response.json({ candidates: [{ content: { parts: [{ text: "Answer" }] } }] });

test("admission rejection precedes local reservation, images, and all providers", async () => {
  const restore = setup(async () => ({ rateLimited: true }));
  mock.method(clientQuota, "tryConsume", () => { assert.fail("Must not reserve daily allowance"); });
  mock.method(imageFetchDns, "lookupAll", () => { assert.fail("Must not fetch images"); });
  mock.method(globalThis, "fetch", () => { assert.fail("Must not contact providers"); });
  try {
    for (const provider of ["gemini", "ollama", "replit"]) {
      const res = await call({ provider, body: { model: "test-model", webSearch: false,
        messages: [{ role: "user", content: [{ type: "text", text: "private-prompt" }, { type: "image", url: "https://images.example.test/image.png" }] }] } });
      assert.equal(res.statusCode, 429);
      assert.deepEqual(res.body, { error: "rate_limited" });
      assert.equal(res.headers["Retry-After"], "60");
    }
  } finally { restore(); }
});

test("missing-rule errors are sanitized at the HTTP boundary without local/provider work", async () => {
  const restore = setup(async () => ({ rateLimited: false, error: "not-found" }));
  mock.method(clientQuota, "tryConsume", () => { assert.fail("Must not reserve"); });
  mock.method(globalThis, "fetch", () => { assert.fail("Must not generate"); });
  try {
    const res = await call();
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: "rate_limit_unavailable" });
    assert.equal(res.headers["Retry-After"], "5");
    assert.doesNotMatch(JSON.stringify(res), /private-|APP_SECRET|provider-key|attacker/);
  } finally { restore(); }
});

test("independent handlers share external app admission despite concurrent rotated client IDs", async () => {
  const buckets = new Map();
  const calls = [];
  const restore = setup(async (_id, options) => {
    calls.push(options);
    const used = buckets.get(options.rateLimitKey) || 0;
    if (used >= 3) return { rateLimited: true };
    buckets.set(options.rateLimitKey, used + 1);
    return { rateLimited: false };
  });
  mock.method(globalThis, "fetch", async () => success());
  try {
    const { default: secondHandler } = await import("../api/inference.js?second-instance");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call({ run: i % 2 ? handler : secondHandler })));
    assert.equal(results.filter((res) => res.statusCode === 200).length, 3);
    assert.equal(results.filter((res) => res.statusCode === 429).length, 9);
    assert.equal((await call({ provider: "replit" })).statusCode, 429);
    assert.equal((await call({ app: "advancednostrsearch" })).statusCode, 200);
    assert.doesNotMatch(JSON.stringify(calls), /private-|attacker|x-inference|authorization|prompt|client/);
  } finally { restore(); }
});

test("provider failure releases local daily success allowance but never refunds app admission", async () => {
  let admissions = 0;
  const restore = setup(async () => ({ rateLimited: admissions++ >= 2 }));
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  const token = crypto.randomUUID();
  const fetch = mock.method(globalThis, "fetch", async () => { throw new Error("private-provider-error"); });
  try {
    assert.equal((await call({ token })).statusCode, 502);
    fetch.mock.mockImplementation(async () => success());
    assert.equal((await call({ token })).statusCode, 200);
    assert.equal((await call({ token: crypto.randomUUID() })).statusCode, 429);
    assert.equal(fetch.mock.callCount(), 2);
  } finally { restore(); }
});

test("auth, validation, byte-size limits, missing tokens, and kill switch precede admission", async () => {
  const restore = setup(async () => { assert.fail("Invalid requests must not reach WAF"); });
  try {
    assert.equal((await call({ headers: { authorization: "Bearer wrong-secret" } })).statusCode, 401);
    assert.equal((await call({ token: "" })).body.error, "missing_client_token");
    assert.equal((await call({ body: { messages: [] } })).statusCode, 400);
    assert.equal((await call({ body: { model: "model", messages: [{ role: "user", content: "界".repeat(40000) }] } })).statusCode, 413);
    process.env.INFERENCE_FALLBACK_ENABLED = "false";
    assert.equal((await call()).body.error, "disabled");
  } finally { restore(); }
});
