# Deployment, integration, and rollback

The shared service lives in the `samsamskies-projects/ipa-inference-fallback-api`
Vercel project. Its stable production base URL is
`https://ipa-inference-fallback-api.vercel.app`; append `/api/inference` or
`/api/providers`. There is no homepage. Both routes require app authentication.
The empty `public/` directory is the static output directory; application source
under `lib/` is packaged for functions without being served as static files.

## Ownership and configuration

| Location | Settings and responsibility |
| --- | --- |
| Shared Vercel project | `TRENDINGNOSTR_APP_SECRET`, `ADVANCEDNOSTRSEARCH_APP_SECRET`, global enable switch, timeout, admission rule, and provider limits |
| Each app's backend | Its matching app secret, its own provider keys, explicit provider/model selection, public-proxy abuse controls |
| Browser | IPA-first routing, consent, prompts, language, images, and a client token; credentials stay in the backend |
| Provider account/project | Model access, quota, billing limits/alerts, and key creation/revocation |

Store secrets as **sensitive** Vercel environment variables, scoped separately to
Production and Preview as appropriate. Never use a `VITE_`, `NEXT_PUBLIC_`, or
other browser-exposed prefix. `.env.local`, `.env`, and `.vercel` stay ignored;
`.vercelignore` also excludes local environment files from CLI uploads.
Do not put provider keys or the smoke caller key on the shared deployment.

The app proxies use these backend-only settings:

| App-backend variable | Value / use |
| --- | --- |
| `SHARED_INFERENCE_URL` | `https://ipa-inference-fallback-api.vercel.app/api/inference` |
| `SHARED_INFERENCE_APP_SECRET` | The secret matching that app's registry entry |
| `SHARED_INFERENCE_OLLAMA_API_KEY` | That app's distinct Ollama credential |
| `SHARED_INFERENCE_GEMINI_API_KEY` | That app's distinct Gemini credential |
| `SHARED_INFERENCE_REPLIT_API_KEY` | The same gateway key in both app backends; the gateway currently accepts one key |

These names are an integration convention for the app proxies, not settings read
by this service. Choose provider/model in backend code or backend-only settings;
the shared service has no default provider or default model. Ollama and Gemini
use separate keys per app for rotation and attribution. Distinct keys can still
share a billing account and quota. Replit intentionally uses the same gateway
key in both app backends because the gateway currently accepts a single key.
App authentication secrets and per-app service admission buckets remain separate.
Rotate the Replit gateway key in both backends together.

## Local development with independent proxies

Use Node.js 24 and install the pinned CLI with `npm ci`. In this repository:

```sh
cp .env.example .env.local
npm run --silent generate:app-secret
# Set each app's own secret in .env.local; run the generator once per app.
npx vercel login
npx vercel link --project ipa-inference-fallback-api --scope samsamskies-projects
npm run dev:vercel
```

The service listens on **3001**. Append
`-- --listen 3002` to select another port. Run each app's own dev/proxy server in
a separate terminal on a free port (for example TrendingNostr on 3000 and
AdvancedNostrSearch on 3002). In each app's ignored backend environment, set
`SHARED_INFERENCE_URL=http://127.0.0.1:3001/api/inference`, its matching local app
secret, and that app's provider keys. The browser calls its own proxy; only the
proxy calls port 3001.
AdvancedNostrSearch retains its Vite development middleware; run it with that
app's `npm run dev`. Local development skips the managed admission check, so
validate that check on a deployment too.
Do not add a `dev` script that runs `vercel dev`: the pinned CLI detects that as
a recursive development command and refuses to start.

The proxy must overwrite browser-supplied identity/credential headers, provider,
and model; forward only validated prompt/image/options data and the client token.
Set `redirect: "error"`, bound body size and request duration, and preserve shared
HTTP status and `Retry-After`. Proxy `/api/providers` with app authentication only.
See the [request contract](../README.md#server-to-server-requests).

## Deploying a release

1. Verify the account/project with `npx vercel whoami` and
   `npx vercel project inspect ipa-inference-fallback-api`. Use the Other
   framework with no frontend build/dev command. `package.json` pins Node 24;
   keep Vercel's system environment variables exposed.
2. Configure the two app secrets. For a new value, pipe it from a secret manager
   to `npx vercel env add NAME production --sensitive`; repeat for Preview when
   needed. Avoid secret CLI arguments or command history. Keep the shared service
   and corresponding app backend in sync.
3. Publish the `inference-app` fixed-window WAF rule and configure
   `INFERENCE_RATE_LIMIT_WINDOW_SECONDS` to its window. The initial deployment
   template specifies **10 admitted requests/app/60 seconds**, counted within a region. Read
   [production controls](production-controls.md) before changing the threshold.
   The [checked-in rule](../config/inference-app-rule.json) buckets by the SDK's
   `x-vercel-rate-limit-key` header; an empty key list would group all apps.
   Use the pinned CLI's stage/review/publish workflow from the production controls
   runbook. Retain the explicit SDK header key and recheck both app buckets
   after changing the rule; empty keys or IP-only counting can pool the apps.
4. Enable [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
   and expose its `VERCEL_AUTOMATION_BYPASS_SECRET` to deployments. The firewall
   SDK calls the protected deployment hostname even when the production alias
   is public. Keep Vercel Authentication on preview/deployment URLs. The stable
   production alias must be reachable by the app backends without a Vercel login.
5. Run `npm test`, then `npm run deploy:preview`. **Vercel can make the first
   deployment of a new project production automatically.** For an established
   project, validate the preview before `npm run deploy:production`.
6. Run the matrix below against the deployed URL with each app's credentials.
   Record the deployment URL/ID, source commit, runtime, WAF version/threshold,
   model IDs, results, and rollback target. Recheck after promoting to production.
   A GET probe does not exercise the WAF or provider credentials.

Environment changes apply to new deployments; redeploy after changing secrets,
runtime configuration, or automation bypass settings. A rollback restores a
deployment's configuration snapshot, so verify compatibility with current app
secrets and never restore a revoked secret accidentally.

## Deployment smoke matrix

The CLI reads the chosen app's `*_APP_SECRET` from the caller environment or
ignored `.env.local`. Every run prompts for that app/provider's key with hidden
input; enter or paste the key and press Enter. Ctrl+C cancels. The smoke command
requires an interactive terminal and does not read provider keys from flags,
environment variables, or piped input. For protected deployment URLs also set
`VERCEL_AUTOMATION_BYPASS_SECRET` in the caller environment. Credentials are HTTP
headers, never CLI arguments. These tests make real provider calls and use quota.

```sh
npm run smoke -- --app trendingnostr --provider replit --model google/gemma-4-26b-a4b-it --checks --url https://ipa-inference-fallback-api.vercel.app/api/inference
npm run smoke -- --app advancednostrsearch --provider replit --model google/gemma-4-26b-a4b-it --checks --url https://ipa-inference-fallback-api.vercel.app/api/inference
# Check features separately for the selected app/provider/model:
npm run smoke -- --app trendingnostr --provider replit --model google/gemma-4-26b-a4b-it --vision --url https://ipa-inference-fallback-api.vercel.app/api/inference
npm run smoke -- --app trendingnostr --provider replit --model google/gemma-4-26b-a4b-it --web-search --url https://ipa-inference-fallback-api.vercel.app/api/inference
```

`--checks` verifies authenticated discovery, missing/incorrect app auth, missing
provider keys, missing/repeated provider selectors, malformed JSON, missing
models, GET configuration, and POST generation. It fails if a response contains
the supplied app/provider/bypass credentials or the wrong provider. Negative
checks stop before admission/provider work. `--vision` sends a 64×64 red PNG,
requires vision, and checks the reported color. `--web-search` requires search
and an HTTPS source URL. A cited URL alone cannot prove an upstream search ran;
use provider usage evidence when verifying search billing/execution.

Test invalid upstream credentials/models separately and expect a sanitized
provider error (see the [error table](../README.md#request-and-response-contract)).
Validate deployed 429/503 and app-bucket isolation using dummy provider keys as
described in [production controls](production-controls.md#validation-and-incident-response).
Do not load-test a paid model to test the admission threshold.

## Rollback

Record a known-good deployment URL and source commit before each release.

To roll back **the shared service**, run
`npx vercel rollback <KNOWN_GOOD_SHARED_DEPLOYMENT_URL>` from this repository,
then verify both apps' availability and normal inference. A deployment rollback
restores its configuration snapshot; confirm its app secrets remain valid.

To roll back **one app**, use that app's known-good deployment and verify its
IPA/fallback flow, model, and errors. Its retained direct-provider switch can
also be used while that implementation and its credentials still exist. Follow
the app's own runbook; leave the other app on its working deployment. Never
revoke credentials that a retained rollback or another consumer still needs.
TrendingNostr's spam detection may use an Ollama key independently of inference.

For emergency shutdown, follow the
[kill-switch instructions](production-controls.md#validation-and-incident-response).

## Operations, rotation, and extensions

Use Vercel runtime/traffic/firewall views and provider usage dashboards to track
status counts, latency/timeouts, 429s, `rate_limit_unavailable`, provider errors,
model usage, and cost per app/provider. Keep the deployment ID and approximate
time for correlation. Do not log bodies, complete headers, credential values, or
raw upstream error objects. Application logs contain only sanitized status/error
metadata; responses redact provider-key echoes. Check platform log integrations
for header capture/redaction too.

Admission counts attempts, not successes. Images, reasoning, retries, and search
can multiply cost per request. In-memory daily/concurrency controls reset across
instances; there is no exact global daily or monetary cap. Configure account
spending controls and a shutdown threshold if needed using the optional
hardening guidance in the production controls runbook.

Rotate a provider key in its owning app backend, redeploy that app, smoke-test,
then revoke the old key once rollback no longer needs it. Rotate one app secret
at a time: pause that app's hosted inference, deploy the new shared secret and
matching backend secret, verify authentication/generation, then resume.
Only one app secret is accepted at a time; plan for that transition. Rotating the
automation bypass requires redeploying the shared service and updating private
smoke callers; recheck POST admission on protected deployment URLs.

To change an app's provider/model, change the relevant backend's selection,
verify discovery/model capabilities and the new app-owned key, deploy just that
app, and run the matrix. No shared `DEFAULT_INFERENCE_PROVIDER` is supported.
Onboard an app via the [application registry steps](../README.md#application-registry).
Add a provider with the [adapter contract](../README.md#provider-adapters), register
its capabilities/model overrides, add contract/error tests, explicitly allow it
per app, and verify credential redaction and live feature behavior before rollout.

Gemini search must remain gated in each app until the chosen model/key passes
live search validation. Provider discovery metadata alone does not establish
upstream feature availability.
