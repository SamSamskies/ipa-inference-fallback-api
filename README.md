# IPA inference fallback API

A shared fallback inference endpoint for apps using the Inference Provider API
(IPA). Apps retain IPA-first routing, prompts, consent, and their server-side
proxies; this service supplies reusable Ollama Cloud, Gemini, and Replit adapters.
It runs as Node ESM `/api/inference` and `/api/providers` functions. The
`@vercel/firewall` SDK supplies Vercel-backed app admission checks.

Every GET probe, provider-discovery request, and POST inference request must authenticate a registered app.
The app backend supplies the provider, model, and provider API key for each
inference request. Provider credentials are owned by the calling backends and
are never resolved from shared-service environment settings or another request.
The registry stores app identity and allowed providers. Service policy owns
provider limits, including an optional Replit completion cap.

Production: `https://ipa-inference-fallback-api.vercel.app`. See the
[deployment and integration runbook](docs/deployment.md) for environment ownership,
port 3001 development, the smoke matrix, staged frontend migrations, and rollback.
Inference is enabled with verified per-app admission limits. Neither frontend
has been migrated; see the [deployment validation record](docs/deployment-validation.md)
for tested features and remaining rollout checks.

## Local development

Requires Node.js 24 and npm. The deployment runtime and Vercel CLI are pinned.

```sh
npm ci
cp .env.example .env.local
npm run --silent generate:app-secret
# Set a separate app secret for each enabled app in .env.local.
npm run dev:vercel
```

On first use, sign in with `npx vercel login` and link a development project.
Use the **Other** framework preset with no frontend build or development command.
The service listens on port **3001**; run each app's own proxy independently on
another port. The
[local proxy instructions](docs/deployment.md#local-development-with-independent-proxies)
explain how to connect the two processes.
Secrets belong in ignored local environment files or server-side environment
settings. The shared service's local loader reads only its exact settings:
`INFERENCE_FALLBACK_ENABLED`, `INFERENCE_CLIENT_DAILY_LIMIT`,
`INFERENCE_REQUEST_TIMEOUT_MS`, `INFERENCE_RATE_LIMIT_WINDOW_SECONDS`,
the three `OLLAMA_` limits, `REPLIT_MAX_TOKENS`,
and the app secret names registered in `lib/apps.js`. It fills missing settings
from `.env.local` then `.env` without overriding nonempty injected values. It does not load provider
API keys, smoke caller keys, or obsolete provider/model defaults.

`vercel.json` requests a [180 second function duration](https://vercel.com/docs/functions/configuring-functions/duration).
Each request has a 120-second total timeout covering images, generation, search,
and retries. `INFERENCE_REQUEST_TIMEOUT_MS` is capped at 170,000 ms. There is no
frontend at `/`; use `/api/inference` through a server-side app proxy.

Before deploying, publish the Vercel **`inference-app`** rate-limit rule using the
[production controls runbook](docs/production-controls.md). Deployed POSTs fail
closed if the check fails or its rule is missing. Local development skips the
external check. Each authenticated app has its own admission bucket across its
providers and browser IDs; Vercel's counters are shared across instances within
a region. They are not exact global daily quotas. Configure public-proxy rate
limits and provider spending controls separately as described in the runbook.

## Server-to-server requests

The calling backend sets these headers itself; never forward browser-supplied
app identity, authorization, provider keys, provider selection, or model selection:

| Header | Purpose |
| --- | --- |
| `X-Inference-App` | Registered app ID: `trendingnostr` or `advancednostrsearch` |
| `Authorization: Bearer <app secret>` | Authenticates that app against its registered server-side secret |
| `X-Inference-Provider-Key` | Credential for the provider selected by this request |
| `X-Inference-Client` | Required POST client token, scoped to the authenticated app for quotas |

For example, inside the TrendingNostr **backend**:

```js
const response = await fetch("https://your-service.vercel.app/api/inference?provider=replit", {
  method: "POST",
  redirect: "error",
  headers: {
    "Content-Type": "application/json",
    "X-Inference-App": "trendingnostr",
    Authorization: `Bearer ${process.env.TRENDINGNOSTR_APP_SECRET}`,
    "X-Inference-Provider-Key": process.env.REPLIT_API_KEY,
    "X-Inference-Client": clientToken,
  },
  body: JSON.stringify({
    model: "google/gemma-4-26b-a4b-it",
    messages: [{ role: "user", content: "Explain DNS in one sentence." }],
    webSearch: false,
    options: { reasoningEffort: "none", temperature: 0.3 },
  }),
});
```

`REPLIT_API_KEY` above belongs to the **app backend** environment. It is not a
shared-service setting. Each backend can use its own names for provider keys.
Both registered apps intentionally use the same Replit gateway key because the
gateway currently accepts one key. Their app authentication secrets and service
admission limits remain separate; rotate the gateway key in both backends together.
Use HTTPS between deployed backends. Provider destinations are fixed in the
adapters, and credential-bearing requests reject redirects. Gemini uses
`x-goog-api-key`, keeping credentials out of its request URL.

App authentication runs before provider resolution, credential validation, quota
reservation, image fetching, and generation. Missing, incorrect, ambiguous,
unknown-app, disabled-app, or unconfigured app credentials return
`401 unauthorized_app`. Provider credentials do not authenticate an app. App
secrets are compared with a timing-safe comparison of fixed-length hashes.

A provider key must be a single header containing 1–8192 visible ASCII characters,
without whitespace or commas. Missing keys return `400 missing_api_key`; malformed
keys return `400 invalid_api_key`. Duplicate credential headers are rejected.
Keys in bodies, query parameters, global env settings, or per-app env settings
never substitute for the header. No request key is written to `process.env`,
a cache, or persistent storage by the shared handler.

`GET /api/inference?provider=replit` requires the same app authentication and
provider-key header. It returns `200 {"ok":true}` when the app/provider is enabled,
the credential is syntactically valid, and the fallback switch is on. The probe
makes no upstream request and does not verify that the provider accepts the key.
GET requires neither a model nor a client token.

### Provider discovery

`GET /api/providers` requires only `X-Inference-App` and
`Authorization: Bearer <app secret>`. The app backend can proxy this metadata to
its frontend. No provider key, model, or client token is needed. For example,
the response includes entries like:

```json
{
  "providers": [{
    "id": "replit",
    "capabilities": { "vision": true, "webSearch": true, "reasoning": true },
    "models": [{
      "id": "google/gemma-4-26b-a4b-it",
      "capabilities": { "vision": true, "webSearch": true, "reasoning": true }
    }]
  }]
}
```

Only the authenticated app's allowlisted, enabled providers are returned. Invalid
local provider policy (such as an invalid `REPLIT_MAX_TOKENS`) omits that provider;
an empty list is valid. Global fallback disable returns `503 disabled`.
Responses use `Cache-Control: no-store` and contain no secrets, app configuration,
upstream URLs, or default selection. Discovery makes no upstream calls or quota
reservations, and does not check provider credentials or live availability.

Capabilities are static transport defaults with effective overrides for the exact
model IDs listed in the server registry. This is neither an exhaustive model
catalog nor a model allowlist. Unknown models inherit the transport defaults;
the app backend must choose and verify its models and keys. Discovery does not
guarantee that an upstream model supports or will use a feature. Provider/model
selection and credentials remain explicit on inference requests.

Authenticated backend requests need no `Origin`. If an Origin is supplied, it
must match the existing localhost/same-host/Vercel allowlist. CORS preflight
requires no secrets. CORS permission is not authentication, and secret headers
are not added to the browser CORS allowlist.

## Smoke testing

The smoke CLI acts as a caller backend. Set the selected app's registered
`*_APP_SECRET` in its local environment or ignored `.env.local`. The CLI always
prompts for the selected provider's API key with hidden input in an interactive
terminal. Type or paste the key and press Enter; Ctrl+C cancels. It is sent only
in the provider-key HTTP header, without being saved to configuration, echoed,
or included in command arguments. No provider-key flag or environment variable
is needed; the old `INFERENCE_SMOKE_PROVIDER_KEY` setting is ignored.

```sh
npm run smoke -- --app trendingnostr --provider ollama --model gemma4:cloud
npm run smoke -- --app trendingnostr --provider gemini --model gemma-4-31b-it
npm run smoke -- --app advancednostrsearch --provider replit --model google/gemma-4-26b-a4b-it
```

All three flags are required. Enter the matching provider key when prompted.
The CLI starts a temporary local server around the actual handler,
probes configuration, and sends a short generation request with search disabled
and reasoning effort `none`. No Vercel login or running dev server is needed.
This makes a real provider API call and may consume quota or incur a small charge.

To target an existing service, append `--url https://your-service.vercel.app/api/inference`.
The caller still supplies its app secret and provider key. HTTP targets are allowed
only for loopback development, and redirects are rejected. An explicit provider
replaces any provider parameters in the supplied URL. The CLI leaves environment
files unchanged, prints model/response/timing with credential echoes redacted, and
exits nonzero on failures. Its timeout is the configured request budget plus
30 seconds (150 seconds by default). Use `npm run smoke -- --help` for usage.

Add `--checks` to test discovery, auth/validation failures, provider selection,
and credential non-disclosure. Add `--vision` or `--web-search` in separate runs
to check an inline image or a search-enabled response with a source URL. Protected
deployment URLs accept a caller-side `VERCEL_AUTOMATION_BYPASS_SECRET`. See the
[deployment smoke matrix](docs/deployment.md#deployment-smoke-matrix) for details
and the limits of these checks.

## Shared service configuration

| Variable | Default / behavior |
| --- | --- |
| `INFERENCE_FALLBACK_ENABLED` | Enabled unless `0`, `false`, or `off` |
| `INFERENCE_CLIENT_DAILY_LIMIT` | 50 successful requests per authenticated app + client token per UTC day, shared across that app's providers |
| `INFERENCE_REQUEST_TIMEOUT_MS` | 120,000 ms; positive integer capped at 170,000 ms |
| `INFERENCE_RATE_LIMIT_WINDOW_SECONDS` | 60; integer from 10–600, matching the published `inference-app` WAF window. Supplies conservative `Retry-After`; the dashboard owns the threshold/window |
| `OLLAMA_REQUESTS_PER_MINUTE` | 20 upstream attempts across apps/clients, including search/continuation calls |
| `OLLAMA_CLIENT_REQUESTS_PER_MINUTE` | 5 explanation attempts per app + client token |
| `OLLAMA_MAX_CONCURRENT` | 2 active explanations across apps |
| `TRENDINGNOSTR_APP_SECRET` | Required to authenticate TrendingNostr |
| `ADVANCEDNOSTRSEARCH_APP_SECRET` | Required to authenticate AdvancedNostrSearch |
| `REPLIT_MAX_TOKENS` | Optional service-owned cap, including reasoning and the final answer; positive decimal safe integer. Unset or blank omits `max_tokens` and uses gateway/upstream defaults |

There is no default Replit cap in this service. Absent or blank
`REPLIT_MAX_TOKENS` omits `max_tokens` from upstream requests. Set it only to
enforce a service-wide override. Invalid nonblank settings return
`503 invalid_provider_config` for Replit probes and inference requests before
quota reservation or upstream work; other
providers are unaffected. Registered apps cannot override the cap through body,
options, or query fields (`max_tokens`, `maxTokens`, and `max_completion_tokens`
are ignored). Old app-specific cap settings are unused.

An explicit cap includes reasoning and visible answer tokens. Choose a value
supported by the configured models and verify it with live smoke tests. Without
an override, output limits follow the gateway/upstream behavior; this service
does not assume the gateway has explicit per-model defaults. Other numeric limits
retain their existing positive-integer/default behavior. The client daily
allowance and Ollama limits/cooldowns remain in memory per process; Vercel
instances do not share those counters. The Vercel admission check adds a separate
per-app request budget across instances within a region. It counts admitted
POSTs, including later failures, and is never refunded. Exact daily accounting
and global budgets remain deferred in [issue #6](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/6).
See [production controls](docs/production-controls.md) for WAF setup, provider
spending safeguards, public-proxy controls, emergency shutdown, and rotation.

There are no shared provider/model defaults or stored provider-key settings.
Before rolling out, move provider credentials into the appropriate app backends
and configure their authenticated proxies. Remove obsolete global and app-scoped
`*_API_KEY`, `*_MODEL`, `DEFAULT_INFERENCE_PROVIDER`, and app-specific
`*_REPLIT_MAX_TOKENS` settings from the shared deployment and local service
configuration after migration.
Existing stored secrets are not deleted by this source change. App secrets and
the service-wide `REPLIT_MAX_TOKENS` remain shared-service settings.

The shared service handles provider keys transiently, so a running-service
compromise could still capture keys in active requests. Application logs omit raw
provider errors and credential values. Configure platform logs/traces to redact
`Authorization`, `X-Inference-Provider-Key`, and upstream credential headers;
request bodies and full headers should not be logged. Provider-key echoes in
successful responses are redacted too.

## Application registry

`lib/apps.js` registers TrendingNostr and AdvancedNostrSearch, both allowing
Ollama, Gemini, and Replit. Entries contain `name`, boolean `enabled`,
`authSecretEnv`, and a provider allowlist with optional `enabled` settings.
The immutable registry contains no provider credentials, provider-key environment
names, model settings, default provider, or token-limit settings.

`resolveAppProviderConfig(appId, providerId)` resolves a trusted app/provider into
`{ appId, providerId, adapter }`. `authenticateApp(req)` verifies the
request identity before the HTTP handler calls it. Unknown/disabled apps are
rejected by authentication; disallowed providers return `403 provider_not_allowed`
and disabled providers return `503 provider_disabled`.

To onboard another app:

1. Add its unique lowercase ID, metadata, unique `authSecretEnv`, and explicit
   provider allowlist in `lib/apps.js`. Registered app secret names are loaded
   locally automatically.
2. Generate a separate app secret with `npm run --silent generate:app-secret`.
   Configure it in the shared service and that app's backend. The command prints
   a fresh 256-bit URL-safe value and does not write configuration files.
3. Store provider keys only in that app's backend. Have its proxy authenticate,
   set the provider-key header, provider query parameter, and model body field,
   and preserve upstream status codes and `Retry-After` for its browser client.
4. Follow the production controls runbook, run `npm test`, and validate the
   admission rule and an authenticated smoke request before rollout.

Rotate provider keys in their owning backend; the next request uses the new key
without a shared-service configuration change. Coordinate app-secret rotation
between the shared service and app backend; the current registry accepts one
secret per app. Browser bundles must never contain app secrets or provider keys.

This implements the registry from [issue #4](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/4)
and the authentication/routing portion of [issue #5](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/5).
Frontend migrations and removal of old credentials remain staged follow-up work;
see the [rollout order and independent rollback](docs/deployment.md#staged-rollout-and-independent-rollback).

## Provider adapters

`lib/providers/registry.js` is the static allowlist for Ollama, Gemini, and Replit.
Each entry describes its capabilities and
`generate(normalizedRequest, { model, apiKey, signal, maxTokens? })` function.
The app resolver supplies the allowed adapter; the handler supplies the validated
request model and request-local provider key explicitly. `lib/replit-limits.js`
resolves the optional service-owned Replit cap. The handler passes it as
`maxTokens` when configured; otherwise the adapter omits `max_tokens`.
Adapters continue to receive their configuration explicitly.

The shared request format has `system`, `messages`, `options`, `webSearch`, and
`requiredCapabilities`.
Messages use `user`/`assistant` roles and `parts` containing `{ text }` or
`{ image: { mediaType, data } }`. URL images initially contain
`{ image: { mediaType, url } }`; shared image preparation downloads them before
generation, retaining failed URLs as text unless vision is required. Shared helpers own validation, image
safety and size limits, stale vision-hint removal, source formatting, and HTTP
error responses. Adapters own native message mapping, search, reasoning,
response parsing, and provider-specific retry/error classification.

Registry entries define `capabilities: { vision, webSearch, reasoning }` and a
`models` map of exact model IDs to partial capability overrides. For example,
`models: { "your-text-model": { vision: false, reasoning: false } }` disables
images and explicit reasoning controls for that requested model while inheriting
the provider's search setting. Requests containing images then fail with
`400 unsupported_capability` rather than losing image input. Unsupported optional
search/reasoning controls are omitted from native calls; required ones fail
before quota reservation, image fetching, or generation.
These are server-owned settings; clients cannot override them. Defaults preserve
the existing best-effort controls for requested models, including unknown model
IDs; this metadata does not discover or guarantee upstream model support.

To replace an implementation, update its registry entry and implement the JSDoc
contract there. Return `{ content, model, sources }` and use the shared
`inferenceError` helper for classified failures. Transport and parsing exceptions
are sanitized by the HTTP boundary. An optional `acquire(clientId)` hook reserves
provider capacity before image downloads and returns a release function called
on every exit. Ollama uses this hook for its existing process-local limits.
Provider endpoints remain fixed inside each adapter. Application clients keep
using the same `/api/inference` contract.

## Request and response contract

Select a provider with `POST /api/inference?provider=ollama`,
`POST /api/inference?provider=gemini`, or `POST /api/inference?provider=replit`.
Exactly one `provider` query parameter is required for POST requests and GET
probes. Its value is trimmed and lowercased. Missing, unknown, empty, or repeated
`provider` parameters return `400 invalid_provider`; a body field cannot supply it.
The chosen provider must be enabled and allowed for the authenticated app. The
backend supplies its key in `X-Inference-Provider-Key`; missing credentials return
`400 missing_api_key`. The global fallback switch returns `503 disabled` when off.
Requests do not automatically switch providers on failure.

POST requires authenticated app headers, a request-local provider-key header, and
a nonempty `X-Inference-Client`. GET requires the same credentials and provider
selection. Origin is optional for authenticated server-to-server calls.

```json
{
  "model": "google/gemma-4-26b-a4b-it",
  "messages": [
    { "role": "system", "content": "Caller-owned instructions, including response language." },
    { "role": "user", "content": "Question" },
    { "role": "assistant", "content": "Prior answer" },
    { "role": "user", "content": "Follow-up question" }
  ],
  "webSearch": false,
  "options": { "reasoningEffort": "none", "temperature": 0.3 }
}
```

`model` is required in every POST JSON body. It must be a string that, after
trimming, contains 1–200 characters with no whitespace or control characters.
Missing or invalid models return `400 invalid_model` before quota reservation,
image downloads, or generation. A `model` query parameter does not supply or
override the body field. GET probes require no model and only check provider
configuration. `gemma4:cloud` retains its Ollama API alias mapping to `gemma4:31b`.

The intended caller is the app's server-side proxy: set the model there as
backend-owned configuration rather than forwarding a browser-supplied model.
The shared API has no model default or model allowlist. App authentication and
provider allowlists apply before generation.

The conversation must start and end with a usable user turn (excluding system
messages). Text content may also be an array of `{ "type": "text", "text": "..." }`
and `{ "type": "image", "url": "https://..." }` or
`{ "type": "image", "mediaType": "image/png", "data": "base64..." }` parts.
Supported image types are JPEG, PNG, WebP, and GIF. The serialized request body is
capped at 100,000 UTF-8 bytes and prompt text at 60,000 characters; fetched
images are capped at 4,000,000 bytes each, and the total inline image payload
after fetch cannot exceed 4,000,000 bytes (`413 payload_too_large`). Image fetches reject private/local
destinations and credentials, validate all DNS answers and redirect hops, and pin
the connection IP while retaining the original Host/TLS SNI. At most five
redirects are followed. Failed image downloads become text URLs unless vision is
required, in which case the entire request fails with `400 image_unavailable`
without generation, even if some other images succeeded. The quota reservation
is released.

Use optional `requiredCapabilities: ["vision", "webSearch", "reasoning"]` to
require configured support for those capabilities. The array may contain any
subset, including an empty array; unknown values, duplicates, and non-arrays
return `400 invalid_request`. Requiring `webSearch` while disabling it, or
`reasoning` with `reasoningEffort: "none"`, is also invalid. An unsupported
requirement returns `400 {"error":"unsupported_capability","capability":"vision"}`
(or the relevant capability) before reserving quota or contacting upstreams.
These requirements prevent service-side downgrades; they do not force the model
to perform a search or expose reasoning. Ordinary upstream failures retain their
existing error mappings. Supplied images always require configured vision support,
even without this array; optional image downloads can still degrade to URL text.

`webSearch` defaults to enabled when omitted. `false`, `0`, `"false"`, and `"off"`
disable it; other non-boolean values return `400 invalid_request`. Ollama calls
`https://ollama.com/api` directly and may run up to two `web_search` tools and
three chat calls. Gemini uses Google Search grounding and retries capacity errors
once. Replit calls the fixed
[`samsamskies-inference.replit.app` gateway](https://samsamskies-inference.replit.app)
at `/api/v1/chat/completions` using the request-supplied provider key. With search
enabled, it sends
`tools: [{"type":"openrouter:web_search"}]` and leaves execution to the gateway,
following [OpenRouter's hosted search format](https://openrouter.ai/docs/guides/features/server-tools/web-search).
Returned `url_citation` annotations become source links. Replit uses OpenAI-compatible
text/image messages and `reasoning_effort`; unsupported reasoning or temperature options get one retry without
the rejected field, within the same deadline. If reasoning is required, a rejected
reasoning control returns `400 unsupported_capability` without a downgrade retry;
an optional temperature retry still retains the required reasoning control.

All providers append source links when needed. `reasoningEffort` accepts `auto`,
`none`, `low`, `medium`, and `high`; it maps to each provider's existing thinking
settings. `temperature` accepts numbers from 0 through 2. App backends select the
provider through the query parameter, model through the body, and provider key
through its dedicated header. Provider base URLs remain fixed in the shared API.

Successful requests return `200 {"content":"...","model":"...","provider":"replit"}`
with the selected provider ID. Errors retain their existing JSON shape and codes,
plus the capability/image errors described above:

| HTTP status | Error codes |
| --- | --- |
| 400 | `invalid_provider`, `missing_api_key`, `invalid_api_key`, `invalid_json`, `invalid_request`, `invalid_model`, `missing_client_token`, `unsupported_capability` (with `capability`), `image_unavailable`, Gemini `provider_error` (with upstream `http` and optional `providerStatus`) |
| 401 | `unauthorized_app` |
| 403 | `forbidden_origin`, `provider_not_allowed` |
| 405 | `method_not_allowed` |
| 413 | `payload_too_large` |
| 429 | `client_limit`, `client_capacity`, `rate_limited`, `quota_exhausted`, `search_quota` |
| 502 | `provider_error`, Ollama/Replit `model_unavailable`, Ollama/Replit `provider_auth` |
| 503 | `disabled`, `provider_disabled`, `invalid_app_config`, `invalid_provider_config`, `provider_busy`, `rate_limit_unavailable` |

Ollama rate limits/cooldowns, Replit gateway rate limits, and Gemini 429s retain `Retry-After`;
Replit maps insufficient-credit responses to `quota_exhausted`. Gemini quota classification
distinguishes search, daily, and short-window limits. Provider failures release
the daily success allowance, while Ollama attempt limits still count failures.
Vercel admission limits return `429 rate_limited` with one full configured WAF
window as `Retry-After`; check/configuration failures return
`503 rate_limit_unavailable` with `Retry-After: 5`. GET probes and discovery do not
check or consume this budget. The existing daily success allowance remains
process-local; it is not a reliable deployment-wide browser quota.

Application prompt builders, language choice, local-time context, IPA-first
routing, and user consent remain in the frontends. This API forwards supplied
instructions and follow-ups. It retains only the existing compatibility cleanup
of the clients' vision hint when no images survive, so failed downloads do not
leave an instruction claiming images are attached.

## Verification

```sh
npm test
```

Tests use Node's built-in runner with mocked providers, image transport, and DNS;
they need no credentials or network access. They cover validation, probes/CORS,
timeouts, limits and `Retry-After`, bounded search, images/SSRF/redirects, reasoning,
language instruction forwarding, Gemini capacity/quota handling, malformed
provider replies, provider/model/auth failures, and required provider/model
selection, app authentication, request-local credential isolation, duplicate-header
rejection, error redaction, app-scoped client quotas, Vercel admission failure
handling and app isolation using a shared mock counter service, and the SDK's
outbound headers/timeout. Published WAF rules and provider spending controls
require separate rollout validation; live generation is a separate, credentialed check.
