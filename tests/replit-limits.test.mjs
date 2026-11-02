import assert from "node:assert/strict";
import test, { beforeEach, afterEach, mock } from "node:test";
import handler from "../api/inference.js";
import { DEFAULT_REPLIT_MAX_TOKENS, replitMaxTokens } from "../lib/replit-limits.js";
import { clientQuota } from "../lib/client-quota.js";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";

const envNames = ["REPLIT_MAX_TOKENS", "TRENDINGNOSTR_REPLIT_MAX_TOKENS",
  "ADVANCEDNOSTRSEARCH_REPLIT_MAX_TOKENS", "TRENDINGNOSTR_APP_SECRET", "ADVANCEDNOSTRSEARCH_APP_SECRET",
  "INFERENCE_FALLBACK_ENABLED"];
const originalFetch = globalThis.fetch;
let previous;
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  envNames.forEach((name) => delete process.env[name]);
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
  process.env.ADVANCEDNOSTRSEARCH_APP_SECRET = "second-app-secret";
  process.env.INFERENCE_FALLBACK_ENABLED = "true";
  globalThis.fetch = () => { throw new Error("Unexpected provider call"); };
});
afterEach(() => {
  mock.restoreAll(); globalThis.fetch = originalFetch;
  envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

test("Replit has a mandatory default cap and accepts only positive decimal safe integers", () => {
  assert.equal(DEFAULT_REPLIT_MAX_TOKENS, 16384);
  for (const [value, expected] of [[undefined,16384],["",16384],["  ",16384],
    ["1",1],["8192",8192],[" 24576 ",24576]]) {
    if (value === undefined) delete process.env.REPLIT_MAX_TOKENS;
    else process.env.REPLIT_MAX_TOKENS = value;
    assert.equal(replitMaxTokens(), expected);
  }
  for (const invalid of ["0", "-1", "0.5", "1.5", "1e3", "0x100", "invalid", "Infinity", "9007199254740992"]) {
    process.env.REPLIT_MAX_TOKENS = invalid;
    assert.throws(() => replitMaxTokens(), { status: 503, message: "invalid_provider_config" });
  }
});

async function call({ app = "trendingnostr", method = "POST", provider = "replit", query = "", body = {} } = {}) {
  const res = { statusCode: 200, body: undefined, setHeader() {},
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; },
  };
  await handler({ method, url: `/api/inference?provider=${provider}${query}`,
    headers: { ...appHeaders("provider-key", app, app === "trendingnostr" ? TEST_APP_SECRET : "second-app-secret"),
      "x-inference-client": crypto.randomUUID(),
    },
    body: { model: "backend/model", messages: [{ role: "user", content: "Hello" }], webSearch: false, ...body },
  }, res);
  return res;
}

test("both apps always receive the service cap; legacy app settings and request overrides are ignored", async () => {
  process.env.TRENDINGNOSTR_REPLIT_MAX_TOKENS = "1";
  process.env.ADVANCEDNOSTRSEARCH_REPLIT_MAX_TOKENS = "99999";
  for (const configured of [undefined, "8192"]) {
    if (configured === undefined) delete process.env.REPLIT_MAX_TOKENS;
    else process.env.REPLIT_MAX_TOKENS = configured;
    const sent = [];
    globalThis.fetch = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
    };
    const responses = await Promise.all(["trendingnostr", "advancednostrsearch"].map((app) => call({ app,
      query: "&max_tokens=99999&maxTokens=1",
      body: { max_tokens: 1, maxTokens: 99999, max_completion_tokens: 1,
        options: { reasoningEffort: "high", maxTokens: 1, max_tokens: 99999 } },
    })));
    assert.deepEqual(responses.map((res) => res.statusCode), [200, 200]);
    assert.deepEqual(sent.map((body) => body.max_tokens), [configured ? 8192 : 16384, configured ? 8192 : 16384]);
    assert.ok(sent.every((body) => body.reasoning_effort === "high"));
    assert.equal(process.env.REPLIT_MAX_TOKENS, configured);
  }
});

test("invalid service caps reject Replit GET/POST before quota/upstream work and leave Gemini available", async () => {
  process.env.REPLIT_MAX_TOKENS = "not-a-cap";
  const quota = mock.method(clientQuota, "tryConsume", () => { throw new Error("Must validate the cap first"); });
  for (const method of ["GET", "POST"]) {
    const response = await call({ method });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: "invalid_provider_config" });
  }
  assert.equal(quota.mock.callCount(), 0);
  assert.equal((await call({ method: "GET", provider: "gemini" })).statusCode, 200);
});
