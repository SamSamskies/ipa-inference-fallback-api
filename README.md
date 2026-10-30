# IPA inference fallback API

A fallback inference endpoint for apps using the Inference Provider API (IPA).
When no Inference Provider API is detected, an app can use this endpoint for
hosted inference. The app handles provider detection and decides when to use
the fallback.

The endpoint runs as a standalone Node ESM `/api/inference` function.
Ollama Cloud is the default; Gemini is selectable through server configuration.
There are no runtime package dependencies or frontend/build framework dependencies.

This is the behavior-preserving extraction in [issue #2](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/2).
Provider adapters, app registry/authentication, distributed limits, deployment,
and frontend migrations are subsequent work in [the parent plan](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/1).
The existing origin checks and client token are not app authentication. Existing
limits are in memory, per process, and do not provide a shared production quota.

## Local development

Requires Node.js 22+ and npm. Vercel CLI is pinned as a development dependency.

```sh
npm ci
cp .env.example .env.local
# Set OLLAMA_API_KEY, or choose Gemini and set GEMINI_API_KEY.
npm run dev:vercel
```

On first use, sign in with `npx vercel login` and follow Vercel's prompts to link
a development project. Use the **Other** framework preset with no frontend build
or development command. The script is named `dev:vercel` because Vercel rejects a
`dev` script that recursively invokes itself. Secrets belong in `.env.local` or
the Vercel environment; local env files are ignored by Git. The extracted env
loader fills missing `INFERENCE_`, `OLLAMA_`, and `GEMINI_` values from `.env.local`
then `.env`, without overriding existing nonempty environment values.

`vercel.json` requests a [60 second function duration](https://vercel.com/docs/functions/configuring-functions/duration),
where supported by the Vercel plan/runtime. Each inference attempt shares a
50 second deadline across image downloads, provider calls, search, and retries.
There is no frontend at `/`; use `/api/inference`.

```sh
curl -i http://localhost:3000/api/inference
curl -i http://localhost:3000/api/inference \
  -H 'Origin: http://localhost:3000' \
  -H 'Content-Type: application/json' \
  -H 'X-Inference-Client: local-example-client' \
  --data '{"messages":[{"role":"user","content":"Explain DNS in one sentence."}],"webSearch":false,"options":{"reasoningEffort":"none","temperature":0.3}}'
```

The probe returns `200 {"ok":true}` when the selected provider is configured and
enabled, or `503 {"ok":false,"error":"missing_api_key"}` / `"disabled"`. It checks
configuration only and does not contact the provider. An unsupported configured
provider returns `503 {"error":"invalid_provider"}`.

## Configuration

| Variable | Default / behavior |
| --- | --- |
| `INFERENCE_PROVIDER` | `ollama`; alternatively `gemini` |
| `INFERENCE_FALLBACK_ENABLED` | Enabled when the selected provider has a key; `0`, `false`, or `off` disables it |
| `INFERENCE_CLIENT_DAILY_LIMIT` | 50 successful requests per client token per UTC day |
| `OLLAMA_API_KEY` | Required for Ollama; Gemini keys are never sent to Ollama |
| `OLLAMA_INFERENCE_MODEL` | `gemma4:cloud`, mapped to `gemma4:31b` on the direct cloud API |
| `OLLAMA_REQUESTS_PER_MINUTE` | 20 upstream attempts across clients, including search/continuation calls |
| `OLLAMA_CLIENT_REQUESTS_PER_MINUTE` | 5 explanation attempts per client token |
| `OLLAMA_MAX_CONCURRENT` | 2 active explanations |
| `GEMINI_API_KEY` | Required for Gemini unless legacy `INFERENCE_API_KEY` is set |
| `GEMINI_MODEL` | `gemma-4-31b-it` |

Provider-specific model variables take precedence over `INFERENCE_MODEL`, which
is considered only when `INFERENCE_PROVIDER` is explicitly nonempty. Set
`OLLAMA_INFERENCE_MODEL` to configure the Ollama model; `OLLAMA_MODEL` is not
read here. Legacy Gemini aliases `INFERENCE_API_KEY`,
`GEMINI_FALLBACK_ENABLED`, and `GEMINI_CLIENT_DAILY_LIMIT` remain fallbacks for
their corresponding settings. A generic setting takes precedence when present.
Numeric limits accept positive values, flooring them to integers; invalid values
fall back to defaults.

## Request and response contract

`POST /api/inference` requires an allowed `Origin` and a nonempty
`X-Inference-Client` header. Allowed origins are localhost/127.0.0.1, the request
host over HTTPS, and Vercel's `VERCEL_URL`, `VERCEL_BRANCH_URL`, and
`VERCEL_PROJECT_PRODUCTION_URL` values. `OPTIONS` supports the existing CORS
preflight contract. The future authenticated frontend proxies are not implemented
in this extraction; server-to-server calls currently still require `Origin`.

```json
{
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

The conversation must start and end with a usable user turn (excluding system
messages). Text content may also be an array of `{ "type": "text", "text": "..." }`
and `{ "type": "image", "url": "https://..." }` or
`{ "type": "image", "mediaType": "image/png", "data": "base64..." }` parts.
Supported image types are JPEG, PNG, WebP, and GIF. Request body and prompt caps
remain 100,000 and 60,000 respectively using the existing length checks; fetched
images are capped at 4,000,000 bytes each. Image fetches reject private/local
destinations and credentials, validate all DNS answers and redirect hops, and pin
the connection IP while retaining the original Host/TLS SNI. At most five
redirects are followed. Failed image downloads become text URLs.

`webSearch` defaults to enabled unless explicitly `false`. Ollama calls
`https://ollama.com/api` directly and may run up to two `web_search` tools and
three chat calls. Gemini uses Google Search grounding and retries capacity errors
once. Both append source links when needed. `reasoningEffort` accepts `auto`,
`none`, `low`, `medium`, and `high`; it maps to each provider's existing thinking
settings. `temperature` accepts numbers from 0 through 2. Provider/model/key/base
URL selection belongs to server configuration, not request fields.

Successful requests return `200 {"content":"...","model":"..."}`. Errors retain
their existing JSON shape and codes:

| HTTP status | Error codes |
| --- | --- |
| 400 | `invalid_json`, `invalid_request`, `missing_client_token`, Gemini `provider_error` (with upstream `http` and optional `providerStatus`) |
| 403 | `forbidden_origin` |
| 405 | `method_not_allowed` |
| 413 | `payload_too_large` |
| 429 | `client_limit`, `rate_limited`, `quota_exhausted`, `search_quota` |
| 502 | `provider_error`, Ollama `model_unavailable`, Ollama `provider_auth` |
| 503 | `missing_api_key`, `disabled`, `invalid_provider`, `provider_busy` |

Ollama rate limits/cooldowns retain `Retry-After`; Gemini quota classification
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
provider replies, and provider/model/auth failures. Live provider generation is
a separate, credentialed check.
