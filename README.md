# IPA inference fallback API

A fallback inference endpoint for apps using the Inference Provider API (IPA).
When no browser extension providing the Inference Provider API is detected,
an app can use this endpoint for hosted inference. The app handles provider
detection and decides when to use the fallback.

The endpoint runs as a standalone Node ESM `/api/inference` function.
Callers can select Ollama Cloud, Gemini, or the Replit gateway per request;
Ollama Cloud is the default.
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
loader fills missing `DEFAULT_INFERENCE_PROVIDER`, `INFERENCE_`, `OLLAMA_`, and
`GEMINI_` and `REPLIT_` values from `.env.local` then `.env`, without overriding existing
nonempty environment values.

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
  --data '{"messages":[{"role":"user","content":"Explain DNS in one sentence."}],"webSearch":false,"options":{"reasoningEffort":"none","temperature":0.3}}'
```

The probe returns `200 {"ok":true}` when the selected provider is configured and
enabled, or `503 {"ok":false,"error":"missing_api_key"}` / `"disabled"`. It checks
configuration only and does not contact the provider. Use
`GET /api/inference?provider=gemini` to probe a specific provider. An unsupported
configured default returns `503 {"error":"invalid_provider"}`; an invalid caller
selection returns `400 {"error":"invalid_provider"}`.

## Smoke testing

Add provider keys to `.env.local`, then run:

```sh
npm run smoke -- --provider ollama
npm run smoke -- --provider gemini
npm run smoke -- --provider replit
npm run smoke
```

The script starts a temporary local HTTP server around the actual inference
handler, probes configuration, and sends a short generation request to the chosen
provider. No Vercel login or running development server is needed. Without
`--provider`, it uses `DEFAULT_INFERENCE_PROVIDER` (Ollama when unset).
Keys and model settings load from `.env.local` using the same rules as the API.
Override the selected provider's model for a single run with `--model`:

```sh
npm run smoke -- --provider ollama --model gemma4:cloud
npm run smoke -- --provider gemini --model gemma-4-31b-it
npm run smoke -- --provider replit --model google/gemma-4-26b-a4b-it
```

The override applies only to the smoke-test process and leaves `.env.local`
unchanged. Omit `--provider` to override the default provider's model.
Web search is off and reasoning effort is `none`. This makes a real provider API
call and may consume quota or incur a small charge.

The script prints the model, response, and elapsed time, then shuts down its
temporary server. It exits nonzero for configuration, connection, or provider
failures and malformed responses. API keys are never printed or sent to the
endpoint by the script; they stay in the server's provider requests.
Its timeout is the locally configured request budget plus 30 seconds (150 seconds
by default).

To test a running Vercel development server or deployed endpoint instead:

```sh
npm run smoke -- --provider gemini --url http://localhost:3000/api/inference
npm run smoke -- --provider ollama --url https://your-service.vercel.app/api/inference
```

With `--url`, the target server supplies its own provider keys and model settings.
`--model` cannot be combined with `--url`. Omit `--provider` to test that server's
default. Set `INFERENCE_REQUEST_TIMEOUT_MS` locally to match the target's request
budget when testing a server with a different timeout. Use
`npm run smoke -- --help` for usage.

## Configuration

| Variable | Default / behavior |
| --- | --- |
| `DEFAULT_INFERENCE_PROVIDER` | `ollama`, `gemini`, or `replit`; defaults to `ollama`; used when the request omits `provider` |
| `INFERENCE_FALLBACK_ENABLED` | Enabled when the selected provider has a key; `0`, `false`, or `off` disables it |
| `INFERENCE_CLIENT_DAILY_LIMIT` | 50 successful requests per client token per UTC day |
| `INFERENCE_REQUEST_TIMEOUT_MS` | 120,000 ms total per request; positive integer, capped at 170,000 ms; invalid values use the default |
| `OLLAMA_API_KEY` | Required for Ollama; Gemini keys are never sent to Ollama |
| `OLLAMA_MODEL` | `gemma4:cloud`, mapped to `gemma4:31b` on the direct cloud API |
| `OLLAMA_REQUESTS_PER_MINUTE` | 20 upstream attempts across clients, including search/continuation calls |
| `OLLAMA_CLIENT_REQUESTS_PER_MINUTE` | 5 explanation attempts per client token |
| `OLLAMA_MAX_CONCURRENT` | 2 active explanations |
| `GEMINI_API_KEY` | Required for Gemini |
| `GEMINI_MODEL` | `gemma-4-31b-it` |
| `REPLIT_API_KEY` | The Replit gateway's bearer token; required for Replit |
| `REPLIT_MODEL` | `google/gemma-4-26b-a4b-it` |
| `REPLIT_MAX_TOKENS` | Optional total completion-token cap, including reasoning; unset uses gateway/model defaults |

Set `OLLAMA_MODEL`, `GEMINI_MODEL`, and `REPLIT_MODEL` to configure each provider's model. When
unset, each provider uses its built-in default listed above.
Replit leaves the output budget to the gateway unless `REPLIT_MAX_TOKENS` is set.
Reasoning models need room for both reasoning and the final answer; a small total
cap can exhaust the budget before visible answer text is produced. All calls
remain subject to the configured per-request total timeout (120 seconds by default).
Numeric limits accept positive values, flooring them to integers; invalid values
fall back to defaults.

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
settings. `temperature` accepts numbers from 0 through 2. Callers select only the
provider through the query parameter; models, credentials, and provider base URLs
remain under server control.

Successful requests return `200 {"content":"...","model":"..."}`. Errors retain
their existing JSON shape and codes:

| HTTP status | Error codes |
| --- | --- |
| 400 | `invalid_provider` (caller selection), `invalid_json`, `invalid_request`, `missing_client_token`, Gemini `provider_error` (with upstream `http` and optional `providerStatus`) |
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
