# Model Profiles and Connection Backends

This reference owns model connection configuration, Integration Connection
contracts, OAuth credential lifecycle, capability evidence, and provider request
behavior. See the
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
route is resolved at request time and is shared by Direct API
discovery/generation, OAuth login, refresh, catalog and product traffic, and
built-in Plugin HTTP or WebSocket traffic. It never changes which
provider or protocol a Profile owns.

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
Before each logical model request, the bridge checkpoints its transient
assistant, visible-reasoning, and in-flight search projection. A physical retry
rolls back only output from that failed request attempt, so an earlier
output-limit continuation prefix remains visible and reconnectable.
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

### Visible reasoning output

Reasoning visibility is an output-protocol fact, not a model-name inference and
not a guarantee implied by the configured reasoning effort. Live Smith does not
enable a summary or change thinking display settings for the sake of the UI. It
normalizes only reasoning stages and text already returned by the selected
backend: OpenAI Responses reasoning summary or reasoning-text events and items,
OpenAI-compatible Chat Completions plaintext or structured reasoning fields,
Anthropic thinking blocks and deltas, and Google parts explicitly marked
`thought: true`.

An explicit stage with no visible text appears as a stage-only Thinking item.
Visible text streams into that item and the accepted result is stored as a
separate collapsed Session event before the assistant answer. A backend that
returns neither a stage nor visible text produces no Thinking item. Anthropic
signatures and redacted payloads, OpenAI encrypted reasoning, Google thought
signatures, and unknown provider fields remain opaque replay state and are
never projected into Session text or the WebView. Provider SDKs expose wrappers
around these same wire fields; Live Smith decodes them in its existing bounded
HTTP/SSE transports so Fetch, cancellation, proxy, retry, and redaction remain
under the Extension Host compatibility boundary.

### OpenAI Responses

Responses requests use local conversation state and `store: false`. Tool calls,
tool results, encrypted reasoning replay, output-limit continuation, citations,
and hosted Web Search state remain provider protocol data until normalized into
`ModelTurn`. Documented reasoning summary and reasoning-text events are also
normalized into its distinct visible reasoning field without exposing encrypted
content. Direct API Extra Body cannot override protected request ownership
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
is not lost after the first `finish_reason` chunk. Visible reasoning is decoded
by response shape rather than endpoint or model name. Structured
`reasoning_details` summary/text entries take precedence, followed by a string
`reasoning`, then its `reasoning_content` alias. Only one representation is
shown when an endpoint returns duplicates; a higher-priority representation
that begins later in a stream replaces the lower-priority draft atomically.
Across an output-limit continuation, that replacement is scoped to the current
request segment so the earlier reasoning prefix remains intact, including when
the later segment needs a physical retry.
Encrypted and unknown detail types remain opaque, while a detail-only response
still supplies a stage signal. The complete raw assistant message remains the
authoritative replay state. A
`length` response preserves
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
and identity headers. A thinking-block start creates the visible stage; text
from streaming `thinking_delta` events or non-streaming `thinking` blocks
enters its content. Multiple visible thinking blocks in one assistant turn use
content-block index order and the same blank-line boundaries in streaming and
terminal projections. `signature_delta` and `redacted_thinking` payloads remain
replay-only. Canonical refusal and
truncation stop reasons preserve the
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

## External audio tools

External audio tools are provided by immutable built-in Plugins and configured
independently of chat Profiles in **Inspector → App → Connections**. Add a named
Connection, select its Plugin, enter the required credential, and save it before
use. Up to 20 Connections can coexist, including multiple accounts for the same
Plugin. The list shows each Plugin and its saved or draft status. Select a row to
expand its editor; model overrides are optional disclosure controls. Each
Connection has its own enable switch and write-only secret field. An omitted
replacement preserves secrets only for the same Connection and Plugin; switching
Plugins never inherits them. Clearing a key or removing a saved Connection
requires confirmation. Clearing a key disables only that Connection. Removing a
Connection leaves its Session results intact but makes remote recovery through it
unavailable.

Saves check the collection revision to prevent another window's changes from
being overwritten. Configuration requires private persistent extension storage;
there is no environment-variable fallback. Settings schema 9 stores each entry as
`id`, `name`, `pluginId`, `enabled`, public `configuration`, and private `secrets`.
Historical schema-8 `audioServices` and the older single LALAL.AI service are
migrated on read without rewriting their file. The next authorized settings write
persists only `integrationConnections`.

Tools expose only enabled, configured connections that support the requested
operation. Every new model tool request selects an exact `connectionId`; the chat
model receives a user-defined label and non-secret selected model ID when present,
but never receives a key, callback secret, provider endpoint, or generic HTTP
execution tool. Namespaced built-in tool definitions and strict argument parsing
come from the selected Plugin rather than a central Provider operation switch.
The chat model needs function-tool support, not native audio generation support.
Saved-job listing and recovery remain available to the model when no Integration
Connection is enabled; only new remote operations depend on enabled Connections.
When the active Profile has verified audio-input support on a protocol that can
carry tool-produced audio, `listen_to_audio_asset` can attach one exact local
Session result to the next model turn. Text-only Profiles never receive that tool
or those bytes. Online players and remote provider URLs are not model input.
The connection is bound when these tools are admitted for a chat request.
Changing that connection before upload or paid submission stops the operation;
send a new request to use the changed configuration. Editing another connection
does not invalidate this request.

### Music and sound effects

ElevenLabs supports `generate_music` and `generate_sound_effect` using its official
[music](https://elevenlabs.io/docs/api-reference/music/compose) and
[sound-effect](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
REST endpoints. Prompt character limits count Unicode code points, including
supplementary characters as one, consistently from the chat tool to the adapter.
Music accepts a description, an instrumental flag, and an optional
3–600 second duration. The integration defaults to `music_v2`; an optional saved
music model ID replaces that value. Sound effects accept a description, a
0.5–30 second duration, and a loop flag, and use `eleven_text_to_sound_v2`
independently of the music model setting. Both return MP3 audio that is inspected
and stored as a Session result. No provider SDK runtime is bundled.

These requests can consume the selected account's paid allowance. API access and
charges are governed by the provider account, not the selected chat Profile.
An ElevenLabs request returns audio directly, rather than a resumable task ID.
Stopping an incomplete response does not confirm service-side cancellation or a
refund. A lost response is never regenerated automatically; a complete local
file that outlives a job-record failure can be recovered without another request.

### Google Lyria through the Gemini API

**Google Lyria (Gemini API)** is a separate API-key audio connection. It uses
Gemini Developer API billing and credentials; a Google OAuth subscription
Profile does not supply this key or grant Lyria access. Create the key in
[Google AI Studio](https://aistudio.google.com/apikey). The connection accepts
text prompts through the existing `generate_music` tool and does not currently
send image prompts or expose returned lyric/structure text.

The default `lyria-3.5` model calls the official
[Interactions API](https://ai.google.dev/gemini-api/docs/music-generation) once
with `store: false` and requests WAV output. An optional 3–600 second value is
added as prompt guidance; the provider describes full-song duration as
prompt-controlled, so it is not an exact cut. `lyria-3-clip-preview` returns MP3
and always generates 30 seconds. A different explicit duration for that model is
rejected before an audio job or paid request is created. Instrumental requests
add an explicit no-vocals instruction inside the provider adapter. Batch output
is bounded, decoded from the final documented model-output audio block, then
inspected and saved as an ordinary Session asset.

The experimental `lyria-realtime-exp` model uses the official
[Live Music WebSocket](https://ai.google.dev/api/live_music). Live Smith sends
the key only in the `x-goog-api-key` handshake header, waits for setup to
complete, sends one weighted prompt, and collects a bounded duration before
issuing `STOP`. Omitted duration defaults to 30 seconds; explicit values may be
3–600 seconds. The provider's raw 48 kHz, stereo, 16-bit PCM is copied only up
to the requested frame count and wrapped in a standard WAV container. This is a
generation transport, not an interactive steering or live-performance UI.
Lyria RealTime is instrumental-only, so vocal requests are excluded from the
tool schema and rejected again before submission.

All Lyria output is subject to provider safety filtering and SynthID
watermarking. Batch generation is single-turn, and the realtime model remains
experimental. Requests can consume Gemini API quota or paid usage. Stop,
timeouts, connection loss, and a lost response do not establish provider-side
cancellation or a refund, and Live Smith never retries an unknown generation
automatically. Synthetic request and WebSocket replay tests do not establish
live key access, billing, regional availability, quota, or current model
entitlement.

### Mureka official API

**Mureka** is an official API-key connection using the server and Bearer
authentication documented in its
[Quickstart](https://platform.mureka.ai/docs/en/quickstart.html). It is separate
from chat-model Profiles and sends authenticated metadata requests only to
`https://api.mureka.ai`.

The connection exposes prompt-based `generate_music`. Vocal music uses the
official [Prompt to song](https://platform.mureka.ai/docs/api/operations/post-v1-song-easy-generate.html)
endpoint; instrumental music uses the separate
[Generate instrumental](https://platform.mureka.ai/docs/api/operations/post-v1-instrumental-generate.html)
endpoint. Live Smith requests one non-streaming choice and applies a common
1,024-Unicode-code-point prompt limit, matching the narrower instrumental
contract. Requesting one choice avoids silently purchasing the provider's
documented default of two when the user asked for one result. It does not expose
custom lyrics, styles, reference audio, vocal cloning, streaming playback, an
explicit duration, or other Mureka operations through this tool.

The optional model field suggests `auto`, `mureka-7.6`, `mureka-o2`,
`mureka-8`, `mureka-9`, and `mureka-9.5`, following the current official
generation schemas. Blank uses `auto`. Because the official instrumental
schema does not include `mureka-o2`, Live Smith rejects that combination before
creating an audio job or sending a paid request; the same saved model remains
usable for prompt-to-song generation.

An accepted task is persisted before polling the matching song or instrumental
[query endpoint](https://platform.mureka.ai/docs/api/operations/get-v1-song-query-%7Btask_id%7D.html).
The documented preparing, queued, running, and streaming states remain pending;
succeeded results bind one stable music role to the returned choice ID. Failed,
timed-out, and cancelled task states are terminal.
Provider failure text is not returned to the model, Session history, or dialog.

Completed HTTPS output URLs are temporary provider locators. Downloads accept
provider-returned HTTPS hosts without treating example CDN names as a stable
protocol contract, send no API key, Cookie, or referrer, and do not follow
redirects. Each downloaded WAV or MP3 is inspected and stored as an immutable
Session asset before it becomes available for playback, model listening, or a
separate scoped Live import.
Changed result identities are rejected on Resume, while refreshed URLs for the
same identities are accepted. The published API reference documents polling but
no cancellation request, so Stop ends the local wait without claiming remote
cancellation or a refund. Resume queries the original task and never resubmits
generation automatically.

Synthetic request-capture tests cover the documented request, polling, response,
download, cancellation, storage, and recovery boundaries. They do not establish
that a real Mureka account has access to a selected model, sufficient credits,
or current regional availability.

### Suno Platform official API

**Suno Platform (official API)** is a first-party API-key connection. Open
[platform.suno.com](https://platform.suno.com/) in the system default browser
to create or manage an API account and key. The adapter sends authenticated
requests only to `https://api.suno.com`; it never receives or uses the
Suno.com website Cookie. Platform access, quotas, and billing are separate from
consumer Pro/Premier subscription credits.

The implemented flow submits `POST /v0/audio`, persists its returned task ID,
polls `GET /v0/audio/{id}`, and saves the completed HTTPS audio result locally.
Description mode lets Suno choose lyrics and style. Custom mode maps literal
lyrics, style, optional title, an existing supported voice ID, and the
instrumental flag. Instrumental description requests use the custom style form
without inventing lyrics. The current Platform contract does not expose a model
selector or duration through Live Smith. Cover and Mashup are advertised by the
Platform but do not yet have chat-tool input contracts here.

Suno's public page confirms the official REST product but keeps the endpoint
reference behind account access. The implemented request shape follows the
available partner-facing `/v0/audio` contract and is covered by synthetic
request-capture tests; without a configured Platform key, those tests do not
establish live account access or current quota. Paid submissions, unknown
outcomes, HTTP failures, and Stop are never automatically retried.

### Suno through a third-party API

**Suno via SunoAPI.org (third-party)** is a separate connection, not Suno's
official API or a Suno subscription login. It uses a SunoAPI.org API key and
that service's [published generation protocol](https://docs.sunoapi.org/suno-api/generate-music).
An enabled connection also requires a user-owned callback URL accepted by that
provider.
The provider requires this address when submitting full-song generation even
when the desktop client retrieves results by polling. Live Smith does not host
the callback or verify ownership/reachability; do not enter a placeholder or an
address belonging to someone else. HTTP and HTTPS callbacks may contain a
provider-required query token, custom port, IP literal, or local hostname.
Malformed URLs, fragments, embedded credentials, whitespace, and values that
reflect the API key are rejected. Live Smith never contacts the callback URL.

The connection exposes prompt-based `generate_music` in non-custom mode, with an
instrumental flag and up to 3,000 prompt characters. The integration defaults to
`V6`; a saved supported model ID can select another published version. The model
field suggests the current published IDs while remaining editable.
Explicit duration, custom lyric mode, covers and extensions are not part of this
operation. Returned task IDs are persisted before polling. One or two final
tracks are saved as music results; Resume uses the original task, not a new
generation. The first completed response binds each result role to its remote
track ID. Resume rejects changed track identities while allowing reordered
responses and refreshed download URLs. The published protocol has no
cancellation operation, so Stop ends the local wait without claiming a refund
or remote cancellation.

Downloads accept the HTTP or HTTPS URL returned by the authenticated task result,
including signed queries, custom ports, IP addresses, and changing CDN hosts.
They never carry the API key, Cookie, referrer, or browser credentials and never
follow redirects. Malformed, embedded-credential, credential-reflecting, non-HTTP,
and fragment-bearing URLs are rejected.

A Suno Pro/Premier subscription is not a credential for the SunoAPI.org connector.
Website subscription sign-in is a separate connection, described below.

### Suno.com website sign-in

**Suno.com subscription (experimental)** uses the ordinary `suno.com` account, not Suno
Platform or SunoAPI.org. It requires no browser extension or particular browser.
On macOS and Windows, the website action opens `https://suno.com/create` using
the system default browser and its existing login state. Google login and
sign-in verification remain there, under the user's control. Generation
verification uses the separate in-app workflow below.

This is a manual Cookie import, not an automatic OAuth callback:

1. Add a Suno connection in **Inspector → App → Connections** and open Suno.
   Opening the website does not require saving the connection first.
2. Open the browser's developer tools → Network, reload Suno, and inspect a
   request to `auth.suno.com` or `studio-api-prod.suno.com`.
3. Copy its request Cookie header into Live Smith's private Suno session field.
   Older sessions may contain `__client`; current sessions may instead contain
   `__session` and `__client_uat`. A raw `__client` or `__session` JWT is also
   accepted. Live Smith canonicalizes the input and retains only `__client`,
   `__session`, Clerk update timestamps, and a valid Suno device identifier;
   unrelated analytics, Google, Cloudflare, and other cookies are discarded.
   If no usable device identifier is present, a private UUID is generated and
   retained for this connection after verification.
4. Connect the account. If the named connection is still a draft, Live Smith
   saves it first and imports only after a confirmed save. Import verifies the
   active Suno session before privately saving the credential. The input is
   cleared on submission; failed replacement does not overwrite a saved Cookie.
5. Select **Enable connection** and save. Connecting alone does not enable paid
   tools. An enabled connection without a saved Cookie remains unavailable to
   chat requests. Multiple named Suno accounts can be enabled independently.

Treat the Cookie like a password. Enter it only in the local settings form,
never in a chat message, terminal command, screenshot or shared file. The app
sends the normalized Cookie only to the fixed Suno authentication host for
verification and short-lived API token exchange, and stores it in private local files, not in the model's context,
public settings or UI state. Local files are access-restricted but are not
additionally encrypted by Live Smith. Each saved audio connection owns its own
Cookie, so multiple Suno accounts can coexist without new browser profiles.
To connect a different account, log into it in the browser/profile of your choice
and explicitly import its own Cookie into a different named connection.

Successful verification displays account identity. Open dialogs share verification
results within one extension activation, including failures; closing a dialog
does not discard that evidence. After the extension host restarts, a saved
connection is not presented as freshly verified until checked again.
Expired sessions require a fresh Cookie import; network failures are not reported
as successful sign-in. Website traffic uses the browser's network configuration;
app verification and music requests use Live Smith's saved API proxy setting.

Disconnect removes only that connection's local Cookie. It does not sign out the
browser or revoke the remote Suno session. Removing the connection or changing
its provider also clears its saved Cookie; cleanup failure prevents the ownership
change. A later settings-write failure can leave the old connection disconnected.
Closing Live Smith does not close the browser. Legacy managed browser directories
are not read, imported or deleted by this workflow.

The experimental tools use the Suno.com account directly. No official Suno SDK
or OAuth grant is implied, and no SDK dependency is bundled. The adapter maps a
bounded subset of the current Suno web client's `v2-web` request contract, which
is unofficial and may change. Synthetic protocol tests do not establish
that a particular live account can generate. Cookie identity alone does not
prove plan entitlements, sufficient credits or freedom from security challenges.
Before enabling it, review [Suno's current terms](https://suno.com/terms). Live
Smith does not represent this unofficial protocol as authorized or stable, and
website or policy changes may make it unavailable for an account.

- `generate_music`: description mode (up to 3000 characters), or `options.mode:
  "custom"` with literal lyrics (up to 5000, empty for instrumentals), title
  (100), styles and excluded styles (1000 each), Weirdness and Style Influence
  (0–100), male or female vocal gender, a 10–480 second duration on catalog
  models that report version 6 support, and an existing Persona ID. Account model
  limits can be lower and are checked before submission. Sliders, vocal gender,
  and duration map to structured fields rather than prompt suffixes. Instrumental
  and lyric intent are separate from a style description.
- `inspect_music_service`: current account model/credit catalog, one bounded
  library page (20 songs with opaque pagination), or one Persona by ID. It does
  not enumerate all Voices or train/register a new voice. Returned text is data,
  not instructions; media URLs and credentials never enter the model context.
  Library entries preserve explicit download-unlocked evidence separately from
  generation status; missing evidence is not treated as permission.
- `retrieve_music`: add one or two selected existing songs from the account for preview,
  without generating, extending or authorizing a download. Chat calls require
  clip IDs the model observed through that connection's library or saved jobs.
  Repeating an identical retrieval in the same Session reuses its existing job
  and any saved outputs.
- `extend_music`: lyrics/styles for a completed, observed song starting at an
  explicit second before its end. `get_whole_song` joins one extension's
  existing lineage, not an arbitrary collection of audio files. These operations
  can consume credits and never import to Live without a separate scoped Apply.

Use **Music version → Load versions** in a saved Suno connection to read that
account's catalog directly; no chat request or generation credits are required,
and a saved connection can remain disabled during setup. **Follow account
default** uses its current usable default; choosing a named version fixes that
connection's model after **Save audio settings**. Unavailable or unknown-access
versions cannot be selected from the catalog. A saved ID missing from a newly
loaded catalog remains visible instead of silently changing the selection.
**Advanced model ID** retains explicit ID entry; **Discard** restores the saved
connection without a settings write. Catalogs stay in the current dialog and
are invalidated by explicit authentication lifecycle changes or a different
account, not by a verified automatic Cookie rotation, and are not persisted to disk.
There is no model-name guessing or fallback to a different account/provider.
Every Suno.com API request carries a fresh bounded `browser-token`, the imported
device identifier when available (otherwise a generated private UUID persisted
with that connection), and the Suno Origin/Referer used by the web client. `__client`
credentials use Clerk's active-client and token endpoints. `__session`
credentials use the session `touch` endpoint on the current auth host, with the
observed legacy Clerk host as a non-paid compatibility fallback; they rotate the
returned session JWT, preserve updated Clerk timestamps when supplied, and
atomically save the verified rotation without replacing a concurrent reimport.
Every generation is preceded by
account/parameter validation and a CAPTCHA check. An explicit no-challenge
response or a fresh result from the requested official component permits
submission. A challenge waits for manual action in the owned verification
window. There is no browser/device impersonation, CAPTCHA
solver, challenge bypass, or automatic replay of a paid submission. Stop allows
a bounded receipt-read grace period; it is not a remote cancellation or refund.

HTTP failures retain the numeric status and, when available, a bounded,
structured provider diagnostic: error codes/types and validation field paths.
Arbitrary provider messages, rejected input and server debug data are never
exposed. An unavailable error body or an interrupted diagnostic read does not
erase an already received HTTP rejection, and a diagnostic never authorizes a
generation retry.

#### Online preview, file downloads and Live import

Suno generation completion is separate from a file download. **Session audio**,
above the chat composer, holds the active Session's processing jobs and results;
it is separate from application connection settings and collapses when switching
Sessions. A generated song can be ready for online listening without a local audio
asset. The result card offers an explicitly opened Suno embedded player at
`https://suno.com/embed/{clip_id}`.
Each job shows a creation time, chronological number and newest marker; the optional
custom title is retained without lyrics or other prompt content. One result row per
version switches its single Preview control between open and closed. Downloaded
versions use local playback in that same row. Generation completion and local
download count are displayed separately, with earlier failures identified as
earlier tasks rather than the latest result.
The player loads only when requested and remains owned by Suno, inside a
sandboxed cross-origin frame with no referrer. Live Smith passes no Cookie or API
token to it and does not capture its playback data. The player uses the host
WebView's network/session environment, not the API proxy; provider restrictions
or network failures can make online playback unavailable without invalidating
generation. Closing the preview, collapsing the result shelf or switching
Session removes the embedded player. Collapsing the shelf also pauses local
audio; reopening it does not automatically play or download anything.

**Download to Live Smith** is a separate, explicit per-song download action. Its
confirmation explains that an existing download allowance may be consumed.
Only the selected output is authorized, using the original job's exact account
and immutable clip identity. If the song is already unlocked, it is not
authorized again. Live Smith never buys download packs or treats playback
permission as permission to export a file. Suno describes its streaming and
download distinction in its [download FAQ](https://help.suno.com/en/articles/13614785).

Downloaded audio becomes a verified local Session asset, with local playback
and a separate **Export MP3/WAV** button. Export opens the system default
browser with a two-minute link for this file only, not the dialog's control
credential. Keep Live Smith open until the browser finishes the download; no
Suno request or additional download allowance is needed. Repeating a saved output's download reuses that
asset without a provider request. Importing into Live requires this local asset
and remains a separate scoped Apply operation. When asked, a verified audio-input
Profile can also receive the exact local WAV or MP3 through
`listen_to_audio_asset`, subject to the request's binary-count and byte limits.
The tool result text is recorded before its untrusted audio part is admitted, and
the bytes are not persisted in conversation events. An online preview cannot be
used as either a Live import source or model input.

#### In-app human verification and selected-output download

On macOS 14 or later, a challenged music generation or extension opens Live
Smith's native verification window. It loads an actual `https://suno.com`
document, not a local page with a substituted hostname, and uses only the
component requested by the generation check: hCaptcha version 1 or Turnstile
version 2. Click **Start verification** and complete any challenge yourself.
The opaque result travels only through a private process pipe and transient
adapter memory. It never enters chat, job records, settings, logs, process
arguments or UI text. Saved Cookies, model credentials and lyrics are not sent
to the window. Its WebKit store is nonpersistent and its own generation and
download-authorization routes are blocked.

A successful callback continues the exact prepared request once, adding
`token` and numeric `token_provider` without recreating request IDs, lyrics,
options or model selection. No-challenge requests use null proof fields.
The selected account/configuration, proxy revision, request values, Stop signal
and proof lifetime are rechecked before submission. The helper follows the
selected API proxy mode; explicit No proxy uses an authenticated local CONNECT
tunnel without intercepting HTTPS. Closing/cancelling the window, loading
failure or an expired result does not submit generation. A silent component has
a bounded wait and supports manual retry; there is no automatic paid retry.
Callback success is not itself evidence of server acceptance: the validated
generation receipt is authoritative. Unknown challenge versions, unsupported
hosts and challenged Get Whole Song requests fail before submission; the
whole-song proof contract is not verified and no fields are guessed.

Retrieval and Resume check the original Suno songs without automatically
downloading them. A generated song can be complete but still unavailable for
file export. The separate download action checks explicit download permission;
with the user's confirmation it can authorize one locked song through
`POST /api/download/authorize`, then recheck that same song's permission. A
missing or uncertain authorization response is never replayed automatically.
The adapter requests the prepared MP3 through
`GET /api/download/clip/{clip_id}?format=mp3`, rather than treating the song's
playback URL as a file download. Preparation and transfer have a cancellable
ten-minute deadline; only the Suno CDNs and the exact
`suno-data-uploads.s3.amazonaws.com` bucket returned by authorized MP3 preparation
are accepted over HTTPS, without API credentials or redirects.
Missing permission, a failed preparation or an unfamiliar host stops that output
with a recoverable error instead of falling back to an alternate media endpoint.

If one song's download fails, its remote identity and already-saved sibling
results remain available. Retry that song's explicit download to check its
permission and collect it without another generation. **Resume** checks remote
generation state; it does not spend download allowance. This is a human-assisted workflow, not
unattended CAPTCHA automation or full website parity.

Suno returns individual clip IDs. All acknowledged IDs and their output roles
are saved before polling. Missing/pending clips remain pending; successful clips
are retained when a sibling fails. Recovery uses the same IDs without generating
again. Renewing a Cookie for the same verified account permits recovery; switching
the connection to another account does not. Saved files remain recoverable locally.

The Suno.com adapter does not currently map Sounds/One Shot/Loop/BPM/Key,
upload/recording, Cover/Remaster, Replace Section, Add Vocals/Instrumental,
Suno stem extraction, Voice enrollment, custom-model training, Inspo/My Taste,
or Suno Studio workspace editing and publishing. These are adapter gaps, not
restrictions on Live Smith or the user's workflow, and they are not simulated
with text tags. Ableton editing remains available; configured LALAL.AI stem and
ElevenLabs sound-effect tools can be used independently or in the same workflow.

### Stem separation

LALAL.AI uses its Public API v1 connection for the separation operation.

`separate_stems` accepts a non-empty selection of vocals, drums, bass, piano,
electric guitar, and acoustic guitar. LALAL.AI processes the selected stems and
also returns the remaining mix. Its multistem endpoint charges processing minutes
for each requested stem, rather than once for the input file. The adapter follows
the [official OpenAPI contract](https://www.lalal.ai/api/v1/openapi.json): octet-stream
upload, multistem submission, task-state checks, and cancellation of an exact task.
Requests use the existing global network proxy route. No provider SDK or local
model runtime is required.

Inputs can be a current audio attachment, a saved result from the same Session,
or a bounded range inside an isolated Arrangement Audio Clip. Arrangement input
is rendered before the track's effects. Post-effects mixes, instrument-track
renders, and Session View rendered ranges are not available through this tool.
The snapshot is fixed before upload; later Clip edits cannot change an existing
processing task. A text-only chat model receives source and result references,
not audio bytes. With a verified audio-input Profile, the model may call
`listen_to_audio_asset` for one exact saved result when the user asks it to hear,
analyze, compare, or transcribe that audio.

Audio processing files are limited to 128 MiB and 15 minutes each, with a 1 GiB
total and 40 processing jobs per Session. Composer audio attachments retain
their separate 20 MiB/120-second input limit. LALAL.AI keeps WAV sources lossless
and requests MP3 output for MP3 sources so a valid long compressed input is not
expanded past the per-file result limit. Media transfer has a ten-minute deadline;
API metadata calls retain a two-minute deadline. Results are inspected as WAV or MP3,
stored privately, and exposed through authenticated local playback. Remote
download links, credentials, and filesystem paths never enter tool results.
Download links from the documented LALAL.AI output host use HTTPS without API
credentials; unexpected output hosts or redirects are rejected.
Before a paid request, the host checks worst-case local output capacity using
the per-file limit and the operation's output count. This can reject a request
before the byte quota is completely full; it prevents starting work whose
bounded results could not all be retained. The existing same-Session operation
fence protects this budget while processing, and each file save rechecks it.

### Saved results and recovery

`list_audio_jobs` reads local processing records and exposes available result
references. `resume_audio_job`, also available on a saved job in the interface,
queries its existing remote task and retrieves missing outputs when the provider
has a task-based protocol. Fully saved results finish local recovery without a
provider request or an enabled connection. Local recovery checks the saved
metadata and exact audio bytes even if the original connection has been removed
or its key changed. Successful stems or generated variants survive a failure to
download or validate another output. Submission is never automatically replayed
after an unknown outcome. A task without a confirmed remote ID can only finish
recovering already committed local audio; it cannot retrieve a lost provider
response. Historical Suno jobs that saved only result roles, without track IDs,
still support complete local recovery. If such a job has only some results saved,
they remain usable, but missing files cannot be safely matched to new remote
results; Resume retains the existing files and explains that limitation. An old
job with no saved outputs can acknowledge its first identity mapping.
Metadata is committed before its audio file, and an incomplete file
is not presented as an available result. LALAL.AI currently limits status checks
to 24 hours after task creation, so remote recovery can expire even though downloaded local results
remain available.
Status polling is coordinated by credential owner within one storage scope, with
a small margin below LALAL.AI's published 30-checks-per-minute account limit.
Provider-confirmed terminal failures and failed sibling outputs are retained as
terminal state and are not presented as recoverable work.

Stop and window closure interrupt local processing. A bounded cancellation
request is attempted for an accepted remote task; this does not claim that the
service has stopped until its status confirms cancellation. After restart, a
recoverable job can be explicitly resumed using its original Integration
Connection. Each job retains its Plugin/tool identity, original Connection ID,
and credential-owner fingerprint. Changing a Connection key or selecting another
account cannot transfer an old job.
Recovering a result never restarts a stopped Live edit plan.

If Stop arrives after a separation submission has started, the client allows
up to three seconds to receive its task receipt before aborting the request.
This preserves a returned task ID for cancellation and recovery, without
continuing the separation workflow. An absent receipt remains an unknown outcome.

Neither generation nor separation creates tracks or modifies Clips. Import uses the saved
audio result as a SampleSource and retains the existing approval policy, complete
Edit Scope checks, mutation queue, and state revalidation. Creating tracks also
requires Structure scope. Source timing metadata describes the original snapshot;
it does not establish sample-accurate alignment or authorize an edit to a changed
target. Inspect timing and Warp behavior in Live when importing stems.

## Credential storage

`live-smith-settings.json` contains Direct API keys because a Direct API Profile
owns its complete connection. It also contains private built-in Plugin Connection
secrets under exact Connection and Plugin identities. `oauth/credentials.json`
contains OAuth tokens in Profile-ID/provider tuple slots because subscription
Profiles deliberately do not contain them. Suno.com session material remains in
its separate private per-Connection record. These files must not be committed,
logged, copied into fixtures, or shown in screenshots.

Provider failures are redacted with both the active Direct API secret set and
the send-scoped OAuth credential. Errors retain useful provider/protocol/status
context without returning authorization headers, tokens, request bodies, or raw
credential-bearing causes.

## Running

No environment variable selects a provider or supplies OAuth credentials. Run
Live Smith normally, create an Account subscription Profile, choose ChatGPT,
Claude, or Google Antigravity, and use the in-dialog sign-in action. Direct API
keys remain configured only in explicit Direct API Profiles.
