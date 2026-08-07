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
    session-context.ts
      Selects scoped sessions and derives bounded conversation and recovery
      context from events.

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
    persistence.ts
      Serialized local transactions plus private, atomic JSON replacement.
    model-cache.ts
      Profile/fingerprint-isolated raw model-metadata cache.
    events.ts, sessions.ts
      Chat session metadata and the canonical event history.

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
      capability preview, and session/timeline factories with an explicit
      dependency-injection bootstrap.
```

## Model request flow

1. The bridge accepts a prompt and session ID only.
2. `agent-flow.ts` loads the saved active profile; an unsaved UI draft can never
   enter a model request.
3. `capabilities.ts` resolves effective model capabilities and validates the
   saved generation parameters from manual overrides, raw discovery metadata,
   known policy, and conservative fallback.
4. `registry.ts` selects OpenAI Responses, OpenAI Chat Completions, or Anthropic
   Messages.
5. The transport maps normalized tools/messages/parameters to the wire protocol.
6. The transport returns normalized text/tool calls and opaque replay state.
7. Before confirmation, `agent-flow.ts` performs a fresh action-specific Live
   preflight observation and captures an opaque guard from actual SDK handle
   identities plus every current value the action can overwrite, including
   tempo, mute, solo, and device parameter value. Host `bigint` values are
   encoded deterministically at this fingerprint boundary instead of being
   passed to ordinary JSON serialization; Auto approve cannot bypass the guard.
8. After confirmation and immediately before execution, `agent/loop.ts` invokes
   that provider-neutral guard. A changed target, clip, device, parameter, or
   other action-relevant state performs no mutation and returns a failed tool
   result so the model can inspect again before proposing a new confirmation.
9. `agent/loop.ts` executes the bounded apply loop without inspecting provider
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

OpenAI Responses always uses `store: false`. Responses output items, Chat raw
assistant messages, and Anthropic content blocks are stored only inside the
current local agent loop and replayed unchanged when their protocol requires it.
Non-2xx provider response bodies are treated as untrusted and are not read,
logged, or persisted; transport errors retain only family/mode context plus the
HTTP status and status text.

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
validated before use as filename components, and duplicate session or event IDs
are rejected as corruption rather than sharing or collapsing history. On POSIX
hosts, read paths as well as writes tighten storage directories to `0700` and
JSON files to `0600`.
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
Set identifier across activation, matching prior-activation kind/label pairs are
shown only as recovery candidates. An explicit `restore_session` command ignores
client-supplied scope/project data and atomically rebinds the chosen history to
the current server-owned opening scope.
Model context uses the latest 24 user/assistant events plus a separate bounded
projection of the latest 12 persisted Apply results, rejected tool inputs, and
errors (at most 12,000 characters). Recovery records are labelled untrusted
bookkeeping data and never gain instruction authority. The bridge permits one
active send per Session while different Sessions may observe and plan in
parallel. Session select/create/restore/rename/delete commands remain available
during background sends, but Profile and model-discovery writes are locked in
both the dialog and bridge while any send is active. The global Auto approve
toggle is the exception: it remains writable during a send and is read again
immediately before each new Apply decision. Profile and RuntimeProfile state
remain the request-start snapshot, and a confirmation already open is not
changed. Confirmed Live mutations enter one process-wide queue; after acquiring
the queue lock, each plan repeats its preflight immediately before execution.
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
state. Tool-free completion prose remains subordinate to an active unresolved
failure. The same invalid tool error still
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
own. Every JSON body is bounded to 1 MiB before parsing.
