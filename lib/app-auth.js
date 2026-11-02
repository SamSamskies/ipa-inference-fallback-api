import { createHash, timingSafeEqual } from "node:crypto";
import { apps } from "./apps.js";
import { validateAppRegistry } from "./app-config.js";
import { INFERENCE_APP_HEADER, INFERENCE_PROVIDER_KEY_HEADER, singleHeader } from "./http.js";
import { inferenceError } from "./inference-response.js";

const digest = (value) => createHash("sha256").update(value).digest();

/** App authentication is independent of browser Origin, client tokens, and provider keys. */
export function createAppAuthenticator(registry = apps, env = process.env) {
  validateAppRegistry(registry);
  const snapshot = structuredClone(registry);
  return function authenticate(req) {
    const appId = singleHeader(req, INFERENCE_APP_HEADER);
    const authorization = singleHeader(req, "Authorization");
    const app = typeof appId === "string" && Object.hasOwn(snapshot, appId) ? snapshot[appId] : undefined;
    const token = typeof authorization === "string" && authorization.length <= 4096
      ? /^Bearer ([^\s,]+)$/i.exec(authorization)?.[1] : undefined;
    const expected = app?.enabled ? env[app.authSecretEnv]?.trim() : undefined;
    // Hash to fixed-size buffers so unequal secret lengths still use a timing-safe comparison.
    const matches = timingSafeEqual(digest(token || ""), digest(expected || ""));
    if (!token || !expected || !matches) throw inferenceError(401, "unauthorized_app");
    return appId;
  };
}

export const authenticateApp = createAppAuthenticator();

/** Provider credentials belong only to this request; never read a fallback from env. */
export function requestProviderKey(req) {
  const key = singleHeader(req, INFERENCE_PROVIDER_KEY_HEADER);
  if (key === undefined || !key.trim()) throw inferenceError(400, "missing_api_key");
  if (key.length > 8192 || !/^[\x21-\x7e]+$/.test(key) || key.includes(",")) {
    throw inferenceError(400, "invalid_api_key");
  }
  return key;
}
