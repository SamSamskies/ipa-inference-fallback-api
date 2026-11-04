# Deployment, integration, and rollback

The shared service lives in the `samsamskies-projects/ipa-inference-fallback-api`
Vercel project. Its stable production base URL is
`https://ipa-inference-fallback-api.vercel.app`; append `/api/inference` or
`/api/providers`. There is no homepage. Both routes require app authentication.
The empty `public/` directory is the static output directory; application source
under `lib/` is packaged for functions without being served as static files.

Inference is enabled with independently verified app buckets. The rule was
published through the pinned Vercel CLI's staged configuration workflow, without
a plan change or datastore. See the [validation record](deployment-validation.md)
for tested features and remaining rollout checks. Neither frontend has been migrated.

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

The app migrations can adopt these staged backend-only settings without changing
the existing direct-provider route's environment variables:

| App-backend variable | Value / use |
| --- | --- |
| `SHARED_INFERENCE_URL` | `https://ipa-inference-fallback-api.vercel.app/api/inference` |
| `SHARED_INFERENCE_APP_SECRET` | The secret matching that app's registry entry |
| `SHARED_INFERENCE_OLLAMA_API_KEY` | That app's distinct Ollama credential |
| `SHARED_INFERENCE_GEMINI_API_KEY` | That app's distinct Gemini credential |

These names are an integration convention for the app proxies, not settings read
by this service. Choose provider/model in backend code or backend-only settings;
the shared service has no default provider or default model. Keep separate keys
per app/provider for rotation and attribution. Distinct keys can still share a
billing account and quota. Replit requires its own app credentials before an
isolated Replit rollout; do not substitute one app's key for another's.

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
proxy calls port 3001. App migrations must implement this forwarding before
these settings take effect. Local Vercel development skips the managed admission
check, so validate that check on a deployment too.
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
   runbook. The full-configuration PUT API returned `402 payment_required`, while
   the CLI workflow successfully published the SDK header rule on this account.
   Both an empty key list and IP-only counting failed live app isolation; retain
   the explicit SDK header key and recheck both buckets after changing the rule.
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

The CLI reads the chosen app's `*_APP_SECRET` and `INFERENCE_SMOKE_PROVIDER_KEY`
from the caller environment or ignored `.env.local`. Set the latter to that
app/provider's key before each command. For protected deployment URLs also set
`VERCEL_AUTOMATION_BYPASS_SECRET` in the caller environment. Credentials are
headers, never CLI arguments. These tests make real provider calls and use quota.

```sh
npm run smoke -- --app trendingnostr --provider ollama --model gemma4:cloud --checks --url https://ipa-inference-fallback-api.vercel.app/api/inference
npm run smoke -- --app advancednostrsearch --provider gemini --model gemma-4-31b-it --checks --url https://ipa-inference-fallback-api.vercel.app/api/inference
# Repeat both providers for both apps, then test each feature separately:
npm run smoke -- --app trendingnostr --provider ollama --model gemma4:cloud --vision --url https://ipa-inference-fallback-api.vercel.app/api/inference
npm run smoke -- --app trendingnostr --provider ollama --model gemma4:cloud --web-search --url https://ipa-inference-fallback-api.vercel.app/api/inference
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
described in [production controls](production-controls.md#operations-and-rollout-validation).
Do not load-test a paid model to test the admission threshold.

## Staged rollout and independent rollback

1. **Deploy and verify the shared API.** Record its production deployment and
   source commit. Provision app credentials and verify public-proxy WAF controls
   and provider spending safeguards before switching public traffic.
2. **Migrate TrendingNostr first** in its own PR/deployment. Keep IPA-first routing,
   prompts, consent, browser behavior, and its old direct-provider route/code
   available. Add a backend routing switch (for example
   `SHARED_INFERENCE_ENABLED`) so a deployment can choose the shared proxy or old
   implementation. Record the pre-migration app commit/deployment and existing
   direct-provider environment settings. Test discovery, generation, images,
   search, auth failures, and 429/503 propagation through the public proxy.
3. **Observe TrendingNostr** before migrating AdvancedNostrSearch independently.
   Compare success/error rates and latency with its previous deployment; inspect
   provider usage/costs and admission failures. Keep both paths and credentials
   valid through the agreed observation period. Migrate AdvancedNostrSearch in
   its own PR with the same checks and its own rollback target.
4. **Remove duplicated code and old keys last**, after both apps have passed
   their observation periods and rollback no longer depends on those keys.
   Inspect other consumers before revocation: TrendingNostr's spam detection
   may share its existing Ollama credential, and its `OLLAMA_MODEL` setting is
   distinct from inference's `OLLAMA_INFERENCE_MODEL`. Revoke unused provider
   credentials at the provider, remove obsolete Vercel settings, and redeploy
   affected apps. Remove old routes in separate cleanup commits.

To roll back **one frontend**, disable its shared-routing switch and redeploy
that app, or run `npx vercel rollback <PRE_MIGRATION_DEPLOYMENT_URL>` from that
app's linked project. Verify its IPA/fallback flow, model, and errors. Leave the
other frontend on its working deployment. Retain the original app commits and
deployment URLs until the observation period ends; rollback depends on their
credentials remaining valid.

To roll back **the shared service**, use
`npx vercel rollback <KNOWN_GOOD_SHARED_DEPLOYMENT_URL>` from this repository and
recheck both apps. For the initial release there is no previous shared release:
return migrated apps to their retained direct routes. For emergency shutdown,
follow the [kill-switch instructions](production-controls.md#operations-and-rollout-validation).

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
spending controls and a shutdown threshold using the production controls runbook.

Rotate a provider key in its owning app backend, redeploy that app, smoke-test,
then revoke the old key once rollback no longer needs it. Rotate one app secret
at a time: pause or return that app to its direct route, deploy the new shared
secret and matching backend secret, verify authentication/generation, then resume.
Only one app secret is accepted at a time; plan for that transition. Rotating the
automation bypass requires redeploying the shared service and updating private
smoke callers; recheck POST admission on protected deployment URLs.

To change the default provider/model, change the relevant app backend's selection,
verify discovery/model capabilities and the new app-owned key, deploy just that
app, and run the matrix. No shared `DEFAULT_INFERENCE_PROVIDER` is supported.
Onboard an app via the [application registry steps](../README.md#application-registry).
Add a provider with the [adapter contract](../README.md#provider-adapters), register
its capabilities/model overrides, add contract/error tests, explicitly allow it
per app, and verify credential redaction and live feature behavior before rollout.
