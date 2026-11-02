# IPA inference fallback API

A fallback inference endpoint for apps using the Inference Provider API (IPA).
When no browser extension providing the Inference Provider API is detected,
an app can use this endpoint for hosted inference. The app handles provider
detection and decides when to use the fallback.

The endpoint runs as a standalone Node ESM `/api/inference` function.
Callers can select Ollama Cloud, Gemini, or the Replit gateway per request;
Replit is the default.
There are no runtime package dependencies or frontend/build framework dependencies.

The existing origin checks and client token are not app authentication. Existing
limits are in memory, per process, and do not provide a shared production quota.

## Local development

Requires Node.js 22+ and npm. Vercel CLI is pinned as a development dependency.

```sh
npm ci
cp .env.example .env.local
# Set the API key for each provider callers should be able to use.
npm run dev:vercel
```

On first use, sign in with `npx vercel login` and follow Vercel's prompts to link
a development project. Use the **Other** framework preset with no frontend build
or development command. The script is named `dev:vercel` because Vercel rejects a
`dev` script that recursively invokes itself. Secrets belong in `.env.local` or
the Vercel environment; local env files are ignored by Git. The extracted env
loader fills missing `DEFAULT_INFERENCE_PROVIDER`, `INFERENCE_`, `OLLAMA_`,
`GEMINI_`, `REPLIT_`, and registered app settings from `.env.local` then `.env`,
without overriding existing nonempty environment values.

`vercel.json` requests a [180 second function duration](https://vercel.com/docs/functions/configuring-functions/duration),
supported on Hobby with Fluid Compute enabled. Each inference request has a
120-second total timeout by default, covering image downloads, provider calls,
search, and retries. Set `INFERENCE_REQUEST_TIMEOUT_MS` to change this budget;
values above 170,000 ms are capped to leave 10 seconds before Vercel's limit.
There is no frontend at `/`; use `/api/inference`.

```sh
curl -i http://localhost:3000/api/inference
curl -i 'http://localhost:3000/api/inference?provider=ollama' \
  -H 'Origin: http://localhost:3000' \
  -H 'Content-Type: application/json' \
  -H 'X-Inference-Client: local-example-client' \
  --data '{"model":"gemma4:cloud","messages":[{"role":"user","content":"Explain DNS in one sentence."}],"webSearch":false,"options":{"reasoningEffort":"none","temperature":0.3}}'
```

The probe returns `200 {"ok":true}` when the selected provider is configured and
enabled, or `503 {"ok":false,"error":"missing_api_key"}` / `"disabled"`. It checks
configuration only and does not contact the provider. Use
`GET /api/inference?provider=gemini` to probe a specific provider. An unsupported
configured default returns `503 {"error":"invalid_provider"}`; an invalid caller
selection returns `400 {"error":"invalid_provider"}`.

## Smoke testing

Add provider keys to `.env.local`, then specify a model for each smoke request:

```sh
npm run smoke -- --provider ollama --model gemma4:cloud
npm run smoke -- --provider gemini --model gemma-4-31b-it
npm run smoke -- --provider replit --model google/gemma-4-26b-a4b-it
```

The script starts a temporary local HTTP server around the actual inference
handler, probes provider configuration, and sends a short generation request.
No Vercel login or running development server is needed. Without `--provider`,
it uses `DEFAULT_INFERENCE_PROVIDER` (Replit when unset). `--model` is required
and is sent in the POST JSON body. Provider keys load from `.env.local`; model
selection comes entirely from the command argument. Environment files stay
unchanged. Web search is off and reasoning effort is `none`.
This makes a real provider API call and may consume quota or incur a small charge.

The script prints the model, response, and elapsed time, then shuts down its
temporary server. It exits nonzero for invalid arguments, configuration,
connection or provider failures, and malformed responses. Provider API keys stay
in the server's provider requests. Its timeout is the locally configured request
budget plus 30 seconds (150 seconds by default).

To test a running Vercel development server or deployed endpoint instead:

```sh
npm run smoke -- --provider gemini --model gemma-4-31b-it --url http://localhost:3000/api/inference
npm run smoke -- --provider ollama --model gemma4:cloud --url https://your-service.vercel.app/api/inference
```

With `--url`, the target server supplies its provider keys and the CLI still
supplies the required model. Omit `--provider` to test that server's default.
Set `INFERENCE_REQUEST_TIMEOUT_MS` locally to match the target's request budget
when testing a server with a different timeout. Use
`npm run smoke -- --help` for usage.

## Configuration

| Variable | Default / behavior |
| --- | --- |
| `DEFAULT_INFERENCE_PROVIDER` | `ollama`, `gemini`, or `replit`; defaults to `replit`; used when the request omits `provider` |
| `INFERENCE_FALLBACK_ENABLED` | Enabled when the selected provider has a key; `0`, `false`, or `off` disables it |
| `INFERENCE_CLIENT_DAILY_LIMIT` | 50 successful requests per client token per UTC day |
| `INFERENCE_REQUEST_TIMEOUT_MS` | 120,000 ms total per request; positive integer, capped at 170,000 ms; invalid values use the default |
| `OLLAMA_API_KEY` | Required for Ollama; Gemini keys are never sent to Ollama |
| `OLLAMA_REQUESTS_PER_MINUTE` | 20 upstream attempts across clients, including search/continuation calls |
| `OLLAMA_CLIENT_REQUESTS_PER_MINUTE` | 5 explanation attempts per client token |
| `OLLAMA_MAX_CONCURRENT` | 2 active explanations |
| `GEMINI_API_KEY` | Required for Gemini |
| `REPLIT_API_KEY` | The Replit gateway's bearer token; required for Replit |
| `REPLIT_MAX_TOKENS` | Optional total completion-token cap, including reasoning; unset uses gateway/model defaults |

Models are required in each inference request body. Global and app-specific
`*_MODEL` environment variables are unused; there is no server-selected model
default. The app backend owns model selection.
Replit leaves the output budget to the gateway unless `REPLIT_MAX_TOKENS` is set.
Reasoning models need room for both reasoning and the final answer; a small total
cap can exhaust the budget before visible answer text is produced. All calls
remain subject to the configured per-request total timeout (120 seconds by default).
Numeric limits accept positive values, flooring them to integers; invalid values
fall back to defaults.

## Application registry

`lib/apps.js` registers `trendingnostr` (TrendingNostr) and
`advancednostrsearch` (AdvancedNostrSearch). Both apps are enabled, allow Ollama,
Gemini, and Replit, and default to **Replit**. Every app/provider entry has its
own API-key environment variable name and optional completion-token cap.
Model selection belongs in each app's server-side proxy.
The registry is immutable and contains metadata and environment variable names;
actual credentials belong in the shared API's server-side environment.

This is the registry foundation for [issue #4](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/4).
The current HTTP endpoint and smoke CLI still use the global configuration above.
Authenticated proxy routing and provider discovery are tracked in
[issue #5](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/5);
the registry does not authenticate an HTTP request or activate frontend migrations.

| App | App secret | Provider key |
| --- | --- | --- |
| TrendingNostr | `TRENDINGNOSTR_APP_SECRET` | `TRENDINGNOSTR_OLLAMA_API_KEY` |
| | | `TRENDINGNOSTR_GEMINI_API_KEY` |
| | | `TRENDINGNOSTR_REPLIT_API_KEY` |
| AdvancedNostrSearch | `ADVANCEDNOSTRSEARCH_APP_SECRET` | `ADVANCEDNOSTRSEARCH_OLLAMA_API_KEY` |
| | | `ADVANCEDNOSTRSEARCH_GEMINI_API_KEY` |
| | | `ADVANCEDNOSTRSEARCH_REPLIT_API_KEY` |

Optional `TRENDINGNOSTR_REPLIT_MAX_TOKENS` and
`ADVANCEDNOSTRSEARCH_REPLIT_MAX_TOKENS` accept positive decimal safe integers;
blank values use gateway defaults. Invalid caps fail with `invalid_app_config`.

`lib/app-config.js` exports `resolveAppProviderConfig(appId, providerId?)` for
server code that has **already authenticated** the app ID. Omitted provider uses
that app's default. The result has `appId`, `providerId`, `adapter`, `apiKey`,
and optional `maxTokens`. The HTTP handler validates the request model and resolves
its capabilities from the provider registry before generation. The resolver result
contains credentials and must stay inside server code; do not log it or return it
to clients. App secret verification belongs at the HTTP boundary before calling
this resolver.

Resolution fails closed with sanitized error codes:

| Status | Code / condition |
| --- | --- |
| 403 | `unknown_app`, `app_disabled`, or `provider_not_allowed` |
| 400 | `invalid_provider` for an invalid explicit provider |
| 503 | `provider_disabled`, `missing_api_key`, or `invalid_app_config` |

A missing key affects only that app/provider. It never uses another app's key,
an app secret, a global provider key, or another provider. A missing default
provider key returns an error; it does not switch providers. `enabled: false` on
an app disables its resolution; on a provider entry it disables that provider.
Registry validation requires known providers, a registered/enabled default for
enabled apps, valid metadata, and unique environment names across all app secrets,
keys, and token caps. Model capability metadata comes from the provider adapter
registry and is resolved per request.

### Registering another app and rotating secrets

Generate a new app secret with:

```sh
npm run --silent generate:app-secret
```

Each run prints a new 256-bit cryptographically random, URL-safe secret. Copy it
into the app's `*_APP_SECRET` server environment setting. The command only prints
the value; it does not update environment files or Vercel settings.

1. Add an entry to `lib/apps.js` with a unique lowercase app ID, `name`, boolean
   `enabled`, `authSecretEnv`, `defaultProvider`, and explicit `providers` map.
   Copy an existing entry and give **every** environment variable a new app
   prefix. Each provider requires `apiKeyEnv`; `enabled` and Replit's `maxTokensEnv`
   are optional. Configure the model in that app's backend and include it in every
   inference request body. Providers outside the registry map are denied.
2. Add the new environment names to `.env.example`. Configure separate provider
   credentials in the shared Vercel project's relevant environments (or local
   `.env.local`), and generate an independent app secret. Once authenticated
   proxies are implemented, that app secret is shared only with its server-side
   proxy; provider keys stay in the shared service. Registered environment names
   are automatically picked up by the local env loader.
3. Run `npm test`. Use `createAppConfigResolver(registry, env)` to test a custom
   registry or environment without changing process-wide settings.
4. Rotate a provider key by replacing only its app/provider environment value,
   redeploying the shared service, verifying that app/provider, and revoking the
   old key. App-secret rotation requires coordinating the shared service and its
   authenticated proxy before revoking the old secret; this registry stores one
   secret name per app. Never place secrets in Git, browser bundles, or logs.

## Provider adapters

`lib/providers/registry.js` is the static allowlist for Ollama, Gemini, and Replit.
Each entry describes its environment settings, capabilities, and
`generate(normalizedRequest, { model, apiKey, signal, maxTokens? })` function.
The environment resolver in `lib/provider-config.js` supplies the selected
credentials and completion budget for each request. The handler supplies the
validated request model; adapters receive credentials and model IDs explicitly.
Replit's optional completion budget is passed as `maxTokens`.

The shared request format has `system`, `messages`, `options`, and `webSearch`.
Messages use `user`/`assistant` roles and `parts` containing `{ text }` or
`{ image: { mediaType, data } }`. URL images initially contain
`{ image: { mediaType, url } }`; shared image preparation downloads them before
generation, retaining failed URLs as text. Shared helpers own validation, image
safety and size limits, stale vision-hint removal, source formatting, and HTTP
error responses. Adapters own native message mapping, search, reasoning,
response parsing, and provider-specific retry/error classification.

Registry entries define `capabilities: { vision, webSearch, reasoning }` and a
`models` map of exact model IDs to partial capability overrides. For example,
`models: { "your-text-model": { vision: false, reasoning: false } }` disables
images and explicit reasoning controls for that requested model while inheriting
the provider's search setting. Image URLs then remain text, inline images are
omitted, and unsupported search/reasoning controls are omitted from native calls.
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
`POST /api/inference?provider=gemini`, or `POST /api/inference?provider=replit`. Omitting the parameter uses
`DEFAULT_INFERENCE_PROVIDER`. The same selection applies to `GET` probes.
Unknown, empty, or repeated `provider` parameters return `400 invalid_provider`.
The chosen provider must have a server-side API key and be enabled; otherwise
the request returns `503 missing_api_key` or `503 disabled`. Requests do not
automatically switch providers on failure.

`POST /api/inference` requires an allowed `Origin` and a nonempty
`X-Inference-Client` header. Allowed origins are localhost/127.0.0.1, the request
host over HTTPS, and Vercel's `VERCEL_URL`, `VERCEL_BRANCH_URL`, and
`VERCEL_PROJECT_PRODUCTION_URL` values. `OPTIONS` supports the existing CORS
preflight contract. The future authenticated frontend proxies are not implemented
in this extraction; server-to-server calls currently still require `Origin`.

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
routing remain the deployment prerequisite tracked in issue #5.

The conversation must start and end with a usable user turn (excluding system
messages). Text content may also be an array of `{ "type": "text", "text": "..." }`
and `{ "type": "image", "url": "https://..." }` or
`{ "type": "image", "mediaType": "image/png", "data": "base64..." }` parts.
Supported image types are JPEG, PNG, WebP, and GIF. Request body and prompt caps
remain 100,000 and 60,000 respectively using the existing length checks; fetched
images are capped at 4,000,000 bytes each, and the total inline image payload
after fetch cannot exceed 4,000,000 bytes (`413 payload_too_large`). Image fetches reject private/local
destinations and credentials, validate all DNS answers and redirect hops, and pin
the connection IP while retaining the original Host/TLS SNI. At most five
redirects are followed. Failed image downloads become text URLs.

`webSearch` defaults to enabled when omitted. `false`, `0`, `"false"`, and `"off"`
disable it; other non-boolean values return `400 invalid_request`. Ollama calls
`https://ollama.com/api` directly and may run up to two `web_search` tools and
three chat calls. Gemini uses Google Search grounding and retries capacity errors
once. Replit calls the fixed
[`samsamskies-inference.replit.app` gateway](https://samsamskies-inference.replit.app)
at `/api/v1/chat/completions` using `REPLIT_API_KEY`. With search enabled, it sends
`tools: [{"type":"openrouter:web_search"}]` and leaves execution to the gateway,
following [OpenRouter's hosted search format](https://openrouter.ai/docs/guides/features/server-tools/web-search).
Returned `url_citation` annotations become source links. Replit uses OpenAI-compatible
text/image messages and `reasoning_effort`; unsupported reasoning or temperature options get one retry without
the rejected field, within the same deadline.

All providers append source links when needed. `reasoningEffort` accepts `auto`,
`none`, `low`, `medium`, and `high`; it maps to each provider's existing thinking
settings. `temperature` accepts numbers from 0 through 2. App backends select the
provider through the query parameter and model through the body; credentials and
provider base URLs remain under shared API control.

Successful requests return `200 {"content":"...","model":"..."}`. Errors retain
their existing JSON shape and codes:

| HTTP status | Error codes |
| --- | --- |
| 400 | `invalid_provider` (caller selection), `invalid_json`, `invalid_request`, `invalid_model`, `missing_client_token`, Gemini `provider_error` (with upstream `http` and optional `providerStatus`) |
| 403 | `forbidden_origin` |
| 405 | `method_not_allowed` |
| 413 | `payload_too_large` |
| 429 | `client_limit`, `client_capacity`, `rate_limited`, `quota_exhausted`, `search_quota` |
| 502 | `provider_error`, Ollama/Replit `model_unavailable`, Ollama/Replit `provider_auth` |
| 503 | `missing_api_key`, `disabled`, `invalid_provider` (configured default), `provider_busy` |

Ollama rate limits/cooldowns, Replit gateway rate limits, and Gemini 429s retain `Retry-After`;
Replit maps insufficient-credit responses to `quota_exhausted`. Gemini quota classification
distinguishes search, daily, and short-window limits. Provider failures release
the daily success allowance, while Ollama attempt limits still count failures.

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
provider replies, provider/model/auth failures, and default/explicit provider
selection with credential/model isolation. Live provider generation is a separate,
credentialed check.
