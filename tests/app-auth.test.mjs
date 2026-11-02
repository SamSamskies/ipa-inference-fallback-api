import assert from "node:assert/strict";
import test, { beforeEach, afterEach, mock } from "node:test";
import handler from "../api/inference.js";
import { apps, appEnvNames } from "../lib/apps.js";
import { createAppAuthenticator, requestProviderKey } from "../lib/app-auth.js";
import { clientQuota } from "../lib/client-quota.js";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";

const secondSecret = "private-second-app-secret";
const ids = ["trendingnostr", "advancednostrsearch"];
const providerIds = ["ollama", "gemini", "replit"];
const envNames = ["REPLIT_MAX_TOKENS", ...appEnvNames(), "INFERENCE_FALLBACK_ENABLED", "INFERENCE_CLIENT_DAILY_LIMIT",
  ...providerIds.flatMap((id) => [`${id.toUpperCase()}_API_KEY`, ...ids.map((app) => `${app.toUpperCase()}_${id.toUpperCase()}_API_KEY`)])];
const originalFetch = globalThis.fetch;
let previous;
let time = Date.now();
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  envNames.forEach((name) => delete process.env[name]);
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
  process.env.ADVANCEDNOSTRSEARCH_APP_SECRET = secondSecret;
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  time += 120_000;
  mock.method(Date, "now", () => time);
  globalThis.fetch = () => { throw new Error("Unexpected network call"); };
});
afterEach(() => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

const messages = [{ role: "user", content: "Hello" }];
async function call({ method = "POST", provider = "replit", app = "trendingnostr", secret = TEST_APP_SECRET,
  key = "private-provider-key", headers = {}, rawHeaders, token = crypto.randomUUID(),
  body = { model: "backend-model", messages, webSearch: false }, url } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; }, end() {},
  };
  await handler({ method, url: url || `/api/inference?provider=${provider}`, rawHeaders,
    headers: { ...appHeaders(key, app, secret), host: "example.test", "x-inference-client": token, ...headers }, body,
  }, res);
  return res;
}

function success(provider, content = "OK") {
  if (provider === "gemini") return Response.json({ candidates: [{ content: { parts: [{ text: content }] } }] });
  const message = { role: "assistant", content };
  return Response.json(provider === "ollama" ? { message } : { choices: [{ message }] });
}

test("app authentication rejects forged identities, disabled/unconfigured apps and ambiguous headers", () => {
  const registry = structuredClone(apps);
  const env = { TRENDINGNOSTR_APP_SECRET: TEST_APP_SECRET, ADVANCEDNOSTRSEARCH_APP_SECRET: secondSecret };
  const authenticate = createAppAuthenticator(registry, env);
  assert.equal(authenticate({ headers: appHeaders("key") }), "trendingnostr");
  assert.equal(authenticate({ headers: appHeaders("key", ids[1], secondSecret) }), ids[1]);
  const invalid = [
    {}, { "x-inference-app": "unknown" }, { "x-inference-app": "constructor" },
    { "x-inference-app": "__proto__" }, { "x-inference-app": ids[1], authorization: `Bearer ${TEST_APP_SECRET}` },
    { "x-inference-app": ids[0], authorization: undefined },
    { "x-inference-app": ids[0], authorization: "Basic wrong" },
    { "x-inference-app": ids[0], authorization: `Bearer ${TEST_APP_SECRET},extra` },
    { "x-inference-app": [ids[0]], authorization: `Bearer ${TEST_APP_SECRET}` },
    { "x-inference-app": ids[0], authorization: [`Bearer ${TEST_APP_SECRET}`] },
    { "x-inference-app": ids[0], authorization: `Bearer ${"x".repeat(4096)}` },
  ];
  for (const headers of invalid) assert.throws(() => authenticate({ headers }), { status: 401, message: "unauthorized_app" });
  for (const name of ["Authorization", "X-Inference-App"]) {
    assert.throws(() => authenticate({ headers: appHeaders(), rawHeaders: [name, "first", name, "second"] }),
      { status: 401, message: "unauthorized_app" });
  }
  delete env.TRENDINGNOSTR_APP_SECRET;
  assert.throws(() => authenticate({ headers: appHeaders() }), { status: 401 });
  registry.trendingnostr.enabled = false;
  assert.throws(() => createAppAuthenticator(registry, { TRENDINGNOSTR_APP_SECRET: TEST_APP_SECRET })({ headers: appHeaders() }),
    { status: 401 });
});

test("GET and POST authenticate before provider selection, key validation or quota work", async () => {
  const quota = mock.method(clientQuota, "tryConsume", () => { throw new Error("Must authenticate first"); });
  for (const method of ["GET", "POST"]) {
    for (const headers of [{ authorization: undefined }, { "x-inference-app": undefined },
      { "x-inference-app": "unknown" }, { authorization: `Bearer ${secondSecret}` }]) {
      const response = await call({ method, url: "/api/inference", headers });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.body, { error: "unauthorized_app" });
    }
    const probe = await call({ method: "GET" });
    assert.equal(probe.statusCode, 200);
  }
  assert.equal(quota.mock.callCount(), 0);
});

test("provider keys must be supplied in one valid header, with no env/body/query fallback", async () => {
  for (const name of envNames.filter((name) => name.endsWith("_API_KEY"))) process.env[name] = "private-unused-env-key";
  for (const key of [undefined, "", "  ", ["first", "second"], "first,second", "key with spaces", "key\nvalue", "x".repeat(8193)]) {
    for (const method of ["GET", "POST"]) {
      const response = await call({ method, headers: { "x-inference-provider-key": key },
        url: "/api/inference?provider=replit&apiKey=private-query-key",
        body: { model: "backend-model", messages, webSearch: false, apiKey: "private-body-key" },
      });
      assert.equal(response.statusCode, 400);
      assert.ok(["missing_api_key", "invalid_api_key"].includes(response.body.error));
    }
  }
  const response = await call({ rawHeaders: ["X-Inference-Provider-Key", "first", "x-inference-provider-key", "second"] });
  assert.equal(response.statusCode, 400);
  assert.equal(requestProviderKey({ headers: { "x-inference-provider-key": "fresh-key" } }), "fresh-key");
});

for (const provider of providerIds) {
  test(`${provider}: concurrent authenticated apps use only their request keys and models`, async () => {
    const before = envNames.map((name) => process.env[name]);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const key = provider === "gemini" ? init.headers["x-goog-api-key"] : init.headers.Authorization.slice(7);
      const app = ids.find((id) => key === `private-${id}-${provider}-key`);
      assert.ok(app);
      assert.equal(init.headers["X-Inference-Provider-Key"], undefined);
      assert.equal(init.headers["X-Inference-App"], undefined);
      assert.equal(init.redirect, "error");
      assert.ok(!url.includes(key));
      assert.ok(!JSON.stringify(init).includes(TEST_APP_SECRET));
      assert.ok(!JSON.stringify(init).includes(secondSecret));
      const model = `${app}/model`;
      if (provider === "gemini") assert.ok(decodeURIComponent(url).endsWith(`/models/${model}:generateContent`));
      else assert.equal(JSON.parse(init.body).model, model);
      seen.push(app);
      await new Promise((resolve) => setImmediate(resolve));
      return success(provider);
    };
    const responses = await Promise.all(ids.map((app, i) => call({ provider, app,
      secret: i ? secondSecret : TEST_APP_SECRET, key: `private-${app}-${provider}-key`,
      body: { model: `${app}/model`, messages, webSearch: false, apiKey: "ignored-key", baseUrl: "https://untrusted.test" },
    })));
    assert.deepEqual(responses.map((res) => res.statusCode), [200, 200]);
    assert.deepEqual(seen.sort(), [...ids].sort());
    assert.deepEqual(envNames.map((name) => process.env[name]), before);
    assert.equal((await call({ provider, headers: { "x-inference-provider-key": undefined } })).statusCode, 400);
  });
}

test("client quotas are separate for authenticated apps even with the same browser token", async () => {
  process.env.INFERENCE_CLIENT_DAILY_LIMIT = "1";
  globalThis.fetch = async () => success("replit");
  const token = crypto.randomUUID();
  for (const [app, secret] of [[ids[0], TEST_APP_SECRET], [ids[1], secondSecret]]) {
    assert.equal((await call({ app, secret, token })).statusCode, 200);
    assert.equal((await call({ app, secret, token })).body.error, "client_limit");
  }
});

test("provider credential echoes are redacted from successful content and model fields", async () => {
  const key = "private-provider-key";
  globalThis.fetch = async () => Response.json({ model: key,
    choices: [{ message: { role: "assistant", content: `Echo: ${key}` } }],
  });
  const response = await call({ key });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { content: "Echo: [redacted]", model: "[redacted]", provider: "replit" });
});

test("raw upstream failures and status fields cannot echo secrets into logs or error responses", async () => {
  const logged = [];
  mock.method(console, "warn", (...args) => logged.push(JSON.stringify(args)));
  const key = "private-provider-key";
  for (const provider of providerIds) {
    for (const status of [400, 429, 503]) {
      globalThis.fetch = async () => Response.json({ error: { status: key, message: `${key} ${TEST_APP_SECRET}`, quotaId: key } }, { status });
      const response = await call({ provider, key });
      assert.ok(response.statusCode >= 400);
      assert.doesNotMatch(JSON.stringify(response), /private-provider-key|private-test-app-secret/);
    }
  }
  assert.doesNotMatch(logged.join("\n"), /private-provider-key|private-test-app-secret/);
});
