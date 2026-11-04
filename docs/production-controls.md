# Production controls

For configuration, releases, and rollback, see
[deployment and integration](deployment.md). Shared-service admission is enabled
with a published `inference-app` rule: 10 admitted POSTs per app per 60 seconds
within a region.

Public-proxy WAF rules and provider spending verification are optional hardening
for the current low-traffic deployment. Revisit them if abuse, unexpected costs,
sustained admission pressure, or increased usage warrants it. The sections below
provide procedures; they do not certify those optional controls as configured.

This service uses Node serverless functions. Its Maps survive only as long as a
particular process does. They cannot enforce daily quotas, concurrency, request
budgets, or cooldowns across Vercel instances or cold starts.

Shared admission uses Vercel's managed rate limiting without Redis. Vercel's
counters are shared across function instances **within a region**, not globally
exact. A fixed window can admit a burst on either side of
a window boundary. This is traffic control, not exact success accounting or a
dollar spending cap. See [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
and the [Rate Limiting SDK](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk).

## Shared-service admission rule

For a new deployment, configure this rule in the **shared fallback service's
Vercel project** before enabling inference. The existing shared project already
has a published rule:

1. Open **Firewall → Configure → New Rule**.
2. Choose the **`@vercel/firewall`** condition and set the Rate Limit ID to
   **`inference-app`**. Use this condition alone: the SDK receives only a trusted
   deployment host, so filters depending on incoming request headers, paths, or
   browser IPs are not available on this check.
3. Choose **Rate Limit**, **Fixed Window**, and a window of **60 seconds**. Choose
   a request count that fits the app's traffic and provider allowance. For
   example, **10 requests per 60 seconds** gives each app its own bucket; this is
   an illustrative starting value, not a verified capacity recommendation.
4. Select the enforcing **429** action. **Log** only observes traffic and does
   not protect provider usage. Review and publish the rule.
5. Expose Vercel system environment variables. The handler uses `VERCEL`,
   `VERCEL_ENV`, `NODE_ENV`, and the trusted deployment hostname `VERCEL_URL`.
   Keep `NODE_ENV=production` on deployed functions. For protected previews,
   configure [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
   as described in the SDK docs. Keep its secret server-side.
6. Set `INFERENCE_RATE_LIMIT_WINDOW_SECONDS=60`. If the dashboard window changes,
   update this setting too (10–600 seconds). It controls the conservative
   `Retry-After` advice; the **dashboard rule owns the window and request count**.

For CLI-based provisioning, use the checked-in
[`inference-app` rule](../config/inference-app-rule.json). Its rate-limit bucket
keys must be **`["header:x-vercel-rate-limit-key"]`**, the SDK's derived key.
Empty keys or IP-only counting can pool apps instead of giving each one an
independent bucket. Use the pinned Vercel CLI's stage/review/publish workflow and
verify app isolation after changing the rule.

For a new project without an existing admission rule:

```sh
npx vercel firewall rules add --data "$(cat config/inference-app-rule.json)" --project ipa-inference-fallback-api --scope samsamskies-projects --yes
npx vercel firewall rules inspect "Per-app inference admission" --project ipa-inference-fallback-api --scope samsamskies-projects --json
npx vercel firewall publish --project ipa-inference-fallback-api --scope samsamskies-projects
```

For an existing rule, use `firewall rules update "Per-app inference admission"`
with the same `--data` payload and project/scope. Review the staged changes and
publish only the intended rule. In noninteractive use, `publish` returns the
exact confirmation arguments and effects digest; follow the CLI's approval flow.
`--yes` on its own does not approve publishing. Keep production inference disabled
while commissioning a new rule; a protected preview can use an enabled switch.

If updating via individual flags, include `--action rate_limit` along with
`--rate-limit-window`, `--rate-limit-requests`, and `--rate-limit-keys`; an update
containing only the key flag may not apply the intended change.
Do not overwrite unrelated rules through the full-configuration PUT API.
Recheck app isolation after provisioning; a successful publish or GET probe alone
does not establish separate counters.

This consumes one WAF rate-limit rule in the project. Check the linked Vercel
plan limits and usage charges before adding rules or changing thresholds.

Every valid authenticated POST with a client token checks `inference-app` using a
server-derived key containing the app ID. Each app gets a separate bucket,
shared across that app's providers and client IDs. Changing UUIDs, models,
providers, or provider credentials does not create a new app bucket. Backend IPs
are not used as identities. All apps use the same rule's threshold.

The check runs before local daily reservation, image fetching, provider admission,
and generation. It counts requests even when later local quota checks, image
downloads, or generation fail; it is never refunded. One admitted request may
make up to five Ollama upstream calls (chat/search), two Gemini calls, or two
Replit calls. The Replit gateway can also perform search internally. Size the
rule with this amplification and model costs in mind.

App secrets, provider keys, client tokens, prompts, cookies, and original request
headers are not passed to the SDK. The SDK receives only the app bucket key and
the trusted deployment hostname; the incoming Host header never selects the
check's destination.

A limit or firewall block returns `429 rate_limited`. The SDK does not expose
remaining-window retry information, so `Retry-After` is one full configured
window. A missing rule, invalid local configuration, unexpected response,
transport failure, or one-second check timeout returns sanitized
`503 rate_limit_unavailable` with `Retry-After: 5`, without image/provider work.
There is no fail-open fallback on deployed Vercel functions.

Local runs, including `vercel dev` (`VERCEL_ENV=development`), skip this external
check and retain only the existing local controls. Deploying on another host
requires equivalent external admission enforcement. GET probes and discovery
do not consume admission budget or verify that the WAF rule exists: a successful
probe is not proof that production inference will be admitted.

## Optional public-proxy hardening

If public-proxy abuse controls are needed, apply a separate WAF rate-limit rule
in **each calling application's project** to the public POST route that forwards
inference. Use the real route from that
app's code; `/api/inference` here is the shared service route and is not
necessarily the app's proxy route.

- Match the proxy route and POST method; count by client **IP** for an initial
  anonymous-user burst limit. Test shared-IP households and mobile networks to
  choose a usable threshold. Do not use a browser UUID as an abuse-resistant key.
- Use an enforcing 429 action. Add browser bot/challenge controls at the public
  application where appropriate; ensure the application can handle them. Do not
  put an interactive browser challenge on this service's server-to-server path.
- Overwrite browser-supplied app/auth/provider/model headers and configuration in
  the backend. Enforce request size and timeout bounds before forwarding. Preserve
  status and `Retry-After` in the app's response to its browser client.

An IP rule on the shared service sees backend egress traffic and can unfairly
group legitimate users. The authenticated app admission rule provides a separate
aggregate bound; it does not authenticate users or replace public-proxy controls.
IP rotation and traffic across multiple regions can still exceed the intended
per-user rate. Public-proxy configuration is outside this repository.

## Optional provider spending safeguards

When reviewing provider exposure, record each credential's owning account
or project, enabled models, billing arrangement, and the maximum acceptable
exposure. Use separate billing projects/accounts when independent isolation is
needed: separate keys alone can share the same account quota or balance.

- **Ollama Cloud:** inspect the account's included usage, purchased balance, and
  usage settings. Avoid purchasing or enabling additional usage beyond the
  intended budget. Plan limits are based on infrastructure utilization, not
  this service's request counts. Verify the actual account behavior against
  [Ollama's current usage/plan documentation](https://ollama.com/pricing).
- **Gemini:** use an appropriate dedicated Google project, reduce available
  quotas where supported, and configure billing notifications and an operator
  response. An alerts-only Cloud Billing budget **does not cap spending**; do not
  represent it as a hard stop. See [Google's budget documentation](https://docs.cloud.google.com/billing/docs/how-to/budgets).
- **Replit gateway:** verify the gateway's own upstream billing/credit controls,
  models, search charges, and any automatic replenishment with its operator. This
  adapter maps HTTP 402 to `quota_exhausted`; that mapping does not establish that
  the gateway enforces a hard account spending cap. Use the optional
  `REPLIT_MAX_TOKENS` cap after checking the selected models. The gateway currently
  accepts one authentication key, intentionally shared by the two app backends.
  Coordinate gateway-key rotation across both backends. Their separate app
  authentication and service admission buckets still apply.

Request limits do not bound cost precisely: model prices, output tokens,
reasoning, images, search, and retries vary. Verify real controls in provider
consoles when setting up these safeguards. If the account cannot impose
a hard cap, document that remaining exposure and an explicit shutdown threshold.

## Validation and incident response

When changing admission rules, use a controlled preview to verify their behavior:

1. Record project, rule ID, threshold/window, region limitations, and owner in
   the operator's private runbook. Keep credentials out of the record.
2. In a controlled preview, temporarily choose a small threshold and use dummy
   app/provider credentials. Send enough valid POSTs to observe admission and
   `429 rate_limited` with `Retry-After`. Invalid provider credentials can produce
   `provider_auth` while still consuming admission budget. This checks the WAF
   path without successful paid generation.
3. Rotate client UUIDs and provider selections within the same app: the app limit
   must still apply. Test both registered apps to verify separate buckets. Repeat
   across new function instances; within one region, the admission budget should
   remain shared. Mocked unit tests cannot establish Vercel's deployed behavior.
4. Test a missing rule/check failure in preview and confirm
   `503 rate_limit_unavailable` prevents provider calls. Confirm public proxies
   preserve 429/503 and retry headers, then restore the intended thresholds.
5. Run a separately authorized live smoke only when needed to validate actual
   provider access. Watch usage and errors after releases. Do not log prompt
   bodies, full headers, raw upstream errors, or credential material. Configure
   platform redaction for `Authorization`, `X-Inference-Provider-Key`, upstream
   authorization headers, and automation bypass secrets. Avoid secret/header
   matching conditions in firewall rules.

**Emergency stop:** set `INFERENCE_FALLBACK_ENABLED=false` on the shared service
and apply it to all active deployments through the normal Vercel configuration
workflow. Stop the calling proxies or add a platform deny rule if an immediate
traffic block is needed. An environment change is not an instantaneous global
circuit breaker and cannot cancel upstream work already in flight. Revoke
provider credentials in their owning accounts if needed to stop provider access.

**Rotation:** rotate provider keys in their owning app backends. Coordinate app
secret changes between backend and service; the registry accepts one secret per
app. Rotate any exposed automation bypass credential through Vercel. Verify
recovery with sanitized responses, never by printing credentials.

## Accounting limits

The existing 50-successes/app/client/UTC-day allowance, failure refunds, Ollama
attempt limits, concurrency, and cooldowns remain process-local safeguards.
They reset on cold starts and can be multiplied by parallel instances. No exact
global daily, service, app+provider, credential, or billing-account quota is
implemented. Persistent shared state is required if those guarantees become
necessary. Evaluate persistent accounting separately if exact guarantees become
an operational requirement.
