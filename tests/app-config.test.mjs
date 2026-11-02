import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { apps, appEnvNames, getApp } from "../lib/apps.js";
import { createAppConfigResolver, resolveAppProviderConfig, validateAppRegistry } from "../lib/app-config.js";
import { sendInferenceError } from "../lib/inference-response.js";

function rejectsWith(fn, code, status) {
  assert.throws(fn, (error) => {
    const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    sendInferenceError(response, error);
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.body, { error: code });
    assert.doesNotMatch(JSON.stringify(response), /private-|API_KEY|APP_SECRET/);
    return true;
  });
}

test("both apps allow three providers with no stored provider credentials or defaults", () => {
  validateAppRegistry(apps);
  const resolve = createAppConfigResolver(apps, {});
  for (const id of ["trendingnostr", "advancednostrsearch"]) {
    assert.equal(getApp(id), apps[id]);
    assert.equal(apps[id].enabled, true);
    assert.equal(Object.hasOwn(apps[id], "defaultProvider"), false);
    rejectsWith(() => resolve(id), "invalid_provider", 400);
    for (const provider of ["ollama", "gemini", "replit"]) {
      const result = resolve(id, provider);
      assert.equal(result.providerId, provider);
      assert.equal(result.adapter.id, provider);
      assert.equal(Object.hasOwn(result, "apiKey"), false);
      assert.equal(Object.hasOwn(result, "model"), false);
      assert.equal(Object.hasOwn(apps[id].providers[provider], "apiKeyEnv"), false);
    }
  }
  assert.equal(typeof resolveAppProviderConfig, "function");
  assert.ok(appEnvNames().every((name) => !/API_KEY|MODEL/.test(name)));
  for (const id of ["unknown", "toString", "constructor", "__proto__", undefined]) assert.equal(getApp(id), undefined);
  assert.throws(() => { apps.trendingnostr.providers.replit.enabled = false; }, TypeError);
});

test("unknown/disabled apps and disallowed/disabled providers fail closed", () => {
  const registry = structuredClone(apps);
  registry.advancednostrsearch.enabled = false;
  delete registry.trendingnostr.providers.gemini;
  registry.trendingnostr.providers.ollama.enabled = false;
  const resolve = createAppConfigResolver(registry, {});
  for (const id of [undefined, "unknown", "constructor", "__proto__", []]) rejectsWith(() => resolve(id), "unknown_app", 403);
  rejectsWith(() => resolve("advancednostrsearch", "replit"), "app_disabled", 403);
  rejectsWith(() => resolve("trendingnostr", "gemini"), "provider_not_allowed", 403);
  rejectsWith(() => resolve("trendingnostr", "ollama"), "provider_disabled", 503);
  for (const id of [undefined, "", " ", "unknown", "constructor", "__proto__", null, []]) {
    rejectsWith(() => resolve("trendingnostr", id), "invalid_provider", 400);
  }
  registry.trendingnostr.providers.replit.enabled = false;
  assert.equal(resolve("trendingnostr", " REPLIT ").providerId, "replit");
});

test("Replit completion caps are app-scoped and validated without global fallback", () => {
  const env = { REPLIT_MAX_TOKENS: "9999", TRENDINGNOSTR_REPLIT_MAX_TOKENS: "4096" };
  const resolve = createAppConfigResolver(apps, env);
  assert.equal(resolve("trendingnostr", "replit").maxTokens, 4096);
  assert.equal(resolve("advancednostrsearch", "replit").maxTokens, undefined);
  for (const value of ["0", "-1", "0.5", "1.5", "no", "Infinity", "9007199254740992", "1e3"]) {
    env.TRENDINGNOSTR_REPLIT_MAX_TOKENS = value;
    rejectsWith(() => resolve("trendingnostr", "replit"), "invalid_app_config", 503);
  }
});

test("invalid app metadata and duplicate environment names are rejected", () => {
  for (const mutate of [
    (r) => { r.trendingnostr.providers = null; },
    (r) => { r.trendingnostr.providers.replit = null; },
    (r) => { r.trendingnostr.enabled = "true"; },
    (r) => { r.trendingnostr.name = " "; },
    (r) => { r.trendingnostr.providers = []; },
    (r) => { r.trendingnostr.providers.unknown = {}; },
    (r) => { r.trendingnostr.providers.replit.enabled = "false"; },
    (r) => { r.trendingnostr.authSecretEnv = "private-secret"; },
    (r) => { r.trendingnostr.authSecretEnv = r.advancednostrsearch.authSecretEnv; },
    (r) => { r.trendingnostr.providers.replit.maxTokensEnv = r.trendingnostr.authSecretEnv; },
    (r) => { r.trendingnostr.providers.ollama.maxTokensEnv = "OLLAMA_CAP"; },
  ]) {
    const registry = structuredClone(apps); mutate(registry);
    rejectsWith(() => createAppConfigResolver(registry, {}), "invalid_app_config", 503);
  }
  for (const registry of [null, [], "invalid"]) rejectsWith(() => validateAppRegistry(registry), "invalid_app_config", 503);
});

test("local env loading includes all app secrets/settings and preserves injected values", () => {
  const directory = mkdtempSync(join(tmpdir(), "ipa-app-env-"));
  try {
    writeFileSync(join(directory, ".env.local"), appEnvNames().map((name) => `${name}=local-value`).join("\n") + "\nOLLAMA_API_KEY=private-old-key\nGEMINI_API_KEY=private-old-key\nREPLIT_API_KEY=private-old-key\nINFERENCE_SMOKE_PROVIDER_KEY=private-caller-key");
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !appEnvNames().includes(name) && !/API_KEY$|INFERENCE_SMOKE_PROVIDER_KEY/.test(name)));
    env.TRENDINGNOSTR_APP_SECRET = "injected-value";
    const script = `
      await import(${JSON.stringify(new URL("../api/inference.js", import.meta.url).href)});
      const { appEnvNames } = await import(${JSON.stringify(new URL("../lib/apps.js", import.meta.url).href)});
      for (const name of ["OLLAMA_API_KEY", "GEMINI_API_KEY", "REPLIT_API_KEY", "INFERENCE_SMOKE_PROVIDER_KEY"]) {
        if (process.env[name] !== undefined) process.exit(2);
      }
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
