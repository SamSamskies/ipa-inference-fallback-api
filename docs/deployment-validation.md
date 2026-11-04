# Deployment validation — November 4, 2026

## Current state

- Project: `samsamskies-projects/ipa-inference-fallback-api`.
- Stable production base: `https://ipa-inference-fallback-api.vercel.app`.
- Runtime pinned to Node 24; static output restricted to the empty `public/` directory.
- `INFERENCE_FALLBACK_ENABLED=true` in Production and Preview after the deployed
  app-isolation test passed. App authentication still rejects unauthenticated
  requests. Local development also supports its own enable switch.
- Shared project has distinct app secrets and the server-side automation bypass,
  with system environment variables exposed. It contains no provider API keys.
- Both app projects have staged `SHARED_INFERENCE_URL`,
  `SHARED_INFERENCE_APP_SECRET`, `SHARED_INFERENCE_OLLAMA_API_KEY`, and
  `SHARED_INFERENCE_GEMINI_API_KEY` in Production/Preview. Existing routes do not
  read these names. Neither frontend was migrated or redeployed.
- Firewall remains enabled. Active configuration version **5** has the
  `inference-app` SDK rule: **10 admitted requests per authenticated app per 60
  seconds**, fixed window, counting by `header:x-vercel-rate-limit-key`.
  Neither browser client tokens nor provider selection create new app buckets.
- The pinned Vercel CLI is **65.11.0**. Its stage/publish workflow provisioned the
  working rule on the existing Hobby account. No plan/billing change or datastore
  was needed. The SDK remains pinned at 1.2.6.

## Checks performed

| Check | Result |
| --- | --- |
| Full test suite using the explicit Node 24.12.0 binary | 179 passed |
| `vercel dev --listen 3001` | Authenticated discovery and configuration probe passed |
| Stable production alias without automation bypass | App-authenticated probe succeeded before disable; unauthenticated discovery returned JSON 401 |
| Both apps × Ollama/Gemini | GET probe, discovery, negative checks, and real POST generation passed with separate app/provider credentials |
| Provider/model selection | Ollama `gemma4:cloud` returned native `gemma4:31b`; Gemini `gemma-4-31b-it` returned the selected model |
| Auth and request errors | Missing/wrong app auth, missing keys, missing/duplicate provider selector, malformed JSON, and missing models returned expected sanitized errors |
| Ollama vision | Identified the inline red square |
| Gemini vision (`gemma-4-31b-it`) | Identified the inline red square |
| Ollama search | Returned official Vercel documentation URLs and source links |
| Gemini search (`gemma-4-31b-it`) | Failed with sanitized `503 provider_busy`; not validated |
| Alternate Gemini search (`gemini-2.5-flash`) | Failed with sanitized `provider_error`, upstream HTTP 404 / `NOT_FOUND`, despite appearing in the model-list response; not validated |
| Invalid provider credentials | Ollama returned `502 provider_auth`; Gemini returned sanitized `400 provider_error` |
| SDK rule with IP-only counting | Published through the current CLI but pooled two synthetic callers; not used for inference |
| SDK rule with explicit SDK header counting | Each synthetic caller independently received two allowed checks, then its own limit |
| Real app admission and isolation on enabled preview | Each app independently received ten admitted requests and its own eleventh-request `429 rate_limited` / `Retry-After: 60`, while providers and client IDs rotated |
| Earlier empty-key rule | Pooled the apps; replaced by the live-verified SDK header rule |
| Missing-rule failure handling | With no rule, an enabled deployment returned `503 rate_limit_unavailable` / `Retry-After: 5` before provider work |
| Response credential checks | Selected app/provider/bypass credentials absent from successful probes, discovery, negative responses, and generation responses in `--checks` runs |
| Static output on corrected Node 24 preview | `/lib/app-auth.js`, `/.env.local`, and `/package.json` returned 404; API routes remained available |

Initial provider generation/feature checks ran before the temporary disable.
The API/adapters are unchanged; generation is rechecked after re-enabling. A
response containing a URL does not independently prove upstream search execution
or charges.

## Resolution and remaining rollout checks

The admission blocker is resolved. Earlier full-configuration PUT requests
returned `402 payment_required`, but the current CLI's staged update and publish
workflow accepted the explicit SDK header rule. Live tests established separate
counters on this account. The failed PUT calls did not prove that an upgrade was
needed. Follow the [working CLI procedure](production-controls.md#shared-service-admission-rule).

1. **Gemini search:** establish a model/key combination that supports live search
   and passes `--web-search`. Static discovery metadata does not prove support.
   This remains unvalidated and does not block working text/vision requests;
   use Ollama for the initially validated search path.
2. **Replit isolation, if rolling out Replit:** the available local Replit keys
   are shared between the two apps. Distinct app keys were not provisioned or
   staged. Ollama/Gemini app keys are distinct and passed live generation.
3. **Before public migration:** verify each app's public-proxy WAF controls and
   provider-account spending safeguards. Those external controls were not
   changed or certified by this deployment.

Follow the [staged rollout](deployment.md#staged-rollout-and-independent-rollback)
when migrating the apps. Issue #7 remains open for its remaining feature and
rollout validation. Admission continues to use Vercel's managed counters; no
datastore was introduced.
