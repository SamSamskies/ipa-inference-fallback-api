import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/smoke.mjs", import.meta.url));

function readJsonLines(path) {
  try { return readFileSync(path,"utf8").trim().split("\n").map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function run(args, scenario = "success", requestTimeout = "", app = "trendingnostr") {
  if (app) args = ["--app", app, ...args];
  const directory = mkdtempSync(join(tmpdir(), "ipa-smoke-test-"));
  try {
    const envContents = `DEFAULT_INFERENCE_PROVIDER=replit\nGEMINI_API_KEY=private-gemini-test-key\nOLLAMA_API_KEY=private-ollama-test-key\nGEMINI_MODEL=configured-gemini-model\nOLLAMA_MODEL=configured-ollama-model\nREPLIT_API_KEY=private-replit-test-key\nREPLIT_MODEL=configured-replit-model\nINFERENCE_REQUEST_TIMEOUT_MS=${requestTimeout}\nTRENDINGNOSTR_APP_SECRET=${scenario === "missing_app_secret" ? "" : "private-smoke-app-secret"}\nINFERENCE_SMOKE_PROVIDER_KEY=${scenario === "missing_caller_key" ? "" : "private-smoke-provider-key"}\n`;
    writeFileSync(join(directory, ".env.local"), envContents);
    const mockPath = join(directory, "mock.mjs");
    writeFileSync(mockPath, `
      import assert from "node:assert/strict";
      import { appendFileSync } from "node:fs";
      import http from "node:http";
      import { syncBuiltinESMExports } from "node:module";
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (ms) => {
        appendFileSync("timeouts.jsonl", JSON.stringify(ms) + "\\n");
        return originalTimeout(ms);
      };
      let localHandler;
      // Exercise the real local adapter/handler without opening a socket.
      http.createServer = (callback) => {
        localHandler = callback;
        return {
          once() {}, listen(_port, _host, ready) { ready(); },
          address() { return {port: 31415}; },
          close(done) { done(); }, closeAllConnections() {},
        };
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (url, init) => {
        const target = new URL(url);
        if (target.hostname === "127.0.0.1") {
          return new Promise((resolve, reject) => {
            const headers = Object.fromEntries(new Headers(init.headers));
            const req = { method: init.method, url: target.pathname + target.search,
              headers: { ...headers, host: target.host },
              async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body); },
            };
            const responseHeaders = new Headers();
            const res = { statusCode: 200,
              setHeader(name, value) { responseHeaders.set(name, value); },
              end(body) { resolve(new Response(body, {status: this.statusCode, headers: responseHeaders})); },
            };
            Promise.resolve(localHandler(req, res)).catch(reject);
          });
        }
        if (url === "https://ollama.com/api/chat") {
          assert.equal(init.headers.Authorization, "Bearer private-smoke-provider-key");
          const model = JSON.parse(init.body).model;
          appendFileSync("requests.jsonl", JSON.stringify({provider:"ollama", model}) + "\\n");
          return Response.json({message:{role:"assistant",content:"smoke test OK"}});
        }
        if (target.hostname === "generativelanguage.googleapis.com") {
          assert.equal(init.headers["x-goog-api-key"], "private-smoke-provider-key");
          assert.equal(target.search, "");
          const model = decodeURIComponent(target.pathname.split("/models/")[1].split(":generateContent")[0]);
          appendFileSync("requests.jsonl", JSON.stringify({provider:"gemini", model}) + "\\n");
          return Response.json({candidates:[{content:{parts:[{text:"smoke test OK"}]}}]});
        }
        if (target.hostname === "samsamskies-inference.replit.app") {
          // The gateway serves its HTML SPA at the incorrect /v1 path.
          if (target.pathname !== "/api/v1/chat/completions") {
            return new Response("<!DOCTYPE html><html>Inference Gateway</html>", {headers:{"Content-Type":"text/html"}});
          }
          assert.equal(init.headers.Authorization, "Bearer private-smoke-provider-key");
          const model = JSON.parse(init.body).model;
          appendFileSync("requests.jsonl", JSON.stringify({provider:"replit", model}) + "\\n");
          return Response.json({choices:[{message:{role:"assistant",content:"smoke test OK"}}]});
        }
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, "Bearer private-smoke-app-secret");
        assert.equal(init.headers["X-Inference-App"], "trendingnostr");
        assert.equal(init.headers["X-Inference-Provider-Key"], "private-smoke-provider-key");
        const safeHeaders = { ...init.headers, Authorization: "[redacted]", "X-Inference-Provider-Key": "[redacted]" };
        const request = { url: String(url), method: init.method, headers: safeHeaders,
          body: init.body ? JSON.parse(init.body) : undefined };
        appendFileSync("requests.jsonl", JSON.stringify(request) + "\\n");
        const scenario = process.env.IPA_SMOKE_SCENARIO;
        if (scenario === "transport_secret") throw new Error("private-smoke-provider-key private-smoke-app-secret");
        if (scenario === "redirect") return new Response("", {status:302,headers:{Location:"https://untrusted.test"}});
        if (scenario === "echo_secrets" && init.method === "POST") return Response.json({content:"private-smoke-app-secret private-smoke-provider-key",model:"private-smoke-provider-key"});
        if (scenario === "timeout") throw new DOMException("Timed out", "TimeoutError");
        if (scenario === "unreachable") throw new TypeError("fetch failed");
        if (scenario === "missing_key") return Response.json({error:"missing_api_key"}, {status:503});
        if (scenario === "bad_json") return new Response("not JSON");
        if (init.method === "GET") return Response.json({ok: scenario !== "bad_probe"});
        if (scenario === "limited") return Response.json({error:"rate_limited"}, {status:429, headers:{"Retry-After":"30"}});
        if (scenario === "empty") return Response.json({content:"",model:"mock-model"});
        if (scenario === "missing_model") return Response.json({content:"smoke test OK"});
        if (scenario === "raw_error") return Response.json({error:"private-gemini-test-key"}, {status:502});
        return Response.json({content:"smoke test OK",model:"mock-model"});
      };
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(DEFAULT_INFERENCE_PROVIDER|INFERENCE_|GEMINI_|OLLAMA_|REPLIT_|TRENDINGNOSTR_|ADVANCEDNOSTRSEARCH_|NODE_OPTIONS)/.test(name)));
    const result = spawnSync(process.execPath, ["--import", mockPath, script, ...args], {
      cwd: directory, env: { ...env, DEFAULT_INFERENCE_PROVIDER: "replit", IPA_SMOKE_SCENARIO: scenario }, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(readFileSync(join(directory, ".env.local"), "utf8"), envContents);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /private-(?:gemini|ollama|replit)-test-key|private-smoke/);
    return { ...result, output, requests: readJsonLines(join(directory,"requests.jsonl")),
      timeouts: readJsonLines(join(directory,"timeouts.jsonl")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("smoke help and invalid arguments exit without a request", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.output, /--provider ollama\|gemini/);
  assert.match(help.output, /--model MODEL/);
  assert.equal(help.requests.length, 0);
  for (const args of [[], ["--provider", "unknown"], ["--provider", ""], ["--unknown"],
    ["--provider", "replit", "--model", ""], ["--provider", "replit", "--model", "  "],
    ["--provider", "replit", "--model", "two models"],
    ["--provider", "replit", "--model", "x".repeat(201)],
    ["--provider", "replit", "--model", "model", "--url", "invalid"],
    ["--provider", "replit", "--model", "model", "--url", "file:///etc/passwd"],
    ["--provider", "replit", "--model", "model", "--url", "https://user:password@example.test"],
    ["--provider", "unknown", "--model", "model", "--url", "https://smoke.example/api/inference"],
    ["--provider", "replit", "--model", "model", "--url", "http://smoke.example/api/inference"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.requests.length, 0);
  }
});

test("smoke requires a model even when legacy model environment variables are set", () => {
  for (const args of [["--provider", "ollama"], ["--provider", "replit", "--url", "https://smoke.example/api/inference"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.output, /--model is required/);
    assert.equal(result.requests.length, 0);
  }
});

test("smoke request models reach each selected provider without changing the env file", () => {
  for (const [args, provider, model] of [
    [["--provider", "ollama", "--model", "  custom:cloud  "], "ollama", "custom:cloud"],
    [["--provider", "gemini", "--model", "custom-gemini-model"], "gemini", "custom-gemini-model"],
    [["--provider", "replit", "--model", "custom/replit-model"], "replit", "custom/replit-model"],
    [["--provider", " REPLIT ", "--model", "backend/model"], "replit", "backend/model"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, [{provider, model}]);
    assert.ok(result.output.includes(`Model: ${model}`));
  }
});

test("smoke requires an explicit provider despite legacy defaults and URL parameters", () => {
  for (const args of [
    ["--model", "backend/model"],
    ["--model", "backend/model", "--url", "https://smoke.example/api/inference?provider=replit"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /--provider is required/);
    assert.equal(result.requests.length, 0);
  }
});

test("remote smoke sends model in the body and credentials only in headers", () => {
  for (const provider of ["ollama", "gemini", "replit"]) {
    const result = run(["--provider", provider, "--model", "backend/model", "--url", "https://smoke.example/api/inference"]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Smoke test passed/);
    assert.match(result.output, /Model: mock-model/);
    assert.match(result.output, /Response: smoke test OK/);
    assert.deepEqual(result.requests.map((request) => request.method), ["GET", "POST"]);
    for (const request of result.requests) {
      assert.equal(new URL(request.url).searchParams.get("provider"), provider);
      assert.equal(new URL(request.url).searchParams.has("model"), false);
    }
    const post = result.requests[1];
    assert.equal(post.headers.Origin, undefined);
    assert.equal(post.headers["X-Inference-App"], "trendingnostr");
    assert.equal(post.headers.Authorization, "[redacted]");
    assert.equal(post.headers["X-Inference-Provider-Key"], "[redacted]");
    assert.ok(post.headers["X-Inference-Client"]);
    assert.equal(post.body.model, "backend/model");
    assert.equal(post.body.webSearch, false);
    assert.equal(post.body.options.reasoningEffort, "none");
    assert.equal(post.body.messages[0].role, "user");
    assert.doesNotMatch(JSON.stringify(result.requests), /private-(?:gemini|ollama|replit)-test-key|private-smoke/);
  }
});

test("explicit smoke provider replaces all provider parameters in the remote URL", () => {
  const result = run(["--provider", "gemini", "--model", "backend/model", "--url",
    "https://smoke.example/api/inference?provider=ollama&provider=replit"]);
  assert.equal(result.status, 0, result.output);
  for (const request of result.requests) {
    assert.deepEqual(new URL(request.url).searchParams.getAll("provider"), ["gemini"]);
  }
});

test("smoke failures exit nonzero with useful endpoint errors", () => {
  for (const [scenario, expected] of [
    ["unreachable", /Could not reach the endpoint/],
    ["missing_key", /HTTP 503: missing_api_key/],
    ["limited", /HTTP 429: rate_limited.*Retry after 30s/],
    ["bad_json", /without a JSON response/],
    ["bad_probe", /invalid configuration probe/],
    ["empty", /invalid inference response/],
    ["missing_model", /invalid inference response/],
    ["raw_error", /HTTP 502: unexpected_error/],
  ]) {
    const result = run(["--provider", "gemini", "--model", "backend/model", "--url", "https://smoke.example/api/inference"], scenario);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
  }
});

test("smoke timeout tracks the local request budget plus 30 seconds", () => {
  for (const [configured,expected] of [["",120_000],["75000",75_000],["300000",170_000]]) {
    const result = run(["--provider","replit","--model","backend/model"],"success",configured);
    assert.equal(result.status,0,result.output);
    assert.deepEqual(result.timeouts,[expected+30_000,expected]);
  }
});

test("smoke timeout errors report the configured duration", () => {
  const result = run(["--provider","replit","--model","backend/model","--url","https://smoke.example/api/inference"],"timeout","1000");
  assert.equal(result.status,1);
  assert.match(result.output,/Request timed out after 31 seconds/);
  assert.deepEqual(result.timeouts,[31_000]);
});

test("smoke requires a registered app and caller credentials with no provider-env fallback", () => {
  const args = ["--provider", "replit", "--model", "backend/model"];
  for (const app of [null, "unknown"]) {
    const result = run(args, "success", "", app);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /--app is required/);
    assert.equal(result.requests.length, 0);
  }
  for (const [scenario, expected] of [["missing_app_secret", /TRENDINGNOSTR_APP_SECRET/],
    ["missing_caller_key", /INFERENCE_SMOKE_PROVIDER_KEY/]]) {
    const result = run(args, scenario);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
    assert.equal(result.requests.length, 0);
  }
});

test("smoke does not print credential echoes or transport details and refuses redirects", () => {
  const args = ["--provider", "replit", "--model", "backend/model", "--url", "https://smoke.example/api/inference"];
  const echoed = run(args, "echo_secrets");
  assert.equal(echoed.status, 0, echoed.output);
  assert.match(echoed.output, /\[redacted\]/);
  const transport = run(args, "transport_secret");
  assert.equal(transport.status, 1);
  assert.match(transport.output, /Request failed/);
  const redirect = run(args, "redirect");
  assert.equal(redirect.status, 1);
  assert.equal(redirect.requests.length, 1);
});
