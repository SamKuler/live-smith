# Live Smith Architecture

Live Smith keeps the Ableton extension entrypoint thin and separates Live API
execution from model protocol details.

## Module map

```text
src/
  extension.ts
    Registers Ableton commands and context-menu entrypoints.

  app/
    agent-flow.ts
      Coordinates modal state, bridge commands, managed readiness, and errors.
    agent-request.ts
      Runs one provider-neutral agent request, including attachment/Skill
      context, trace persistence, approval, preflight, and Live execution.
    chat-bridge.ts
      Local authenticated HTTP/SSE bridge state machine for the modal WebView.
    chat-bridge-http.ts
      Strict correlation IDs, command/query decoding, bounded body reads, and
      safe request errors for the bridge transport boundary.
    model-request.ts
      Builds provider-neutral transport requests and capability previews.
    attachment-context.ts
      Resolves current and bounded historical attachment parts without exposing
      attachment storage details to providers or the agent loop.
    skill-context.ts
      Resolves persistent and one-turn Skill activation from one immutable,
      hash-validated storage snapshot without changing prompt bytes.
    session-context.ts
      Selects scoped sessions and derives bounded conversation and recovery
      context from events.
    session-mutation-fence.ts
      Serializes the full same-Session send and lifecycle boundary across
      dialogs that share one storage directory.
    model-auth-send-fence.ts
      Serializes storage-wide managed auth reads/mutations and subscription
      sends, including pending-login reconciliation, generation invalidation,
      and poison.

  agent/
    action-schema.ts
      Single-source action descriptors that derive types, JSON schemas,
      runtime parsing, and model examples.
    actions.ts
      Plan validation, confirmation summaries, the action prompt, and the
      shared action-to-observation routing used by preflight and recovery.
    loop.ts
      Provider-neutral bounded tool loop with cancellation and safety limits.
    progress.ts, system-instructions.ts
      Agent-facing progress labels and model instructions.

  attachments/
    audio.ts
      Strict, bounded WAV/MP3 inspection without decoding, executing metadata,
      or changing the owned source bytes.
    image.ts, pdf.ts, ooxml*.ts, docx.ts, xlsx.ts, pptx.ts
      Type-specific inspection and bounded local document extraction.

  skills/
    format.ts
      Strict UTF-8 `SKILL.md` parser and safe Skill ID/summary contracts.

  live/
    action-bindings.ts
      Binds existing action targets to SDK handles and revalidates them after
      confirmation so ordered structural edits cannot drift to another object.
    context.ts
      Converts Live objects and selections into model-readable context.
    observer.ts
      Reads allowed Live state for model tools.
    executor.ts
      Applies validated and confirmed actions to the Live Set.
    audio-attachment-source.ts
      Copies a selected Audio Clip, Sample, or Simpler source through a
      race-checked regular-file boundary without exposing its path.

  model/
    contracts.ts
      Normalized conversation, tool-call, and model-turn contracts.
    profile.ts
      Named profile schema and structural validation.
    provider.ts
      Normalized model, capability, tool, transport, managed-auth, and backend
      contracts.
    capabilities.ts
      API-mode fallbacks, known model policies, and manual override resolution.
    backend-registry.ts
      Exposes distinct Direct API and managed Codex backend contracts and owns
      the lazily started managed backend slot.
    shared-backend-manager.ts
      Ref-counts one managed backend manager per canonical storage directory.
    registry.ts
      Selects a Direct API transport from a validated API family/mode pair.
    backends/
      codex-app-server.ts
        Managed ChatGPT subscription auth, model discovery, ephemeral turns,
        schema-constrained tool intent, cancellation, and result normalization.
      codex-rpc.ts
        Bounded stdio App Server RPC with an exact Codex `0.148.x` handshake,
        request cancellation/timeouts, redacted stderr, and process shutdown.
    transports/
      openai-responses.ts
      openai-chat.ts
      anthropic-messages.ts
      Protocol serialization, streaming, tool calls, and opaque state replay.
      openai-http.ts, anthropic-http.ts, server-sent-events.ts
      Explicit HTTP headers, endpoint resolution, status-only non-2xx errors,
      and shared SSE framing without provider SDK runtime dependencies.

  runtime/
    host.ts
      Resolves host-provided Fetch and Abort APIs with explicit capability
      errors and shared cancellation checks.
    process-host.ts
      Starts the official Codex native payload with a private runtime workspace,
      isolated `CODEX_HOME`, stripped environment, and disabled agent features.
    codex-executable.ts
      Resolves the supported global npm launcher topology to its matching native
      platform payload without executing the launcher.
    codex-metadata-firewall.ts
      Owns the narrow loopback policy responder required by Codex 0.148's
      attribution and cloud-config extensions.

  storage/
    scope.ts
      Canonicalizes the Ableton-provided storage path once so every process,
      transaction, fence, and event registry shares one physical identity.
    settings.ts
      Explicit named-profile CRUD and global settings persistence.
    settings-migrations.ts
      Current-schema validation plus registered adjacent-version migrations
      for historical settings files.
    persistence.ts
      Serialized local transactions plus private, atomic JSON replacement.
    model-cache.ts
      Profile/fingerprint-isolated raw Direct API model-metadata cache;
      Live Smith's normalized subscription catalogs stay modal-only. Codex's
      separate isolated upstream cache is described below.
    events.ts, sessions.ts
      Chat session metadata and the canonical event history.
    attachments.ts
      Private create-only attachment blobs, integrity metadata, ownership checks,
      quota policy, and durable Session-scoped cleanup.
    skills.ts
      Private bounded Skill catalog with recoverable replacement/deletion and
      selected-definition integrity checks.

  ui/
    chat-state.ts
      Safely serializes modal state and the authoritative source identity for
      capability/model discovery results.
    chat-document.ts
      Composes the production and DOM-test chat document from one fragment map.
    templates/chat-dialog.html
      Chat layout and styles.
    client/*.script.html
      Shared WebView host adapter plus Profile/model settings, bridge lifecycle,
      attachment, local Skill, and session/timeline factories. Bootstrap owns
      final composer/status presentation and explicit dependency wiring.
```

## Model request flow

1. The bridge accepts a prompt and session ID only. Attachment upload/delete are
   separate authenticated, size-bounded routes with strict Session ownership;
   bytes never enter the send JSON body.
2. `agent-flow.ts` loads the saved active profile; an unsaved UI draft can never
   enter a model request.
3. `capabilities.ts` resolves effective model capabilities and validates the
   saved generation parameters from manual overrides, raw discovery metadata,
   known policy, and conservative fallback.
4. Before attachment reads or event append, `skill-context.ts` unions sorted
   persistent Session IDs with installed `$skill-id` mentions. It validates and
   copies only selected definitions inside one global storage transaction,
   escapes their `&<>` boundary text, and freezes one 128-KiB-bounded instruction
   snapshot for every model turn in the loop. The original prompt is not rewritten.
5. Before appending the user event, `attachment-context.ts` verifies pending
   attachment metadata/blobs, resolves current plus bounded historical user
   parts, and extracts supported Office text. The append atomically consumes the
   current immutable references only after current-file validation succeeds.
6. `backend-registry.ts` routes strictly on `profile.connection.kind`. A
   `direct-api` connection asks `registry.ts` for OpenAI Responses, OpenAI Chat
   Completions, or Anthropic Messages. A `codex-subscription` connection uses
   the one canonical-storage-keyed, reference-counted Codex App Server shared
   by every modal that uses the managed connection. Model names
   never select or change this connection boundary.
7. A Direct API transport maps normalized client function tools and
   provider-hosted tools, messages, and parameters to its wire protocol. The
   Codex backend instead creates an ephemeral, read-only App Server thread with
   a strict output schema describing assistant text and Live Smith tool intent;
   it provides no runtime workspace root, environment, or dynamic Codex tool.
8. Either backend returns the same normalized text and client tool-call
   boundary. Direct API transports can additionally return bounded citations
   and opaque replay state. Hosted provider tools never enter the client tool
   executor, and unexpected App Server tool activity fails the Codex turn.
9. Before confirmation, `agent-request.ts` performs a fresh action-specific Live
   preflight observation and captures an opaque guard from actual SDK handle
   identities plus every current value the action can overwrite, including
   tempo, mute, solo, and device parameter value. Host `bigint` values are
   encoded deterministically at this fingerprint boundary instead of being
   passed to ordinary JSON serialization; no Approval mode can bypass the
   guard.
10. After confirmation and immediately before execution, `agent/loop.ts` invokes
   that provider-neutral guard. A changed target, clip, device, parameter, or
   other action-relevant state performs no mutation and returns a failed tool
   result so the model can inspect again before proposing a new confirmation.
11. `agent/loop.ts` executes the bounded apply loop without inspecting provider
   or protocol data. Successful or partially successful Live writes and new,
   distinct observations renew a rolling no-progress budget. Repeating the same
   observation and result does not. Execution returns an explicit mutation count,
   so a successful idempotent no-op does not renew the window. The first
   automatic post-failure observation has a failure-scoped progress key, so it
   renews the window even if identical state text was observed earlier;
   repeating the same failure does not. There is no accumulated request or
   tool-call quota; excessive one-turn tool fanout is returned to the model for
   regrouping without executing that batch. A separate six-failure host budget
   stops changing failure variants that produce no Live mutation; any actual
   mutation resets it, so productive large workflows remain uncapped.

One confirmation is an authorization boundary, not a promise of one Live Undo
entry. The 1.0.0 beta SDK does not allow awaiting inside a transaction, so an
ordered plan whose later mutations depend on earlier asynchronous results (for
example, create a track and then rename it) necessarily uses sequential SDK
transactions. Do not wrap the asynchronous executor in `withinTransaction` and
claim that the full plan is one Undo step; only mutations initiated before the
first await would be grouped.

Live context and tool results are explicitly untrusted data. Transports encode
Live context as a JSON string inside a labelled data block, and system
instructions forbid following instructions embedded in Live object names, MIDI
data, parameter labels, or tool output.

Provider-hosted Web Search uses a separate discriminated member of the
provider-neutral tool union from client-executed Live function tools. A Saved
Profile must explicitly opt in. The ordinary path exposes the tool with
automatic selection and adds fixed policy instructions for explicit lookup
requests and current or changing facts. The composer does not override provider
tool choice. OpenAI Responses and Anthropic Messages map the hosted member to
their native server tool; Chat Completions rejects it before HTTP. Search result
blocks remain opaque replay state. Transports separately normalize bounded
provider call IDs, actions, queries, returned result URLs, and answer citation
annotations. OpenAI Responses explicitly requests
`web_search_call.action.sources`; Anthropic result blocks supply the returned
pages. Streaming activity crosses the bridge as a correlated
`web_search_update`, then the agent loop durably persists each terminal action
as a distinct read-only Session event before publishing it to the UI. Terminal
actions are either completed or a fixed, redacted failure; in-flight activity
never enters Session history. One send exposes the remaining portion of a
20-action ceiling to each provider turn. Activity beyond that display and
persistence bound is omitted without discarding an otherwise valid final
answer. The UI reconciles the transient card by call ID, preserves its disclosure
state through terminal replacement, and keeps source-page links separate from
answer citations. Provider-hosted page text is not copied into the Session
event schema. Search data cannot
authorize client tools, approvals, filesystem access, or Live mutations.

OpenAI Responses always uses `store: false`. Responses output items, Chat raw
assistant messages, and Anthropic content blocks are stored only inside the
current local agent loop and replayed unchanged when their protocol requires it.
An OpenAI Responses `incomplete` terminal with reason `max_output_tokens` becomes
a provider-neutral continuation turn: the loop replays every returned output
item, preserves partial text and citations, and makes at most two additional
model requests. A function-call item is executable only if its own protocol
status is `completed`; partial items are replayed but never executed. Other
incomplete reasons fail closed.
Non-2xx provider response bodies are treated as untrusted and are not read,
logged, or persisted; transport errors retain only family/mode context plus the
HTTP status and a fixed local failure description. Remote HTTP reason phrases
are never propagated.

## Model connection boundary

`ModelConnection` is a closed discriminated union:

- `DirectApiConnection` owns API family/mode, base URL, and API key. The
  registry selects one of the three explicit HTTP/SSE transports.
- `CodexSubscriptionConnection` owns only the fixed OpenAI subscription
  identity. It is a managed backend, not a fourth API mode or endpoint preset.

The backend contract mirrors that union. Direct API backends expose model
listing and turn creation. The managed Codex backend additionally requires
terminal notification, first-turn reservation, auth reads and auth mutations at
compile time; application code no longer probes optional managed capabilities
or creates a synthetic Profile to start the process. `requestModelTurn`
receives one explicit turn executor—the backend or a reserved first-turn
executor—and never creates hidden resources.

`storage/scope.ts` canonicalizes the Ableton-provided Live Smith storage path
once, including aliases whose final leaf does not yet exist. The same canonical
directory is then used by persistence transactions, Session mutation fences,
cross-modal event buses, the auth/send fence and the shared backend manager.
This prevents a real path and symlink alias from sharing one Codex process while
accidentally using different storage or notification locks.

The managed runtime is split by responsibility:

- `model/shared-backend-manager.ts` owns one ref-counted
  `ModelBackendManager` per canonical storage directory.
- `app/model-auth-send-fence.ts` serializes auth reads, sends, mutations,
  pending-login ownership, generation changes and poison.
- `runtime/codex-executable.ts` resolves only supported global npm
  nested/hoisted/base-vendor layouts and returns the matching native payload.
- `runtime/process-host.ts` owns the isolated home/workspace, strict child
  environment and fixed Codex configuration.
- `runtime/codex-metadata-firewall.ts` supplies the narrow loopback
  attribution/cloud-config policy boundary.
- `model/backends/codex-rpc.ts` owns bounded stdio framing, timeouts and
  confirmed child/firewall shutdown.
- `model/backends/codex-app-server.ts` owns managed auth, catalog validation,
  turn admission/correlation and normalized model-only results.

Each modal lazily leases the shared manager on its first managed operation.
Auth mutations exclude subscription sends across modals. Direct-only state
hydration, catalog access, and sends neither acquire that managed registry nor
inspect the managed auth fence's health or generation;
pending device login and readiness reconciliation are single-flight;
unknown auth outcomes retire the exact backend before advancing generation.
Managed startup belongs to its shared manager slot: caller cancellation ends
only that wait, while slot retirement or final release aborts initialization
and confirms child/firewall cleanup.
The last managed lease closes the process, and an unconfirmed exit poisons
subscription use for that storage directory rather than starting overlapping
work.

Before prompt persistence, the flow refreshes managed readiness, validates the
current account/catalog/model and reserves first-turn capacity. Subsequent
agent-loop turns use the same explicit backend boundary. Ephemeral-thread
recycling, continuation FIFO, terminal correlation and fail-closed tool
inspection remain inside the Codex backend rather than leaking into the
provider-neutral agent loop.

The exact Codex `0.148.x` feature disables, credential isolation, supported
npm topology, metadata/cache/network behavior, plan eligibility, service-tier
and thread/turn invariants are canonicalized in
[Model Profiles and Connection Backends](MODEL_PROVIDERS.md#chatgpt-subscription-experimental).
Architecture changes should update that document rather than duplicating the
full normative list here.

Anthropic remains a Direct API Messages transport. Claude.ai subscription
credentials are outside the product boundary unless Anthropic grants prior
written approval; see
[Anthropic subscription boundary](MODEL_PROVIDERS.md#anthropic-subscription-boundary).

## Skill boundary

A Skill is one declarative, local UTF-8 `SKILL.md`; it is not a general Codex or
Claude Code Skill package. The parser accepts exactly two plain frontmatter
scalars (`name` and `description`) followed by a non-empty Markdown body. It
rejects malformed UTF-8, BOMs, unsafe controls, ambiguous YAML constructs, and
files larger than 64 KiB. The catalog permits 32 definitions and 1 MiB total.
Directories, symlinks, scripts, binaries, assets, nested references, plugins,
MCP servers, executables, and caller-supplied paths are outside this contract.

`storage/skills.ts` derives every path from a validated Skill ID and uses the
same global per-storage transaction queue as Sessions. Install/replace/delete
uses a recoverable pending mutation plus private staging, durable atomic writes,
directory identity checks before and after mutation, and strict catalog
validation. Stable catalog listing reads summaries and safe file metadata only;
only selected definitions are opened, bounded, hash-checked, and parsed. Catalog
capabilities are scoped to an active opaque storage transaction, and detached
operations are drained before the transaction releases.

`AgentSession.activeSkillIds` is an optional, sorted, unique list of at most four
safe IDs. Activation validates the Session and installed catalog, then writes
the Session inside the same global storage transaction. Normal active Sessions
can add or remove installed Skills. Archived and foreign-project Sessions allow
removal-only changes so a user can unblock catalog deletion without restoring a
historical Live binding. Deletion scans all current, historical, and archived
Sessions in the same transaction and refuses while any still references the ID.

The per-Session mutation fence labels active sends. A cross-dialog
`set_session_skills` command fails immediately while that Session is sending;
otherwise queue order determines whether activation precedes the next send. A
send resolves persistent IDs and lexical `$skill-id` candidates in one storage
transaction before attachments or event append. Unknown mentions remain plain
prompt text. Inline code, CommonMark backtick/tilde fences, email/path tokens,
currency-like numeric tokens, and numeric-leading IDs are not mention syntax.
The prompt and persisted user event remain byte-for-byte unchanged.

Selected definitions are escaped at the wrapper boundary, sorted by ID, and
limited to 128 KiB after final UTF-8 rendering. The same immutable block is used
for every model turn. System order is the four built-in safety instructions,
the fixed lower-priority Skill boundary, rendered Skill blocks, then the Live
action system prompt. Empty activation produces the exact legacy system text.
Skill IDs/descriptions and active IDs may enter chat state; bodies, hashes,
frontmatter source, and paths never enter chat state, Session events, logs, or
errors.

Skills are locally installed declarative workflow guidance. They cannot install
or execute scripts, binaries, MCP servers, plugins, nested resources, or
arbitrary paths; change provider settings; add tools; or add Live actions. A
Skill never expands the built-in action schema or tool set. Every action remains
subject to observation, schema validation, Approval policy, preflight,
cancellation, process-wide mutation serialization, and state-drift
revalidation. Skill Markdown has lower priority than system and safety
instructions and cannot authorize secrets, filesystem access, unsupported
provider fields, or actions outside the built-in schema.

The authenticated local bridge exposes a raw `POST /skills` route with exact
`text/markdown; charset=utf-8`, a 64-KiB reader, a bounded process-wide read
permit, timeout, optional explicit replacement, and an ID/SHA-256 receipt.
`DELETE /skills/:id` is idempotent after confirmed absence. Both use command
correlation and authoritative-state reconciliation. `/send` stays exactly
`{ prompt, sessionId }`; activation is the strict
`{ kind: "set_session_skills", sessionId, skillIds }` command.

## Attachment boundary

The accepted formats are PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3.
Shared policy constants allow at most 4 attachments and 30 MiB of raw bytes in
pending Session state or one model request. Each image is limited to 5 MiB and
the image subtotal to 16 MiB. Each document and the document subtotal are
limited to 20 MiB. Each audio attachment is limited to 20 MiB and 120 seconds;
the audio subtotal is 30 MiB and the audio count is at most 2. The combined
30-MiB and 4-file limits still apply. These are intentional cross-provider
limits: parsing, base64 wire encoding, and multi-round replay must remain
bounded in the Extension Host even when a provider accepts more. The server
detects the actual file type and is authoritative over WebView extension/MIME
hints.

Attachment blobs and JSON integrity metadata live under a private
Session-specific directory. Creation is create-only with collision retry;
reads reject symlinks, verify regular-file metadata, byte length, SHA-256,
detected media type, and bounded image dimensions or document structure.
Directory creation, deletion, and orphan cleanup use durable parent
synchronization and explicit unknown commit outcomes. Startup orphan sweeping
occurs before bridge commands are accepted, never from an ordinary state
snapshot that could race Session creation. POSIX directories are tightened to
`0700` and files to `0600`.

PDFs receive bounded envelope checks and an encryption-token check before use;
this is not PDF sanitization, page-count validation, or visual rendering. A PDF
is carried as a native binary model part only when the active saved
`RuntimeProfile` resolves `inputs.pdf === true` and its mode is OpenAI Responses
or Anthropic Messages. OpenAI Chat PDF input is intentionally outside this Live
Smith milestone, regardless of what a compatible endpoint may offer.

Audio inspection accepts only RIFF/WAVE with PCM format tag 1 or IEEE-float
format tag 3, and MP3 with MPEG-1 or MPEG-2 Layer III frames. The inspector
checks WAV structure and sample math, channel count, sample rate, MP3 frame
continuity, and duration without decoding the audio. ID3 is not executed or
interpreted as instructions, but inspection is not cleaning or sanitization.
The immutable attachment remains the complete original file, including embedded
metadata.

File upload and `attach_selected_audio_source` may create a pending audio
attachment without consulting the active Profile. The selected-source command
contains only the Session ID; it resolves an Audio Clip, Sample, or Simpler
source inside Live and never accepts or returns a filesystem path. The copy
opens only a non-symlink regular file without following links, applies a bounded
read, and compares file identity, size, and change timestamps before and after
the read. It also resolves the Live source again, so a changed selection/source
fails instead of attaching bytes from a stale target. This copies the source
file, not Live's warped, processed, rendered, or mixed output.

DOCX, XLSX, and PPTX are opened by a bounded local OOXML ZIP/XML parser. It
rejects malformed packages and packages with detected macro, VBA, ActiveX, or
macrosheet signals, and it never exposes embedded binary parts to the model.
This is not general OOXML sanitization; unrecognized embedded binary parts are
discarded rather than interpreted or sent.
The extractors preserve validated document, sheet, and presentation slide order
and produce semantic text, not a visual rendering of Word pages, spreadsheet
layout, or slides. Extraction is capped at 100,000 Unicode code points per file
and 200,000 code points across the request; per-file truncation is labelled in
the untrusted document wrapper, while a current request that exceeds the
aggregate limit fails before event append.

Upload, selected-source copy, pending-quota validation, deletion, request
preparation, event append, and existing-Session lifecycle mutations use the
same process-wide Session mutation fence. Operations check cancellation at
their defined boundaries; upload hashing, audio/PDF/OOXML inspection, Office
extraction, history reads, and waiting for the fence yield or recheck
cooperatively. Pending references are completely resolved before the user
event is appended. A confirmed append consumes those exact immutable IDs even
if the provider later fails; unknown append outcomes remain
`PromptPersistence=unknown` until authoritative state is refreshed. An ID can
occur in only one user event, consumed IDs cannot be deleted, and corrupt
duplicate occurrences fail closed. A current validation, capability, binary
budget, or extracted-text-budget failure leaves the files pending.

Current files reserve request capacity first. Historical candidates are
selected newest-first within the remaining count, raw-byte, image, document,
and extracted-text budgets, but the final conversation remains chronological;
only selected/current blobs are opened and verified. Missing, corrupt,
profile-incompatible, and over-budget historical files become fixed untrusted
markers instead of failing the new send. Assistant history is text-only.

The provider-neutral model contract carries typed user text, image, native PDF,
and audio parts. Transports recheck the corresponding input capability before
network I/O. The managed App Server maps image or audio data URLs only when its
signed-in model catalog explicitly declares that modality. Audio additionally
requires explicit `supported` evidence on the active saved `RuntimeProfile` and
either OpenAI Chat Completions or the managed subscription connection; model
tool support is unrelated and is not a gate. OpenAI Responses and Anthropic
Messages reject audio locally in this milestone. Office content is locally
extracted and encoded with its filename and media type in a JSON-escaped block
explicitly labelled untrusted. File names, embedded metadata, document text,
audio, and other binary content have no instruction authority; attachment IDs
and local paths are not exposed, and the action schema has no attachment or
arbitrary-path sample source. A file may inform the model but cannot directly
become a Live sample or filesystem capability.

## Configuration boundaries

Only profile CRUD/activation and the dedicated global-settings command write the
settings file. The global command currently owns the default Queue/Steer
follow-up behavior, is allowed while sends are active, and broadcasts committed
changes to every open dialog for the same storage directory. Sending,
discovering models, and creating/selecting/renaming/deleting sessions do not
write configuration. Old flattened provider settings and environment variables
are not configuration sources.

Each follow-up-setting write increments a persisted canonical nonnegative
decimal-string revision (`"0"` or a positive value without leading zeroes) under
a process-wide per-storage fence. Increment and comparison operate on decimal
digits rather than JavaScript numbers, so ordering has no safe-integer ceiling.
The same fence covers an unknown-commit readback and publication, so another
dialog cannot overtake that reconciliation and have its value attributed to the
wrong command. Each bridge caches the highest revision, overlays older
full-state snapshots, and replays the cached value when an event stream connects
or reconnects. Each modal bridge likewise reconnect-replays the latest
approval-mode patch for every Session, so an SSE gap cannot leave an ABA change
hidden behind an older full-state cut. The client uses the same length-first,
then lexicographic total
order, so an HTTP response serialized before a newer SSE event cannot roll the
control back. A bridge state snapshot may seed a revision, but a correlated
event for the same value and revision replaces that synthetic provenance and is
replayed.

Settings, sessions, and event logs serialize their read-modify-write operations
per storage directory. JSON replacement uses a unique private temporary file,
file sync, atomic rename, and parent-directory sync where the host supports it.
This prevents concurrent operations in one extension process from losing each
other's updates and prevents readers from observing partial JSON. If the rename
succeeds but the parent-directory sync fails, persistence reports an explicit
unknown commit outcome instead of claiming that the replacement did not happen.
Invalid settings, sessions, or event logs are reported as corruption and block
mutations rather than being treated as empty, so a later write cannot overwrite
recoverable Profiles, credentials, or history. Persisted storage IDs are
validated before use as filename components, and duplicate session, event, or
cross-event attachment IDs are rejected as corruption rather than sharing or
collapsing history. On POSIX hosts, read paths as well as writes tighten storage
directories to `0700` and private JSON/blob files to `0600`. Storage failures
cross the attachment HTTP boundary only as fixed typed diagnostics; absolute
paths and credential-bearing causes are never returned to the WebView.
Session deletion durably removes its event log before metadata; if event
removal fails or has an unknown commit outcome, the session remains visible and
retryable instead of leaving an unreachable conversation log.

Capability previews and discovered model lists carry an explicit source identity
in `ChatDialogState`. Both command HTTP responses and SSE state events use that
identity, so an unsaved Profile draft cannot be confused with the active saved
Profile when the two channels arrive in either order.

Profile state has three deliberate boundaries: incomplete `DraftProfile` values
enter through settings commands, only validated `SavedProfile` values reach
storage, and generation plus the active UI summary consume one materialized
`RuntimeProfile`. Each representation retains the same `direct-api` or
`codex-subscription` discriminant. Model discovery uses the Draft connection
gate and therefore does not require a Profile name or selected model. Secrets
enumeration returns only Direct API keys; managed subscription credentials stay
inside the isolated Codex home.

## Adding a model protocol

A new wire protocol requires a new `ModelTransport` implementation and a valid
family/mode branch in `registry.ts`. Keep model-name matching in
`capabilities.ts`; transports must make decisions from the resolved capabilities,
not model names. Add request-capture and multi-step replay tests for the new
transport before changing the registry.

## Adding a Live action

1. Add one descriptor to `src/agent/action-schema.ts`; it derives the action
   type, tool JSON schema, strict runtime parser, and model example together.
2. Add a confirmation summary in `src/agent/actions.ts`.
3. Add execution logic to `src/live/executor.ts`.
4. Add focused parsing, schema, confirmation, and execution tests.
5. Run `npm test` and `npm run build`.

When actions in one `apply_live_actions` call depend on a track that is renamed
or created earlier in that call, express the dependency with top-level
`targets`, creator `ref`, and consumer `trackRef`. Top-level targets and every
name-based action target bind to existing SDK handles. Existing Scenes, Cue
Points, Devices and their parents, Clips, Clip Slots, Take Lanes, mixer
parameters, and sample sources are bound per action as well. Execution uses
those objects directly, so an earlier delete or insertion cannot make a later
index/path resolve to a different object. Because the SDK deletes a Session Clip
through its Slot rather than through a Clip argument, execution also verifies
that the Slot still contains the bound Clip before deleting. A creator `ref` never
binds to a same-name existing track: execution always creates a new track and
binds the returned handle for later actions. Preflight revalidates existing
handles inside the extension-activation-wide mutation queue after confirmation.
All dialogs opened by that activation share the queue. Do not infer aliases from
display-name changes. Use staged apply/inspect/apply calls when later actions
require state only Live can return.

Scene creation, duplication, and deletion shift Session View row indexes. The
validator therefore rejects a structural Scene edit followed in the same plan
by a Scene-index target, Session Clip Slot target, or Session audio source. This
is staged explicitly: apply the structural edit, inspect the resulting Session
View, then submit the index-dependent work. Prebinding a prior Slot and silently
using it after an insertion would authorize a different sequential meaning.

Whole-Clip MIDI authoring uses `create_midi_clip` and accepts 0-4096 notes per
action. An empty named Clip is the staging anchor for longer work.
`replace_midi_clip_segment` then targets that exact arrangement Clip by track,
name, and start beat. Notes are relative to the Clip; each segment removes only
notes whose intervals overlap its range, preserves non-overlapping notes, and
sorts the result deterministically. Plans reject overlapping segment actions
for the same Clip. Preflight fingerprints the full current Clip and execution
rechecks the segment against the current Clip duration before assigning notes.
Every note must state its velocity explicitly; validation never invents a hidden
musical default.

Deterministic whole-Clip MIDI transforms target exactly one Arrangement or
Session MIDI Clip. The action binding captures the Clip handle before
confirmation, preflight fingerprints every current note, and execution applies
transpose, start quantization, velocity scaling, or beat shifting locally. A
transform writes the complete resulting note set only after validating every
pitch, start, and end against MIDI and Clip bounds; invalid output performs no
mutation. Optional SDK note fields are preserved unchanged.

`analyze_audio_clip` is a client-executed read-only observation. It resolves one
Arrangement Audio Clip on an Audio Track and refuses same-track overlap in the
Clip beat range. The SDK `Resources.renderPreFxAudio` service renders that range
to its extension temp directory. Live Smith opens the returned WAV without
following symlinks, validates one stable bounded regular-file snapshot, streams
PCM or IEEE-float samples with cancellation and cooperative yielding, and
returns path-free sample peak, RMS, crest factor, per-channel DC offset,
maximum absolute channel DC offset, silent-frame ratio at a 0.001 amplitude
threshold, and clipped-sample metrics. These are pre-effects track statistics,
not realtime monitoring or integrated LUFS. The Track, Clip, audible-content
settings, beat range, and overlap isolation are snapshotted before rendering
and revalidated afterward; the summary uses only the verified snapshot. The
SDK creates the WAV in its extension temp directory. Live Smith closes the
verified file handle but does not unlink the pathname afterward because the
beta SDK exposes no atomic handle-based cleanup contract; pathname lifecycle
therefore remains with the SDK temp directory.

SDK `1.0.0-beta.1` exposes no Automation Envelope object or automation-point
read/write operation. Automation is therefore outside the current action and
observation contracts; no parameter-write approximation is presented as
Automation support.

Extensions SDK 1.0.0-beta.1 accepts an exact built-in name through
`insertDevice`, but exposes no Browser, installed-device catalog, list, or
search API, and its insertion failure callback carries no host detail. The
agent therefore must not present a bundled name list as current-host truth.
Rejected insertions are runtime evidence: the persisted partial result names the
failed action, but does not prove that the device name is unavailable. The model
re-inspects the target and continues only with missing work using a changed name,
placement, or target only when observed evidence supports that repair. Repeating
an insertion is a literal request for another instance; the executor never
silently reuses a same-name device. Device parameters resolve by exact observed
name after case/whitespace normalization, never by substring guessing.

Drum Pad configuration also has explicit intent. Filling an empty pad refuses to
overwrite a chain that already contains devices. Replacing a sample requires an
exact observed Simpler path and changes only that Simpler, preserving the rest
of the Rack chain. Both replacement forms require explicit confirmation.
Sample confirmations show the complete observed source locator, including an
Arrangement start beat and a Simpler path/index. Session audio creation is
explicitly create-or-replace: a source, Warp, or loop mismatch deletes the
existing slot Clip before recreating it with the requested settings.

The model never executes arbitrary JavaScript or unrestricted filesystem/API
operations.

## Sessions and safety

Sessions are isolated by an activation-scoped project key and the selected Live
object's opaque SDK handle ID. Track, clip, device, and other object scopes stay
distinct even when their action target also retains an owning track; display
labels never determine session identity. Because the beta SDK exposes no stable
Set identifier across activation, historical object names are presented only as
reference labels and never as evidence that two objects are the same. All
unarchived prior-activation Sessions remain manageable in History. A Session
whose scope kind matches the current opening scope may use Continue here; this
does not match names or infer identity. The command sends only the Session ID,
and `restore_session` atomically binds the history to the current server-owned
handle while preserving the first binding as `originScope`. Rename, archive,
unarchive, and delete operate on current or historical Sessions. `archivedAt`
and `activeSkillIds` are optional additive fields. `approvalMode` is also
optional for backward compatibility; a missing value resolves to `manual`,
while new Sessions explicitly persist `manual`. Existing Session files require
no migration. Deleting a Session removes the mode with the same metadata record.
Model context uses the latest 24 user/assistant events plus a separate bounded
projection of the latest 12 persisted Apply results, rejected tool inputs, and
errors (at most 12,000 characters). Recovery records are labelled untrusted
bookkeeping data and never gain instruction authority. The bridge permits one
active send per Session while different Sessions may observe and plan in
parallel. A process-wide lease keyed by normalized storage directory and
Session ID spans exact Session lookup, attachment consumption, the provider/tool
loop, all trace/error persistence, and the final authoritative state snapshot.
Upload/delete, Skill activation, and Session rename/archive/unarchive/delete use
the same lease, so
another dialog cannot delete a Session and then have a running send recreate its
event log. A send never falls back to another Session when its requested ID is
missing. Waiting operations recheck cancellation immediately after acquiring
the lease. Different Sessions still overlap. Profile and model-discovery writes
are locked in both the dialog and bridge while any send is active. The active
Session's Approval mode selector is the exception: it remains writable during a
send and is read again from that Session immediately before each new Apply
decision. A committed change is broadcast to other open dialogs for the same
storage directory. Manual requests user
approval for every plan. Low Risk automatically approves only plans outside the protected
action set. Accept Everything automatically approves every validated plan,
including deletes and replacement writes. An automatic decision persists a
distinct `apply_auto_approved` Session event with the selected mode; this
records the approval source without claiming that Live grouped the plan into a
single Undo entry. Accept Everything changes approval only and cannot bypass
observation, action-schema validation, preflight, the process-wide mutation
queue, cancellation, or target/state-drift revalidation. Profile,
RuntimeProfile, attachment, and Skill state remain the request-start snapshot.

The composer has one follow-up dispatcher and one running control, Stop. Its
persisted global default is Queue. A Queue submission is captured in a
Session-scoped, window-local FIFO and is not appended to the event log early.
After the current send reaches a terminal state, the next item starts through the
ordinary `/send` path with its own send ID. It therefore reacquires the Session
lease and snapshots the then-current Profile, auth generation, capabilities,
Skills, attachments, history, recovery ledger, and Approval state. Stop
terminates only the running send; a queued next turn starts after that terminal
barrier. Queue promotion is
retried whenever a command, attachment operation, or Skill operation releases
its blocker. A pending Close decision is also a promotion barrier. Any turn that
is definitely not persisted, including the original
send, is reinserted at a paused FIFO head; a promoted turn with an unknown
outcome uses the same recovery slot. An original turn with an unknown outcome
also pauses its queued tail, without duplicating the uncertain original prompt.
If a promoted turn is confirmed persisted, only its remaining tail is paused;
the current head is never duplicated. A paused recovery does not count as
runnable work for Profile, Skill, or attachment repair, but it remains owned by
the window and included in Close warnings.
Composer value and revision are captured at send start and refreshed when a
Queue submission consumes the current draft.
The failed text therefore refills only an untouched empty composer, while any
newer draft is preserved. An explicit recovery Send removes that head when
retrying it. If the user instead sends the preserved newer draft, that deliberate
turn runs first and then resumes the retained head; a failure of the newer turn
reinserts it ahead of the retained work. No recovery path silently discards a
queued prompt or lets a later command pump skip the failed original. A typed
unavailable-Session terminal state cancels the shifted item and remaining FIFO
with a visible count even when refreshed state is
unavailable; prompts are never moved to another Session. Opening the Close
confirmation suspends every queue pump. Cancel resumes eligible work; acceptance
keeps promotion suspended while the window closes and discards pending items
without creating user events.
Changing the default affects the next submission immediately and never
reclassifies an item already queued or submitted.
The default is global and carries a monotonic decimal revision, so any
authoritative response may advance it without letting an older response roll it
back. This revisioned global reconciliation is independent of Session snapshot
ownership.

Foreground command, attachment, Skill, and explicit state reconciliation use
their full sendable `sessions` list to reconcile window-local follow-up
ownership. A background send terminal owns only its target Session metadata,
activity, Queue, recovery, and composer provenance; it never treats unrelated
Sessions missing from its older snapshot as deleted. If that target is
authoritatively deleted or archived, target-scoped reconciliation removes or
moves only that record.

`agent-flow.ts` produces an unversioned domain state. At the WebView boundary,
each modal bridge stamps every full `ChatBridgeState` exactly once with its own
monotonic decimal publication revision; the matching HTTP and SSE payload share
that identity. A full state also carries the publication revision captured
before its asynchronous request work as `bridgeStateCoveredThroughRevision`.
That cut, not the later publication identity, says which projection patches the
snapshot is guaranteed to include. Incremental SSE patches that change the
client-held projection carry revisions from the same local sequence, including
reconnect replays. The sequence is neither persisted nor compared across modals
and is not a storage freshness clock: an async snapshot can finish after a newer
patch. Mutable patches are skipped only when the current full-state cut already
covers them. Confirmation state is processed by its exact ID and generation.
Durable steering correlation is represented in both incremental and full-state
Session-event projections, so either one can reconcile an unresolved steer. The
client runs every authoritative HTTP/SSE state through one complete wire
decoder, including nested Session, Profile, model, auth, attachment, and
activity records. State-change and terminal envelopes are decoded before a
revision is consumed, a request is settled, or a projection is mutated. A
successful or failed JSON HTTP response is also decoded against its endpoint's
exact envelope before it can settle a command, Send, Steer, confirmation, or
Stop; Stop additionally requires the echoed send ID to match the request.
A contradictory unknown command outcome or mismatched Stop response is treated
as response loss and enters authoritative reconciliation instead of mutating UI.
A target-only background merge advances
the publication identity but not the dialog-wide cut; it records coverage only
for the target fields it actually adopted. Approval and activity projections
keep per-Session frontiers so a fuller snapshot may supersede an earlier patch
without claiming coverage for fields that the client preserved. Patches that change Session
activity carry the exact status and message written by the bridge; the client
does not invent a second activity projection for confirmations or steering.
Confirmation and steering HTTP acknowledgements echo the same revision and
activity as their SSE publication, so either delivery path is idempotent and a
later response cannot erase a newer visible status. A point HTTP receipt advances
only the observed publication identity and its named projection frontier; it
never advances the dialog-wide snapshot cut. An acknowledgement without an
activity projection leaves the current canonical activity unchanged. An exact
confirmation-resolution SSE also completes the matching in-flight UI decision;
after an HTTP transport loss, the client waits a bounded interval for that
authoritative event before falling back to Stop reconciliation. A different,
later confirmation for the same send is also authoritative forward progress:
it releases the prior wait before presenting the new decision. Every
confirmation carries a safe-integer generation that increases without gaps
within its active
send and is shared by its request, resolution SSE, and HTTP receipt. The client
keeps only the highest resolved generation on the attempt, so an older same-ID
reconnect replay cannot restore a completed or steering-superseded decision and
the replay guard uses constant space. Queue entries have a separate logical
`queueId`; every actual `/send` invocation allocates a fresh transport
correlation ID, so a delayed terminal from a failed attempt cannot match its
retry.

Send, command, attachment, and Skill attempts capture a
causal baseline for all Session records, the active Session identity and its
events, pending attachments, Live context, continuation target, and per-Session
activity. Direct responses and response-loss `/state` reconciliation both carry
that original baseline. A response arriving after a newer command, terminal, or
approval event uses a three-way merge, so it keeps newer fields and keyed list
entries while accepting non-conflicting changes committed by the response
instead of trusting cross-connection arrival order. Persisted events are
immutable and merge by ID only within the same active-Session projection; a
Session switch adopts the new projection as a whole. A conflicting duplicate
keeps the already observed entry. A Send owns both pieces of its active Live
context projection: the summary and the continuation target. It may initialize
its target title only
while that field still matches the attempt baseline; a later explicit rename
wins. It also owns consumed attachment IDs, context, and activity.
Other full-state responses adopt that context pair when the current pair still
matches their causal baseline, and preserve the current pair when it has moved
ahead independently.
Rename/approval/Skill commands own only their named Session fields, but a
baseline-later patch for the same field still wins. Archive/delete own target
activity removal; restore/unarchive do not. An explicit
restore/archive/unarchive/delete command owns its target's collection move. An
unavailable-Session terminal owns its target's authoritative remove or move. If
the target is still visible, it also owns the fallback active selection and that
Session's projection; a background failure does not. Target fields and unrelated
Session membership still use the same baseline merge. Its pending unavailable
marker is recomputed from each new authoritative state rather than surviving a
later target recovery. Removed
queued items contribute a structured
window-local canceled count. Separate cancellations aggregate, remain visible
beside foreground progress, and are not stored back as server state. Queues,
drafts, and visible state for valid foreground or peer Sessions remain intact.

An active send can additionally accept bounded, pure-text steering for its
exact bridge-owned send ID. The current send owner persists each steering
message as an ordinary user event before acknowledging it or adding it to model
context. Storage keeps a strict `(sendId, steerId, prompt SHA-256)` receipt for
idempotency and conflict detection. The UI projection removes the storage-only
hash and exposes only a bounded `(sendId, steerId)` `steeringAck` on that same
user event. Receiving the event therefore persists the timeline item and
reconciles the matching steer atomically, even when the later HTTP response or
`steer_accepted` frame is lost. Terminal acknowledgement reconciliation reads
the authoritative target Session state, not the separately merged projection
for whichever Session is currently visible.
An exact retry returns the original event without rewriting the log, while a
receipt reused for different content fails closed. Mid-loop `$skill` text does
not load another Skill snapshot. Steering aborts only the current provider
call, discards its unaccepted partial output, and replans from the last
protocol-complete local context. If OpenAI Responses is between output-limit
continuation calls, the loop removes the entire unfinished continuation suffix,
including opaque provider state, before adding steering. Stop remains the
terminal cancellation path for the whole send.

A newly submitted steering message supersedes an open confirmation without
approving it. The loop checks again before each tool, after confirmation, inside
the mutation queue, after state revalidation, and between individual validated
Live actions. An action that already crossed its execution boundary is allowed
to finish; later actions in that plan are withheld and the completed results
enter the same partial-recovery ledger used by Stop and host failures. Confirmed
Live mutations enter one process-wide queue; after acquiring the queue lock,
each plan repeats its preflight immediately before execution.
Steering detected at the first per-action guard has no completed action and is
therefore a clean supersession, not a partial host failure; it closes the tool
call and replans without opening a recovery ledger. A guard reached after any
completed action retains the partial-recovery path.
Current settings schema version 4 combines nested connection Profiles with the
strict `defaultFollowUpBehavior` value `queue | steer` and a canonical
nonnegative decimal-string revision. It still validates legacy `approvalMode`
for compatibility, but runtime authorization never reads that field.
Subscription Profiles persist reasoning mode and optional effort but no
unconsumed output-token placeholder; the decoder removes that historical field
from older nested subscription Profiles without rewriting on read. Persisted
settings use adjacent migrations: v1 maps `autoApprove` into v2, v2 wraps flat
Profiles into the subscription branch's nested v3 shape, and v3 is
shape-discriminated before migrating to v4. A v3 containing both follow-up
fields must contain only flat Profiles and preserves its behavior/revision; a
v3 containing neither must contain only nested Profiles and receives Queue at
revision `"0"`. Partial fields, mixed Profile shapes, and unknown fields fail
closed. Reads never rewrite the file; the next authorized settings mutation
persists version 4. A future version or incomplete adjacent migration chain is
reported as settings corruption.
The agent loop enforces a rolling 12-step no-progress window, a per-model-turn
tool fanout limit, cancellation, and a repeated-identical-invalid-tool-call
limit. Distinct validation errors are treated as an evolving repair attempt and
do not trigger the short repeated-error stop; they remain bounded by the rolling
no-progress window. Distinct host failures have an additional consecutive
no-mutation budget; this is not a total tool or workflow quota.
Completed Live mutations, new distinct observations, and accepted steering
renew the rolling window. One send accepts at most 32 distinct steering IDs, so
steering cannot extend the loop without bound; normal multi-stage work otherwise
has no fixed total-step ceiling.
Host observation, preflight, and execution failures are classified separately
and returned for evidence-based recovery rather than being counted as malformed
arguments. Observation argument objects reject unknown fields and invalid
optional values instead of silently falling back to the selected object. Command and send SSE
events carry the initiating request's correlation ID, and Stop identifies its
target send, so delayed state, completion, error, or cancellation traffic cannot
affect a later operation. State reads that arrive during a command wait for the
entire command handler, including body parsing and unknown-outcome
reconciliation, before building their snapshot. Send failures report whether
the user event was already persisted: the UI restores only prompts that
definitely were not stored. Persisted, unknown, and HTTP-success fallback paths
remain busy until an authoritative state refresh succeeds. If Stop initially
reports a non-terminal send, the UI polls with the same send correlation ID and
refreshes state only after that send reaches terminal state.
If cancellation arrives after one or more Live actions complete, their partial
apply result is persisted and published before cancellation propagates; later
actions in the plan are not executed. A simultaneous host failure remains a
partial failure rather than being converted into a successful cancellation
result.
For a non-cancelled action failure, including a rejection of the first action,
the completed mutations and exact failed action are persisted as a recoverable
apply result before being returned to the model. The bounded loop immediately
refreshes the narrowest available current Live state (the affected track when
known, the exact device for parameter failures, otherwise song or Set state).
Another mutation is gated until that refresh or an explicit inspection succeeds,
and an in-loop ledger rejects semantic resubmission of actions already completed
by the failed plan, using resolved Live track identity so `trackRef` cannot be
changed to an equivalent `trackName` to bypass the guard. The model can therefore
propose only missing work without depending on a guessed device catalog.
Persisted Apply/rejected-tool/error recovery context is available on the next
send in the same Session, not only inside one in-memory loop. Partial Apply and
partial Stop events also persist a strict recovery ledger containing only
SHA-256 semantic action-identity digests. The next send hydrates that ledger to
reject an equivalent replay before confirmation. Creator actions retain a
canonical song-level identity before and after Live returns the created Track,
independent of the temporary `ref`. Successful intermediate repair Applies add
their completed identities to the still-active ledger. Only a final successful
repair plan that explicitly sets `resolvesPriorFailure` persists the cleared
state. A host rejection with zero completed mutations is deliberately transient:
it still blocks a false success in the current loop, but it emits no persistent
replay ledger and a later successful alternative clears it without a model-owned
flag. Cross-request recovery therefore exists only when actual Live side effects
need replay protection. Tool-free completion prose remains subordinate to an
active unresolved failure. The same invalid tool error still
stops at the configured repeated-error limit. If the result cannot be persisted,
the failure remains fatal so the model can never retry without knowing what
already changed. Device parameter values outside the freshly observed range are
rejected rather than silently clamped after confirmation. Command mutations
whose follow-up state cannot be built use the same unknown-outcome reconciliation
path as uncertain storage commits. Closing the dialog aborts active work and
waits for send and command handlers to finish their terminal cleanup. Read-only
chat/state connections are destroyed instead, so an unresponsive state build
cannot prevent the modal flow from returning.

Scene actions describe Session View structure: `sceneIndex` identifies the
target, `newName` is the desired name, and `sceneName` is only an optional exact
current-name guard. Arrangement section markers use Cue Points. Preflight and
post-failure recovery share one action-to-observation router: indexed Scene
requests page directly to the target, while a top-level Device selected by
`deviceIndex` uses the exact indexed Device inspection rather than an ambiguous
name-only tree lookup. Validation errors retain the action position and type and
give deterministic target-field repair guidance without rewriting model
arguments. Timeline details preserve a long first error line when its summary
must be truncated, and failed or partial Applies open by default, so the UI and
model both retain the complete diagnostic. Confirmation rows preserve the
validated plan's original order and action numbers; category headings may repeat
rather than reordering mutations before the user authorizes them.

Bridge JSON inputs are strict route-specific contracts. Send accepts only
`prompt` and `sessionId`. Steer accepts the same two fields but requires the
exact active `X-Live-Smith-Send-Id` plus a unique
`X-Live-Smith-Steer-Id`; its prompt is limited to 64 KiB of UTF-8, with at most
eight unsettled and 32 total submissions per send. Same-ID retries are
idempotent only when their prompt is identical and do not supersede a later
confirmation again. The durable receipt remains authoritative after the send
leaves memory, so a terminal same-ID retry can return success only for the exact
original send and prompt. If a storage commit and the receipt read are both
uncertain, `/steer` returns a prompt-free
`steeringOutcome: "unknown"`; the client retains the same ID. Every terminal
send state also carries the Session events for that send, and the client
reconciles a pending steering receipt before clearing or safely retaining its
draft. Until that reconciliation, only the byte-identical guidance may retry
with the retained ID; edited Steer text and Queue submission cannot abandon the
possibly committed receipt. Queue starts another request through the unchanged
Send contract; its mode is never added to that body. The global-settings command
accepts only `kind: "save_global_settings"` and
`defaultFollowUpBehavior: "queue" | "steer"`.
Session, Profile, and subscription-auth commands accept only their
command-specific fields; confirmation and Stop reject body fields they do not
own. Stop targets the exact send ID in its header. While that send is active it
returns `terminal: false`; after cleanup it returns `terminal: true` plus the
consumed `promptPersistence` classification (`persisted`, `not_persisted`, or
`unknown`) for that stopped send. The UI uses that classification before
recovering or advancing Queue work, and an explicit Stop intent remains sticky
if an automatic recovery poll was already running. A Send registers its
correlation ID before reading the request body, so Stop during a slow admission
prevents that request from starting and later reports `not_persisted`. Stop for
an ID that has not arrived yet leaves a bounded process-local tombstone; a later
Send with that ID is rejected, repeated Stop is stable, and correlation IDs are
never intentionally reusable. Once Stop is requested, non-durable stream
progress, deltas, searches, and confirmations
cannot reopen the send's terminal activity; a durable late Session event may
still publish, but it carries the stopped activity. If a Stop-first terminal
classification is `unknown` while the original Send response is outstanding,
the client waits up to the existing five-second reconciliation budget for a
definitive Send outcome before falling back to unknown recovery. Every JSON
body is bounded
to 1 MiB before parsing. Skill source is never a JSON field; it uses the
separate authenticated raw route described above.
