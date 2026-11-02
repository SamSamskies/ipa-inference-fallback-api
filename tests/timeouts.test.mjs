import assert from "node:assert/strict";
import { appHeaders, TEST_APP_SECRET } from "./helpers/app-request.mjs";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach, mock } from "node:test";
import handler from "../api/inference.js";
import { providers } from "../lib/providers/registry.js";
import { requestTimeoutMs, smokeTimeoutMs } from "../lib/timeouts.js";

const envNames = ["REPLIT_MAX_TOKENS", "TRENDINGNOSTR_APP_SECRET", "INFERENCE_REQUEST_TIMEOUT_MS", "INFERENCE_FALLBACK_ENABLED",
  "INFERENCE_CLIENT_DAILY_LIMIT", "OLLAMA_API_KEY", "GEMINI_API_KEY", "REPLIT_API_KEY"];
const originalFetch = globalThis.fetch;
let previous;
beforeEach(() => {
  previous = envNames.map((name) => process.env[name]);
  envNames.forEach((name) => delete process.env[name]);
  process.env.TRENDINGNOSTR_APP_SECRET = TEST_APP_SECRET;
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  envNames.forEach((name,i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  });
});

test("request timeout defaults to 120 seconds and rejects invalid configuration", () => {
  for (const value of [undefined,""," ","0","-1","0.5","NaN","Infinity","invalid"]) {
    if (value === undefined) delete process.env.INFERENCE_REQUEST_TIMEOUT_MS;
    else process.env.INFERENCE_REQUEST_TIMEOUT_MS = value;
    assert.equal(requestTimeoutMs(),120_000);
    assert.equal(smokeTimeoutMs(),150_000);
  }
});

test("request timeout is configurable and capped below Vercel's function deadline", () => {
  for (const [value,expected] of [["1",1],["75000",75_000],["170000",170_000],["300000",170_000]]) {
    process.env.INFERENCE_REQUEST_TIMEOUT_MS = value;
    assert.equal(requestTimeoutMs(),expected);
    assert.equal(smokeTimeoutMs(),expected+30_000);
  }
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json",import.meta.url),"utf8"));
  assert.ok(requestTimeoutMs()+10_000 <= vercel.functions["api/inference.js"].maxDuration*1000);
});

test("all providers use the configured request deadline", async () => {
  process.env.INFERENCE_REQUEST_TIMEOUT_MS = "73000";
  const deadlines = [];
  mock.method(AbortSignal,"timeout",(ms) => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  globalThis.fetch = async (url) => {
    if (url === "https://ollama.com/api/chat") return Response.json({message:{role:"assistant",content:"OK"}});
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      return Response.json({candidates:[{content:{parts:[{text:"OK"}]}}]});
    }
    assert.equal(url,"https://samsamskies-inference.replit.app/api/v1/chat/completions");
    return Response.json({choices:[{message:{role:"assistant",content:"OK"}}]});
  };
  for (const provider of Object.keys(providers)) {
    const res = {setHeader(){},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
    await handler({method:"POST",url:`/api/inference?provider=${provider}`,
      headers:{...appHeaders(),host:"example.test",origin:"https://example.test","x-inference-client":crypto.randomUUID()},
      body:{model:"test-model",messages:[{role:"user",content:"Test"}],webSearch:false}},res);
    assert.equal(res.statusCode,200);
  }
  assert.deepEqual(deadlines,[73_000,73_000,73_000]);
});
