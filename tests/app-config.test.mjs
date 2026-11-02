import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { apps, appEnvNames, getApp } from "../lib/apps.js";
import { createAppConfigResolver, resolveAppProviderConfig, validateAppRegistry } from "../lib/app-config.js";
import { normalizeRequest } from "../lib/inference-request.js";
import { sendInferenceError } from "../lib/inference-response.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const providerIds = ["ollama", "gemini", "replit"];
const appIds = ["trendingnostr", "advancednostrsearch"];

function environment() {
  return Object.fromEntries(Object.entries(apps).flatMap(([id, app]) =>
    Object.entries(app.providers).flatMap(([providerId, config]) => [
      [config.apiKeyEnv, `private-${id}-${providerId}-key`],
    ])));
}

function rejectsWith(fn, code, status) {
  assert.throws(fn, (error) => {
    const response = {
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; },
    };
    sendInferenceError(response, error);
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.body, { error: code });
    assert.doesNotMatch(JSON.stringify(response), /private-|API_KEY|APP_SECRET/);
    return true;
  });
}

test("both registered apps allow all three providers and default to Replit", () => {
  assert.doesNotThrow(() => validateAppRegistry(apps));
  for (const id of appIds) {
    assert.equal(getApp(id), apps[id]);
    assert.equal(apps[id].enabled, true);
    assert.deepEqual(Object.keys(apps[id].providers), providerIds);
    const resolve = createAppConfigResolver(apps, environment());
    assert.equal(resolve(id).providerId, "replit");
    for (const providerId of providerIds) {
      assert.equal(resolve(id, providerId).providerId, providerId);
    }
  }
  assert.equal(typeof resolveAppProviderConfig, "function");
  for (const id of ["unknown", "toString", "constructor", "__proto__", undefined]) {
    assert.equal(getApp(id), undefined);
  }
  assert.throws(() => { apps.trendingnostr.providers.replit.apiKeyEnv = "OTHER_KEY"; }, TypeError);
});

for (const providerId of providerIds) {
  test(`${providerId}: resolved app settings reach the adapter with independent keys and models`, async () => {
    const resolve = createAppConfigResolver(apps, environment());
    const request = normalizeRequest({
      messages: [{ role: "user", content: "Hello" }], webSearch: false,
    });
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const target = new URL(url);
      const body = JSON.parse(init.body);
      const key = providerId === "gemini" ? target.searchParams.get("key")
        : init.headers.Authorization.slice(7);
      const id = appIds.find((appId) => key === `private-${appId}-${providerId}-key`);
      assert.ok(id, "unexpected credential");
      const model = `${id}/${providerId}-model`;
      if (providerId === "gemini") assert.ok(decodeURIComponent(target.pathname).includes(`/models/${model}:generateContent`));
      else assert.equal(body.model, model);
      seen.push(id);
      await new Promise((done) => setImmediate(done));
      if (providerId === "gemini") return Response.json({ candidates: [{ content: { parts: [{ text: id }] } }] });
      if (providerId === "ollama") return Response.json({ message: { role: "assistant", content: id } });
      return Response.json({ choices: [{ message: { role: "assistant", content: id } }] });
    };
    const results = await Promise.all(appIds.map(async (id) => {
      const config = resolve(id, providerId);
      return config.adapter.generate(request, { ...config, model: `${id}/${providerId}-model`, signal: AbortSignal.timeout(1000) });
    }));
    assert.deepEqual(seen, appIds);
    assert.deepEqual(results.map(({ content, model }) => ({ content, model })),
      appIds.map((id) => ({ content: id, model: `${id}/${providerId}-model` })));
  });
}

test("missing app/provider keys never use another app, provider, app secret, or global key", () => {
  for (const id of appIds) {
    for (const providerId of providerIds) {
      const env = environment();
      Object.assign(env, { OLLAMA_API_KEY: "private-global", GEMINI_API_KEY: "private-global",
        REPLIT_API_KEY: "private-global", [apps[id].authSecretEnv]: "private-app-secret" });
      env[apps[id].providers[providerId].apiKeyEnv] = "  ";
      const resolve = createAppConfigResolver(apps, env);
      rejectsWith(() => resolve(id, providerId), "missing_api_key", 503);
      const other = appIds.find((appId) => appId !== id);
      assert.equal(resolve(other, providerId).appId, other);
      const otherProvider = providerIds.find((candidate) => candidate !== providerId);
      assert.equal(resolve(id, otherProvider).providerId, otherProvider);
      if (providerId === "replit") rejectsWith(() => resolve(id), "missing_api_key", 503);
    }
  }
});

test("unknown/disabled apps and providers outside the app allowlist fail closed", () => {
  const registry = structuredClone(apps);
  registry.advancednostrsearch.enabled = false;
  delete registry.trendingnostr.providers.gemini;
  registry.trendingnostr.providers.ollama.enabled = false;
  const resolve = createAppConfigResolver(registry, environment());
  for (const id of [undefined, "unknown", "constructor", "__proto__", ["trendingnostr"]]) {
    rejectsWith(() => resolve(id), "unknown_app", 403);
  }
  rejectsWith(() => resolve("advancednostrsearch"), "app_disabled", 403);
  rejectsWith(() => resolve("trendingnostr", "gemini"), "provider_not_allowed", 403);
  rejectsWith(() => resolve("trendingnostr", "ollama"), "provider_disabled", 503);
  for (const providerId of ["", " ", "unknown", "constructor", "__proto__", null, []]) {
    rejectsWith(() => resolve("trendingnostr", providerId), "invalid_provider", 400);
  }
  assert.equal(resolve("trendingnostr", " REPLIT ").providerId, "replit");
  registry.trendingnostr.providers.replit.apiKeyEnv = "REPLIT_API_KEY";
  assert.equal(resolve("trendingnostr").apiKey, "private-trendingnostr-replit-key");
});

test("app resolution contains only credentials and provider settings; models belong to requests", () => {
  const env = environment();
  env.REPLIT_MODEL = "ignored-global-model";
  env.TRENDINGNOSTR_REPLIT_MODEL = "ignored-app-model";
  const resolve = createAppConfigResolver(apps, env);
  assert.equal(Object.hasOwn(resolve("trendingnostr"), "model"), false);
  assert.equal(Object.hasOwn(resolve("trendingnostr"), "capabilities"), false);
  assert.ok(appEnvNames().every((name) => !name.endsWith("_MODEL")));
  for (const app of Object.values(apps)) {
    for (const config of Object.values(app.providers)) {
      assert.equal(Object.hasOwn(config, "model"), false);
      assert.equal(Object.hasOwn(config, "modelEnv"), false);
    }
  }
});

test("Replit completion budgets are app-scoped and validated without global fallback", () => {
  const env = environment();
  env.REPLIT_MAX_TOKENS = "9999";
  env.TRENDINGNOSTR_REPLIT_MAX_TOKENS = "4096";
  const resolve = createAppConfigResolver(apps, env);
  assert.equal(resolve("trendingnostr").maxTokens, 4096);
  assert.equal(resolve("advancednostrsearch").maxTokens, undefined);
  for (const invalid of ["0", "-1", "0.5", "1.5", "no", "Infinity", "9007199254740992", "1e3"]) {
    env.TRENDINGNOSTR_REPLIT_MAX_TOKENS = invalid;
    rejectsWith(() => resolve("trendingnostr"), "invalid_app_config", 503);
  }
});

test("malformed registries reject invalid defaults, metadata, and reused environment names", () => {
  for (const mutate of [
    (r) => { r.trendingnostr.defaultProvider = "unknown"; },
    (r) => { r.trendingnostr.defaultProvider = "constructor"; },
    (r) => { r.trendingnostr.providers.replit.enabled = false; },
    (r) => { r.trendingnostr.enabled = "true"; },
    (r) => { r.trendingnostr.name = " "; },
    (r) => { r.trendingnostr.providers = []; },
    (r) => { r.trendingnostr.providers.unknown = r.trendingnostr.providers.replit; },
    (r) => { r.trendingnostr.providers.replit.enabled = "false"; },
    (r) => { r.trendingnostr.authSecretEnv = "private-secret-value"; },
    (r) => { r.trendingnostr.providers.replit.apiKeyEnv = ""; },
    (r) => { r.trendingnostr.providers.replit.apiKeyEnv = r.advancednostrsearch.providers.replit.apiKeyEnv; },
    (r) => { r.trendingnostr.authSecretEnv = r.advancednostrsearch.authSecretEnv; },
    (r) => { r.trendingnostr.providers.ollama.maxTokensEnv = "OLLAMA_CAP"; },
  ]) {
    const registry = structuredClone(apps);
    mutate(registry);
    rejectsWith(() => createAppConfigResolver(registry, {}), "invalid_app_config", 503);
  }
  for (const registry of [null, [], "invalid"]) {
    rejectsWith(() => validateAppRegistry(registry), "invalid_app_config", 503);
  }
});

test("local env loading includes all app secrets/settings and preserves injected values", () => {
  const directory = mkdtempSync(join(tmpdir(), "ipa-app-env-"));
  try {
    writeFileSync(join(directory, ".env.local"), appEnvNames().map((name) => `${name}=local-value`).join("\n"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !appEnvNames().includes(name)));
    env.TRENDINGNOSTR_APP_SECRET = "injected-value";
    const script = `
      await import(${JSON.stringify(new URL("../api/inference.js", import.meta.url).href)});
      const { appEnvNames } = await import(${JSON.stringify(new URL("../lib/apps.js", import.meta.url).href)});
      for (const name of appEnvNames()) {
        if (process.env[name] !== (name === "TRENDINGNOSTR_APP_SECRET" ? "injected-value" : "local-value")) process.exit(1);
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: directory, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
