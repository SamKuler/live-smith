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
      Coordinates chat state, bridge commands, agent execution, and errors.
    chat-bridge.ts
      Local authenticated HTTP/SSE bridge for the modal WebView.
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
      Normalized model, capability, tool, and transport contracts.
    capabilities.ts
      API-mode fallbacks, known model policies, and manual override resolution.
    registry.ts
      Selects a transport from a validated API family/mode pair.
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

  storage/
    settings.ts
      Explicit named-profile CRUD and global settings persistence.
    settings-migrations.ts
      Current-schema validation plus registered adjacent-version migrations
      for historical settings files.
    persistence.ts
      Serialized local transactions plus private, atomic JSON replacement.
    model-cache.ts
      Profile/fingerprint-isolated raw model-metadata cache.
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
      Shared WebView host adapter plus isolated Profile editor, bridge lifecycle,
      file attachment, local Skill manager, capability preview, and
      session/timeline factories with an explicit dependency-injection bootstrap.
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
6. `registry.ts` selects OpenAI Responses, OpenAI Chat Completions, or Anthropic
   Messages.
7. The transport maps normalized client function tools and provider-hosted
   tools, messages, and parameters to the wire protocol.
8. The transport returns normalized text, client tool calls, bounded citations,
   and opaque replay state. Hosted provider tools never enter the client tool
   executor.
9. Before confirmation, `agent-flow.ts` performs a fresh action-specific Live
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
HTTP status and status text.

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
network I/O. Audio additionally requires OpenAI Chat Completions and explicit
`supported` audio-input evidence on the active saved `RuntimeProfile`; model
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
settings file. Sending, discovering models, and creating/selecting/renaming/
deleting sessions do not write configuration. Old flattened provider settings
and environment variables are not configuration sources.

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
`RuntimeProfile`. Model discovery uses the Draft connection gate and therefore
does not require a Profile name or selected model.

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

Extensions SDK 1.0.0-beta.0 accepts an exact built-in name through
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
and `activeSkillIds` are optional additive fields, so existing Session files
require no migration.
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
are locked in both the dialog and bridge while any send is active. The global
Approval mode selector is the exception: it remains writable during a send and
is read again immediately before each new Apply decision. Manual requests user
approval for every plan. Low Risk automatically approves only plans outside the protected
action set. Accept Everything automatically approves every validated plan,
including deletes and replacement writes. An automatic decision persists a
distinct `apply_auto_approved` Session event with the selected mode; this
records the approval source without claiming that Live grouped the plan into a
single Undo entry. Accept Everything changes approval only and cannot bypass
observation, action-schema validation, preflight, the process-wide mutation
queue, cancellation, or target/state-drift revalidation. Profile and
RuntimeProfile state remain the request-start snapshot, and a confirmation
already open is not changed. Confirmed Live mutations enter one process-wide
queue; after acquiring the queue lock, each plan repeats its preflight
immediately before execution.
The settings schema stores the mode as `manual`, `low-risk`, or `everything`.
Persisted settings pass through an adjacent-version migration registry before
current-schema validation. Loading a valid schema-version-1 file maps
`autoApprove: false` to Manual and `autoApprove: true` to Low Risk while
preserving Profiles and credentials. Reads never rewrite the file; the next
authorized settings mutation persists schema version 2. A future schema version
or a historical version without a complete `vN` to `vN+1` migration chain fails
closed as settings corruption.
The agent loop enforces a rolling 12-step no-progress window, a per-model-turn
tool fanout limit, cancellation, and a repeated-identical-invalid-tool-call
limit. Distinct validation errors are treated as an evolving repair attempt and
do not trigger the short repeated-error stop; they remain bounded by the rolling
no-progress window. Distinct host failures have an additional consecutive
no-mutation budget; this is not a total tool or workflow quota.
Completed Live mutations and new distinct observations renew the rolling window;
there is no fixed total-step ceiling, so normal multi-stage work can continue.
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
`prompt` and `sessionId`; Session and Profile commands accept only their
command-specific fields; confirmation and Stop reject body fields they do not
own. Every JSON body is bounded to 1 MiB before parsing. Skill source is never a
JSON field; it uses the separate authenticated raw route described above.
