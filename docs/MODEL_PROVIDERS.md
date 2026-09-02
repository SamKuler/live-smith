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
Claude Code, Gemini CLI, Antigravity, or another provider runtime.

## Network routing

The global network setting is independent of Profiles and has three explicit
modes: no proxy, System proxy (static macOS routes or the current Windows
user's static settings), or one credential-free Manual proxy URL. The selected
route is resolved at request time and is shared by
Direct API discovery/generation and OAuth login, refresh, catalog, and product
traffic. It never changes which provider or protocol a Profile owns.

System mode reads static HTTP, HTTPS, and SOCKS routes from macOS. On Windows it
uses one fixed, read-only `reg.exe query` and recognizes the current user's
`ProxyEnable`, `ProxyServer`, `ProxyOverride`, `AutoConfigURL`, and `AutoDetect`
Internet Settings values when present. It never invokes a shell or writes the
registry. It does not read machine-scoped or connection-specific Windows
settings. Loopback targets remain direct. PAC/WPAD is not evaluated. A non-empty
`AutoConfigURL` or enabled `AutoDetect` value returned by the queried key is
rejected; automatic settings outside that key cannot supply a route to this
static reader. When the reader finds no applicable static route, System mode is
direct. Manual mode accepts a concrete proxy URL, not a PAC/WPAD URL. Windows
System mode accepts static HTTP and HTTPS destination entries as ordinary HTTP
proxy transports. It rejects an unqualified SOCKS entry whenever HTTP or HTTPS
would need that fallback because Live Smith supports SOCKS5, not Windows'
SOCKS4 system syntax. Choose Manual mode for an HTTPS proxy transport or
SOCKS5. Proxy credentials never enter dialog state. No proxy is the migration
default, so upgrading does not silently change an existing connection's route.

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

Non-2xx response bodies are untrusted. OpenAI-compatible, Anthropic, and Google
paths may decode at most 64 KiB of JSON only to retain strictly bounded canonical
error types, codes, reasons, quota identifiers, and retry delays; remote messages
and arbitrary metadata are never returned or logged. Malformed error envelopes
fall back to the protocol and numeric HTTP status. Request bodies, authorization
headers, API keys, OAuth tokens, and credential-bearing causes never enter
Session events or WebView state.

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
Non-success provider JSON is read through one size- and time-bounded diagnostic
path. Validated safe identifiers can refine the error; a missing, malformed, or
stalled body falls back to the HTTP status without blocking cancellation or
exposing provider messages.

OpenAI-compatible generation retries HTTP 408, 409, 429, and 5xx plus fixed
transient stream codes; on 429 and decoded 4xx responses, a structured quota,
billing, usage, context, or policy code overrides the HTTP default and remains
fatal. Anthropic generation honors `x-should-retry` and otherwise retries HTTP
408, 409, 429, and 5xx. A valid `Retry-After` supplies the provider delay but is
not required for a 429 retry.
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
| Google | Antigravity browser PKCE | Antigravity streamGenerateContent |

OAuth traffic is not silently rerouted to a saved Direct API Profile. Direct
API billing and subscription-account usage therefore remain distinct
connections. Anthropic currently assigns third-party OAuth Messages traffic to
Claude Extra Usage when that account feature is enabled; this is separate from
an Anthropic Console API key balance and from the plan's base allowance.

#### Credential ownership

OAuth credentials live only in private Ableton storage at
`<storageDirectory>/oauth/credentials.json`. The file is schema-validated,
atomically replaced, and mode `0600` on POSIX; its directory is mode `0700`.
It stores discriminated credentials in exact Profile-ID/provider slots:

- OpenAI: access token, refresh token, expiry, and ChatGPT account ID.
- Anthropic: access token, refresh token, and expiry.
- Google: access token, refresh token, expiry, Antigravity companion project ID,
  and an optional account label.

Access and refresh credentials never enter Profiles, Session model selections,
model caches, Session events, model requests as data, bridge command bodies,
dialog state, or logs. Antigravity's one-time authorization code crosses only
its strict, bounded submit command and is not stored, logged, or projected into
state. The browser receives only credential-free auth state: signed out,
pending authorization URL and optional device code, signed in account label and
service label, or a fixed unavailable description with an optional trusted
account-verification URL. An unavailable account keeps an explicit Sign out
action so a revoked or malformed refresh credential can be cleared before
starting a new authorization.

Credential-store schema v1 used provider-global slots. Before the first OAuth
operation in a process, and before any Profile Save or Delete that changes OAuth
ownership, one serialized preparation reads the current saved settings and
assigns each retained, validated legacy credential to the active matching saved
Profile, or the first matching saved Profile when the active Profile uses
another connection. A legacy credential with no saved owner is discarded, so a
future Draft cannot inherit it. The preparation also removes tuple credentials
left from a prior process when they no longer match a saved connection.
Preparation failure prevents the ownership-changing settings mutation from
committing.

Credential-store schema v3 retires only Google credentials issued by the
former Gemini CLI OAuth client because they cannot be refreshed as Antigravity
credentials. OpenAI and Anthropic Profile tuples survive that migration;
Google subscription Profiles require one new Antigravity sign-in.

While one Profile is being edited, signing in to another provider writes a
separate provisional tuple and does not overwrite the saved provider's refresh
token. Saving an OAuth connection retains only its selected provider tuple;
saving Direct API or deleting the Profile removes every tuple for that Profile.
Discarding, replacing, or closing a Draft reconciles any provider authorized by
that modal against authoritative saved settings: the saved provider remains,
while foreign-provider and never-saved Profile tuples are removed. Direct-only
Draft changes do not enter OAuth storage. Discarding the Draft therefore cannot
sign the saved provider out or leave an unreachable refresh token behind.
If settings commit but backend retirement or tuple cleanup cannot be confirmed,
the exact Profile remains in a process-wide per-storage reconciliation set that
survives modal closure. State hydration retries that cleanup from authoritative
saved settings. Until it succeeds, the command reports the committed settings
and an explicit reconciliation warning instead of claiming an ordinary failure
or silently reusing the old credential.

#### Login and refresh lifecycle

OpenAI uses device authorization. Claude uses its registered fixed loopback
port. Antigravity uses Google browser PKCE with the registered hosted
`https://antigravity.google/oauth-callback` redirect. That page displays an
authorization code which the user pastes into Live Smith; the code is bounded,
submitted only to the active Google Profile's pending attempt, and never stored
or projected back into dialog state. Claude's loopback callback accepts only
its exact path and state, returns inert local HTML, and closes after success,
denial, cancellation, timeout, or backend shutdown.

The dialog does not depend on popup support in Ableton's embedded WebView.
After login acquisition returns a validated pending HTTPS URL, the Extension
Host launches it through a fixed system browser command: `/usr/bin/open` on
macOS or the System32 URL handler on Windows. A rejected launch cancels the
browser command but keeps the provider-owned pending attempt, PKCE state,
callback or authorization-code wait, and verified URL active. The dialog marks
that launch failure;
selecting the link retries the same Host browser command and a successful retry
clears the marker, while the address remains available to copy manually.
Pending auth states that do not require local input are checked automatically
with bounded backoff; ChatGPT still requires entering its device code before
that check can complete, while Antigravity waits for the pasted authorization
code before checking. Closing the owning modal stops admitting new browser
launches, cancels an unfinished launch, and waits for it to settle before OAuth
cleanup completes. Sign-out, replacement, or completed account reconciliation
likewise cancels that Profile connection's unfinished browser launch.

One Profile/provider backend owns an in-flight login from adapter acquisition
through credential commit, plus one refresh single-flight. Login ownership is
installed before provider setup begins, so caller abort, logout, and close can
cancel a late-returning browser or device attempt and await its completion.
Concurrent requests waiting on an expired credential share the same rotating
refresh operation. A caller may cancel its wait without canceling a refresh
already owned by another request. Sign-in, logout, and backend close retire the
current credential generation, abort and settle any detached refresh, and
reject a late refresh result before it can write. Credential persistence checks
that ownership again after entering the serialized storage transaction, making
the check and commit one ordered operation. Logout also cancels pending
authorization and removes only that Profile's matching provider credential.
Once logout starts, its settle-and-delete cleanup remains manager-owned even if
the caller cancels its wait; close and later operations wait for that cleanup,
so an already-started credential write cannot outlive a confirmed retirement.
An operation resumed after waiting for logout rechecks caller cancellation
before acquiring new login, read, or refresh ownership.
Provider refresh failures are replaced at the credential boundary with a fixed
provider-context error; raw Fetch errors and their credential-bearing request
data never propagate.
Every close caller shares the same completion through the credential manager,
native backend, and backend registry; registry close also waits for OAuth slots
already undergoing invalidation and for every Profile/provider cleanup before
reporting one cleanup failure.

The auth/send fence is Profile-scoped because one Profile owns one editable
connection lifecycle. It tags pending login ownership, live auth activity, and
credential-free generations by provider. This prevents a provider switch,
Profile Save, or Delete from racing another provider operation for the same
Profile, while different Profile IDs remain independent even when they use the
same provider. Provider-local generations invalidate only that tuple's modal
catalog and stale auth projection. Auth state is cached as one atomic
Profile/provider/generation entry, so delayed reads from independent Profiles
cannot exchange account projections. Profile lifecycle paths acquire the
Profile fence before the request-configuration fence, including recovery of an
unknown settings outcome. Direct API hydration and sends do not enter this
fence; ordinary Direct Profile mutations use only the cheap in-process Profile
gate unless OAuth state for that Profile actually needs retirement.

#### Provider request mapping

OpenAI OAuth sends Responses requests to
`https://chatgpt.com/backend-api/codex/responses`. Requests use Bearer auth,
the token-derived `chatgpt-account-id`, the Codex Responses beta header,
JSON content type, `store: false`, full local conversation input, and Live Smith
function tools. An `error` envelope is treated as provisional while awaiting
the authoritative `response.failed` event; that terminal's fixed error code
separates transient provider failures from context, usage, and policy failures
without returning the provider message. If the stream instead ends after a
well-formed canonical `error` event, Live Smith preserves and classifies that
bounded provider error. A clean stream with neither a terminal nor a canonical
error remains connection loss, while malformed error events fail closed.
Generation HTTP 408, 409, 429, and 5xx responses use the same bounded
provider-retry path; catalog loading remains an explicit read operation rather
than an accepted model turn.
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

Google OAuth uses Antigravity's installed-app client, hosted callback, and
the Cloud, account, Code logging, experiment/config, AI Code, and OpenID scopes
required by the product. It first resolves the account's managed companion
project and fails closed if Antigravity does not return one. If Google reports
`VALIDATION_REQUIRED`, Live Smith exposes only its allowlisted
`accounts.google.com` verification URL and a fixed local description; after
verification, starting sign-in again completes setup.

Account bootstrap uses `cloudcode-pa.googleapis.com`; Antigravity catalog and
generation traffic use its `daily-cloudcode-pa.googleapis.com` product route.
Generation sends SSE requests to
`https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
with Antigravity CLI 1.1.22's consumer HTTP identity. The request envelope
contains `requestType: "agent"`, `userAgent: "antigravity"`, and one opaque
`requestId` in `agent/<UUID>` form for each logical model request. Only physical
connection retries reuse that ID; tool-result and output-limit continuations
start new IDs. The adapter
requires a terminal finish reason, treats a missing terminal as connection
loss, classifies bounded HTTP and SSE code/status/reason fields, and accepts
only `STOP` or `MAX_TOKENS` as successful finish reasons. Prompt policy
feedback, malformed or unknown terminals, exhausted daily quota or model
account quota, and required account validation remain fatal. Temporary model
capacity, per-minute quota hints, transient rate, abort, timeout, unavailable,
and server failures retry. Safe canonical status/reason/finish values remain in
errors; raw provider messages and credential-bearing metadata do not. An empty
HTTP 429 uses a bounded one-minute rate-limit delay instead of immediately
exhausting the retry loop. Retry
progress and final exhaustion preserve that safe normalized cause and the
scheduled wait instead of replacing it with a generic failure label.

The adapter owns Google content-role mapping, function declarations,
function-call/result replay, thought signatures, thinking levels or budgets,
usage projection, bounded citation/grounding-source normalization, SSE parsing,
and fixed safe errors. Present malformed tool arguments, candidate parts,
citations, usage, or conflicting terminals fail explicitly instead of being
discarded or coerced. Provider-supplied
function-call IDs are replayed on both call and result; a Live Smith ID
synthesized for an ID-less call remains internal and is omitted from both
Google wire parts.

#### Catalogs and send admission

Subscription catalogs are scoped to the exact Profile/provider connection
fingerprint and that connection's current auth generation. They remain
modal-only and are never persisted across accounts. Every subscription send
refreshes or loads the provider catalog before prompt persistence and rejects a
Session model that is no longer available.

OpenAI and Anthropic use OAuth-authenticated product catalogs. Google loads the
signed-in Antigravity account's bounded `fetchAvailableModels` catalog and
exposes every returned agent model regardless of model-name family. Internal
entries and the IDs in the provider's `imageGenerationModelIds` and
`audioTranscriptionModelIds` lists are excluded because this transport cannot
use those specialized protocols. Every exposed model, including a newly
returned ID, consumes the catalog's `maxTokens`, `maxOutputTokens`, thinking
support, legacy image/PDF flags, and `supportedMimeTypes`. Direct
OpenAI-compatible discovery likewise consumes
returned context/output limits, input modalities, MIME maps, and legacy input
flags. Anthropic discovery consumes its official input and reasoning capability
objects. Missing fields remain unverified instead of being inferred from a
model name. Every catalog is decoded through the same normalized
`DiscoveredModelInfo` contract before it can reach Profile or Session selection.
Exact MIME and wildcard entries are retained in bounded provider evidence. A
coarse Live Smith image or audio capability becomes supported only when the
catalog covers every format that the corresponding attachment type can emit;
partial or coarse-only provider support remains visible without authorizing an
incompatible format. Usable capabilities are also intersected with the selected
wire protocol: Chat supports image/audio, Responses and Messages support
image/PDF, and Antigravity supports image/audio/PDF. A positive thinking flag or
scalar is retained as provider evidence but does not expose an explicit
reasoning control unless the catalog also defines a complete encodable strategy.

Live Smith sends the exact account project and lets Antigravity select the
account's default entitlement and region. It does not import or guess the
Antigravity CLI's separate local license-tier or project-region overrides.

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
Direct and subscription model configurations may both store a local context
window and automatic compaction threshold. Subscription model configurations
otherwise store only the selected model and reasoning settings: output-token
requests, endpoint overrides, temperature, Extra Body, hosted tools, and manual
capability overrides remain rejected.

The configured context window supplies the denominator when provider metadata
is absent or intentionally overridden. A blank auto-compaction threshold uses
90% of the effective context window; without either a known window or an
explicit threshold, automatic compaction remains unavailable instead of
guessing a provider limit. The threshold must stay below an explicitly
configured or resolved window.

Automatic compaction uses the same active model connection as generation. It
requests a bounded checkpoint with no tools or visible streaming output,
persists that checkpoint as the history boundary, and continues with only the
checkpoint and newer user, assistant, and provider-neutral Tool activity tail.
Further activity can cross the threshold and create a newer checkpoint. The
manual `/compact [instructions]` command uses this same saved Profile, selected
model, account generation, and requester; its optional instructions only add
one-time preservation priorities and are not stored as a user turn. Retry and
reconnect notices are transient command progress, and the user may request Stop
until checkpoint persistence begins. This common request path covers Direct API
plus OpenAI, Anthropic, and Google subscriptions; Live Smith does not depend on
an OpenAI-only compact endpoint.

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
An incomplete `max_output_tokens` turn validates every known output item, then
replays it with a fixed non-execution output for each returned function call or
with a fixed user continuation marker when no call was returned. Incomplete
function calls are never exposed for local execution. Codex subscription uses
the same terminal decoder and continuation contract. Known message items must
remain assistant output. Incomplete Web Search items retain only validated
provider states (`in_progress`, `searching`, `incomplete`, `completed`, or
`failed`); non-terminal states are replayed but are not reported as completed
search activity.

### OpenAI Chat Completions

Chat Completions maps local messages and function tools to delta streams. It
supports OpenAI-compatible services, including compatible Gemini endpoints,
when the service implements the wire contract. This Direct API mode is separate
from Google account OAuth and Antigravity. Streaming requests ask for the final
usage chunk and read through the terminal `[DONE]`, so authoritative token usage
is not lost after the first `finish_reason` chunk. A `length` response preserves
its raw assistant message but exposes no executable tool calls. Its continuation
replays that assistant message followed by a fixed user continuation marker, or
by a fixed non-execution result for every complete or partial function call.
Ordinary `tool_calls` responses remain paired with their real client results.
Both response modes require the assembled provider message to identify itself
as an assistant before any text, function call, or opaque state can be replayed.

### Anthropic Messages

Messages requests preserve signed thinking blocks, tool-use IDs, pause-turn
continuations, and exact tool-result ordering. OAuth and Direct API connections
share this protocol implementation but supply different request authentication
and identity headers. Canonical refusal and truncation stop reasons preserve the
returned content, citations, and usage. Successful JSON responses and streaming
`message_start` envelopes require
`type: "message"` and `role: "assistant"`. A 200 `type: "error"` envelope is
classified through the same bounded safe-error contract as other Anthropic
failures. Every stream content block started after `message_start` must close
exactly once before `message_stop`; an unclosed tool block is never executable.
`max_tokens` also preserves replay blocks; the following request ends with a
local continuation marker, or with
`is_error` results for every returned client tool so none can execute. An
error result for an incomplete streamed tool input also contains its exact raw
JSON. A mixed turn with a complete server-tool input returns only the client
error results and leaves the server block for Anthropic to continue. A truncated
server-tool input terminates even when client tools are also present. An
unresolved server-only turn likewise terminates with an output-limit notice
because a client result or text marker would close the provider-owned server
turn incorrectly.
Context-window termination retains no unusable replay state. Malformed known
content blocks, their known fields, stream-delta shapes, or events for an
already closed block fail explicitly, while unknown object block types remain
opaque replay data.
Streaming must begin with exactly one canonical `message_start`, whose `content`
is empty. Every returned content block must then pass through its own start,
delta, and stop lifecycle before `message_stop`, so a missing start or an
unclosed tool block can never become executable.

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

Google catalog models advertise the context/output limits, thinking support,
legacy input flags, and supported MIME types returned for that exact account.
Google model names do not fill missing input or thinking controls. OpenAI and
Anthropic OAuth evidence comes from their signed-in catalog metadata; their
known reasoning policy remains available to Direct API Profiles. Model names do
not authorize binary input for any connection.
Provider-reported video support is preserved for display even though Live Smith
does not yet define a video attachment part.

## Input mapping

Images are supported only when the saved runtime capability and evidence allow
them. OpenAI Responses uses image data URLs, Anthropic uses base64 image source
blocks, and Antigravity uses inline data parts. Native PDF input uses OpenAI
Responses, Anthropic Messages, or Antigravity inline data only when the loaded
catalog or Direct API metadata supports `application/pdf`.

Audio input uses OpenAI Chat Completions or Antigravity inline data only when
the loaded metadata explicitly supports WAV or MP3. Other subscription
backends, OpenAI Responses, and Anthropic Messages reject audio locally. Office
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
uses the Antigravity product backend.

## Credential storage

`live-smith-settings.json` contains Direct API keys because a Direct API Profile
owns its complete connection. `oauth/credentials.json` contains OAuth tokens in
Profile-ID/provider tuple slots because subscription Profiles deliberately do
not contain them. Both are private local files and must not be
committed, logged, copied into fixtures, or shown in screenshots.

Provider failures are redacted with both the active Direct API secret set and
the send-scoped OAuth credential. Errors retain useful provider/protocol/status
context without returning authorization headers, tokens, request bodies, or raw
credential-bearing causes.

## Running

No environment variable selects a provider or supplies OAuth credentials. Run
Live Smith normally, create an Account subscription Profile, choose ChatGPT,
Claude, or Google Antigravity, and use the in-dialog sign-in action. Direct API
keys remain configured only in explicit Direct API Profiles.
