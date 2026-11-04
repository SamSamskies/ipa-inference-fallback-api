# Deployment validation — November 4, 2026

## Current state

- Project: `samsamskies-projects/ipa-inference-fallback-api`.
- Stable production base: `https://ipa-inference-fallback-api.vercel.app`.
- Runtime pinned to Node 24; static output restricted to the empty `public/` directory.
- `INFERENCE_FALLBACK_ENABLED=false` in Production and Preview. Authenticated
  requests return `503 disabled` on the final deployment. App authentication
  still rejects unauthenticated requests.
- Shared project has distinct app secrets and the server-side automation bypass,
  with system environment variables exposed. It contains no provider API keys.
- Both app projects have staged `SHARED_INFERENCE_URL`,
  `SHARED_INFERENCE_APP_SECRET`, `SHARED_INFERENCE_OLLAMA_API_KEY`, and
  `SHARED_INFERENCE_GEMINI_API_KEY` in Production/Preview. Existing routes do not
  read these names. Neither frontend was migrated or redeployed.
- Firewall remains enabled. The pooled test rule was removed (configuration
  version 2); a valid inference request on an older, enabled deployment now
  fails closed with `503 rate_limit_unavailable` before upstream work.

## Checks performed

| Check | Result |
| --- | --- |
| Full Node 24 test suite | 179 passed |
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
| Test WAF threshold | Returned `429 rate_limited` with `Retry-After: 60` after ten admitted requests |
| Test WAF app isolation | Failed: empty counting keys pooled the two apps. Rule removed; no isolated production limit is claimed |
| Response credential checks | Selected app/provider/bypass credentials absent from successful probes, discovery, negative responses, and generation responses in `--checks` runs |
| Static output on corrected Node 24 preview | `/lib/app-auth.js`, `/.env.local`, and `/package.json` returned 404; API routes remained available |

Provider generation/feature checks ran before disabling inference. The final
release retains the same API/adapters; its runtime/static output and disabled
state are checked separately. A response containing a URL does not independently
prove upstream search execution or charges.

## Remaining release gates

1. **App-keyed admission:** the correct
   [`inference-app` template](../config/inference-app-rule.json) requires a bucket
   based on the SDK's `x-vercel-rate-limit-key`. Vercel's API rejected both that
   header dimension and a nonempty IP dimension with `402 payment_required`
   (`Rate limiting is not available for this plan`). No plan upgrade or billing
   change was made. Resolve the platform entitlement/configuration or explicitly
   choose another shared-counter implementation. Do not use empty counting keys:
   they were accepted but failed the deployed app-isolation test.
2. **Gemini search:** establish a model/key combination that supports live search
   and passes `--web-search`. Static discovery metadata does not prove support.
3. **Replit isolation, if rolling out Replit:** the available local Replit keys
   are shared between the two apps. Distinct app keys were not provisioned or
   staged. Ollama/Gemini app keys are distinct and passed live generation.
4. **Before public migration:** verify each app's public-proxy WAF controls and
   provider-account spending safeguards. Those external controls were not
   changed or certified by this deployment.

After resolving the gates, publish the app-keyed rule, verify both app buckets
and failure handling, enable the service in a new deployment, rerun the full live
matrix, then follow the [staged rollout](deployment.md#staged-rollout-and-independent-rollback).
Issue #7 remains open until the deployment and feature gates pass.
