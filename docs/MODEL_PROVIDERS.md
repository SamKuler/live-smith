# Model Profiles and Connection Backends

This reference covers connection ownership, Profile configuration, capability
evidence, and provider request behavior. See the [README](../README.md) for the
product overview, [Architecture](ARCHITECTURE.md) for cross-module contracts,
and [Development](DEVELOPMENT.md) for installation, verification, and packaging.

Every Profile chooses one of two explicit connection kinds:

- `direct-api` sends a provider protocol directly over HTTP/SSE with a saved
  API key (except unauthenticated loopback endpoints).
- `codex-subscription` appears as **ChatGPT subscription (Experimental)** and
  delegates ChatGPT authentication and model execution to a locally managed
  official Codex CLI process.

The Direct API connection has two API families and three supported protocol
combinations:

| API family | API mode |
| --- | --- |
| OpenAI | Responses |
| OpenAI | Chat Completions |
| Anthropic | Messages |

There are no Direct API endpoint or vendor presets. A compatible service is
configured as an ordinary Direct API Profile for the OpenAI or Anthropic
protocol family it implements, with its own base URL, model, API mode, and
parameters. The managed Codex connection is a backend boundary, not another API
mode and not an OpenAI-compatible endpoint preset.

## Connection backends

### Direct API

The `direct-api` branch owns `apiFamily`, `apiMode`, `baseUrl`, and `apiKey`.
`src/model/registry.ts` selects one of the three `ModelTransport`
implementations described under [API behavior](#api-behavior). Live Smith owns
request mapping, SSE parsing, protocol replay, and error redaction. Environment
variables and `.env` files are never credential or connection fallbacks.

#### Errors, bounds, and cancellation

For all three Direct API modes, a non-2xx HTTP response reports the API
family/mode, status code, and a fixed local `request failed` description. Its
remote status text and response body are untrusted and are never read or
persisted, because a provider or proxy can echo prompts, Live context, replay
state, or Extra Body fields in that body. Error events inside a successful SSE
response likewise expose only fixed protocol context, never an arbitrary
provider message. Transport errors remove URL query and fragment data and
redact the configured API key plus every Base URL query or fragment value,
including when a cause echoes a value separately from its URL.

Successful Direct API JSON responses are streamed through a 16 MiB byte
budget, and an SSE event must reach a delimiter within 1 MiB. The shared model
catalog contract accepts at most 1,000 unique, bounded model records; paginated
discovery stops after 20 pages. Invalid, ambiguous, or oversized catalogs fail
before they can replace a modal projection or persistent Direct API cache.
Stream cancellation is best-effort and nonblocking: Live Smith requests it once
but never waits on a provider- or host-controlled cancellation Promise before
propagating the original abort, size, read, or protocol result.

#### Connection-loss recovery

Direct model generation classifies only a rejected Fetch call, a rejected
response-body read, or a clean streaming EOF before the mode's required
terminal event as a typed connection loss. Abort is checked first and retains
its exact reason. HTTP status failures, explicit provider error events,
malformed or contradictory protocol data, early `[DONE]`, oversized data, and
consumer callback failures remain ordinary failures and are not reconnected.
For streaming compatibility, an absent `Content-Type` is accepted when the
body is valid SSE; an explicitly incompatible media type is a non-retryable
protocol error.

The agent may rebuild only the current unaccepted Direct API `askModel`
logical response. After the initial outer attempt it makes at most five outer
reconnect attempts, with cancellable waits of 0.5, 1, 2, 4, and 8 seconds. A
transport may still use multiple HTTP exchanges inside one outer attempt, such
as Anthropic `pause_turn` continuation; those exchanges do not consume separate
reconnect attempts. The agent does not restart `/send`, append the prompt again,
replay durable Session events, or re-execute an accepted client tool or Live
mutation. An OpenAI Responses output-limit continuation chain remains one
unfinished logical response until the loop accepts its final non-continuation
turn. ChatGPT subscription failures never enter this retry path; the managed
process, reservation, and quota lifecycle continue to fail closed.

Provider-hosted Web Search remains durable-first and read-only. Search IDs
observed before a connection loss continue to consume the send's 20-action
budget, so each rebuilt request receives only the remaining allowance. A
provider may perform a new search under a new ID after reconnection, but that
cannot authorize or replay a client tool or Live mutation.

### ChatGPT subscription (Experimental)

#### Runtime and billing

The `codex-subscription` branch owns only the fixed provider identity `openai`;
the official Codex CLI owns authentication. Live Smith requires
`@openai/codex@0.148.x` installed globally with npm and its `codex` launcher on
`PATH`. The resolver binds that launcher to the discovered global package,
checks only its nested optional platform package, the same npm scope's hoisted
package, then the base-package vendor fallback, and launches the resulting
native `codex app-server` payload directly over stdio. It never executes the
JavaScript or command shim, consults `NODE_PATH`, or accepts a platform package
outside the discovered installation. It validates the package layout, reported
`0.148.x` protocol line, and isolated home, not cryptographic binary provenance.
Local npm bins, standalone binaries, and opaque package-manager shims are
unsupported because they cannot be bound to an owned native App Server payload.

App Server's `chatgptDeviceCode` flow consumes the signed-in account's applicable
Codex subscription limits. Live Smith does not convert ChatGPT OAuth into a
Bearer token for `/v1/responses`, accept App Server's API-key login mode, or
silently fall back to separately billed API usage. API-key billing requires an
explicit `direct-api` Profile.

#### Runtime isolation

The child receives `CODEX_HOME=<storageDirectory>/codex-subscription` and starts
only after confirming the private runtime workspace beneath that directory is
empty. It does not read or overwrite `~/.codex/auth.json`. OpenAI, ChatGPT,
Codex, Anthropic, Claude, and AWS credentials are excluded by a stricter rule:
the child receives only allowlisted executable lookup, operating-system,
temporary-directory, and locale variables, plus Live Smith's controlled
`CODEX_HOME`. Ambient proxy variables, custom-CA settings, provider credentials,
and arbitrary parent-process variables are not inherited. The CLI file
credential store and ChatGPT-only login method are forced, and initialization
must report the canonical isolated home.
Launch overrides pin the official ChatGPT/OpenAI URLs, clear configured MCP
servers and custom model providers, and reject any persistent `config.toml`,
symlinked child directory, or linked/non-regular `auth.json`; an existing
isolated auth file is tightened to `0600` on POSIX. Each thread pins the
built-in OpenAI provider without fallback. The official model endpoint is
separate from a randomized private loopback ChatGPT product-metadata responder.
The responder returns only attribution-disabled settings and an empty cloud
bundle, rejects every other route, and closes with the child; Codex's official
device-login and refresh/revoke routes remain unchanged. This blocks the
external metadata requests that exact 0.148's Git-attribution and cloud-config
extensions can otherwise issue, and prevents attribution developer
instructions. Neither official routes nor the local policy responder inherit
proxy or custom-CA routing. Supporting an enterprise proxy would require an
explicit trusted configuration rather than ambient host state. A shell or
normal Codex configuration therefore cannot silently change the intended
execution, credential store, or billing identity. Credentials remain App
Server-owned and never enter a Profile, model request, Session event, or Live
Smith log.

An empty cloud bundle is not permission to ignore workspace management.
Every workspace-managed and unknown ChatGPT plan type is ineligible for this
experimental backend and fails before model discovery or thread creation, while
Check and Sign out remain available. Codex may write an identity-scoped cache
of that empty local result under the isolated managed home for a rejected
account; no delivered organization policy is accepted or executed.

This backend deliberately removes Codex's agent capabilities. Shell and coding
tools, code mode, browser/computer use, MCP, apps, plugins, Codex Skills,
workspace dependencies, hooks, image generation, multi-agent behavior, and Web
Search are disabled. Memory use and generation, notifications, goals/planning,
request-user-input, automatic/bundled Codex Skill instructions, and MCP
dependency/elicitation paths are forced off too. Codex's permission, apps,
collaboration-mode, and environment instruction blocks plus both Skill/MCP
orchestrators are disabled. Project-document discovery is set to zero bytes and
project-root markers are empty, so parent `AGENTS.md` and `.codex/config.toml`
files cannot enter the managed request. CLI history persistence, analytics,
feedback, update checks, OTEL export, remote plugins/sharing, in-app updates,
and remote compaction v2 are disabled. Each model call uses an ephemeral
thread, no workspace roots or environments, empty developer instructions, a
read-only sandbox, `approvalPolicy: never`, and no rollout path. The App Server
output schema constrains the envelope and tool-name enum. The backend rejects
runtime-tool items, unknown names, and malformed, non-object, or oversized
argument strings. The provider-neutral outer loop remains the
authoritative action-schema validator and the only component that executes Live
observation or mutation tools.

#### Authentication and process ownership

All subscription Profiles under one Ableton storage directory share one isolated
ChatGPT login. Deleting a Profile does not sign out; use the explicit **Sign
out** action, which requires UI confirmation.

All modals for one storage directory share a process-wide managed auth/send
fence. An auth mutation cannot start during a ChatGPT subscription send; a
pending device flow remains owned by its modal and blocks other auth flows and
subscription sends until a Check observes signed-in, signed-out, or definitive
failure, cancellation or sign-out succeeds, or the owner closes.
Direct-only state hydration, catalog access, and sends stay outside this fence
and do not acquire the managed backend registry; they neither wait for managed
auth mutations nor inspect managed health. State responses may read only the
credential-free auth generation so stale subscription projections can be
discarded without entering managed use.
`storage/scope.ts` resolves the Ableton-provided Live Smith storage directory's
longest existing ancestor before appending a missing suffix. That one canonical
directory owns persistence transactions, Session mutation queues, cross-modal
settings/approval events, the auth/send fence, one reference-counted backend
manager, and one App Server. A real path and symlink alias therefore cannot
share `auth.json` while splitting storage writes or notifications. The shared
process has one refresh lock, in-memory credential owner, model worker, and
cache writer. The last managed lease closes it; a modal that owns an unfinished
device flow retires it before releasing pending ownership.

Each definitive Check and every login/logout attempt advances the generation
that invalidates modal-only managed auth/catalog projections. Each modal clears
them before its next subscription state, auth, discovery, or send operation;
Direct API catalogs remain independent. Successful mutations update the shared
process; an unknown outcome retires its exact backend to confirmed exit before
advancing the generation or releasing the transition. Peer managed auth,
subscription discovery, and subscription-send paths wait behind that
storage-wide barrier; an unconfirmed exit poisons subscription use until
extension-process restart.
Matching App Server login-completion notifications clear failed/expired backend
flows with fixed safe text, and a definitive failure exposes a new sign-in
attempt without requiring the modal to close. Any modal's later authoritative
signed-in, signed-out, or definitive-failure read reconciles global pending
ownership once; pending and non-definitive results keep it locked. Pending-login
state and Check callers share one storage-wide readiness refresh, and send/auth
mutation remain blocked until it settles. Caller cancellation stops only that
wait; RPC timeout, terminal failure, or last-owner backend close bounds the
shared read. Modal `/chat` and `/state` builds own host-provided cancellation
signals; disconnect
or close aborts and awaits those reads. Closing the pending-login owner also
aborts the fence-owned shared reconciliation before backend retirement, so a
detached state read cannot delay cleanup or another modal's auth operation.
Each shared Codex startup slot likewise owns a host cancellation controller.
Canceling one caller stops only that caller's wait; retiring the slot or
releasing its final owner aborts startup and waits for the child process and
metadata firewall to close.

#### Catalog restoration and send admission

Explicit Check, Settings discovery, loading a missing composer model/reasoning
projection, and send readiness request credential refresh, while ordinary
signed-in or signed-out state hydration is passive.

When a window opens with an active saved subscription Profile, an eligible
signed-in account, and no catalog, the client makes one background capability
read. Typing, Session navigation, and ordinary Send admission do not wait for
this read; Send still performs the readiness checks below. Repeated requests
for the same Profile revision and auth generation share the pending read.
It restores Settings and composer evidence for the configured models without
saving Profile settings or changing the Session model selection. Late results
cannot restore a previous Profile or account, or switch the active Session.
If the read fails, the interface stays usable with unverified capabilities;
opening the composer model selector or choosing Settings' **Load Models** retries
explicitly. Passive `/state` reads do not list models.
After any successful Session command changes the active Session, the client
starts the same background read when the current subscription catalog is still
missing. This lets a restored Session materialize its saved model and reasoning
override without waiting for focus on the model selector.
Each state response derives its runtime summary and catalog-ready flag from one
auth-generation catalog snapshot, so concurrent Session navigation cannot pair
a fallback runtime with a later ready flag.

Before persisting every new subscription prompt, the server confirms an eligible
signed-in account, reads the current App Server model catalog, and requires the
saved Session-selected model in it. Readiness failures are unpersisted, so Queue
pauses its head instead of draining. Normalized catalogs remain modal-scoped
and never enter Live Smith's persistent model cache. The auth-generation value
projected to the UI is non-sensitive and process-local; a window discards
older-account Draft metadata when authoritative state arrives.

#### Turn lifecycle

The RPC reader accepts a line up to twice the locally bounded encoded
`turn/start` payload, so valid attachment echoes are supported without
unbounded framing. Oversized context fails before `thread/start`. Connection
failure, unconfirmed turn start, or unconfirmed interruption closes the owned
process rather than leaving quota-consuming work orphaned.

Both `thread/start` and `turn/start` send `serviceTier: null`; with exact 0.148's
`fast_mode` disabled, Live Smith requires a null effective response tier before
allowing the turn. The backend also correlates
`thread/tokenUsage/updated` to the exact owned ephemeral thread and turn. A
valid `last.totalTokens` plus non-null `modelContextWindow` becomes the latest
accepted-turn context meter; a valid null window means the meter remains
unavailable. Terminal turns call `thread/unsubscribe`. A backend
admits at most four concurrent turns and recycles after eight created threads
once its active turns and first-turn reservations drain. Threshold recycling
rejects new reservations while already-admitted continuations finish. At
instantaneous capacity, continuations belonging to persisted sends wait FIFO
and prevent new first-turn reservations from overtaking them; each waiter shares
its send's abort lifetime. Unsafe cleanup or a forbidden App Server runtime
item blocks further turns and retires the process after owned work drains.
Runtime terminal events retire only their matching manager slot. Replacement
waits for confirmed child exit, and an unconfirmed SIGKILL poisons the shared
storage boundary rather than permitting overlapping ownership. Preflight
reserves first-turn capacity before prompt persistence; recycling waits for
that reservation. Later model steps reacquire the current
manager slot, wait for fair admission on an eligible live backend when
necessary, and otherwise hand off to a confirmed replacement. Child `error`,
`exit`, and `close` share one terminal observation, so a missing executable's
`error` followed by `close` is reported as unavailable without unnecessary
shutdown escalation or storage poison.

#### Model capabilities and upstream metadata

Codex subscription Profiles do not support Direct API temperature
or output-token controls, reasoning token budgets, provider-hosted tools,
capability overrides, or Extra Body. Reasoning cannot be set to Disabled. Model
discovery and supported reasoning-effort choices, including `ultra` when
advertised, come from the signed-in App Server catalog rather than the OpenAI
`/v1/models` endpoint. Unknown effort values fail discovery instead of being
silently discarded. Persisted `parameters` contain only reasoning mode and
optional effort; App Server owns the output-token limit.

Codex 0.148 starts an online model-catalog refresh worker with App Server and
repeats it every three minutes. Successful refreshes may write
`models_cache.json` under the isolated managed `CODEX_HOME`; `model/list` uses a
fresh entry for up to five minutes. This release exposes no supported
cache/worker-off mode that retains dynamic account-aware discovery. This is
model metadata traffic, not an inference turn. Live Smith does not copy the
file into settings, Sessions, events, or its Direct API model cache. The
upstream file has no account key and is not an account-scoped cache.

This connection is experimental and uses a version-specific App Server
protocol. Package and protocol validation do not establish subprocess
compatibility with Ableton's Extension Host. Startup and shutdown require
separate [target-host verification](DEVELOPMENT.md#verification).

Official references: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[Codex and API-key billing](https://learn.chatgpt.com/docs/pricing),
[Codex App Server](https://learn.chatgpt.com/docs/app-server), and
[Codex CLI releases](https://github.com/openai/codex/releases).

### Anthropic subscription boundary

Claude/Anthropic subscription login is not implemented. Anthropic's official
credential policy says third-party products should use Claude Console API keys
or supported cloud providers and does not permit offering Claude.ai login or
routing consumer subscription credentials on behalf of users without approval.
Until Anthropic grants Live Smith prior written approval, every Claude
subscription tier is outside this product's connection surface. Live Smith does
not read `~/.claude`, reuse Claude Code OAuth, invoke private Claude.ai APIs, or
wrap Claude Code/Agent SDK as a hidden transport. Anthropic support remains the
Direct API `Anthropic Messages` mode with a Console API key. Paid Claude plans
and Claude API billing are separate.

Official references: [Claude Code authentication and credential-use
policy](https://code.claude.com/docs/en/legal-and-compliance) and
[Claude subscription/API billing separation](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console).

## Named profiles

Each Profile stores one complete connection and one or more configured models:

- a name and discriminated `direct-api` or `codex-subscription` connection;
- a non-empty model configuration list plus one default model;
- for Direct API, API family/mode and base URL, plus an API key unless the
  endpoint is local loopback;
- per-model, capability-aware generation controls;
- for each Direct API model, maximum output tokens, optional temperature or
  token-budget thinking, optional provider-hosted Web Search, capability
  overrides, and Extra Body JSON.

Add and Duplicate create an unsaved draft. **Save & Use** validates and persists
the entire draft and makes it active. Changing session or sending a message does
not save the draft. Send remains disabled until the draft is saved or discarded.
**Load Models** checks the Draft connection and refreshes the provider catalog.
A Direct API reload adds newly discovered IDs when the Draft model collection
still belongs to that same connection; changing kind, family, mode, endpoint, or
API key replaces the old connection's collection. A ChatGPT subscription reload
reconciles to the complete current account catalog, removing unavailable IDs
while preserving reasoning settings for IDs that remain. The first available
entry becomes the default only when the prior default is gone. An empty
first-run model slot is reused so generation values entered before the first
load are preserved. Only a matching command receipt may apply an operation, so
a failed load cannot reuse an older cached catalog. Verified capability limits
may adjust incompatible Draft values; explicit capability overrides remain
authoritative.
A catalog contains at most 1,000 entries, while a Profile may contain at most
2,000 models so one existing/manual set can coexist with one complete catalog
when both belong to the same connection.
Direct API discovery metadata is stored in a credential-safe connection hash
slot, so probing an unsaved connection cannot evict the still-saved
connection's catalog. Existing Profile-ID cache files remain exact-match
read-only fallbacks until that connection is discovered again.
An edit carries a fixed-length SHA-256 revision of the normalized Saved Profile
from which its Draft started. The storage transaction recomputes that same
Profile's revision and rejects a mismatch, instead of silently replacing a newer
model collection. Only the active Profile revision is projected to the dialog;
edits to a different Profile do not create false conflicts.
Profile Save, activation, and deletion also publish a credential-free
invalidation to peer dialogs. A peer disables Send until a full authoritative
state refresh has replaced its runtime label and Settings projection; a failed
refresh remains blocked rather than sending through a different saved Profile.
Switching a saved Profile switches the connection. The composer selects one of
that Profile's configured models for the active Session; the selection persists
only Profile ID, model ID, and an optional reasoning-effort override. It never
copies connection fields, credentials, discovery metadata, or request JSON into
the Session. Subscription selections hold the managed-auth fence through their
commit, and every selection is re-materialized and validated from the current
saved model configuration inside the final storage transaction.
Restoring a Session preserves that selection but does not activate its saved
Profile. If the current active Profile differs, or no longer contains the saved
model, runtime resolution uses the active Profile's default model and omits the
historical reasoning override until its matching Profile is active again.

The implementation keeps three Profile representations explicit:

- `DraftProfile` is the editable, possibly incomplete connection and model
  collection. **Load Models** checks only its connection fields, so the name
  and model list may still be incomplete.
- `SavedProfile` is the fully validated connection, default model, and model
  configuration collection persisted by Profile CRUD.
- `RuntimeProfile` contains only the active saved connection identity, the one
  model configuration selected for the Session, and capabilities resolved for
  that model. Transports never receive the persisted model collection.

The Settings discovery projection belongs only to the Draft editor. The
composer reads a separate projection built from the active Saved Profile and
active Session, so an unsaved Draft cannot change a conversation's runtime
model or reasoning label. Connection routing reads the discriminant and is
never inferred from a model name.

### Storage compatibility

The first run contains no Profiles. Schema-version-2 flat Profiles first
migrate to the nested version-3 `direct-api` shape. Current schema version 5
also reads the other historical development-v3 shape containing flat Profiles
plus Queue/Steer behavior and a canonical decimal-string revision. Version 3 is
discriminated before validation: both follow-up fields mean the flat shape;
neither means the nested subscription shape. Partial fields, mixed Profile
shapes, and unknown fields fail closed. Migration preserves API family, mode,
base URL, key, model, supported parameters, active identity, and any Queue/Steer
revision; the nested v3 shape receives Queue at revision `"0"`. Version 4's
single model, parameters, and Advanced settings become the sole model
configuration and default model in version 5. Reads do not rewrite.
Historical schema-v3/v4 subscription Profiles may contain the former fixed
`maxOutputTokens` placeholder. Decoding removes that unconsumed field, and the
next authorized settings write persists the connection-specific shape.

## API behavior

### Follow-up modes

Queue and Steer are deliberately different lifecycles. Queue is the global
default: the UI holds each pending item for its Session, waits for the current
send to become terminal, and then starts a new ordinary send with a new
correlation ID. That turn reloads the active saved Profile, the Session's model
and reasoning selection, auth generation, capabilities, Skills, attachments,
Session history, recovery state, and Approval state. Queue text never enters
the preceding provider request or its local replay state.

Steer targets the active send instead. The chosen default is read when each
follow-up is submitted, so a settings change applies immediately to the next
item without changing items already queued or submitted. Neither mode is sent as
a provider field or added to the strict `/send` body. The persisted setting's
canonical decimal-string revision and bridge replay behavior are
UI/orchestration metadata only; they never enter provider request or replay
state.

In-loop steering is provider-neutral. The three protocol-specific sections
after it describe Direct API transports; the managed Codex backend normalizes
its App Server result into the same `ModelTurn` boundary but does not pass
through those HTTP serializers.

### In-loop steering

Steering has one provider-neutral meaning: bounded, persisted user guidance is
added to the active agent send at the next protocol-safe boundary. It is not a
provider-native continuation feature. Each model call receives a child
cancellation signal; Steer cancels only that call, while Stop cancels the parent
send. Partial text, tool arguments, reasoning state, and an Anthropic
`pause_turn` chain from an interrupted call are discarded. The next request is
rebuilt from the last complete locally accepted context plus the new user
message. Completed hosted searches remain persisted and continue to count
against the send budget.

This also applies between OpenAI Responses output-limit continuation calls. The
agent loop tracks the first message in the unfinished continuation chain and
removes that entire canonical-message suffix before installing steering, so an
obsolete partial function call or encrypted reasoning item cannot be replayed
ahead of the new user message. Without steering, a completed continuation chain
remains available for normal local replay.

When a complete assistant tool turn was already accepted, every tool call is
closed with a real or explicit skipped result before steering is replayed:

- OpenAI Responses places the user message after all linked
  `function_call_output` items.
- OpenAI Chat Completions places it after all `role: tool` messages.
- Anthropic Messages places `tool_result` blocks first and steering text after
  them in the same user content block.

Steering is text-only. It does not resnapshot the Profile, selected model or
reasoning, attachments, active Skills, capabilities, or Extra Body. Persistence
and retry are also provider-neutral: each accepted steering user event has a
storage receipt bound to the original send ID, steering ID, and prompt hash.
The dialog projection removes that storage-only hash and exposes a
correlation-only `steeringAck` on
the same event, so digest validation stays inside storage while incremental or
full-state delivery can resolve the matching UI attempt. Exact retries are idempotent,
including after the send has reached terminal state. An explicit unknown
persistence outcome keeps the same client steering ID until authoritative
Session state confirms presence or absence. While that receipt is unresolved,
the client permits only a byte-identical same-ID retry; edited guidance and
Queue submission remain blocked rather than abandoning a possibly committed
user event.

### OpenAI Responses

- Sends the protocol directly over HTTP/SSE without an OpenAI SDK runtime
  dependency.
- Uses `max_output_tokens` and `reasoning.effort`.
- Always sends `store: false`.
- Requests encrypted reasoning output when available.
- Replays local typed output items and links tool results with `call_id`.
- Maps an opted-in provider-neutral hosted search tool to `web_search`, keeps
  `web_search_call` items in local replay state, and exposes bounded
  `url_citation` sources to the Session timeline.
- Does not use `previous_response_id`.
- Treats `response.completed` and `response.incomplete` as terminal lifecycle
  events and cancels the reader without waiting for EOF or `[DONE]`.
- Replays an `incomplete: max_output_tokens` response locally and automatically
  continues it at most twice. Partial text and citations are retained, while
  a function call is executable only when the item itself is marked
  `completed`; partial call items are replayed but never executed.
- Rejects other incomplete reasons and rejects executable tool calls unless the
  overall response is complete and every call has a non-empty, unique protocol
  ID, a non-empty function name, and a string argument representation. A
  malformed declared call invalidates the entire turn even when text output is
  also present.

### OpenAI Chat Completions

- Sends the protocol directly over HTTP/SSE without an OpenAI SDK runtime
  dependency.
- Uses `max_completion_tokens` and `reasoning_effort`.
- Uses assistant `tool_calls` followed by `role: tool` messages linked by call
  ID. Signed Gemini tool turns also return the matching function name required
  by that compatibility extension.
- Requires a complete `stop` or `tool_calls` finish reason before returning a
  turn to the agent loop; truncated, filtered, unknown, and unterminated
  responses fail before any tool call can run.
- Preserves unknown JSON-compatible assistant fields for compatible endpoints
  that require them during later tool turns.
- Rejects missing, empty, or duplicate tool-call IDs, empty function names, and
  missing or non-string argument representations before any Live action can
  run. Every call must have type `function` and `tool_calls` must be an array.
  Compatible streams that omit per-call indexes use that delta's array order;
  a terminal `stop` is normalized to `tool_calls` only after one or more calls
  pass complete validation. Ordinary assistant text cannot hide a malformed or
  missing declared call.

### Anthropic Messages

- Requires a Direct API Profile and Claude Console API key for every remote
  endpoint; Claude subscription OAuth is not accepted as Messages API
  authentication.
- Uses `max_tokens`, content-block tools, and `tool_result` blocks.
- Sends the versioned Messages HTTP protocol directly and parses SSE events
  locally, without an Anthropic SDK runtime dependency.
- Supports adaptive thinking plus `output_config.effort` for models whose policy
  advertises it.
- Supports token-budget thinking for models whose policy advertises it.
- Replays complete assistant content blocks, including thinking signatures.
- Maps an opted-in provider-neutral hosted search tool to
  `web_search_20250305`, including a fixed local `max_uses` budget. Server tool
  calls, encrypted result content, and citation metadata are replayed unchanged.
- Completes and cancels the stream reader at the protocol-terminal
  `message_stop` event rather than requiring EOF or a nonstandard `[DONE]`.
- Requires a complete `end_turn`, `tool_use`, or `stop_sequence` stop reason.
  A server `pause_turn` is continued internally with the exact assistant
  content, up to three times; truncation, refusal, context exhaustion, unknown
  reasons, and missing terminal metadata fail before any client tool can run.
- Rejects missing, empty, or duplicate tool-use IDs, empty tool names, and
  non-object tool input before any Live action can run. Parsed `tool_use` blocks
  must agree bidirectionally with the terminal stop reason. Ordinary text blocks
  cannot hide a malformed or missing declared `tool_use` block.

### Image, document, and audio input mapping

Live Smith assembles user-added attachment context as provider-neutral input
parts before the first model turn. Assistant history remains text-only, while
current and historical user images are mapped to each protocol's native blocks:

- OpenAI Responses uses `input_text` and `input_image` with a base64 data URL.
- OpenAI Chat Completions uses `text` and `image_url` with a base64 data URL.
- Anthropic Messages uses `text` and a base64 `image` source block.
- ChatGPT subscription uses App Server's image input with a base64 data URL,
  but only after its signed-in model catalog declares image support.

The active saved Runtime Profile must resolve `inputs.image` to `true`; every
transport checks that capability again before making a network request. Image
file names, attachment IDs, and local storage paths are not sent in image
blocks.

PDF is the only native document part. When the active saved Runtime Profile
resolves `inputs.pdf` to `true`, OpenAI Responses maps it to `input_file` and
Anthropic Messages maps it to a base64 `document` source. OpenAI Chat
Completions and ChatGPT subscription reject native PDF input locally. These are
Live Smith input-mapping boundaries, not claims about every compatible endpoint.

OpenAI Chat Completions maps audio to `input_audio` with canonical base64 data
and `wav` or `mp3` format. ChatGPT subscription maps the same bounded source
bytes to App Server's audio data-URL input only when the signed-in model catalog
declares audio support. A send requires the active saved Runtime Profile to
resolve `inputs.audio` to `true` and carry explicit `supported` evidence.
Direct API discovery metadata or a manual capability override can provide that
evidence; subscription evidence can come only from App Server discovery because
managed capability overrides are disabled. An unverified fallback cannot.
`capabilities.tools` is not an audio-input gate. OpenAI Responses and Anthropic
Messages reject audio locally before making a provider request.

When tools are also enabled, Live Smith exposes `read_arrangement_audio` only
for the same verified audio-capable OpenAI Chat or subscription protocols. A
successful call adds a bounded, temporary pre-effects Arrangement render to the
next model turn without creating a Session attachment. OpenAI Chat emits every
text tool result in the assistant's batch first, then adds the audio in a
separate untrusted user content block. The subscription backend keeps only an
attachment reference in its JSON transcript and sends the binary as a separate
audio input. Tool-produced parts participate in the same binary count and byte
limits as current and historical attachments. OpenAI Responses and Anthropic
Messages reject tool-produced audio before provider I/O as well as omitting the
tool.

DOCX, XLSX, and PPTX never reach a provider as binary document parts. Live
Smith validates and extracts them locally, then sends their bounded text in a
JSON-escaped block labelled as untrusted data. This is semantic text extraction,
not Office visual rendering. Packages with detected macro, VBA, ActiveX, or
macrosheet signals are rejected; this is not general OOXML sanitization, and
unrecognized embedded binary parts are discarded. File names and extracted
content remain untrusted and cannot authorize tools, filesystem access, or a
Live sample source. A separate host-generated locator can make a current audio
input available as a SampleSource for that send; the locator contains the
current user-event ID and audio-only index, not a filename, attachment storage
ID, or path. It grants no mutation approval and expires with the send.

The shared policy accepts PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3.
It permits at most 4 attachments and 30 MiB of raw attachment bytes in pending
state or one model request. Each image is limited to 5 MiB and the image
subtotal to 16 MiB; each document and the document subtotal are limited to
20 MiB. Each audio file is limited to 20 MiB and 120 seconds, with a 30-MiB
audio subtotal and at most 2 audio attachments. The combined 30-MiB and 4-file
limits still apply. Office text is limited to 100,000 Unicode code points per
file and 200,000 per request. The server validates detected type, structure,
ownership, integrity, and quota; the WebView checks shared limits only for early
feedback. PDF checks do not promise sanitization, page-count validation, or
visual rendering.

Supported audio is narrowly defined as RIFF/WAVE containing PCM or IEEE-float
samples, or MP3 containing MPEG-1 or MPEG-2 Layer III frames. A user-added audio
attachment sends the complete original file bytes, including embedded metadata;
it is not Live's warped, processed, rendered, or mixed output. In contrast,
`read_arrangement_audio` sends only its reported pre-effects Arrangement range
and does not include the track device chain. ID3 metadata is not executed
locally, but the parser is not a cleaning or sanitization step. File names,
embedded metadata, and audio content are untrusted model input.

Audio may enter pending state through ordinary file upload or by copying the
file backing a selected Live Audio Clip, Sample, or Simpler. Neither path is
gated by the current Profile, which allows the user to attach first and select a
compatible Profile before sending. The selected-source command accepts only a
Session ID; no UI or model request can supply an arbitrary path.

Files remain pending until the associated user event is durably appended. A
confirmed append consumes those immutable IDs before provider I/O, including
when the provider later fails. Current files take the request budget first;
historical user files are selected newest-first within the remaining budgets,
then emitted in chronological conversation order. Only selected/current blobs
are opened. Missing, corrupt, incompatible, or omitted historical files degrade
to fixed untrusted markers. Duplicate attachment IDs across events are storage
corruption, and consumed IDs cannot be removed or attached to another prompt.

### Provider-hosted Web Search

Hosted Web Search is an explicit per-model setting in a saved Direct API
Profile, not a model-name guess or a client-tool capability override. It is
disabled by default. OpenAI Responses maps it to `{ "type": "web_search" }`;
Anthropic Messages maps it to
the versioned `web_search_20250305` server tool. Each native request gives the
model the remaining portion of a 20-call send budget; this is a ceiling, not a
forced number of searches. Live Smith displays and persists at most 20 distinct
search activities across the complete agent send, shrinking or removing the
tool in later model turns as that bound is reached. If a compatible endpoint
ignores the request field and emits additional activity, Live Smith omits the
overflow without discarding the model's final answer.
OpenAI Chat Completions rejects the hosted tool before body construction or
HTTP rather than switching to a special search model.

Enabling the setting makes hosted search available with automatic tool choice.
Fixed system policy tells the model to search for explicit lookup requests and
current or changing facts, and forbids claiming a search or inventing citations
unless the provider actually executes the server tool. Independently of search,
every factual premise that affects a Live mutation must have evidence in the
current request context or be obtained through an available tool. Missing
evidence is requested from the user when no tool can obtain it; model memory is
not evidence. When hosted search is absent, the request contains an explicit
unavailable capability statement and the model may not promise a search. This
does not require a search when the necessary evidence is already available.

The composer does not contain a second search switch. The saved Profile setting
only makes the hosted tool available; the model decides whether the current
request needs it.

Protocol compatibility is not capability discovery. A compatible Responses
endpoint may omit OpenAI's hosted tool, so the Profile UI does not claim that
model discovery verified search support. Chat Completions disables the control
and announces when changing formats turns an enabled Draft setting off.

Live Smith opens a live Web Search timeline card only after a provider event
indicates search activity. The card shows the bounded query and safe result
pages as they arrive, then reconciles to one persisted terminal card for each
provider call. A provider-reported search error becomes a fixed failed card
with no raw provider error payload or invented result URL. Enabling the Profile
setting or receiving uncited assistant prose cannot create that status.

The provider executes this tool; it never appears as a client `tool_use` for the
Live agent loop to run. Complete provider search blocks remain in opaque local
replay state. OpenAI Responses requests the complete
`web_search_call.action.sources` list; Anthropic uses returned
`web_search_tool_result` pages. Only normalized, bounded HTTP(S) titles and URLs
enter Web Search Session events. Answer citations are stored separately and
only when the provider returns citation annotations, so a reviewed result is
never presented as cited merely because it appeared in the search list. Search
page text stays inside the provider-hosted model context; neither provider
exposes that text as a safe user-facing excerpt in Live Smith's source list.
Search results and citations are untrusted data and cannot authorize a Live tool,
approval, filesystem operation, or mutation.

Protocol references: [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)
and [Anthropic Web Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).

### Skill instructions

A User Skill is one UTF-8 `SKILL.md` with exactly two plain frontmatter fields
and a non-empty Markdown body:

```markdown
---
name: mix-review
description: Use when a mix needs a structured balance and translation review.
---
Your local workflow guidance goes here.
```

The name is its ID, using lowercase letters, numbers, and single hyphens. After
importing the definition, enable it for a Session or use `$mix-review` for one
request. See the [Skill boundary](ARCHITECTURE.md#skill-boundary) for parser,
storage, and import constraints. This is a declarative Live Smith format, not
a general Codex or Claude Code Skill package.

Skills are provider-neutral system guidance. Three read-only arrangement Skills
are bundled with Live Smith, while User Skills are stored locally. Before
reading attachments or appending the user event, Live Smith combines the
Session's saved active IDs with available one-turn `$skill-id` mentions, sorts
and deduplicates the result, and resolves only those selected bodies in one
storage snapshot. User definitions are hash-checked; a historical User Skill
with a built-in ID remains authoritative until deleted. The prompt and
conversation history remain unchanged, and at most four Skills can guide one
request.

The final escaped Skill block is limited to 128 KiB of UTF-8. It follows the
built-in safety instructions and a fixed lower-priority boundary, precedes the
Live action system prompt, and remains identical across all model turns for the
request. Transports receive it through the ordinary provider system instruction
field, with each Skill ID inside an escaped `<skill id="...">` wrapper. The
assembler does not add descriptions, hashes, local paths, or frontmatter, and
there is no separate Skill protocol field. With no active Skill, the request
contains no Skill instruction block.

Skills are declarative workflow guidance. They cannot install or execute
scripts, binaries, MCP servers, plugins, nested resources, or arbitrary paths;
change provider settings; add tools; or add Live actions. A Skill never expands
the built-in action schema or tool set. Every action remains subject to
observation, schema validation, the selected Approval policy, preflight,
cancellation, process-wide mutation serialization, and state-drift
revalidation. Skill Markdown has lower priority than Live Smith's system and
safety instructions and cannot authorize secrets, filesystem access,
unsupported provider fields, or actions outside the built-in schema.

## Capability resolution

Direct API capabilities resolve in this order:

1. Profile manual overrides.
2. Explicit discovery metadata.
3. Known model policy.
4. Conservative API-mode fallback.

ChatGPT subscription uses the signed-in App Server catalog and has no manual
capability overrides or Direct API known-model fallback.

The UI projection retains evidence for temperature, output/context limits,
reasoning, and every input modality. A manual override wins over a valid
discovery hint, which wins over documented known-model policy. An explicit
`false` is unsupported; a conservative fallback Boolean remains
unknown/unverified rather than being presented as provider evidence. This
distinction gates the corresponding image or native PDF input. Audio uses the
stricter rule above and requires `supported` evidence in addition to an OpenAI
Chat Completions connection or a subscription catalog that declares audio
input. None of these gates ordinary text sends, local Office text extraction,
or creation of a pending attachment.

Anthropic discovery reads the official
`capabilities.image_input.supported` and `capabilities.pdf_input.supported`
fields when they are explicit Booleans. Modality arrays are accepted only as a
secondary compatibility hint, and only when every entry is a string; malformed
or partial values are ignored instead of erasing stronger known-model policy.
Custom OpenAI-compatible model names receive no image capability from name
guessing and require discovery metadata or a manual override.

Unknown models remain usable with standard protocol fields, while explicit
reasoning stays at Provider default until discovery or a manual override says it
is supported. The backend validates capability-dependent parameters again before
every request.

Anthropic discovery treats explicit-disable support conservatively: the UI only
offers Disabled when model metadata, known policy, or a manual override says the
model can disable thinking. Missing discovery fields do not erase known-model
policy; a custom endpoint's explicit capability fields are used when present.
Budget thinking is validated at Profile save and request time; its budget must
be at least 1024 tokens and remain below the requested output-token limit.

An absent output-token limit remains unknown. The 8192 value shown for a new
Profile is only an initial requested value, not a model capability limit. Live
Smith constrains and validates that field only when discovery metadata, known
model policy, or a manual capability override provides an explicit limit.

Context-window capacity is separate from the output-token limit. Anthropic's
explicit `max_input_tokens` discovery field and known-model policy for the
documented GPT-5.6 aliases can supply that metadata; unknown/custom models remain
unverified. Live Smith never uses `maxOutputTokens` as a context denominator.
Terminal OpenAI Responses, non-streaming Chat Completions, and Anthropic
Messages usage becomes a percentage only when that authoritative denominator
is present. Chat Completions streaming is not changed merely to request usage.
The value is scoped to the latest accepted model turn, not summed retries,
continuations, agent-loop steps, or billed traffic, and remains window-local UI
state rather than Session history. Starting a new send does not erase the
Session's last accepted value, but once that send accepts a turn without both
parts of the exact pair, the display returns to unavailable. Changing the
effective Profile/model clears the old value immediately so a previous model's
denominator is never displayed beside the new model; a reasoning-only change
keeps it.

Live Smith's persistent Direct API discovery cache stores only raw provider
metadata. Known-model policy and manual Profile overrides are applied when the
UI is rendered and again when a request is sent, so removing an override takes effect
immediately and cached policy does not become stale after an extension update.
Subscription catalogs never use that Live Smith cache; their normalized view is
modal-scoped and invalidated by the process-wide auth generation. The separate
upstream Codex `models_cache.json` behavior is documented in the subscription
section above.

Reasoning has three modes:

- Provider default: omit explicit controls.
- Disabled: send an explicit disable only when supported.
- Enabled: use the policy's effort, adaptive-thinking, or budget-thinking
  strategy.

## Compatible endpoints

Create a Direct API OpenAI or Anthropic Profile for the protocol family the
endpoint actually implements. OpenAI Profiles choose Responses or Chat
Completions; Anthropic Profiles use Messages. Enter the base URL exactly as
required, including `/v1` when applicable. In **Settings**, use **Load Models**
if the endpoint implements the corresponding model-list API, or type the model
ID manually. This section does not apply to the managed Codex connection.

Advanced capability overrides describe endpoint/model features without adding a
vendor-specific adapter. Extra Body JSON can add or override nonstandard
generation fields. It cannot replace `model`, `input`/`messages`, `tools`, or
`stream`, because Live Smith owns those structures. Responses additionally
protects `instructions`, `store`, `previous_response_id`, and `conversation` to
enforce instruction and local-state ownership, and always retains
`reasoning.encrypted_content` when merging `include`. Chat Completions also
protects top-level `modalities` and `audio`; audio attachments do not request
audio output. Anthropic Messages likewise protects `system`. Base URLs must not
contain username/password credentials.
Provider connections must use HTTPS. Plain HTTP is accepted only for loopback
providers such as `localhost`, `127.0.0.1`, or `::1`; private-LAN and remote HTTP
endpoints are rejected before a Profile can be saved or used for discovery.
Loopback endpoints may leave API key blank, in which case Live Smith omits the
authentication header entirely. Every non-loopback endpoint requires a key.

### Google Gemini

Gemini uses its
[official OpenAI compatibility endpoint](https://ai.google.dev/gemini-api/docs/openai);
it is not a separate Live Smith provider mode. Create a Direct API Profile with:

- API family: OpenAI
- API mode: Chat Completions
- Base URL: `https://generativelanguage.googleapis.com/v1beta/openai`
- API key: a Gemini API key

Use **Load Models** or enter a Gemini model ID manually. The compatible model
catalog may omit modality and reasoning metadata. Set documented image or audio
support in Advanced Overrides when needed; otherwise Live Smith keeps those
inputs unavailable. Leave reasoning at Provider default unless the selected
model's supported efforts are configured explicitly.

This path supports Live Smith's client function tools and inline image/WAV audio
input. It preserves
[Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
across tool turns. Google's compatibility layer remains beta and does not add
Gemini-native File API or Google Search grounding to Live Smith.

Live context and tool results are sent as explicitly labelled untrusted data.
Track, Clip, Device, parameter, and MIDI names/content never gain instruction
authority merely because they appear in a Live Set or tool response.

## Credential storage

Configured Direct API keys are stored as plain text in Ableton's local extension
storage directory. Use a dedicated key with provider-side spending and rate
limits. The official Codex CLI separately owns ChatGPT credentials under the
isolated `<storageDirectory>/codex-subscription` `CODEX_HOME`; Live Smith never
copies them into settings or reads the normal `~/.codex` credential cache or
Keychain entry. The managed process is forced to use its isolated file store.
Do not commit, share, or cloud-sync either storage location. Environment
variables and `.env` files are not model configuration or credential fallbacks.
On POSIX hosts, Live Smith creates or tightens its storage directories to mode
`0700` and private JSON and attachment blob files to `0600`.

## Running

See the [Development guide](DEVELOPMENT.md) for prerequisites, local
installation, verification, packaging, and launching the extension.
