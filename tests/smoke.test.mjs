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

function run(args, scenario = "success", requestTimeout = "") {
  const directory = mkdtempSync(join(tmpdir(), "ipa-smoke-test-"));
  try {
    const envContents = `DEFAULT_INFERENCE_PROVIDER=${scenario === "bad_local_default" ? "invalid" : "gemini"}\nGEMINI_API_KEY=private-gemini-test-key\nOLLAMA_API_KEY=private-ollama-test-key\nGEMINI_MODEL=configured-gemini-model\nOLLAMA_MODEL=configured-ollama-model\nREPLIT_API_KEY=private-replit-test-key\nREPLIT_MODEL=configured-replit-model\nINFERENCE_REQUEST_TIMEOUT_MS=${requestTimeout}\n`;
    writeFileSync(join(directory, ".env.local"), envContents);
    const mockPath = join(directory, "mock.mjs");
    writeFileSync(mockPath, `
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
          const model = JSON.parse(init.body).model;
          appendFileSync("requests.jsonl", JSON.stringify({provider:"ollama", model}) + "\\n");
          return Response.json({message:{role:"assistant",content:"smoke test OK"}});
        }
        if (target.hostname === "generativelanguage.googleapis.com") {
          const model = decodeURIComponent(target.pathname.split("/models/")[1].split(":generateContent")[0]);
          appendFileSync("requests.jsonl", JSON.stringify({provider:"gemini", model}) + "\\n");
          return Response.json({candidates:[{content:{parts:[{text:"smoke test OK"}]}}]});
        }
        if (target.hostname === "samsamskies-inference.replit.app") {
          // The gateway serves its HTML SPA at the incorrect /v1 path.
          if (target.pathname !== "/api/v1/chat/completions") {
            return new Response("<!DOCTYPE html><html>Inference Gateway</html>", {headers:{"Content-Type":"text/html"}});
          }
          const model = JSON.parse(init.body).model;
          appendFileSync("requests.jsonl", JSON.stringify({provider:"replit", model}) + "\\n");
          return Response.json({choices:[{message:{role:"assistant",content:"smoke test OK"}}]});
        }
        const request = { url: String(url), method: init.method, headers: init.headers,
          body: init.body ? JSON.parse(init.body) : undefined };
        appendFileSync("requests.jsonl", JSON.stringify(request) + "\\n");
        const scenario = process.env.IPA_SMOKE_SCENARIO;
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
      !/^(DEFAULT_INFERENCE_PROVIDER|INFERENCE_|GEMINI_|OLLAMA_|REPLIT_|NODE_OPTIONS)/.test(name)));
    const result = spawnSync(process.execPath, ["--import", mockPath, script, ...args], {
      cwd: directory, env: { ...env, IPA_SMOKE_SCENARIO: scenario }, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(readFileSync(join(directory, ".env.local"), "utf8"), envContents);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /private-(?:gemini|ollama|replit)-test-key/);
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
  for (const args of [["--provider", "unknown"], ["--provider", ""], ["--unknown"],
    ["--model", ""], ["--model", "  "],
    ["--model", "custom-model", "--url", "https://smoke.example/api/inference"],
    ["--url", "invalid"], ["--url", "file:///etc/passwd"], ["--url", "https://user:password@example.test"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.requests.length, 0);
  }
});

test("smoke model overrides reach the selected provider without changing the env file", () => {
  for (const [args, provider, model] of [
    [["--provider", "ollama", "--model", "  custom:cloud  "], "ollama", "custom:cloud"],
    [["--provider", "gemini", "--model", "custom-gemini-model"], "gemini", "custom-gemini-model"],
    [["--provider", "replit", "--model", "custom/replit-model"], "replit", "custom/replit-model"],
    [["--model", "default-provider-model"], "gemini", "default-provider-model"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, [{provider, model}]);
    assert.ok(result.output.includes(`Model: ${model}`));
  }
});

test("local smoke without a model override uses the provider's configured model", () => {
  for (const provider of ["ollama", "gemini", "replit"]) {
    const result = run(["--provider", provider]);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, [{provider, model:`configured-${provider}-model`}]);
  }
});

test("smoke selects each provider and sends the endpoint contract without credentials", () => {
  for (const provider of ["ollama", "gemini", "replit"]) {
    const result = run(["--provider", provider, "--url", "https://smoke.example/api/inference"]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Smoke test passed/);
    assert.match(result.output, /Model: mock-model/);
    assert.match(result.output, /Response: smoke test OK/);
    assert.deepEqual(result.requests.map((request) => request.method), ["GET", "POST"]);
    for (const request of result.requests) {
      assert.equal(new URL(request.url).searchParams.get("provider"), provider);
    }
    const post = result.requests[1];
    assert.equal(post.headers.Origin, "https://smoke.example");
    assert.ok(post.headers["X-Inference-Client"]);
    assert.equal(post.body.webSearch, false);
    assert.equal(post.body.options.reasoningEffort, "none");
    assert.equal(post.body.messages[0].role, "user");
    assert.doesNotMatch(JSON.stringify(result.requests), /private-(?:gemini|ollama|replit)-test-key/);
  }
});

test("smoke without a provider flag preserves the target's default selection", () => {
  for (const scenario of ["success", "bad_local_default"]) {
    const result = run(["--url", "https://smoke.example/api/inference"], scenario);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.requests.every((request) => !new URL(request.url).searchParams.has("provider")));
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
    const result = run(["--provider", "gemini", "--url", "https://smoke.example/api/inference"], scenario);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
  }
});

test("smoke timeout tracks the local request budget plus 30 seconds", () => {
  for (const [configured,expected] of [["",120_000],["75000",75_000],["300000",170_000]]) {
    const result = run(["--provider","replit"],"success",configured);
    assert.equal(result.status,0,result.output);
    assert.deepEqual(result.timeouts,[expected+30_000,expected]);
  }
});

test("smoke timeout errors report the configured duration", () => {
  const result = run(["--url","https://smoke.example/api/inference"],"timeout","1000");
  assert.equal(result.status,1);
  assert.match(result.output,/Request timed out after 31 seconds/);
  assert.deepEqual(result.timeouts,[31_000]);
});
