# Model Profiles and Connection Backends

This reference describes model connection configuration, Integration Connection
contracts, OAuth credential lifecycle, capability evidence, and provider request
behavior. See the [README](../README.md) for the product overview, the
[user guide](USER_GUIDE.md) for workflows, [Architecture](ARCHITECTURE.md) for
module ownership, and [Development](DEVELOPMENT.md) for verification.

Every Profile selects one explicit connection kind:

- `direct-api` stores an endpoint and API key and sends one of the supported
  public provider protocols.
- `oauth-subscription` stores only `provider: openai | anthropic | google`.
  Live Smith owns browser/device authorization, private token persistence,
  refresh, logout, and direct HTTP requests to the provider product backend.

Subscription connections run inside Live Smith and use direct HTTP requests.
They operate independently of installed Codex CLI, Claude Code, Gemini CLI, and
Antigravity runtimes.

## Network routing

The global network setting applies independently of Profiles:

| Mode | Route |
| --- | --- |
| No proxy | Direct connections; also the default for migrated settings |
| System proxy | Static macOS routes or the current Windows user's static settings |
| Manual proxy | One HTTP, HTTPS, or SOCKS5 proxy URL without embedded credentials |

The route is resolved for each Direct API discovery or generation request,
OAuth login, refresh, catalog or product request, and built-in Plugin HTTP or
WebSocket request. Profile provider and protocol selection stay independent of
this setting. Loopback targets remain direct in every mode.

System mode reads static HTTP, HTTPS, and SOCKS routes on macOS. On Windows it
uses a fixed, read-only `reg.exe query` of the current user's Internet Settings
key, recognizing `ProxyEnable`, `ProxyServer`, `ProxyOverride`, `AutoConfigURL`,
and `AutoDetect`. Its scope is that key; machine and connection-specific
settings are outside this reader. A non-empty `AutoConfigURL` or enabled
`AutoDetect` value causes an unsupported-configuration error because PAC/WPAD
evaluation is unavailable. An absent static route uses a direct connection.

Windows HTTP and HTTPS destination entries use ordinary HTTP proxy transports.
A SOCKS fallback needed by either destination causes an error. Manual mode
supports HTTPS proxy transports and SOCKS5, with `socks://` accepted as a SOCKS5
alias. Manual URLs must identify a concrete
proxy server. All configured proxy URLs exclude embedded credentials.

An applicable proxy failure stops the request with a fixed, credential-free
diagnostic. Direct routes selected for loopback or system exceptions retain
ordinary connection behavior.

## Connection backends

### Direct API

The Direct API connection owns `apiFamily`, `apiMode`, `baseUrl`, and `apiKey`.
The supported protocol pairs are:

| API family | API mode |
| --- | --- |
| OpenAI | Responses |
| OpenAI | Chat Completions |
| Anthropic | Messages |

Configure an OpenAI- or Anthropic-compatible service with its actual protocol,
base URL, and API key. Profiles provide these values explicitly; endpoint
presets and environment-variable fallbacks are unavailable.

#### Errors, bounds, cancellation, and recovery

Non-success provider JSON is untrusted and passes through a single diagnostic
reader limited to 64 KiB and a short read deadline. OpenAI-compatible,
Anthropic, and Google adapters retain only validated error types, codes,
reasons, quota identifiers, and retry delays. Missing, malformed, or stalled
bodies use the protocol and numeric HTTP status. Remote messages, arbitrary
metadata, request bodies, authorization headers, credentials, and raw causes
stay outside Session events, dialog state, and logs.

Successful JSON responses have a 16 MiB byte budget. SSE events must reach a
delimiter within 1 MiB. Discovery accepts at most 1,000 unique bounded model
records and at most 20 pages. Cancellation requests stream cleanup once and
releases local ownership independently of the provider's cleanup promise.

A logical response may retry only when its active transport or OAuth product
protocol classifies a rejected Fetch, rejected body read, early clean EOF, or
documented transient HTTP/provider failure as retryable. Provider-requested
waits up to five minutes act as a lower bound on the local backoff; a longer
delay stops automatic retry and asks the user to try again later.
A retry resumes the logical response while preserving the accepted prompt,
client tool results, and Live mutations. Authentication, quota/account limits,
policy or validation failures, malformed protocol data, and local
request-construction failures remain fatal.
Before each logical model request, the bridge checkpoints its transient
assistant, visible-reasoning, and in-flight search projection. A physical retry
rolls back only output from that failed request attempt, so an earlier
output-limit continuation prefix remains visible and reconnectable.

OpenAI-compatible generation retries HTTP 408, 409, 429, and 5xx plus fixed
transient stream codes; on 429 and decoded 4xx responses, a structured quota,
billing, usage, context, or policy code overrides the HTTP default and remains
fatal. Anthropic generation honors `x-should-retry` and otherwise retries HTTP
408, 409, 429, and 5xx. A valid `Retry-After` supplies the provider delay but is
not required for a 429 retry.
Anthropic stream retries are limited to
`overloaded_error`, `rate_limit_error`, `api_error`, and `timeout_error`.

### OAuth subscriptions

An OAuth subscription connection stores its provider identity. Its endpoint,
authentication, and request fields are supplied by the selected backend:

| Provider | Authorization | Product request backend |
| --- | --- | --- |
| OpenAI | ChatGPT device authorization | ChatGPT Codex Responses |
| Anthropic | Claude browser PKCE | Anthropic Messages with OAuth identity |
| Google | Antigravity browser PKCE | Antigravity streamGenerateContent |

OAuth requests use the selected subscription connection. Direct API requests
use their own saved Profile and API key. The provider determines account access,
usage limits, and billing for each connection. Successful sign-in confirms
credential readiness; model availability and usage allowance depend on the account.

#### Credential ownership

OAuth 凭据保存在私有 SQLite 数据库的 `oauth/credentials.json` 逻辑记录中，
经过 schema 校验后原子提交。数据库权限与迁移原件的维护遵循
[凭据存储](#credential-storage)和[持久化契约](ARCHITECTURE.md#durable-local-storage)。
记录按精确的 Profile ID/provider 二元组保存各提供商字段：

- OpenAI: access token, refresh token, expiry, and ChatGPT account ID.
- Anthropic: access token, refresh token, and expiry.
- Google: access token, refresh token, expiry, Antigravity companion project ID,
  and an optional account label.

Access and refresh credentials remain private to OAuth storage and authenticated
provider requests. Profiles, Session selections and events, model caches,
bridge commands, dialog state, and logs contain only credential-free state.
Antigravity's one-time code passes through its dedicated bounded submit command
and stays transient. The dialog receives signed-out state, a pending
authorization URL and optional device code, signed-in account and service labels,
or a fixed unavailable description with an optional trusted verification URL.
Unavailable accounts retain **Sign out** so the saved credential can be cleared
before a new authorization.

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

Signing in to another provider while editing a Profile creates a separate
provisional tuple and preserves the saved provider's credential. Saving an
OAuth connection retains its selected provider tuple; saving Direct API or
deleting the Profile removes all of that Profile's tuples. Discarding,
replacing, or closing a Draft reconciles provisional credentials against saved
settings, retaining the saved provider and removing credentials without a saved
owner. Direct-only Draft changes stay outside OAuth storage.

If settings commit while backend or credential cleanup remains unconfirmed,
Live Smith reports the committed settings with a reconciliation warning. A
process-wide set retains the affected Profile across modal closure, and later
state hydration retries cleanup against saved settings.

#### Login and refresh lifecycle

OpenAI uses device authorization. Claude uses its registered fixed loopback
port. Antigravity uses Google browser PKCE with the registered hosted
`https://antigravity.google/oauth-callback` redirect. That page displays an
authorization code which the user pastes into Live Smith; the code is bounded,
submitted only to the active Google Profile's pending attempt, and never stored
or projected back into dialog state. Claude's loopback callback accepts only
its exact path and state, returns inert local HTML, and closes after success,
denial, cancellation, timeout, or backend shutdown. Accepted unrelated sockets
are retired on completion. The terminal callback response has up to one second
to flush before a non-reading peer is released.

The Extension Host opens each validated pending HTTPS URL in the system browser
through `/usr/bin/open` on macOS or the System32 URL handler on Windows. If that
command fails, the pending authorization, PKCE state, callback or code wait, and
URL remain available. The dialog marks the launch failure and lets the user
retry the same browser command or copy the URL. A successful launch clears the
marker.
Pending auth states that do not require local input are checked automatically
with bounded backoff; ChatGPT still requires entering its device code before
that check can complete, while Antigravity waits for the pasted authorization
code before checking. Closing the owning modal stops admitting new browser
launches, cancels an unfinished launch, and waits for it to settle before OAuth
cleanup completes. Sign-out, replacement, or completed account reconciliation
likewise cancels that Profile connection's unfinished browser launch.

Each Profile/provider backend owns one in-flight login through credential
commit and one shared refresh operation. Ownership begins before provider
setup, so cancellation, logout, and close can also settle a late-returning
authorization attempt. Concurrent requests share refresh; each caller can
cancel its own wait independently.

Sign-in, logout, and close retire the credential generation and settle pending
refresh work. Persistence checks generation ownership inside its serialized
transaction before writing. Logout also cancels pending authorization and
deletes the matching Profile/provider credential. Its cleanup continues even
when the requesting caller cancels its wait; later operations and close await
that cleanup, then recheck cancellation before starting work. All close callers
share the same completion, and registry closure awaits every connection's
cleanup. Refresh failures expose only a fixed provider-context error.

The Profile auth/send fence serializes authorization, sends, provider switches,
Save, and Delete for one Profile. Separate Profile IDs remain independent,
including those using the same provider. Auth projections and modal catalogs
are keyed by Profile, provider, and credential generation. Lifecycle operations
acquire the Profile fence before the request-configuration fence, including
recovery of an unknown settings outcome. Direct API hydration and sends use
their ordinary configuration path; Direct API mutations enter OAuth cleanup
only when that Profile has OAuth state to retire.

#### Provider request mapping

Subscription client identifiers are pinned protocol metadata:

| Provider | Request identifier | Pinned version |
| --- | --- | --- |
| ChatGPT | Codex catalog `client_version` | [0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1) |
| Claude | `claude-cli` User-Agent | [2.1.296](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) |
| Google | Antigravity CLI consumer User-Agent | [1.3.1](https://www.antigravity.google/docs/changelog?tab=cli#rel-cli-1.3.1) |

These identifiers are independent of locally installed CLIs and the Live Smith
release version. Updates require request-contract checks and catalog validation.
Anthropic's `anthropic-version: 2023-06-01` selects the Messages API contract;
dated beta headers select implemented features and are versioned separately
from Claude Code releases. OpenAI's User-Agent identifies Live Smith itself.

OpenAI OAuth sends Responses requests to
`https://chatgpt.com/backend-api/codex/responses`. Requests use Bearer auth,
the token-derived `chatgpt-account-id`, the Codex Responses beta header,
JSON content type, `store: false`, full local conversation input, and Live Smith
function tools. An `error` envelope is treated as provisional while awaiting
the authoritative `response.failed` event; that terminal's fixed error code
separates transient provider failures from context, usage, and policy failures
without returning the provider message. If the stream instead ends after a
well-formed canonical `error` event, Live Smith preserves and classifies that
provider error. A clean stream lacking both events is treated as connection
loss; a malformed error event is a protocol failure.
Generation HTTP 408, 409, 429, and 5xx responses use the same provider-retry path.
Catalog loading remains a separate read operation.
Device login reads ChatGPT account identity from the ID token, with an access
token claim as fallback. If neither `expires_in` nor a JWT expiry is available,
the token remains usable until the bounded HTTP 401 refresh path replaces it.
The same account identity loads the bounded `/codex/models` catalog and exposes
only account picker-visible entries; `supported_in_api` does not exclude a
ChatGPT-only subscription model. Its `client_version` is a separately pinned
Codex catalog compatibility version, updated after validating the decoder
against the target catalog. Codex turn-state returned in HTTP headers or
`response.metadata` remains scoped to one
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
project and stops setup if that project is absent. If Google reports
`VALIDATION_REQUIRED`, Live Smith exposes only its allowlisted
`accounts.google.com` verification URL and a fixed local description; after
verification, starting sign-in again completes setup.

Account bootstrap uses `cloudcode-pa.googleapis.com`; Antigravity catalog and
generation traffic use its `daily-cloudcode-pa.googleapis.com` product route.
Generation sends SSE requests to
`https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
with Antigravity CLI's pinned consumer HTTP identity. The request envelope
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
errors; raw provider messages and credential-bearing metadata do not. An
HTTP 429 with an empty body uses a one-minute rate-limit delay. Retry progress
and final exhaustion preserve the normalized cause and scheduled wait.

The adapter owns Google content-role mapping, function declarations,
function-call/result replay, thought signatures, thinking levels or budgets,
usage projection, bounded citation/grounding-source normalization, SSE parsing,
and fixed safe errors. Malformed tool arguments, candidate parts, citations,
usage, or conflicting terminals cause a protocol failure. Provider-supplied
function-call IDs are replayed on both call and result; a Live Smith ID
synthesized for an ID-less call remains internal and is omitted from both
Google wire parts. Omitted function-call arguments serialize as an explicit
empty object on replay, including unexecuted output-limit calls. The original
provider state and all call IDs and signatures remain unchanged. Pure empty
text chunks are omitted from replay; empty parts
carrying thought signatures or other provider metadata remain intact.
Consecutive streamed thought-text fragments ending in a thought signature
serialize as one complete signed thinking block. Each signature closes its
block; ordinary text, function calls and other provider metadata preserve their
boundaries. This assembly changes only the outbound copy, leaving visible
reasoning deltas and the original provider state intact.

Antigravity function schemas with a root `oneOf`, `anyOf` or `allOf` use an
object envelope with one required `input` property. The original schema and
its constraints remain inside that property; document-local `$ref` pointers
move with it. Explicit nested schema resource IDs retain their own reference
base. This encoding applies across the account's model catalog. The adapter
unwraps valid returned arguments before tool admission, so Plugin and Live
executors continue to consume their canonical arguments. Signed provider parts
retain the exact wire envelope on replay. Incomplete output-limit calls remain
unexecuted and are retained for continuation without decoding partial envelopes.

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
Direct OpenAI-compatible and Antigravity discovery retain exact MIME and
wildcard entries as provider evidence. Their image/audio capabilities require
MIME coverage for every format that the attachment type can emit; partial
format coverage and coarse positive flags remain informational. ChatGPT's
catalog uses its `input_modalities`; Anthropic's catalog uses its input
capability objects and returned modalities. Usable capabilities are also
intersected with the selected wire protocol: Chat supports image/audio, Responses and Messages support
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
- per-model generation parameters and advanced settings allowed by that
  connection.

Direct API model configurations require a maximum output-token count. They may
also store temperature, reasoning, capability overrides, hosted-tool policy,
and Extra Body. Discovery evidence is stored separately from Profile settings.
Direct and subscription model configurations may both store a local context
window and automatic compaction threshold. Subscription model configurations
also store reasoning settings and the Web Search opt-in: output-token
requests, endpoint overrides, temperature, Extra Body, and manual
capability overrides remain rejected.

The configured context window supplies the denominator when provider metadata
is absent or intentionally overridden. A blank auto-compaction threshold uses
90% of the effective context window; without either a known window or an
explicit threshold, automatic compaction remains unavailable. The threshold
must stay below an explicitly
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
plus OpenAI, Anthropic, and Google subscriptions.

Settings schema v7 introduced `oauth-subscription`. A schema-v6
`codex-subscription` Profile migrates to
`{ kind: "oauth-subscription", provider: "openai" }`. The migration does not
copy or import credentials from Codex or any other application.

A Session model selection stores only Profile ID, model ID, and an optional
reasoning-effort override. Send admission resolves the complete current model
from the active saved Profile. Draft connection data stays in the editor until
saved.

## API behavior

### Visible reasoning output

Visible reasoning depends on the output returned by the provider. Model names
and reasoning-effort settings alone provide no visibility guarantee. ChatGPT
subscription
requests ask for `reasoning.summary: "auto"` when the resolved model supports
reasoning and reasoning is not disabled. Anthropic Messages requests use
`display: "summarized"` with explicitly enabled adaptive or budget thinking;
Provider default and disabled thinking keep their configured behavior. This
mapping is shared by Anthropic Direct API and subscription connections.
OpenAI-compatible Direct API requests retain their configured summary policy
through Extra Body. Google Antigravity retains backend-default thinking;
`includeThoughts` is not enabled by this adapter because its support in the
subscription product protocol is unverified. Live Smith normalizes reasoning
stages and visible text returned by the selected backend: OpenAI Responses
reasoning summary or reasoning-text events and items,
OpenAI-compatible Chat Completions plaintext or structured reasoning fields,
Anthropic thinking blocks and deltas, and Google parts explicitly marked
`thought: true`.

An explicit stage with no visible text shows Thinking while in progress.
Visible text streams into that item and the accepted result is stored as a
separate collapsed Session event before the assistant answer. Completed
reasoning events with empty or whitespace-only content are omitted from the
timeline, including saved history. Backends that return neither a stage nor
visible text omit the Thinking item. Anthropic
signatures and redacted payloads, OpenAI encrypted reasoning, Google thought
signatures, and unknown provider fields remain opaque replay state and are
kept out of Session text and the WebView. Live Smith decodes these wire fields
in its HTTP/SSE transports, which share the Extension Host's Fetch,
cancellation, proxy, retry, and redaction behavior.

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
authoritative replay state. A `length` response preserves its raw assistant
message and withholds tool calls from execution. Its continuation
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
replay-only. Canonical refusal and truncation stop reasons preserve the
returned content, citations, and usage. Successful JSON responses and streaming
`message_start` envelopes require
`type: "message"` and `role: "assistant"`. A 200 `type: "error"` envelope is
classified through the same bounded safe-error contract as other Anthropic
failures.
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
already closed block cause a protocol failure. Unknown object block types remain
opaque replay data.
Streaming must begin with exactly one canonical `message_start`, whose `content`
is empty. Every returned content block must then pass through its own start,
delta, and stop lifecycle before `message_stop`, so a missing start or an
unclosed tool block can never become executable.

### Follow-ups and steering

Queue and steering are implemented by the local Session. A queued
follow-up begins a new send only after the active send is terminal. Steering is
inserted only at the next safe model boundary and discards obsolete transient
provider output without replaying accepted client tools or Live mutations.

## Capability resolution

Direct API capabilities resolve from the conservative protocol fallback, known
model policy, normalized discovery metadata, and finally an explicit manual
override. OAuth capabilities resolve from the conservative fallback and the
current signed-in provider catalog; central model-name policy is not treated as
OAuth evidence.

Temperature, reasoning, and binary-input evidence remains `supported`,
`unsupported`, or `unverified`. Token-limit evidence uses `verified`,
`configured`, or `unverified`. A fallback keeps a protocol usable while retaining
unverified evidence. Subscription catalog evidence is scoped to its account and
auth generation and stays separate from the persistent Direct API model cache.

Google catalog models advertise the context/output limits, thinking support,
legacy input flags, and supported MIME types returned for that exact account.
Google model names do not fill missing input or thinking controls. OpenAI and
Anthropic OAuth evidence comes from their signed-in catalog metadata; their
known reasoning policy remains available to Direct API Profiles. Model names do
not authorize binary input for any connection.
Provider-reported video support is preserved for display even though Live Smith
does not yet define a video attachment part.

## Input mapping

Binary input requires the resolved runtime capability and supporting evidence.
Direct API evidence can include explicit per-model overrides; subscription
evidence comes from the current account catalog. The selected protocol must
also support the input type:

| Connection | Native input types | Wire representation |
| --- | --- | --- |
| Direct OpenAI Responses or ChatGPT OAuth | Images, PDF | Image data URLs and file data |
| Direct OpenAI Chat Completions | Images, WAV/MP3 audio | Image data URLs and `input_audio` parts |
| Direct Anthropic Messages or Claude OAuth | Images, PDF | Base64 image and document source blocks |
| Google Antigravity OAuth | Images, WAV/MP3 audio, PDF | Inline data parts |

Catalog-derived audio evidence requires coverage of both WAV and MP3. Plain
text, code, rich documents, spreadsheets, presentations, and MIDI are extracted
locally into bounded untrusted text. Additional browser-decodable images are
normalized to PNG before upload. Audio stays in its original WAV/MP3 format;
other formats require an explicit export before attachment. Image conversion
depends on codecs in the local WebView, independently of provider capability
evidence.

Inline model input admits at most two audio parts of up to 15 minutes each
within the shared 128 MiB binary request budget. Remote provider limits can be
lower. See [local attachment limits](USER_GUIDE.md#supported-formats-and-limits)
for saving, playback, and reuse.

Modern Office and OpenDocument use bundled parser workers without an installed
helper runtime. Formula caches are read without evaluation; missing cached
values remain explicit. Historical DOC/XLS/PPT references are retained as
unsupported-format context markers. They never become native provider parts.

Locally extracted text includes a JSON-escaped filename as untrusted metadata.
Attachment storage IDs and filesystem paths never enter model input.
Base64 bytes appear only in the send-scoped provider request for a supported
input type.

## Provider-hosted Web Search

Hosted Web Search is an explicit per-model opt-in for Direct API OpenAI
Responses and Anthropic Messages, and for all three OAuth subscription
providers. Direct API OpenAI Responses and Anthropic Messages, including Claude
OAuth, use native server tools with bounded activity and opaque result replay.
Support still depends on the selected endpoint, model and account; enabling the
setting does not establish provider verification. Chat Completions does not
expose hosted search.

ChatGPT advertises a private query function and executes it through the Codex
standalone `POST /alpha/search` protocol, using the same Profile credential,
account and selected model. The auxiliary request contains the search query,
explicit search commands and settings; full conversation history and Live tool
results are not sent to it. The returned text becomes a function result for the
next model turn. Explicit citation markers and source-reference headers in prose
are expanded into Markdown links using that response's validated text-result URLs
before replay, because independent searches can reuse reference IDs. The mdast
parser supplies source positions with standard GFM table and strikethrough
extensions; code, existing links, reference definitions and ordinary IDs retain
their literal text. Link labels and destinations encode data symbols so Markdown
and HTML parsing preserve the original source title and URL. Unresolved citation
markers are omitted without guessing source associations. Validated text-result
URLs also supply search activity; encrypted search output is not replayed.
Missing or null result metadata is allowed when
the response contains valid output text. The request and output contract follows
the [Codex search client](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/codex-api/src/endpoint/search.rs)
and its [tool executor](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/ext/web-search/src/tool.rs).
The Responses request contains ordinary functions without a native `web_search`
tool or `max_tool_calls`; search execution obeys the local per-send allowance.

Antigravity advertises a private search function alongside ordinary functions.
The adapter executes that function through a separate `requestType: "web_search"`
request containing only `googleSearch`, using the same Profile credential and
project. It selects the conversation model when present in the account's
`webSearchModelIds`, otherwise the first advertised search model. No model name
is inferred and no other Profile or Direct API connection supplies the search.
Only the search query enters this auxiliary request. Missing search models,
provider rejection or absent grounding evidence return a failed search result
to the conversation model. Ordinary function calls retain their original Live
admission and approval path.

ChatGPT and Antigravity expose query-only functions. Their search results and
internal exchanges remain request-scoped protocol state. Connection retries
retain accepted searches and their original allowance; OAuth refresh retains
already-published text. Antigravity grounding metadata and Codex result records
produce search activity, while answer citations come from the conversation
model. Sources returned by search are not automatically promoted
to answer citations. Search results consume the existing per-send activity
budget, and search is omitted from workflows that request no hosted tools.
Provider-internal exchanges also supply normalized context-estimation messages
and the message boundary covered by exact provider usage. Search text appended
after that boundary contributes to the next compaction decision; text already
covered by usage is not counted twice. Displayed provider usage remains exact.
When only private search calls complete, the adapter returns a hosted-tool
continuation to the Agent loop. Each subsequent conversation-model request
therefore passes through the application's compaction, steering, cancellation
and planning limits.
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

External audio tools are provided by built-in Plugins and configured
independently of chat Profiles in **Settings → Extensions → Audio services**.
Add a named Connection, select its Plugin, enter the required credential, and
save it before use. Audio services share the limit of 20 Integration Connections
with other Plugin and standalone MCP connections. Multiple accounts for one
Plugin can coexist. The list shows each Plugin and its saved or draft status.
Select a row to expand its editor; optional model overrides use a disclosure. Each
Connection has its own enable switch and write-only secret field. An omitted
replacement preserves secrets only for the same Connection and Plugin; switching
Plugins never inherits them. Clearing a key or removing a saved Connection
requires confirmation. Clearing a key disables only that Connection. Removing a
Connection leaves its Session results intact but makes remote recovery through it
unavailable.

Saves check the collection revision so a stale editor cannot overwrite a changed
connection. Configuration requires private persistent extension storage.
Settings schema 10 stores built-in entries as
`id`, `name`, `pluginId`, `enabled`, public `configuration`, and private `secrets`.
Historical schema-8 `audioServices` and the older single LALAL.AI service are
migrated on read without rewriting their file. The next authorized settings write
persists only `integrationConnections`.

Tools expose only enabled, configured connections that support the requested
operation. Every new model tool request selects an exact `connectionId`; the chat
model receives a user-defined label and non-secret selected model ID when present,
while credentials, callback secrets, and provider endpoints remain private.
The selected Plugin supplies namespaced tool definitions and strict argument
parsing for its supported operations.
The chat model needs function-tool support to request these operations.
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

Provider request and replay tests cover local protocol handling. Live access,
model entitlements, quotas, billing, and regional availability depend on the
selected provider account and require checks with that account.

### Music and sound effects

ElevenLabs supports `generate_music` and `generate_sound_effect` using its official
[music](https://elevenlabs.io/docs/api-reference/music/compose) and
[sound-effect](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
REST endpoints. Prompt character limits count Unicode code points, including
supplementary characters as one, consistently from the chat tool to the adapter.
Music accepts a description of up to 4,100 Unicode code points, an instrumental
flag, and an optional 3–600 second duration. The integration defaults to
`music_v2`; an optional saved
music model ID replaces that value. Sound effects accept a description, a
0.5–30 second duration, and a loop flag, and use `eleven_text_to_sound_v2`
independently of the music model setting. Both return MP3 audio that is inspected
and stored as a Session result. No provider SDK runtime is bundled.

These requests can consume the selected account's paid allowance. API access and
charges are governed by the selected ElevenLabs account.
An ElevenLabs request returns audio directly and has no resumable task ID.
Stopping an incomplete response does not confirm service-side cancellation or a
refund. A lost response is never regenerated automatically; a complete local
file that outlives a job-record failure can be recovered without another request.

### Google Lyria through the Gemini API

**Google Lyria (Gemini API)** uses a separate API-key audio connection with
Gemini Developer API billing. Create its key in
[Google AI Studio](https://aistudio.google.com/apikey). The connection accepts
text prompts of up to 4,100 Unicode code points through `generate_music`.
Google OAuth Profiles, image prompts, and returned lyric/structure text are
outside this connection's input and output contract.

The default `lyria-3.5` model calls the official
[Interactions API](https://ai.google.dev/gemini-api/docs/music-generation) once
with `store: false` and requests WAV output. An optional 3–600 second value is
added as prompt guidance; the provider describes full-song duration as
prompt-controlled, so it is not an exact cut. `lyria-3-clip-preview` returns MP3
and always generates 30 seconds. A different explicit duration for that model is
rejected before an audio job or paid request is created. Instrumental requests
add an explicit no-vocals instruction inside the provider adapter. Batch output
is bounded, decoded from the final documented model-output audio block, then
inspected and saved as an ordinary Session asset. After the complete HTTP body
reaches EOF, bounded local validation and decoding finish even if Stop arrives,
so the received result can be saved. Incomplete reads remain cancellable.

The experimental `lyria-realtime-exp` model uses the official
[Live Music WebSocket](https://ai.google.dev/api/live_music). Live Smith sends
the key only in the `x-goog-api-key` handshake header, waits for setup to
complete, sends one weighted prompt, and collects a bounded duration before
issuing `STOP`. Omitted duration defaults to 30 seconds; explicit values may be
3–600 seconds. The provider's raw 48 kHz, stereo, 16-bit PCM is copied only up
to the requested frame count and wrapped in a standard WAV container.
Lyria RealTime is instrumental-only, so vocal requests are excluded from the
tool schema and rejected again before submission.

All Lyria output is subject to provider safety filtering and SynthID
watermarking. Batch generation is single-turn, and the realtime model remains
experimental. Requests can consume Gemini API quota or paid usage. Stop,
timeouts, connection loss, and a lost response do not establish provider-side
cancellation or a refund. Unknown generation outcomes require an explicit new
submission.

### Mureka official API

**Mureka** is an official API-key connection using the server and Bearer
authentication documented in its
[Quickstart](https://platform.mureka.ai/docs/en/quickstart.html). It is separate
from chat-model Profiles and sends authenticated metadata requests only to
`https://api.mureka.ai`.

The connection exposes three tools:

| Tool | Input and result | API route |
| --- | --- | --- |
| `generate_music` | A description of up to 1,024 Unicode code points; one vocal or instrumental result | [Prompt to song](https://platform.mureka.ai/docs/api/operations/post-v1-song-easy-generate.html) or [Generate instrumental](https://platform.mureka.ai/docs/api/operations/post-v1-instrumental-generate.html) |
| `generate_lyrics` | A brief of up to 8,000 code points; a generated title and editable lyrics | [Generate lyrics](https://platform.mureka.ai/docs/api/operations/post-v1-lyrics-generate.html) |
| `generate_song_from_lyrics` | Literal lyrics of up to 5,000 code points, an optional style prompt of up to 1,024 code points, and optional male/female vocal gender; one rendered song | [Lyrics to song](https://platform.mureka.ai/docs/api/operations/post-v1-song-generate.html) |

Audio generation explicitly requests one non-streaming choice with `n: 1`.
Lyric generation returns text to Session tool history and can consume the
connection's API allowance. An unconfirmed lyric response remains an unknown
outcome and requires an explicit new submission. Reference audio, vocal cloning,
streaming playback, and explicit audio duration are outside these tool contracts.

The optional model field suggests `auto`, `mureka-7.6`, `mureka-o2`,
`mureka-8`, `mureka-9`, and `mureka-9.5`. Blank uses `auto`. These are the model
IDs supported by this adapter. Instrumental generation excludes `mureka-o2`;
the adapter rejects that combination before creating a job or sending a paid
request. The same saved model remains usable for vocal song generation.

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
instrumental flag. Instrumental description requests send the supplied prompt
as style text. Model, duration, Cover, and Mashup controls are outside this
adapter's tool contract.

Suno's public page describes the REST product; its detailed endpoint reference
requires account access. The adapter implements the `/v0/audio` request and
polling contract described above. Paid submissions, unknown outcomes, HTTP
failures, and Stop require explicit user action before another submission.

### Suno through a third-party API

**Suno via SunoAPI.org (third-party)** uses a separate SunoAPI.org API key and
that service's [published generation protocol](https://docs.sunoapi.org/suno-api/generate-music).
An enabled connection also requires a user-owned callback URL accepted by that
provider, including when the desktop client retrieves results by polling.
Supply a callback endpoint you control; hosting and reachability remain the
endpoint owner's responsibility. HTTP and HTTPS callbacks may contain a
provider-required query token, custom port, IP literal, or local hostname.
Malformed URLs, fragments, embedded credentials, whitespace, and values that
reflect the API key are rejected. Live Smith never contacts the callback URL.

The connection exposes prompt-based `generate_music` in non-custom mode, with an
instrumental flag and up to 3,000 prompt characters. The integration defaults to
`V6`; a saved supported model ID can select another published version. The model
field lists the adapter's supported IDs and also accepts typed input, which is
validated against that same list.
Explicit duration, custom lyric mode, covers and extensions are not part of this
operation. Returned task IDs are persisted before polling. One or two final
tracks are saved as music results; Resume queries the original task. The first
completed response binds each result role to its remote track ID. Resume
rejects changed track identities while allowing reordered
responses and refreshed download URLs. The published protocol has no
cancellation operation, so Stop ends the local wait without claiming a refund
or remote cancellation.

Downloads accept the HTTP or HTTPS URL returned by the authenticated task result,
including signed queries, custom ports, IP addresses, and changing CDN hosts.
They never carry the API key, Cookie, referrer, or browser credentials and never
follow redirects. Malformed, embedded-credential, credential-reflecting, non-HTTP,
and fragment-bearing URLs are rejected.

SunoAPI.org requires its own API key. The Suno.com website connection below uses
a separately imported account session.

### Suno.com website sign-in

**Suno.com subscription (experimental)** uses a `suno.com` account through
manual session Cookie import. It operates independently of Suno Platform and
SunoAPI.org and works with the user's chosen browser.
On macOS and Windows, the website action opens `https://suno.com/create` using
the system default browser and its existing login state. Google login and
sign-in verification remain there, under the user's control. Generation
verification uses the separate in-app workflow below.

To import the session Cookie:

1. Add a Suno connection in **Settings → Extensions → Audio services** and open Suno.
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

Treat the Cookie like a password and enter it only in the local settings form.
The app sends the normalized Cookie only to fixed Suno authentication hosts for
verification and short-lived API token exchange. Its private local record stays
outside model context, public settings, and dialog state. Files have restricted
access permissions and remain unencrypted by Live Smith. Each saved audio connection
owns its own Cookie, so multiple Suno accounts can coexist with the browser
profiles already in use.
To connect a different account, log into it in the browser/profile of your choice
and explicitly import its own Cookie into a different named connection.

Successful verification displays account identity. Open dialogs share verification
results, including failures, for one extension activation. That evidence survives
dialog closure. After the extension host restarts, saved connections require a
new check to show verified status. Expired sessions require a fresh Cookie import.
Website traffic uses the browser's network configuration;
app verification and music requests use Live Smith's saved API proxy setting.

**Clear local Cookie** removes only that connection's local Cookie. The browser
login and remote Suno session remain active. Removing the connection or changing
its provider also clears its saved Cookie; cleanup failure prevents the ownership
change. A later settings-write failure can leave the old connection disconnected.
Closing Live Smith does not close the browser. Legacy managed browser directories
are not read, imported or deleted by this workflow.

The experimental adapter implements a bounded subset of the unofficial Suno web
client's `v2-web` contract. Generation availability depends on account
entitlements, credits, security checks, and [Suno's terms](https://suno.com/terms).
Website and policy changes can make this connection unavailable.

- `generate_music`: description mode (up to 3000 characters), or `options.mode:
  "custom"` with literal lyrics (up to 5000, empty for instrumentals), title
  (100), styles and excluded styles (1000 each), Weirdness and Style Influence
  (0–100), male or female vocal gender, a 10–480 second duration on catalog
  models that report version 6 support, and an existing Persona ID. Account model
  limits can be lower and are checked before submission. Sliders, vocal gender,
  and duration map to structured request fields. Instrumental
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
  existing lineage on the same account. It requires a completed, untrashed
  extension and an available whole-song action. These operations
  can consume credits and never import to Live without a separate scoped Apply.
- `generate_sound_sample`: a sound description of up to 500 characters, One Shot
  or Loop, optional integer BPM (1–300), and optional major/minor key. It uses
  the website's structured Sounds fields and returns the acknowledged variants;
  it does not promise a fixed duration.
- `cover_music`: a permitted observed source, optional source interval, lyrics,
  styles and generation controls. Source permission comes from the account's
  action configuration, with the website's ownership/remix rules as fallback.
- `remaster_music`: an observed source and an available remaster model, with
  optional Subtle, Normal or High variation when that model supports it. The
  remaster catalog is separate from the ordinary generation-model catalog.
- `upload_music`: a current attachment, saved Session asset or isolated
  Arrangement source, plus explicit upload-rights confirmation. The source is
  frozen locally before transfer. The upload checks account duration limits and
  saves a receipt after each confirmed remote stage. Recovery continues only
  from a safe acknowledged stage. Stopping before a remote request starts
  preserves that stage; uncertain mutations are never repeated. An upload
  paused after creation but before transfer completes requires a new upload
  because its temporary storage authorization is not saved. The completed Suno
  clip becomes available to this connection's creation tools.
- `add_vocals` and `add_instrumental`: a permitted source, lyrics/styles and
  supported generation controls. The website's source-type and account action
  rules determine which operation is available.
- `replace_music_section`: an observed source, replacement interval, optional
  context interval and duration, and replacement lyrics. Vocal sources require
  existing lyric alignment; preparation reads alignment without starting a new
  alignment request. `finish_music_replacement` joins one explicitly selected
  completed candidate into its source song. Generation and finalization are
  separate tasks; Live Smith never chooses a candidate automatically.
- `extract_music_stems`: native Suno extraction of twelve instrument groups from
  a permitted observed song. Instrument identities come from the returned clip
  metadata. Live Smith retains up to two returned banks (24 outputs), including
  quiet tracks, with separate identities for alternate versions. Each output can
  be previewed and downloaded independently; the download allowance belongs to
  the source song identified by that stem's lineage.
- `write_lyrics`: generate lyrics from an empty selection, rewrite selected text
  with surrounding context, or request alternatives. Optional title, styles,
  lyric-model selection and supported thinking controls use Suno's separate
  lyric-writing API. `inspect_lyric_models` reads that model catalog. Text and
  receipt IDs are retained in Session tool history for subsequent chat or song
  creation. A lost submission reply remains unconfirmed and is never retried
  automatically.

Audio Influence is available for supported reference-based requests and maps to
the website's structured audio-weight slider. Every operation is also available
through **Session → Tools → connection → tool → Open controls**. Manual calls
use the same schemas, source observations and durable jobs as chat calls, without
requesting a chat-model response. Inputs and textual results enter Session tool
history; audio results appear in the Session audio shelf.

Use **Music version → Load versions** in a saved Suno connection to read that
account's catalog directly; no chat request or generation credits are required,
and a saved connection can remain disabled during setup. **Follow account
default** uses its current usable default; choosing a named version fixes that
connection's model after **Save**. Only versions with known usable access can be
selected from the catalog. A saved ID missing from a newly loaded catalog
remains visible for explicit review.
**Advanced model ID** retains explicit ID entry; **Discard** restores the saved
connection without a settings write. Catalogs stay in the current dialog and
are invalidated by explicit authentication lifecycle changes or a different
account. A verified automatic Cookie rotation preserves the catalog. Catalogs
stay in memory and selections remain scoped to the same connection.
Every Suno.com API request carries a fresh bounded `browser-token`, the imported
device identifier when available (otherwise a generated private UUID persisted
with that connection), and the Suno Origin/Referer used by the web client. `__client`
credentials use Clerk's active-client and token endpoints. `__session`
credentials use the session `touch` endpoint on the current auth host, with the
observed legacy Clerk host as a non-paid compatibility fallback; they rotate the
returned session JWT, preserve updated Clerk timestamps when supplied, and
atomically save the verified rotation without replacing a concurrent reimport.
Generation requests to the website's shared generation endpoint are preceded by
account/parameter validation and a CAPTCHA check. An explicit no-challenge
response or a fresh result from the requested official component permits
submission. A challenge waits for the user to complete the requested component
in Live Smith's verification window. Paid submissions run once. Stop allows a
bounded grace period to preserve a returned receipt; remote cancellation and
refunds remain provider decisions.

HTTP failures retain the numeric status and, when available, a bounded,
structured provider diagnostic: error codes/types and validation field paths.
Arbitrary provider messages, rejected input, and server debug data stay private.
An already received HTTP rejection remains authoritative even when its error
body is unavailable or interrupted. A diagnostic supplies information only;
another generation submission requires explicit user action.

#### Online preview, file downloads and Live import

Suno generation completion is separate from a file download. **Session audio**,
above the chat composer, holds the active Session's processing jobs and results;
it is separate from application connection settings and collapses when switching
Sessions. A generated song can be ready for online listening without a local audio
asset. The result card offers an explicitly opened Suno embedded player at
`https://suno.com/embed/{clip_id}`.
Each job shows a creation time, chronological number and newest marker; the optional
custom title is retained without lyrics or other prompt content. Each version's
row has a Preview control that opens or closes playback. Downloaded
versions use local playback in that same row. Generation completion and local
download count are displayed separately. Earlier failed tasks retain their own
chronological position.
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
browser with a two-minute credential limited to that file. Local export remains
available while the Session's model request runs. Keep Live Smith open until
the browser finishes the download. Exporting or downloading an already saved
output reuses the local asset. Importing into Live requires this local asset
and remains a separate scoped Apply operation. When asked, a verified audio-input
Profile can also receive the exact local WAV or MP3 through
`listen_to_audio_asset`, subject to the request's binary-count and byte limits.
The tool result text is recorded before its untrusted audio part is admitted, and
the bytes are not persisted in conversation events. An online preview cannot be
used as either a Live import source or model input.

#### In-app human verification and selected-output download

On macOS 14 or later, a challenged music generation or extension opens Live
Smith's native verification window. It loads an `https://suno.com` document and
uses only the
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
a bounded wait and supports manual retry. The validated generation receipt
confirms server acceptance. Unknown challenge versions and unsupported
hosts fail before submitting to the shared generation endpoint. Get Whole Song
and completed replacement concatenation use the website's direct `concat/v2`
flow after source validation, without a generation CAPTCHA preflight. Remaster
similarly uses its dedicated endpoint. All retain explicit dispatch authorization,
bounded receipt preservation and no automatic retry of an unknown outcome.

Retrieval and Resume check the original Suno songs without automatically
downloading them. A generated song can be complete but still unavailable for
file export. The separate download action checks explicit download permission;
with the user's confirmation it can authorize one locked song through
`POST /api/download/authorize`, then recheck that same song's permission. A
missing or uncertain authorization response is never replayed automatically.
The adapter requests the prepared MP3 through
`GET /api/download/clip/{clip_id}?format=mp3`. Preparation and transfer have a cancellable
ten-minute deadline; only the Suno CDNs and the exact
`suno-data-uploads.s3.amazonaws.com` bucket returned by authorized MP3 preparation
are accepted over HTTPS, without API credentials or redirects.
Missing permission, a failed preparation or an unfamiliar host stops that output
with a recoverable error instead of falling back to an alternate media endpoint.

If one song's download fails, its remote identity and already-saved sibling
results remain available. Retry that song's explicit download to check its
permission and collect it without another generation. **Resume** checks remote
generation state and preserves download allowance.

Suno returns individual clip IDs. All acknowledged IDs and their output roles
are saved before polling. Missing/pending clips remain pending; successful clips
are retained when a sibling fails. Recovery uses the same IDs without generating
again. Renewing a Cookie for the same verified account permits recovery; switching
the connection to another account does not. Saved files remain recoverable locally.

The Suno.com adapter does not currently map microphone recording,
Voice enrollment, custom-model training, Inspo/My Taste,
or Suno Studio workspace editing and publishing. Ableton editing, configured
LALAL.AI stem tools and ElevenLabs sound-effect tools can be used independently
or combined with the supported Suno operations.

### Stem separation

LALAL.AI uses its Public API v1 connection for the separation operation.

`separate_stems` accepts a non-empty selection of vocals, drums, bass, piano,
electric guitar, and acoustic guitar. LALAL.AI processes the selected stems and
also returns the remaining mix. Its multistem endpoint charges processing minutes
for each requested stem. The adapter follows
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
total and 40 processing jobs per Session. See [input mapping](#input-mapping)
for the separate inline model budget. Original WAV/MP3 bytes reach the selected
protocol adapter, which owns their wire encoding. LALAL.AI keeps WAV sources lossless
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
is not presented as an available result. LALAL.AI's
[status API](https://www.lalal.ai/api/v1/openapi.json) retains a task for 24 hours
after it finishes. Remote recovery can therefore expire while downloaded local
results remain available.
Status polling is coordinated by credential owner within one storage scope, with
a small margin below LALAL.AI's published 30-checks-per-minute account limit.
Provider-confirmed terminal failures and failed sibling outputs are retained as
terminal state and are not presented as recoverable work.

Stop and window closure interrupt local processing. Providers with a cancellation
operation receive a bounded cancellation request for an accepted task. Remote
cancellation remains unconfirmed until the provider reports it. After restart, a
recoverable job can be explicitly resumed using its original Integration
Connection. Each job retains its Plugin/tool identity, original Connection ID,
and credential-owner fingerprint. Changing a Connection key or selecting another
account cannot transfer an old job.
Recovering a result never restarts a stopped Live edit plan.

If Stop arrives after a separation submission has started, the client allows
up to three seconds to receive its task receipt before aborting the request.
This preserves a returned task ID for cancellation and recovery, without
continuing the separation workflow. An absent receipt remains an unknown outcome.

Generation and separation save results to the Session. A separate Live import
uses the saved audio result as a SampleSource and retains the approval policy, complete
Edit Scope checks, mutation queue, and state revalidation. Creating tracks also
requires Structure scope. Source timing metadata describes the original snapshot;
it does not establish sample-accurate alignment or authorize an edit to a changed
target. Inspect timing and Warp behavior in Live when importing stems.

## Credential storage

当前凭据保存在私有 SQLite 数据库中。逻辑记录 `live-smith-settings.json` 保存
Direct API Profile 的完整连接，以及按 Connection/Plugin 身份隔离的内置 Plugin
连接凭据。`oauth/credentials.json` 记录按 Profile ID/provider 二元组保存模型
OAuth token；Suno.com 会话材料使用独立的 Connection 记录。

首次迁移保留旧凭据原件，后续修改和删除作用于数据库记录。数据库与历史原件均按
私有凭据维护，源代码、日志、fixture、截图和共享产物只使用合成测试数据。
备份与旧版恢复的边界见[开发数据指南](DEVELOPMENT.md#development-data)，
数据库提交与迁移契约见[架构说明](ARCHITECTURE.md#durable-local-storage)。

Provider failures are redacted with both the active Direct API secret set and
the send-scoped OAuth credential. Errors retain useful provider/protocol/status
context without returning authorization headers, tokens, request bodies, or raw
credential-bearing causes.
