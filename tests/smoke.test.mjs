import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/smoke.mjs", import.meta.url));

function run(args, scenario = "success") {
  const directory = mkdtempSync(join(tmpdir(), "ipa-smoke-test-"));
  try {
    writeFileSync(join(directory, ".env.local"),
      `DEFAULT_INFERENCE_PROVIDER=${scenario === "bad_local_default" ? "invalid" : "gemini"}\nGEMINI_API_KEY=private-gemini-test-key\nOLLAMA_API_KEY=private-ollama-test-key\n`);
    const mockPath = join(directory, "mock.mjs");
    writeFileSync(mockPath, `
      import { appendFileSync } from "node:fs";
      globalThis.fetch = async (url, init) => {
        const request = { url: String(url), method: init.method, headers: init.headers,
          body: init.body ? JSON.parse(init.body) : undefined };
        appendFileSync("requests.jsonl", JSON.stringify(request) + "\\n");
        const scenario = process.env.IPA_SMOKE_SCENARIO;
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
      !/^(DEFAULT_INFERENCE_PROVIDER|INFERENCE_|GEMINI_|OLLAMA_|NODE_OPTIONS)/.test(name)));
    const result = spawnSync(process.execPath, ["--import", mockPath, script, ...args], {
      cwd: directory, env: { ...env, IPA_SMOKE_SCENARIO: scenario }, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /private-(?:gemini|ollama)-test-key/);
    let requests = [];
    try {
      requests = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ...result, output, requests };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("smoke help and invalid arguments exit without a request", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.output, /--provider ollama\|gemini/);
  assert.equal(help.requests.length, 0);
  for (const args of [["--provider", "unknown"], ["--provider", ""], ["--unknown"],
    ["--url", "invalid"], ["--url", "file:///etc/passwd"], ["--url", "https://user:password@example.test"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.requests.length, 0);
  }
});

test("smoke selects each provider and sends the endpoint contract without credentials", () => {
  for (const provider of ["ollama", "gemini"]) {
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
    assert.doesNotMatch(JSON.stringify(result.requests), /private-(?:gemini|ollama)-test-key/);
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
