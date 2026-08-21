# Model Profiles and Connection Backends

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

For all three Direct API modes, a non-2xx HTTP response reports the API
family/mode, status code, and status text only. Its response body is untrusted
and is never read or persisted, because a provider or proxy can echo prompts,
Live context, replay state, or Extra Body fields in that body. Error events
inside a successful SSE response likewise expose only fixed protocol context,
never an arbitrary provider message.

## Connection backends

### Direct API

The `direct-api` branch owns `apiFamily`, `apiMode`, `baseUrl`, and `apiKey`.
`registry.ts` selects one of the three `ModelTransport` implementations below,
and Live Smith owns request mapping, SSE parsing, protocol replay, and error
redaction. Environment variables and `.env` files are never credential or
connection fallbacks.

### ChatGPT subscription (Experimental)

The `codex-subscription` branch owns only the fixed provider identity `openai`;
the official Codex CLI owns authentication. Live Smith requires Codex CLI
`0.148.x` on `PATH`, launches `codex app-server` over stdio, and uses App
Server's `chatgptDeviceCode` flow. This consumes the signed-in account's
applicable Codex subscription limits. It does not convert ChatGPT OAuth into a
Bearer token for `/v1/responses`, accept App Server's API-key login mode, or
silently fall back to separately billed API usage. A user who wants API-key
billing must explicitly select a `direct-api` Profile.

The child receives `CODEX_HOME=<storageDirectory>/codex-subscription` and starts
only after confirming the private runtime workspace beneath that directory is
empty. It does not read or overwrite `~/.codex/auth.json`. OpenAI, ChatGPT,
Codex, Anthropic, Claude, and AWS credentials are excluded by a stricter rule:
the child receives only allowlisted executable lookup, operating-system,
temporary-directory, and locale variables, plus Live Smith's controlled
`CODEX_HOME`. Ambient proxy variables, custom-CA settings, provider credentials,
and arbitrary parent-process variables are not inherited. The CLI file
credential store and ChatGPT-only login
method are forced, and initialization must report the canonical isolated home.
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
explicit trusted configuration rather than ambient host state. A shell or normal Codex configuration
therefore cannot silently change the intended execution, credential store, or
billing identity. Credentials remain App Server-owned and never enter a
Profile, model request, Session event, or Live Smith log.

An empty cloud bundle is not permission to ignore workspace management.
Every workspace-managed and unknown ChatGPT plan type is ineligible for this
experimental backend and fails before model discovery or thread creation, while
Check and Sign out remain available. Codex may write an identity-scoped cache
of that empty local result under the isolated managed home for a rejected
account; no delivered organization policy is accepted or executed.

Codex 0.148 unconditionally starts an online model-catalog refresh worker when
App Server starts and repeats it every three minutes. Successful refreshes may
write `models_cache.json` under the isolated managed `CODEX_HOME`; `model/list`
uses a fresh entry for up to five minutes. The exact release exposes no
supported cache/worker-off mode that retains dynamic account-aware discovery.
This is model metadata traffic, not a model inference turn. Live Smith does not
copy the file into settings, Sessions, events, or its Direct API model cache,
but the upstream file has no account key and therefore is not described as
account-scoped.

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
argument strings. The existing provider-neutral outer loop remains the
authoritative action-schema validator and the only component that executes Live
observation or mutation tools.

All modals for one storage directory share a process-wide auth/send fence. An
auth mutation cannot start during any send; a pending device flow remains owned
by its modal and blocks other auth flows and sends until a Check observes
signed-in, signed-out, or definitive failure, cancellation or sign-out
succeeds, or the owner closes;
signing out also requires an explicit UI confirmation.
The same canonical storage key owns one reference-counted backend manager and
App Server for every modal. This gives the shared `auth.json` one in-process
refresh lock, in-memory credential owner, model worker, and cache writer. The
canonicalizer resolves the longest existing ancestor before appending a missing
storage suffix, so a symlinked parent cannot split first-open and later-open
modals. The last modal closes it; a modal that owns an unfinished device flow
retires it before releasing pending ownership.

Each definitive Check and every login/logout attempt advances the generation
that invalidates modal-only auth/catalog projections. Each modal clears them
before its next state, auth, discovery, or send operation. Successful mutations
update the shared process; an unknown outcome retires its exact backend to confirmed
exit before advancing the generation or releasing the transition. Peer state,
auth, discovery, and send paths wait behind that storage-wide barrier; an
unconfirmed exit poisons subscription use until extension-process restart.
Matching App Server login-completion notifications clear failed/expired backend
flows with fixed safe text. Any modal's later authoritative signed-in,
signed-out, or definitive-failure read reconciles global pending ownership once;
pending and non-definitive results keep it locked. Pending-login state and Check
callers share one storage-wide readiness refresh, and send/auth mutation remain
blocked until it settles. Caller cancellation stops only that wait; RPC timeout,
terminal failure, or last-owner backend close bounds the shared read. Explicit Check, discovery, and send readiness reads
request credential refresh, while ordinary signed-in or signed-out state
hydration is passive. Before
persisting a subscription prompt, the server confirms an eligible signed-in
account, refreshes a generation-scoped catalog miss, and requires the saved
model in it. Readiness failures are unpersisted, so Queue pauses its head
instead of draining. Live
Smith's normalized subscription model projection
stays only in the owning modal, is invalidated on every auth generation, is
cleared before that modal's next relevant operation, and is never written to
Live Smith's persistent model cache. The RPC reader accepts a
line up to twice the locally bounded encoded
`turn/start` payload, so valid attachment echoes are supported without
unbounded framing. Oversized context fails before `thread/start`. Connection
failure, unconfirmed turn start, or unconfirmed interruption closes the owned
process rather than leaving quota-consuming work orphaned.

Both `thread/start` and `turn/start` send `serviceTier: null`; with exact 0.148's
`fast_mode` disabled, Live Smith requires a null effective response tier before
allowing the turn. Terminal turns call `thread/unsubscribe`. A backend
admits at most four concurrent turns and recycles after eight created threads
once its active turns and first-turn reservations drain. Threshold recycling
rejects new reservations while already-admitted continuations finish. At
instantaneous capacity, continuations belonging to persisted sends wait FIFO
and prevent new first-turn reservations from overtaking them; each waiter shares
its send's abort lifetime. Unsafe cleanup or a forbidden App Server runtime item
blocks further turns and retires the process after owned work drains. Runtime terminal events retire
only their matching manager slot, replacement waits for confirmed child exit, and an unconfirmed
SIGKILL poisons the shared storage boundary rather than permitting overlapping
ownership. Preflight reserves first-turn capacity before prompt persistence;
recycling waits for that reservation. Later model steps reacquire the current
manager slot, wait for fair admission on an eligible live backend when
necessary, and otherwise hand off to a confirmed replacement. Child `error`,
`exit`, and `close` share one terminal observation, so a missing executable's
`error` followed by `close` is reported as unavailable without unnecessary
shutdown escalation or storage poison.

All subscription Profiles under one Ableton storage directory share this
isolated ChatGPT login. Deleting a Profile does not sign out; use the explicit
logout action. The `codex` executable is resolved from `PATH`. Live Smith
validates its reported `0.148.x` protocol line and isolated home, not binary
provenance, so users must install and trust the official binary.

Codex subscription Profiles consequently do not support Direct API temperature
or output-token controls, reasoning token budgets, provider-hosted tools,
capability overrides, or Extra Body. Reasoning cannot be set to Disabled. Model
discovery and supported reasoning-effort choices, including `ultra` when
advertised, come from the signed-in App Server catalog rather than the OpenAI
`/v1/models` endpoint. Unknown effort values fail discovery instead of being
silently discarded.

This connection remains experimental. OpenAI documents the App Server command
as experimental and unsupported for production workloads, and its generated
protocol schema is version-specific. Unit tests with a Node child-process
harness do not prove that subprocess startup and shutdown work in Ableton's real
Extension Host; that end-to-end host smoke remains pending.

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

Each Profile stores a complete connection:

- name, model, and a discriminated `direct-api` or `codex-subscription`
  connection;
- for Direct API, API family/mode and base URL, plus an API key unless the
  endpoint is local loopback;
- connection- and capability-aware generation controls;
- for Direct API, maximum output tokens, optional temperature, and
  token-budget thinking;
- for Direct API, optional provider-hosted Web Search, capability overrides,
  and Extra Body JSON.

Add and Duplicate create an unsaved draft. **Save & Use** validates and persists
the entire draft and makes it active. Changing session or sending a message does
not save the draft. Send remains disabled until the draft is saved or discarded.
Switching a saved Profile switches the whole connection and parameter set.

The implementation keeps three Profile representations explicit:

- `DraftProfile` is the editable, possibly incomplete form. **Connect & Load** checks
  only its connection fields, so name and model may still be blank.
- `SavedProfile` is the fully validated value persisted by Profile CRUD.
- `RuntimeProfile` combines the active Saved Profile with resolved capabilities.
  Model requests and the active header both read this same runtime value; an
  unsaved Draft only changes the labelled Inspector preview. Connection routing
  reads the discriminant and is never inferred from a model name.

The first run contains no Profiles. Schema-version-2 flat Profiles first
migrate to the nested version-3 `direct-api` shape. Current schema version 4
also reads the other historical development-v3 shape containing flat Profiles
plus Queue/Steer behavior and a canonical decimal-string revision. Version 3 is
discriminated before validation: both follow-up fields mean the flat shape;
neither means the nested subscription shape. Partial fields, mixed Profile
shapes, and unknown fields fail closed. Migration preserves API family, mode,
base URL, key, model, parameters, active identity, and any Queue/Steer revision;
the nested v3 shape receives Queue at revision `"0"`. Reads do not rewrite.

## API behavior

### Follow-up modes

Queue and Steer have different lifecycles. Queue is the global default: the UI
holds each pending item for its Session, waits for the current send to become
terminal, and starts a new ordinary send with a new correlation ID. That turn
reloads the active saved Profile and capabilities, Skills, attachments, Session
history, recovery state, auth generation, and Approval state. Queue text never
enters the preceding provider request or its local replay state.

Steer targets the active send. The chosen default is read when each follow-up
is submitted, so a settings change applies immediately to the next item without
changing items already queued or submitted. Neither mode is sent as a provider
field or added to the strict `/send` body. Its canonical decimal-string revision
and bridge replay are UI/orchestration metadata only.

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

Steering is text-only. It does not resnapshot the Profile, attachments, active
Skills, capabilities, or Extra Body. Persistence and retry are also
provider-neutral: each accepted steering user event has a receipt bound to the
original send ID, steering ID, and prompt hash. Exact retries are idempotent,
including after the send has reached terminal state. An explicit unknown
persistence outcome keeps the same client steering ID until authoritative
Session state confirms presence or absence.

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
- Uses assistant `tool_calls` followed by `role: tool` messages.
- Requires a complete `stop` or `tool_calls` finish reason before returning a
  turn to the agent loop; truncated, filtered, unknown, and unterminated
  responses fail before any tool call can run.
- Preserves unknown JSON-compatible assistant fields for compatible endpoints
  that require them during later tool turns.
- Rejects missing, empty, or duplicate tool-call IDs, empty function names, and
  missing or non-string argument representations before any Live action can
  run. Every call must have type `function`, `tool_calls` must be an array, and
  the parsed calls must agree bidirectionally with the terminal finish reason.
  Ordinary assistant text cannot hide a malformed or missing declared call.

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

Live Smith assembles attachment context once as provider-neutral user input
parts. Assistant history remains text-only, while current and historical user
images are mapped to each protocol's native blocks:

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
Anthropic Messages maps it to a base64 `document` source. Live Smith
intentionally does not implement PDF input for OpenAI Chat Completions in this
milestone; this is a Live Smith boundary, not a claim about every compatible
endpoint.

OpenAI Chat Completions maps audio to `input_audio` with canonical base64 data
and `wav` or `mp3` format. ChatGPT subscription maps the same bounded source
bytes to App Server's audio data-URL input only when the signed-in model catalog
declares audio support. A send requires the active saved Runtime Profile to
resolve `inputs.audio` to `true` and carry explicit `supported` evidence.
Direct API discovery metadata or a manual capability override can provide that
evidence; subscription evidence can come only from App Server discovery because
managed capability overrides are disabled. An unverified fallback cannot.
`capabilities.tools` is not an audio-input gate. OpenAI Responses and Anthropic
Messages reject audio locally in this milestone, before making a provider
request.

DOCX, XLSX, and PPTX never reach a provider as binary document parts. Live
Smith validates and extracts them locally, then sends their bounded text in a
JSON-escaped block labelled as untrusted data. This is semantic text extraction,
not Office visual rendering. Packages with detected macro, VBA, ActiveX, or
macrosheet signals are rejected; this is not general OOXML sanitization, and
unrecognized embedded binary parts are discarded. File names and extracted
content remain untrusted and cannot authorize tools, filesystem access, or a
Live sample source.

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
samples, or MP3 containing MPEG-1 or MPEG-2 Layer III frames. Live Smith sends
the complete original file bytes, including embedded metadata. It does not
upload Live's warped, processed, rendered, or mixed output. ID3 metadata is not
executed locally, but the parser is not a cleaning or sanitization step. File
names, embedded metadata, and audio content are untrusted model input.

Audio may enter pending state through ordinary file upload or by copying the
file backing a selected Live Audio Clip, Sample, or Simpler. Neither path is
gated by the current Profile, which allows the user to attach first and select a
compatible Profile before sending. The selected-source command accepts only a
Session ID; no UI or model request can supply an arbitrary path.

### Provider-hosted Web Search

Hosted Web Search is an explicit Saved Profile setting, not a model-name guess
or a client-tool capability override. It is disabled by default. OpenAI
Responses maps it to `{ "type": "web_search" }`; Anthropic Messages maps it to
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

Files remain pending until the associated user event is durably appended. A
confirmed append consumes those immutable IDs before provider I/O, including
when the provider later fails. Current files take the request budget first;
historical user files are selected newest-first within the remaining budgets,
then emitted in chronological conversation order. Only selected/current blobs
are opened. Missing, corrupt, incompatible, or omitted historical files degrade
to fixed untrusted markers. Duplicate attachment IDs across events are storage
corruption, and consumed IDs cannot be removed or attached to another prompt.

### Local Skill instructions

Local Skills are provider-neutral system guidance. Before reading attachments
or appending the user event, Live Smith combines the Session's saved active IDs
with installed one-turn `$skill-id` mentions, sorts and deduplicates the result,
and reads and hash-checks only those selected bodies in one storage snapshot.
The prompt and conversation history remain unchanged, and at most four Skills
can guide one request.

The final escaped Skill block is limited to 128 KiB of UTF-8. It follows the
built-in safety instructions and a fixed lower-priority boundary, precedes the
Live action system prompt, and remains identical across all model turns for the
request. Transports receive it only through the ordinary provider system
instruction field. They do not receive Skill IDs, descriptions, hashes, paths,
frontmatter, or a separate Skill protocol field. With no active Skill, the
system text remains byte-for-byte identical to the legacy request.

Skills are locally installed declarative workflow guidance. They cannot install
or execute scripts, binaries, MCP servers, plugins, nested resources, or
arbitrary paths; change provider settings; add tools; or add Live actions. A
Skill never expands the built-in action schema or tool set. Every action remains
subject to observation, schema validation, the selected Approval policy,
preflight, cancellation, process-wide mutation serialization, and state-drift
revalidation. Skill Markdown has lower priority than Live Smith's system and
safety instructions and cannot authorize secrets, filesystem access,
unsupported provider fields, or actions outside the built-in schema.

## Capability resolution

Capabilities resolve in this order:

1. Profile manual overrides.
2. Explicit discovery metadata.
3. Known model policy.
4. Conservative API-mode fallback.

Input capabilities also retain the evidence behind the resolved Boolean. A
manual override wins over a valid discovery hint, which wins over documented
known-model policy. An explicit `false` is unsupported; the conservative
fallback value remains unknown/unverified in the UI rather than being presented
as provider evidence. This distinction gates the corresponding image or native
PDF input. Audio uses the stricter rule above and requires `supported` evidence
in addition to an OpenAI Chat Completions connection or a subscription catalog
that declares audio input. None of these gates ordinary text sends, local
Office text extraction, or creation of a pending attachment.

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

Live Smith's persistent Direct API discovery cache stores only raw provider
metadata.
Known-model policy and manual Profile overrides are applied when the UI is
rendered and again when a request is sent, so removing an override takes effect
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
required, including `/v1` when applicable. Use **Connect & Load** if the
endpoint implements the corresponding model-list API, or type the model ID
manually. This section does not apply to the managed Codex connection.

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

```sh
npm test
npm run build
npm run package
npm run verify:package
npm start
```

`npm start` builds the development bundle and launches the Ableton Extensions
CLI. Install/enable the extension in the CLI, then open Live and invoke **Ask
Live Smith** from a supported context menu.
