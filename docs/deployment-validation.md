# Deployment validation — November 4, 2026

## Current state

- Project: `samsamskies-projects/ipa-inference-fallback-api`.
- Stable production base: `https://ipa-inference-fallback-api.vercel.app`.
- Runtime pinned to Node 24; static output restricted to the empty `public/` directory.
- Implementation PRs [#12](https://github.com/SamSamskies/ipa-inference-fallback-api/pull/12)
  and [#13](https://github.com/SamSamskies/ipa-inference-fallback-api/pull/13) are
  merged. The November 4 post-merge check found production READY on Node 24 at
  source `edfc9039c9ecb29c98983a31b7b50f188b3e8f66`; its authenticated probe returned 200.
- `INFERENCE_FALLBACK_ENABLED=true` in Production and Preview after the deployed
  app-isolation test passed. App authentication still rejects unauthenticated
  requests. Local development also supports its own enable switch.
- Shared project has distinct app secrets and the server-side automation bypass,
  with system environment variables exposed. It contains no provider API keys.
- Both app projects have staged `SHARED_INFERENCE_URL`,
  `SHARED_INFERENCE_APP_SECRET`, `SHARED_INFERENCE_OLLAMA_API_KEY`, and
  `SHARED_INFERENCE_GEMINI_API_KEY` in Production/Preview. Both app backends also
  have `SHARED_INFERENCE_REPLIT_API_KEY` set to the same gateway key, matching the
  gateway's single-key authentication. Both migrated proxies now use these
  backend-only settings; both apps use shared Replit inference in production,
  as confirmed by the owner on November 4, 2026.
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
| Full test suite using the explicit Node 24.12.0 binary | 183 passed |
| Focused admission, client-quota, and Ollama-limit tests after merge | 27 passed |
| Hidden provider-key prompt | Terminal entry produced no key echo; editing, cancellation, EOF, input validation, and terminal-mode restoration passed |
| `vercel dev --listen 3001` | Authenticated discovery and configuration probe passed |
| Stable production alias without automation bypass | Authenticated probe passed after re-enabling and after merge; unauthenticated discovery returned JSON 401 |
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

After re-enabling production, both apps passed Ollama/Gemini text generation and
Ollama passed vision/search again. The post-merge check confirmed the merged
production deployment was READY and its authenticated probe passed. A response
containing a URL does not independently prove upstream search execution or charges.

## Completed app migrations

- [TrendingNostr #110](https://github.com/SamSamskies/trendingnostr/issues/110)
  is closed. [PR #111](https://github.com/SamSamskies/trendingnostr/pull/111)
  merged as `d68c85cb7cdb939a9db0f3d0372da7b065d7986e`. Its migration record
  reports Ready production deployment `dpl_9rcKvd5vKQ3k8JDZy67bc1eA6nNt`,
  successful production GET and a search-enabled POST with a full-size note image.
  Live preview text, image-color, and search-enabled/citation checks passed;
  79 automated tests and the production build passed.
- [AdvancedNostrSearch #54](https://github.com/SamSamskies/advancednostrsearch/issues/54)
  is closed. [PR #55](https://github.com/SamSamskies/advancednostrsearch/pull/55)
  merged as `2b8f8074b347bc336dd97d03ae09594e0fbecabc`. Its
  [rollout record](https://github.com/SamSamskies/advancednostrsearch/blob/main/docs/shared-inference-rollout.md)
  records live protected-preview text, follow-up, image-color, search-enabled
  citations, a realistic 3.2 MB JPEG, and direct Ollama rollback checks;
  92 automated tests and the production build passed. The owner subsequently
  confirmed production activation in this epic closeout. A production deployment
  ID and a new production smoke result were not independently collected here.
- Both apps select shared Replit model `google/gemma-4-26b-a4b-it` and retain
  separate app identities/secrets and service admission buckets. The gateway
  accepts one intentionally shared key. Its JSON body limit was raised from
  1 MB to 32 MB by the owner, addressing full-size image forwarding failures.
- IPA-first routing, hosted consent, images, follow-ups, and independent direct
  rollback remain in the apps. Absent reasoning uses provider defaults, including
  AdvancedNostrSearch's intentional removal of its former forced `none` default.
- Search-enabled responses and citations passed; private gateway usage was not
  inspected to independently establish actual search execution or charges.

These are existing migration records and the owner's production confirmation;
this documentation closeout did not rerun deployments, provider calls, or tests.

## Accepted scope and issue #6 follow-up

The November 4 read-only configuration check found the shared-service rule active
at version 5, with no pending draft. Neither TrendingNostr nor AdvancedNostrSearch
had a published or draft project firewall configuration. Their public-proxy WAF
rules were not configured or validated by that check. Provider spending/credit
settings remain unverified. The owner's later rollout decision accepts development
rate-limit testing and does not require production public-proxy WAF/rate-limit
testing or spending verification to complete these migrations or the epic.
This is not a claim that those controls were verified in production.
The owner subsequently deferred this extra hardening given low traffic and usage
well below existing limits; issue #6 is closed as not planned. Reopen it if abuse,
unexpected costs, sustained admission pressure, or increased usage warrants it.
Existing shared admission remains in place. Exact global quotas and persistent
accounting remain outside the agreed first pass.

## Resolution and separate follow-ups

The admission blocker is resolved. Earlier full-configuration PUT requests
returned `402 payment_required`, but the current CLI's staged update and publish
workflow accepted the explicit SDK header rule. Live tests established separate
counters on this account. The failed PUT calls did not prove that an upgrade was
needed. Follow the [working CLI procedure](production-controls.md#shared-service-admission-rule).

1. **Gemini search — [#15](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/15):** establish a model/key combination that supports live search
   and passes `--web-search`. Static discovery metadata does not prove support.
   This remains unvalidated and does not block working text/vision requests;
   keep app-proxy Gemini search gated until validated. Both production apps
   currently select Replit.
2. **Deferred production controls — [#6](https://github.com/SamSamskies/ipa-inference-fallback-api/issues/6), closed as not planned:** revisit public-proxy rules and
   provider-account spending verification if usage, costs, or abuse warrants it.
3. **App-owned cleanup — [TrendingNostr #112](https://github.com/SamSamskies/trendingnostr/issues/112) and [AdvancedNostrSearch #56](https://github.com/SamSamskies/advancednostrsearch/issues/56):** retire duplicated direct-provider code and unused
   keys only after independent rollback no longer needs them. Preserve active
   credentials and check spam detection and other consumers before revocation.

The deployment/integration work in #7 and migration epic #1 are complete under
the accepted scope. Keep the
[independent rollback procedure](deployment.md#staged-rollout-and-independent-rollback)
available during observation. Admission continues to use Vercel's managed
counters; no datastore was introduced.
