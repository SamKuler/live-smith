# Model Profiles and Connection Backends

This reference owns model connection configuration, OAuth credential lifecycle,
capability evidence, and provider request behavior. See the
[README](../README.md) for product workflow, [Architecture](ARCHITECTURE.md) for
cross-module ownership, and [Development](DEVELOPMENT.md) for verification.

Every Profile selects one explicit connection kind:

- `direct-api` stores an endpoint and API key and sends one of the supported
  public provider protocols.
- `oauth-subscription` stores only `provider: openai | anthropic | google`.
  Live Smith owns browser/device authorization, private token persistence,
  refresh, logout, and direct HTTP requests to the provider product backend.

No subscription connection starts, bundles, discovers, or requires Codex CLI,
Claude Code, Gemini CLI, or another provider runtime.

## Network routing

The global network setting is independent of Profiles and has three explicit
modes: no proxy, the active macOS system proxy, or one credential-free Manual
proxy URL. The selected route is resolved at request time and is shared by
Direct API discovery/generation and OAuth login, refresh, catalog, and product
traffic. It never changes which provider or protocol a Profile owns.

System mode reads static HTTP, HTTPS, and SOCKS routes from macOS. Loopback
targets remain direct. PAC/WPAD-only configuration fails with an actionable
error instead of silently connecting directly. Manual mode accepts HTTP, HTTPS,
or SOCKS proxy URLs without user information; proxy credentials never enter
dialog state. No proxy is the migration default, so upgrading does not silently
change an existing connection's route.

Manual and System modes never fall back to a direct route when an applicable
proxy hop fails. Pre-response proxy failures become fixed credential-free
diagnostics; loopback and system-exception direct routes keep ordinary
connection semantics.

## Connection backends

### Direct API

The Direct API connection owns `apiFamily`, `apiMode`, `baseUrl`, and `apiKey`.
The supported protocol pairs are:

| API family | API mode |
| --- | --- |
| OpenAI | Responses |
| OpenAI | Chat Completions |
| Anthropic | Messages |

There are no endpoint or vendor presets. An OpenAI- or Anthropic-compatible
service is configured with the protocol it actually implements. Environment
variables and `.env` files are not credential or endpoint fallbacks.

#### Errors, bounds, cancellation, and recovery

Non-2xx response bodies are untrusted. OpenAI-compatible and Google generation
may decode at most 64 KiB of JSON only to recognize fixed error codes, reasons,
and retry delays; remote messages and metadata are never returned or logged.
Other non-2xx generation and discovery paths retain only the protocol and
numeric status. Request bodies, authorization headers, API keys, OAuth tokens,
and credential-bearing causes never enter Session events or WebView state.

Successful JSON responses have a 16 MiB byte budget. SSE events must reach a
delimiter within 1 MiB. Discovery accepts at most 1,000 unique bounded model
records and at most 20 pages. Cancellation requests stream cleanup once and
does not wait indefinitely on a provider-controlled cancel promise.

A logical response may retry only when its active transport or OAuth product
protocol classifies a rejected Fetch, rejected body read, early clean EOF, or
documented transient HTTP/provider failure as retryable. Provider-requested
waits up to five minutes act as a lower bound on the local backoff; a longer
delay stops automatic retry and asks the user to try again later.
The retry does not restart `/send`, append the prompt twice, replay an accepted
client tool, or repeat a Live mutation. Authentication, quota/account limits,
policy or validation failures, malformed protocol data, and local
request-construction failures remain fatal.

OpenAI-compatible generation retries HTTP 408, 409, 429, and 5xx plus fixed
transient stream codes; on 429 and decoded 4xx responses, a structured quota,
billing, usage, context, or policy code overrides the HTTP default and remains
fatal. Anthropic generation honors
`x-should-retry`, retries HTTP 408, 409, and 5xx, and, absent an explicit
header override, retries 429 only when it provides a valid `Retry-After`.
Anthropic stream retries are limited to
`overloaded_error`, `rate_limit_error`, `api_error`, and `timeout_error`.

### OAuth subscriptions

An OAuth subscription Profile has no endpoint, API key, token, client secret,
or provider-specific request fields. The selected provider fixes its product
backend:

| Provider | Authorization | Product request backend |
| --- | --- | --- |
| OpenAI | ChatGPT device authorization | ChatGPT Codex Responses |
| Anthropic | Claude browser PKCE | Anthropic Messages with OAuth identity |
| Google | Google browser PKCE | Cloud Code Assist streamGenerateContent |

OAuth traffic is not silently rerouted to a saved Direct API Profile. Direct
API billing and subscription-account usage therefore remain distinct
connections. Anthropic currently assigns third-party OAuth Messages traffic to
Claude Extra Usage when that account feature is enabled; this is separate from
an Anthropic Console API key balance and from the plan's base allowance.

#### Credential ownership

OAuth credentials live only in private Ableton storage at
`<storageDirectory>/oauth/credentials.json`. The file is schema-validated,
atomically replaced, and mode `0600` on POSIX; its directory is mode `0700`.
It stores one discriminated credential per provider:

- OpenAI: access token, refresh token, expiry, and ChatGPT account ID.
- Anthropic: access token, refresh token, and expiry.
- Google: access token, refresh token, expiry, Cloud Code Assist project ID,
  and an optional account label.

Credentials never enter Profiles, Session model selections, model caches,
Session events, model requests as data, bridge command bodies, dialog state, or
logs. The browser receives only credential-free auth state: signed out,
pending authorization URL and optional device code, signed in account label and
service label, or a fixed unavailable description. An unavailable account keeps
an explicit Sign out action so a revoked or malformed refresh credential can be
cleared before starting a new authorization.

#### Login and refresh lifecycle

OpenAI uses device authorization. Claude uses its registered fixed loopback
port; Google binds an available ephemeral loopback port. Both browser flows use
PKCE and exact state validation. The callback accepts only its one path and
expected state, returns inert local HTML, and closes after success, denial,
cancellation, or backend shutdown.

The dialog does not depend on popup support in Ableton's embedded WebView.
After login acquisition returns a validated pending HTTPS URL, the Extension
Host launches it through a fixed system browser command: `/usr/bin/open` on
macOS or the System32 URL handler on Windows. Launch failure does not cancel the
provider-owned login; the pending dialog state retains the verified URL and
optional device code as a fallback. Closing the owning modal stops admitting
new browser launches, cancels an unfinished launch, and waits for it to settle
before OAuth cleanup completes. Sign-out, replacement, or completed account
reconciliation likewise cancels that provider's unfinished browser launch.

One provider manager owns an in-flight login from adapter acquisition through
credential commit, plus one refresh single-flight. Login ownership is installed
before provider setup begins, so caller abort, logout, and close can cancel a
late-returning browser or device attempt and await its completion.
Concurrent requests waiting on an expired credential share the same rotating
refresh operation. A caller may cancel its wait without canceling a refresh
already owned by another request. Sign-in, logout, and backend close retire the
current credential generation, abort and settle any detached refresh, and
reject a late refresh result before it can write. Credential persistence checks
that ownership again after entering the serialized storage transaction, making
the check and commit one ordered operation. Logout also cancels pending
authorization and removes only the selected provider credential. Once logout
starts, its settle-and-delete cleanup remains manager-owned even if the caller
cancels its wait; close and later operations wait for that cleanup, so an
already-started credential write cannot outlive a confirmed retirement.
An operation resumed after waiting for logout rechecks caller cancellation
before acquiring new login, read, or refresh ownership.
Provider refresh failures are replaced at the credential boundary with a fixed
provider-context error; raw Fetch errors and their credential-bearing request
data never propagate.
Every close caller shares the same completion through the credential manager,
native backend, and backend registry; registry close also waits for OAuth slots
already undergoing invalidation and for every provider cleanup before reporting
one cleanup failure.

The provider-scoped auth/send fence prevents login, refresh-state mutation, and
logout from racing same-provider subscription discovery or generation. Its credential-free
generation invalidates modal-only catalogs and stale auth projections. Direct
API requests do not enter this fence.

#### Provider request mapping

OpenAI OAuth sends Responses requests to
`https://chatgpt.com/backend-api/codex/responses`. Requests use Bearer auth,
the token-derived `chatgpt-account-id`, the Codex Responses beta header,
JSON content type, `store: false`, full local conversation input, and Live Smith
function tools. An `error` envelope is treated as provisional while awaiting
the authoritative `response.failed` event; that terminal's fixed error code
separates transient provider failures from context, usage, and policy failures
without returning the provider message. A stream that ends before either
terminal remains connection loss. Generation HTTP 408, 409, 429, and 5xx
responses use the same bounded provider-retry path; catalog loading remains an
explicit read operation rather than an accepted model turn.
Device login reads ChatGPT account identity from the ID token, with an access
token claim as fallback. If neither `expires_in` nor a JWT expiry is available,
the token remains usable until the bounded HTTP 401 refresh path replaces it.
The same account identity loads the bounded `/codex/models` catalog and exposes
only account picker-visible entries; `supported_in_api` does not exclude a
ChatGPT-only subscription model. Its `client_version` is a separately pinned
Codex catalog compatibility version, never the Live Smith package version, and
is updated only after validating the decoder against the target catalog. Codex
turn-state returned in HTTP headers or `response.metadata` remains scoped to one
local agent turn. The first non-empty value is captured as soon as its response
arrives and is replayed on both connection retries and subsequent tool-loop
requests; later values cannot replace it. The provider-neutral reconnect layer
carries only a fresh opaque identity, which is discarded with that logical
request and is never persisted.

Anthropic OAuth sends the existing Messages protocol to
`https://api.anthropic.com/v1/messages` with Bearer auth, the OAuth and Claude
Code beta identities, and the required Claude Code system identity before Live
Smith's system instructions. It reuses the same strict streaming, tool replay,
thinking-block replay, pagination, and response bounds as Direct Anthropic
Messages. OAuth is never sent in `x-api-key`.

Google OAuth discovers or provisions the account's Cloud Code Assist project,
then performs the optional account-label lookup,
then sends to
`https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`.
The request uses the Gemini CLI `user_prompt_id` product envelope. The adapter
creates that ID once per local agent turn and reuses it across connection
retries, tool-result requests, and output-limit continuations. Steering starts
a new ID. It requires a terminal finish reason, classifies a missing terminal
as connection loss, classifies bounded HTTP and SSE code/status/reason fields,
and accepts only `STOP` or `MAX_TOKENS` as successful finish reasons. Prompt
policy feedback, malformed or unknown terminals, exhausted daily quota or model
capacity, and required account validation remain fatal. Per-minute quota hints,
transient rate, abort, timeout, unavailable, and server failures retry.
The adapter owns Google content-role mapping, function declarations,
function-call/result replay, thought signatures, thinking levels or budgets,
usage projection, SSE parsing, and fixed safe errors. Workspace accounts that
require an explicit Cloud project fail with a configuration error rather than
reading an environment variable implicitly. Provider-supplied function-call
IDs are replayed on both call and result; a Live Smith ID synthesized for an
ID-less call remains internal and is omitted from both Google wire parts.

#### Catalogs and send admission

Subscription catalogs are scoped to the selected provider, exact Profile
connection fingerprint, and current auth generation. They remain modal-only
and are never persisted across accounts. Every subscription send refreshes or
loads the provider catalog before prompt persistence and rejects a Session
model that is no longer available.

OpenAI and Anthropic use OAuth-authenticated product catalogs. Google loads the
signed-in project's bounded `retrieveUserQuota` model buckets; only returned
model IDs are selectable. Recognized IDs receive the Cloud Code Assist
capabilities the product protocol can encode, while a newly returned unknown ID
remains selectable with conservative, unverified capability evidence. Every
catalog is decoded through the same normalized `DiscoveredModelInfo` contract
before it can reach Profile or Session selection.

An OAuth product request rejected with HTTP 401 refreshes its credential and
replays at most once, before any response body has been accepted. Other HTTP or
protocol failures are not retried as authentication.

## Named profiles

A Profile stores:

- an ID, user-visible name, and one discriminated connection;
- one or more model configurations and one default model;
- per-model generation parameters and capability evidence allowed by that
  connection.

Direct API model configurations may store maximum output tokens, temperature,
reasoning, capability overrides, hosted-tool policy, and Extra Body.
Subscription model configurations store only the selected model and reasoning
settings. Tokens, endpoint overrides, temperature, Extra Body, hosted
tools, and manual capability overrides are rejected for subscription Profiles.

Schema version 7 stores `oauth-subscription`. A schema-v6
`codex-subscription` Profile migrates to
`{ kind: "oauth-subscription", provider: "openai" }`. The migration does not
copy or import credentials from Codex or any other application.

A Session model selection stores only Profile ID, model ID, and an optional
reasoning-effort override. Send admission resolves the complete current model
from the active saved Profile; unsaved draft connection data cannot enter a
model request.

## API behavior

### OpenAI Responses

Responses requests use local conversation state and `store: false`. Tool calls,
tool results, encrypted reasoning replay, output-limit continuation, citations,
and hosted Web Search state remain provider protocol data until normalized into
`ModelTurn`. Direct API Extra Body cannot override protected request ownership
such as model, input, tools, store, instructions, or replay state.

### OpenAI Chat Completions

Chat Completions maps local messages and function tools to delta streams. It
supports OpenAI-compatible services, including compatible Gemini endpoints,
when the service implements the wire contract. This Direct API mode is separate
from Google account OAuth and Cloud Code Assist.

### Anthropic Messages

Messages requests preserve signed thinking blocks, tool-use IDs, pause-turn
continuations, and exact tool-result ordering. OAuth and Direct API connections
share this protocol implementation but supply different request authentication
and identity headers.

### Follow-ups and steering

Queue and steering are local Session behavior, not provider features. A queued
follow-up begins a new send only after the active send is terminal. Steering is
inserted only at the next safe model boundary and discards obsolete transient
provider output without replaying accepted client tools or Live mutations.

## Capability resolution

Direct API capabilities resolve from the conservative protocol fallback, known
model policy, normalized discovery metadata, and finally an explicit manual
override. OAuth capabilities resolve from the conservative fallback and the
current signed-in provider catalog; central model-name policy is not treated as
OAuth evidence.

Evidence remains `supported`, `unsupported`, or `unverified`. A fallback may
keep a protocol usable without claiming provider verification. Subscription
catalog evidence is account/auth-generation scoped and cannot be restored from
the persistent Direct API model cache.

Recognized Google catalog models advertise image input, tools, streaming, a
1,048,576 token context window, and model-specific thinking controls. Unknown
account-returned models keep those fields unverified. OpenAI and Anthropic
OAuth evidence comes from their signed-in catalog metadata; their known model
policy remains available to Direct API Profiles.

## Input mapping

Images are supported only when the saved runtime capability and evidence allow
them. OpenAI Responses uses image data URLs, Anthropic uses base64 image source
blocks, and Cloud Code Assist uses inline data parts. Native PDF input remains
limited to verified Direct OpenAI Responses or Anthropic Messages Profiles.

Audio input remains limited to verified Direct OpenAI Chat Completions
connections. OAuth subscription backends do not advertise audio input. Office
documents are extracted locally into bounded untrusted text and do not require
native provider document support.

Attachment names, storage IDs, and filesystem paths never enter model input.
Base64 bytes appear only in the send-scoped provider request for a supported
input type.

## Provider-hosted Web Search

Hosted Web Search is an explicit per-model Direct API setting for OpenAI
Responses and Anthropic Messages. OAuth subscription Profiles do not expose it.
Search results and citations are untrusted data and cannot authorize tools,
approvals, filesystem access, or Live mutations.

## Compatible endpoints

Compatible services use an ordinary Direct API Profile and the protocol they
implement. Base URLs are normalized without inventing vendor presets. HTTP is
allowed only for loopback endpoints; remote endpoints require HTTPS and an API
key.

### Google Gemini Direct API

Gemini Developer API can be configured separately through Google's OpenAI Chat
Completions compatibility endpoint and an API key. This path uses developer API
billing and is unrelated to the Google OAuth subscription connection, which
uses Cloud Code Assist.

## Credential storage

`live-smith-settings.json` contains Direct API keys because a Direct API Profile
owns its complete connection. `oauth/credentials.json` contains OAuth tokens
because subscription Profiles deliberately do not. Both are private local
files and must not be committed, logged, copied into fixtures, or shown in
screenshots.

Provider failures are redacted with both the active Direct API secret set and
the send-scoped OAuth credential. Errors retain useful provider/protocol/status
context without returning authorization headers, tokens, request bodies, or raw
credential-bearing causes.

## Running

No environment variable selects a provider or supplies OAuth credentials. Run
Live Smith normally, create an Account subscription Profile, choose ChatGPT,
Claude, or Google Gemini, and use the in-dialog sign-in action. Direct API keys
remain configured only in explicit Direct API Profiles.
