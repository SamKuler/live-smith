# Live Smith Architecture

This is the engineering reference for module ownership, request and Session
lifecycles, and safety and concurrency contracts. Live Smith keeps the Ableton
extension entrypoint thin and separates Live API execution from model protocol
details.

Use the [README](../README.md) for product usage, [AGENTS.md](../AGENTS.md) for
contributor rules, and the [Development Guide](DEVELOPMENT.md) for source setup,
verification, and packaging. [Model Profiles and Connection Backends](MODEL_PROVIDERS.md)
owns connection configuration, capability resolution, and protocol-specific
behavior; this document describes how those boundaries fit into the application.

## Module map

```text
src/
  extension.ts
    Registers Ableton commands and context-menu entrypoints.

  app/
    agent-flow.ts
      Owns the Agent runtime, bridge commands, OAuth readiness, and errors.
    window-hosts.ts
      Selects the persisted window host and owns one reusable browser runtime.
    agent-request.ts
      Runs one provider-neutral agent request, including attachment/Skill
      context, trace persistence, approval, preflight, and Live execution.
    live-mutation-queue.ts
      Serializes validated Live plans across dialogs in one extension activation;
      the caller revalidates state after acquiring the queue.
    midi-artifact-import.ts
      Validates Session artifact ownership and mediates queued Live MIDI import.
    network.ts
      Binds storage-scoped proxy settings to shared Fetch and WebSocket clients
      for model providers, audio services and Plugin applications.
    chat/
      chat-bridge.ts, chat-bridge-http.ts
        Own authenticated HTTP/SSE state, command admission, body bounds,
        correlation IDs and safe bridge errors.
      steering.ts, error-routing.ts, global-settings-events.ts
        Own follow-up admission, UI error routing and global settings notices.
    audio/
      audio-generation.ts, audio-processing.ts, audio-polling.ts, audio-job-runtime.ts
        Coordinate remote tasks, durable audio jobs, recovery, bounded polling
        and prepared output retrieval.
      audio-asset-sources.ts, request-audio-sources.ts
        Bind admitted audio, stage Session outputs and mediate Live Project import.
      request-audio-tools.ts, audio-parameter-tool.ts
        Assemble request-bound tools and explicit parameter-panel execution.
      suno/
        suno-session-manager.ts, suno-model-catalog.ts, suno-upload.ts,
        suno-human-verification.ts, suno-parameter-suggestions.ts
          Own account lifecycle, catalog admission, upload receipts, user-driven
          verification and account-bound parameter suggestions.
    plugins/
      request-plugin-tools.ts
        Discover enabled installed and standalone MCP tools for one request,
        bind admitted configuration and permissions, and mediate artifacts.
      integration-connections.ts, built-in-plugin-runtime.ts
        Resolve private Connection snapshots and bind host networking, private
        credential callbacks and provider application workflows to Plugin factories.
      plugin-apps.ts, plugin-app-sandbox.ts, plugin-parameter-tool.ts
        Own MCP App sessions, browser sandbox resources and panel invocation.
      plugin-lifecycle.ts, user-skill-lifecycle.ts
        Own package/Skill installation, replacement, permission changes,
        dependent Session cleanup and uncertain-commit reconciliation.
    model/
      model-request.ts, model-reconnect.ts
        Resolve saved Session model selection, assemble provider-neutral requests
        and capability previews, and bound retries before model-turn acceptance.
      model-auth-send-fence.ts, profile-settings-events.ts
        Serialize Profile OAuth edits and sends, and publish committed settings notices.
      dialog-model-state.ts
        Owns dialog model catalogs, discovery receipts, OAuth projections and
        browser login lifetime. Admits catalogs against the current authentication
        generation and binds model requests to the admitted backend. Coordinates
        Profile credential cleanup and backend release when the dialog closes.
      dialog-model-backends.ts
        Own lazy shared OAuth lease acquisition, acquisition cancellation,
        backend invalidation and ordered release for one dialog.
    context/
      attachment-context.ts, skill-context.ts
        Select bounded attachment and Skill data without exposing storage details.
      session-context.ts, context-compaction.ts
        Derive scoped recovery context and bounded model checkpoints from events.
    session/
      session-mutation-fence.ts, session-claims.ts
        Serialize same-Session mutations and track active dialog ownership.
      session-tool-catalog.ts
        Assemble Session tool views without invoking tools.
      session-search.ts, search-contracts.ts
        Search local Session names and chat messages with bounded result pages.
      session-artifacts.ts
        Project saved MIDI/audio versions and filter the artifact catalog.
      session-lifecycle.ts
        Own metadata-first deletion, pending cleanup and startup orphan
        reconciliation through the shared Session mutation boundary.
      session-approval-events.ts, session-edit-scope-events.ts,
      session-model-selection-events.ts, session-state-events.ts
        Publish committed Session metadata and scoped state invalidation.

  agent/
    action-schema.ts
      Single-source action descriptors that derive types, JSON schemas,
      runtime parsing, and model examples.
    actions.ts
      Plan validation, confirmation summaries, the action prompt, and the
      shared action-to-observation routing used by preflight and recovery.
    edit-scopes.ts
      Supported Session edit categories, strict scope parsing, and permission
      denial independent of the selected approval mode.
    loop.ts
      Provider-neutral bounded tool loop with cancellation and safety limits.
    progress.ts, system-instructions.ts
      Agent-facing progress labels and model instructions.

  attachments/
    audio.ts
      Strict, bounded WAV/MP3 inspection without decoding, executing metadata,
      or changing the owned source bytes.
    image.ts, pdf.ts, ooxml*.ts, odf.ts
      Type-specific inspection and bounded ZIP/XML document admission.
    office-parser.ts, office-parser.worker.ts
      Bundled officeparser/SheetJS extraction, visibility policy, presentation
      ordering, and bounded text projection in an owned Node worker.
    rich-rtf.ts
      Bounded built-in RTF visible-text and encoding extraction.

  audio-services/
    contracts.ts
      Typed audio protocol operations, private remote locators, historical job
      compatibility, and immutable audio asset contracts.
    lalal/
      LALAL.AI Public API v1 upload, multistem submission, task checks and
      cancellation, bounded protocol decoding and credential-free downloads.
    elevenlabs/
      Official music and sound-effect requests, bounded MP3 responses, and
      cancellation without automatic regeneration.
    google-lyria/
      Stateless Lyria Interactions generation plus bounded Lyria RealTime WSS
      collection, strict inline/base64 decoding, and PCM-to-WAV packaging.
    mureka/
      Official prompt-to-song and instrumental task submission, typed polling,
      stable output collection, and validated credential-free provider media
      downloads.
    suno-platform/
      First-party Suno Platform API-key generation, task polling, and bounded
      credential-free media collection through api.suno.com.
    sunoapi/
      Explicit third-party SunoAPI.org submission, polling, and provider-returned
      media downloads; no Suno Platform or website-subscription credentials.
    suno/
      Experimental Suno.com account-bound generation, custom parameters,
      extension/whole-song requests, bounded catalog/library reads, short-lived
      session-token exchange and authorized MP3 preparation with allowlisted CDN
      downloads. No browser impersonation or automatic download authorization.
    response-bytes.ts
      Shared bounded decoded-body reads with periodic cancellation yields and
      exact Content-Length checks only for unencoded responses.

  plugins/
    contracts.ts, manifest.ts, archive.ts
      Provider-neutral Plugin/package/tool contracts plus strict portable, Codex,
      and Claude manifest and bounded ZIP decoding.
    registry.ts
      Combines admitted built-in, installed, and standalone MCP toolsets and routes exact
      namespaced calls without a central operation switch.
    integration-connections.ts
      Plugin-owned and standalone MCP Connection configuration, write-only
      secrets, public views, and frozen schema-8 AudioService migration.
    builtins/
      Immutable provider Plugin definitions. Each definition owns its Connection
      descriptor, complete `tools()/parse()` contract, model constraints, and
      protocol factories.
    mcp/
      Bounded stdio and Streamable HTTP MCP configuration, lifecycle, tool
      discovery, invocation, cancellation, and result validation.
    artifacts.ts
      Read-only MIDI/audio staging and declared MIDI/WAV/MP3 output validation; never grants a
      Plugin direct Live mutation authority.

  skills/
    builtins.ts
      Bundled, read-only arrangement Skill registry and merged availability
      projection.
    format.ts
      Strict UTF-8 `SKILL.md` parser and safe Skill ID/summary contracts.
    plugin-package.ts
      Loads direct namespaced Skills from enabled immutable Plugin packages.

  live/
    action-bindings.ts
      Binds existing action targets to SDK handles and revalidates them after
      confirmation so ordered structural edits cannot drift to another object.
    context.ts
      Converts Live objects and selections into model-readable context.
    observer.ts
      Reads allowed Live state for model tools.
    object-id.ts
      Shared browser and host validation for serialized SDK object identities.
    preflight.ts
      Fingerprints action-specific Live identities and overwrite-sensitive state
      for revalidation immediately before execution.
    action-permissions.ts
      Derives complete-plan and per-action write scopes from bound Live objects,
      including the contents affected by container operations.
    executor.ts
      Applies validated and confirmed actions to the Live Set.
    audio-attachment-source.ts
      Reads an SDK-created temporary audio render through a bounded,
      race-checked regular-file snapshot without exposing its path.

  model/
    contracts.ts
      Normalized conversation, visible reasoning, tool-call, and model-turn
      contracts.
    profile.ts
      Named connection Profile, per-model configuration, and structural
      validation contracts.
    provider.ts
      Separates persisted Profile collections from the one effective runtime
      model, and owns normalized capability/evidence, context-usage, tool,
      transport, OAuth-auth, and backend contracts.
    capabilities.ts
      API-mode fallbacks, known model policies, and manual override resolution.
    backend-registry.ts
      Exposes distinct Direct API and OAuth subscription backend contracts and
      owns one lazily created slot per subscription Profile/provider connection.
    shared-backend-manager.ts
      Ref-counts one OAuth backend manager per canonical storage directory.
    registry.ts
      Selects a Direct API transport from a validated API family/mode pair.
    oauth/
      credential-manager.ts, openai.ts, anthropic.ts, google.ts
        Profile/provider-scoped OAuth login, refresh, credential ownership, and
        safe account-state projection.
      openai-codex-protocol.ts, anthropic-protocol.ts, google-protocol.ts
        ChatGPT Codex Responses, Anthropic OAuth Messages, and Google
        Antigravity mapping into the common model-turn boundary.
      direct-transport-adapter.ts, google-catalog.ts
        Request-scoped adaptation into shared Direct transports and the bounded
        Antigravity catalog.
    transports/
      openai-responses.ts
      openai-chat.ts
      anthropic-messages.ts
      Protocol serialization, streaming, tool calls, and opaque state replay.
      openai-http.ts, anthropic-http.ts, provider-error-body.ts,
      openai-errors.ts, anthropic-errors.ts, retry-after.ts,
      server-sent-events.ts
      Explicit HTTP headers, endpoint resolution, bounded provider-error
      classification, and shared SSE framing without provider SDK runtime
      dependencies.

  runtime/
    system-browser.ts
      Validates browser destinations and delegates to the system handler.
    system-open.ts
      Dispatches caller-admitted URLs or local file copies to the fixed macOS
      or Windows default-application handler, without a shell.
    oauth-browser.ts
      Opens one allowlisted pending OAuth HTTPS URL through fixed macOS or
      Windows default-browser commands after provider login acquisition succeeds.
    host.ts
      Resolves host-provided Fetch and Abort APIs with explicit capability
      errors and shared cancellation checks.
    proxy-fetch.ts
      Resolves the saved No proxy, System proxy, or Manual proxy route shared by
      provider Fetch and WebSocket requests.
    proxy-websocket.ts
      Opens bounded direct, HTTP(S)-proxy, or SOCKS-proxy WebSockets with
      header-only provider authentication and cancellable text-message reads.
    network-proxy-error.ts
      Defines the fixed credential-free proxy diagnosis preserved through
      Direct API and OAuth error boundaries.
    undici-network-fetch.ts
      Applies isolated direct/proxy dispatchers to the host-provided Fetch and
      reselects the route for redirect targets without changing process-global
      network configuration; only a selected proxy hop failing before response
      headers is identified as a proxy error.
    network-node-globals.ts
      Supplies explicit Node URL, Blob, Buffer, process, immediate, and
      microtask bindings to bundled network libraries in the restricted
      Extension Host VM.
    system-proxy.ts
      Reads static macOS routes through fixed `scutil --proxy`, or current-user
      Windows Internet Settings through a fixed, read-only `reg.exe query`, and
      returns only validated, credential-free routes. Windows machine-scoped,
      connection-specific, and automatic PAC/WPAD routes remain outside this
      static reader; visible root automatic settings are rejected, not
      evaluated.

  storage/
    scope.ts
      Canonicalizes the Ableton-provided storage path once so every process,
      transaction, fence, and event registry shares one physical identity.
    settings.ts
      Explicit named-profile CRUD and global settings persistence.
    oauth-credentials.ts
      Strict private OAuth credential storage keyed by Profile and provider,
      refresh-token rotation, connection-finalization cleanup, logout deletion,
      and deterministic one-time legacy migration.
    settings-migrations.ts
      Current-schema validation plus registered adjacent-version migrations
      for historical settings files.
    persistence.ts
      Serialized local transactions plus private, atomic JSON replacement.
    model-cache.ts
      Connection-fingerprint-slotted raw Direct API model-metadata cache;
      unsaved Draft discovery cannot evict another connection's slot, and an
      exact legacy Profile-ID slot remains read-only fallback;
      Live Smith's normalized subscription catalogs stay modal-only.
    events.ts, sessions.ts
      Chat session metadata, narrow Profile/model/reasoning selections, and the
      canonical event history.
    attachments.ts
      Private create-only attachment blobs, integrity metadata, ownership checks,
      quota policy, and durable Session-scoped cleanup.
    skills.ts
      Private bounded Skill catalog with recoverable replacement/deletion and
      selected-definition integrity checks.
    plugins.ts
      Private immutable Plugin archives, approvals, materialized runtime trees,
      separate mutable data directories, and recoverable catalog mutations.
    midi-artifacts.ts
      Immutable Session-owned Standard MIDI files and their version metadata.
    audio-artifacts.ts, audio-storage-budget.ts
      Immutable Plugin audio, shared exact audio reads and the aggregate budget
      across Plugin files and provider-job assets.

  ui/
    chat-state.ts
      Safely serializes modal state plus the source identity and evidence for
      capability/model discovery results.
    chat-document.ts
      Composes the production and DOM-test chat document from one fragment map.
    templates/chat-dialog.html
      Chat layout and styles.
    client/*.script.html
      Shared WebView host adapter plus Profile/model settings, bridge lifecycle,
      attachment, local and Plugin Skill, Plugin manager, Connection, tool
      inspector, composer input, and session/timeline factories.
      The composer-input factory owns prompt commands, completion, and keyboard
      semantics; Bootstrap owns final composer/status presentation and explicit
      dependency and operation-policy wiring.
    client/markdown-renderer.ts
      Shared sanitized Markdown rendering for conversation content and the
      read-only built-in Skill viewer.
    client/wire-contracts/
      Browser-safe validators for untrusted model, Session, Plugin and bridge
      state data. Inputs are unknown; output guards and allowed field names
      reference canonical public DTO types.
    client/session-search.ts
      Owns Session search queries, cancellation, refresh and pagination state.
    client/connection-state.ts
      Owns one confirmed Connection snapshot, audio drafts and editor selection.
      Audio form values are derived projections; the full snapshot retains
      installed-Plugin and standalone MCP fields and ordering.
    client/audio-connection-editor.ts
      Owns form rendering/events, submission state, account controls,
      catalog presentation and transient secret input lifetime.
    client/audio-results.script.html
      Owns audio task cards, local and remote playback, pending download
      confirmation and result actions. Reads current Connection and account
      projections; sends commands through the bridge.
    client/bridge-contracts.ts
      Browser bundle entry registering typed validators, Connection state and
      Connection editor factories before the bridge and UI bootstrap.
```

### Extension Host compatibility

Extension code imports Node runtime values such as `URL`, `Buffer`, and process
data from their `node:` modules. Host-provided Fetch defaults and Abort APIs are
resolved only through `runtime/host.ts`, which reports missing capabilities
explicitly and owns the shared cancellation helpers. Provider HTTP traffic uses
that host Fetch with the pinned, lazily loaded Undici dispatcher graph in
`runtime/undici-network-fetch.ts`. Provider WSS traffic uses the bundled `ws`
client with explicit HTTP(S) or SOCKS proxy agents. Bundle-time Node bindings
cover only globals omitted by the restricted Extension Host VM; the Undici Web
Fetch entrypoint is not used. The host evaluates the extension bundle as a
script, so the CommonJS output is wrapped in a function to keep third-party
top-level declarations out of the host's global object. Route selection
remains in `runtime/proxy-fetch.ts` and is consumed by both network paths, so
No proxy, System proxy, and Manual proxy do not mutate the Extension Host's
process-global dispatcher or affect another extension. `model/json-clone.ts` clones
provider/Profile JSON without depending on `structuredClone`. `build.ts`
checks these boundaries and smoke-loads the extension entrypoint without ambient
Web APIs, while the runtime suite sends real direct and CONNECT-proxy requests
through an equivalent restricted VM. A successful Node import alone is not
proof of Extension Host compatibility. Byte-input boundaries use
`node:util.types.isUint8Array`, not realm-local `instanceof`: Node Buffers and
host-returned byte arrays may have a different intrinsic prototype in the
isolated VM. Genuine byte views retain the same size, format, ownership and
integrity checks; other views and prototype/tag lookalikes are not accepted.
Production child processes are limited
to the fixed macOS and Windows default-application commands in
`runtime/system-open.ts` and the fixed read-only macOS/Windows system-proxy
queries in `runtime/system-proxy.ts`, plus the owned, bundled macOS Suno
verification capsule in `runtime/suno-human-verification.ts`; the build rejects
`node:child_process` everywhere else. The verification capsule's private input,
bounded result and lifecycle are described under external audio processing.

## Model request flow

### Admission and execution

1. The bridge accepts a prompt and session ID only. Attachment upload/delete are
   separate authenticated, size-bounded routes with strict Session ownership;
   bytes never enter the send JSON body.
2. Under the Session mutation fence, `agent-flow.ts` reads the requested Session
   and saved settings, then resolves the Session's model selection against the
   active saved Profile. An absent selection, a selection from another Profile,
   or a removed model uses that Profile's default model. An unsaved UI draft can
   never enter a model request.
3. `capabilities.ts` resolves effective model capabilities and their evidence,
   then validates saved generation parameters from manual overrides, raw
   discovery metadata, known reasoning policy, and conservative fallback. A fallback
   Boolean can keep a protocol usable without being presented as verified
   provider support. Bounded `providerReported` catalog evidence retains MIME,
   video, and reasoning scalars that do not authorize a Live Smith request;
   concrete input support is intersected with one shared format list and the
   selected transport's encoder boundary, and model names never authorize
   binary input;
   Direct API caches keep it in their exact connection slot, while OAuth keeps
   it only in the current modal/auth generation. The Settings UI identifies
   provider-reported formats or controls that Live Smith cannot use.
4. Before attachment reads or event append, `skill-context.ts` unions sorted
   persistent Session IDs with available `$skill-id` mentions. It resolves
   selected bundled definitions and copies/hash-validates selected User Skill
   definitions inside one global storage transaction, escapes their `&<>`
   boundary text, and freezes one 128-KiB-bounded instruction snapshot for every
   model turn in the loop. The original prompt is not rewritten.
5. Before appending the user event, `attachment-context.ts` verifies pending
   attachment metadata/blobs, resolves current plus bounded historical user
   parts, and extracts supported Office text. The append atomically consumes the
   current immutable references only after current-file validation succeeds.
6. `backend-registry.ts` routes strictly on `profile.connection.kind`. A
   `direct-api` connection asks `registry.ts` for OpenAI Responses, OpenAI Chat
   Completions, or Anthropic Messages. An `oauth-subscription` connection uses
   the canonical-storage-keyed, reference-counted native OAuth backend for its
   explicit OpenAI, Anthropic, or Google provider. Model names never select or
   change this connection boundary.
7. A Direct API transport maps normalized client function tools and
   provider-hosted tools, messages, and parameters to its wire protocol. OAuth
   backends obtain a refreshed credential and map the same normalized request
   directly to ChatGPT Codex Responses, Anthropic Messages, or Google
   Antigravity. They expose no provider CLI workspace or tool runtime.
8. Either backend returns the same normalized visible-reasoning, text, and
   client tool-call boundary. A reasoning stage exists only when the wire
   protocol reports one; its content contains only provider-returned visible
   text and may be empty for a stage-only signal. Direct API transports can
   additionally return bounded citations and opaque replay state. Signatures,
   encrypted reasoning, and other provider replay state remain transport-owned,
   never enter the visible reasoning contract, and hosted provider tools never
   enter the client tool executor.
9. Before confirmation, `agent-request.ts` performs a fresh action-specific Live
   preflight observation and captures an opaque guard from actual SDK handle
   identities plus every current value the action can overwrite, including
   tempo, mute, solo, and device parameter value. Whole-Scene deletion
   and duplication include every track's target-row slot identity, occupancy,
   and Clip content; renaming a Scene only binds its metadata. Host `bigint` values
   are encoded deterministically at this fingerprint boundary instead of being
   passed to ordinary JSON serialization; no Approval mode can bypass the
   guard. Parameter values outside their observed Device, Track mixer, or Chain
   mixer range fail here, before any earlier action can run. A single Apply is
   limited to 64 actions before preflight work begins. The complete plan must
   also fit the Session's latest saved Edit Scope;
   a denied plan never reaches approval or begins executing.
10. After confirmation and immediately before execution, `agent/loop.ts` invokes
   that provider-neutral guard. A changed target, clip, device, parameter, or
   other action-relevant state performs no mutation and returns a failed tool
   result so the model can inspect again before proposing a new confirmation.
   The guard also rechecks current permissions and affected contents. Before
   each subsequent action, the app synchronously checks that action's current
   bound contents against committed permissions; an already-started action may
   finish.
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
   mutation resets it, so productive large workflows remain uncapped. An active
   partial-recovery ledger accepts at most 5,120 completed-action digests. Its
   staged-work threshold preserves the earlier 4,096-entry format's repair
   headroom, while the larger persistence bound lets an already-full legacy
   ledger record one bounded final repair plan's known identities plus identities
   discovered by a partial execution. Persistence therefore cannot fail only
   after those additional actions have run. Capacity is not treated as an
   unlimited retry strategy: after a trusted current-request recovery
   observation, `resolve_live_recovery` always asks the user whether to keep
   completed changes and close the unfinished operation. Approval modes cannot
   approve it automatically, and it neither undoes nor mutates Live.

### Approval and Undo semantics

Single-action confirmation previews are optional provider-neutral facts carried
by the same preflight guard as target/state revalidation. MIDI and parameter
observations supply both the opaque fingerprint and the preview; the UI never
parses fingerprints or makes an independent read for an older-value display.
MIDI preview and execution share the deterministic transformation and segment
replacement functions. Creation previews pair validated action notes with the
same observed destination used by the guard: an empty destination or an exact
reusable MIDI Clip. Ambiguous overlap effects and non-reusable Session replacements
omit previews. Unsupported observations and multi-action plans omit the
preview and retain the complete existing action summaries.

MIDI action previews retain all validated notes from both snapshots. The piano
roll renders notes intersecting the visible time range, and its full view can
show the complete score. Older saved previews retain their omission counts;
missing historical notes cannot be reconstructed from a later Live state.

The `confirm_request` projection carries proposed facts under its
existing send, Session, model-turn epoch, confirmation ID and generation. Replays
must preserve both the action summaries and preview data. The client validates
the optional union before admitting a confirmation, and the dedicated
typed `action-preview` component renders it through the shared read-only piano
roll, without SDK objects, guessed units, or playback controls. A preview is not
evidence of a completed mutation, an authorization source, or a substitute for
the state-drift guard.

An operation ID correlates each persisted proposal, automatic approval, result,
and transient confirmation. The proposal event owns its bounded preflight facts;
result events record explicit applied, cancelled, partial, or failed status.
The chat reuses one card throughout this lifecycle. Missing results remain
unconfirmed, and proposed-after notes never become post-write observations.
Historical events without structured operation data keep their text presentation.

Tool results can carry canonical saved artifact references from host-managed
storage. The chat reads the exact Session artifact through the existing detail
endpoint and delegates import/export to the existing workflows. Raw tool prose
cannot create a preview or authorize a file operation. Retained card DOM preserves
part choices and piano viewports across event and locale updates; viewport entry
loads saved file details on demand.

An approval decision is an authorization boundary, not a promise of one Live Undo
entry. The 1.0.0 beta SDK does not allow awaiting inside a transaction, so an
ordered plan whose later mutations depend on earlier asynchronous results (for
example, create a track and then rename it) necessarily uses sequential SDK
transactions. Do not wrap the asynchronous executor in `withinTransaction` and
claim that the full plan is one Undo step; only mutations initiated before the
first await would be grouped.

### Untrusted data and hosted tools

Live context and tool results are explicitly untrusted data. Transports encode
Live context as a JSON string inside a labelled data block, and system
instructions forbid following instructions embedded in Live object names, MIDI
data, parameter labels, or tool output.

The SDK does not expose Live's current Arrangement/Session view. Selection
context names an explicit Arrangement range or Session Clip Slot, while a Clip
opened by handle reports its actual parent location. Without an explicit Session
request or location, new Clip creation targets Arrangement rather than guessing
a Session slot.

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
event schema. Search data cannot authorize client tools, approvals, filesystem
access, or Live mutations. Wire mappings and citation contracts are detailed in
[Provider-hosted Web Search](MODEL_PROVIDERS.md#provider-hosted-web-search).

### Protocol state and connection recovery

OpenAI Responses always uses `store: false`. Responses output items, Chat raw
assistant messages, Anthropic content blocks, and Google Antigravity parts are
stored only inside the current local agent loop and replayed unchanged when
their protocol requires it.
An OpenAI Responses `incomplete` terminal with reason `max_output_tokens` becomes
a provider-neutral continuation turn: the loop replays every returned output
item, preserves partial text and citations, and makes at most two additional
model requests. A function-call item is executable only if its own protocol
status is `completed`; partial items are replayed but never executed. Other
incomplete reasons fail closed. Chat `length`, Anthropic `max_tokens`, and Google
`MAX_TOKENS` use the same bounded continuation path. If continuation attempts
remain incomplete, the accumulated text and citations are emitted before the
explicit stop notice rather than discarded. Chat continuation replay closes
every returned function call with a fixed local non-execution result; a
text-only response instead receives a fixed local user continuation marker.
The transport validates the IDs and names needed for that pairing, retains
partial arguments as opaque protocol state, and exposes no truncated call for
execution. Anthropic
`model_context_window_exceeded` similarly preserves the valid partial turn and
ends with a visible context-limit notice instead of retaining replay state for
an impossible continuation. If Anthropic truncates streamed client-tool JSON,
the raw `partial_json` remains transport-owned replay state. The next
continuation ends with a local user marker when no client tool was emitted. If
the truncated response contains any client tool, every call instead receives a
local `is_error` result saying that it was not executed; an incomplete call's
result also returns its exact raw JSON. No truncated call is normalized into or
executed as a client tool call. An unresolved server-only tool turn cannot
accept a client result or text marker, so it terminates after preserving partial
output and tells the user to increase the output limit. A truncated server-tool
input forces the same termination even when the response also contains client
tools; only a complete mixed server/client turn can continue through client
error results. Canonical provider refusals are returned as assistant output;
unknown terminal values still fail closed.
Non-2xx provider response bodies are untrusted and are never logged or
persisted. OpenAI-compatible, Anthropic, and Google paths may decode at most
64 KiB of JSON to select a fixed local classification and retain strictly
validated code, type, status, reason, quota, and retry-delay fields. Transport
errors retain family/mode context, numeric HTTP status, and fixed local text;
remote messages, arbitrary metadata, and HTTP reason phrases are never
propagated.

Connection recovery sits inside one provider-neutral `askModel` step. A
transport or OAuth product protocol gives a private typed identity to eligible
Fetch rejection, response-reader rejection, premature streaming EOF without a
required terminal, or documented transient HTTP/provider failure. The step may
rebuild that same still-unaccepted logical response after cancellable waits of
0.5, 1, 2, 4, and 8 seconds. A valid provider `Retry-After` or structured retry
delay up to five minutes raises the corresponding wait rather than being
truncated; a longer delay exits automatic retry instead of sending early.
Abort wins at every boundary, so Stop and Steer terminate the active request or
backoff with their original reason. Authentication, quota/account limits,
policy/validation, size, decoding, malformed protocol, and callback failures
are not retried. OAuth authentication and lifecycle errors remain governed by
backend retirement, reservation, and auth-fence poison rules rather than
connection recovery.

Those waits permit one initial plus five outer `askModel` attempts. A transport
may make several HTTP exchanges, including Anthropic `pause_turn`
continuations, inside one outer attempt without consuming another reconnect
slot.

The reconnect owner creates one opaque object for those physical attempts and
passes it through request assembly without inspecting provider state. The
ChatGPT Codex protocol weakly associates its first bounded turn-state token
with that object as soon as a response header or metadata event arrives, so an
early EOF retry replays the same token. Google Antigravity likewise associates
one `requestId` with the object so physical retries keep one request identity.
Tool-result and output-limit continuations are new logical requests and receive
new IDs. The object and associations are not persisted or shared with a later
agent turn.

This recovery never re-enters `/send` or its one-time request-start
preparation. Each retry rebuilds the provider request from the same prompt,
Profile, capabilities, Skills, attachments, and history snapshot; the user
event remains appended exactly once, and the remaining hosted-search allowance
is recalculated for the rebuilt body. The loop has not accepted the returned
assistant turn, persisted its ordinary trace, executed a client tool, opened
approval, or entered the Live mutation queue when a retry is allowed.
Consequently no accepted tool result or Live mutation can be replayed.
Terminal hosted-search events keep their existing durable-first semantics;
every observed search ID reduces the allowance exposed to the rebuilt request.
Output-limit continuations remain one unfinished logical response and do not
advance the accepted-turn boundary until their final non-continuation turn.

## Model connection boundary

`ModelConnection` is a closed discriminated union:

- `DirectApiConnection` owns API family/mode, base URL, and API key. The
  registry selects one of the three explicit HTTP/SSE transports.
- `OAuthSubscriptionConnection` owns only an OpenAI, Anthropic, or Google
  provider identity. It is a product-backend boundary, not another Direct API
  mode or endpoint preset.

The backend contract mirrors that union. Direct API backends expose model
listing and turn creation. The OAuth backend additionally requires auth reads
and auth mutations at compile time; application code uses that explicit
contract rather than probing optional capabilities. `requestModelTurn`
receives one explicit backend turn executor and never creates hidden resources.

### OAuth ownership and lifecycle

`storage/scope.ts` canonicalizes the Ableton-provided Live Smith storage path
once, including aliases whose final leaf does not yet exist. The same canonical
directory is then used by persistence transactions, Session mutation fences,
cross-modal event buses, the auth/send fence and the shared backend manager.
This prevents a real path and symlink alias from sharing OAuth state while
accidentally using different storage or notification locks.

The OAuth backend is split by responsibility:

- `model/shared-backend-manager.ts` owns one ref-counted
  `ModelBackendManager` per canonical storage directory.
- `app/model/model-auth-send-fence.ts` serializes each Profile's connection lifecycle,
  with provider-tagged pending-login ownership, activity, generations, and
  poison. Different Profile IDs remain independent.
- `app/model/dialog-model-state.ts` owns each dialog's catalogs and OAuth
  projections. Discovery, capability loading and request admission share catalog
  ownership rules. Capability loading retains its Profile-use lease through
  command-state assembly. Browser launch results remain readable while that
  state is assembled, including authorization for an unsaved Profile.
- `storage/oauth-credentials.ts` owns strict private token persistence in
  Profile-ID/provider tuple slots. Provisional provider sign-ins do not replace
  another provider tuple; authoritative Save and Delete finalize the retained
  slots. Add, Duplicate, Discard, Profile switching, and modal close reconcile
  provider scopes actually authorized by that modal against saved settings, so
  an abandoned Draft cannot leave an unreachable refresh token.
- One process-wide storage preparation starts independently of Direct state
  hydration. OAuth operations and Profile mutations that change OAuth ownership
  await it; it migrates legacy provider-global credentials only to Profiles
  already saved in the same authoritative settings transaction and prunes
  tuples orphaned by a prior process. A failed preparation blocks that ownership
  mutation, while unrelated Direct state and sends remain independent.
- `model/oauth/credential-manager.ts` owns login acquisition through completion
  and refresh single-flight, including manager-owned logout cleanup, abortable
  retirement, generation-checked writes, refresh-error redaction, and one shared
  close completion.
- `model/oauth/openai.ts`, `anthropic.ts`, and `google.ts` own provider
  authorization flows. Antigravity uses its hosted Google callback; the user
  pastes its one-time authorization code into the exact pending Google Profile.
  Claude remains the only browser-PKCE provider using a local callback.
- `model/oauth/openai-codex-protocol.ts`, `anthropic-protocol.ts`, and
  `google-protocol.ts` own product-backend request mapping and normalized model
  results.

Each modal lazily leases the shared manager on its first OAuth operation.
Auth mutations and connection lifecycle changes exclude subscription sends for
the same Profile across modals; another Profile's auth, catalog, and send
ownership remain independent, including when it uses the same provider. Direct-only
state hydration, catalog access, and sends neither acquire that registry nor inspect
the auth fence's health; they may read its credential-free
generation solely to invalidate stale subscription projections;
pending browser or device login and readiness reconciliation are single-flight.
Modal auth projections are stored atomically by Profile, provider, and
generation instead of splitting account state from its identity. Profile
lifecycle paths use one lock order: the Profile auth/send fence precedes the
request-configuration fence. Unknown or partial post-commit cleanup remains in
a process-wide per-storage reconciliation set, survives modal closure, and is
retried against authoritative settings before later state is trusted.
Caller cancellation ends only its wait; backend retirement or final release
cancels pending login, aborts detached refresh, rejects late credential writes,
finishes any started logout deletion, and closes loopback authorization servers.
Native and registry close calls share completion and include slots already
undergoing invalidation. Registry shutdown and Profile-wide invalidation wait
for every provider cleanup before propagating one failure, so a shared manager
cannot be replaced before its prior backends finish retiring.

Before prompt persistence, every new subscription send refreshes credential
readiness and the provider model catalog and validates the current
account/catalog/model. Every agent-loop turn uses the same explicit backend
boundary; provider replay and
tool-call normalization do not leak into the provider-neutral agent loop.

The provider authorization, token fields, product endpoints, catalog ownership,
and wire invariants are canonicalized in
[Model Profiles and Connection Backends](MODEL_PROVIDERS.md#oauth-subscriptions).

## Plugin boundary

### Packages, compatibility, and storage

A Plugin is an installed package and namespace, not an audio provider class or a
Skill. `plugins/manifest.ts` accepts a portable Agent Plugins 1.0 root manifest,
Codex compatibility metadata, or Claude compatibility metadata. Matching Codex
and Claude manifests may coexist; without a portable root, Codex selects the
component paths. Repeated user configuration declarations must agree. A
portable root identity takes precedence only when any compatibility overlay has
the same identity and version. All declared component paths are relative,
normalized, and contained in the package. ZIP import applies the shared bounded
archive reader before manifest parsing and rejects traversal, duplicate paths,
links, special files, excessive entry counts, and expanded-size overflow.

| Package component | Portable | Codex compatible | Claude compatible | Live Smith behavior |
| --- | --- | --- | --- | --- |
| Identity | `plugin.json` | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` | Installed namespace and immutable version metadata |
| Skills | `skills/` | declared or `skills/` | declared or `skills/` | Direct `SKILL.md` entries become `<plugin-id>:<skill-id>` |
| MCP | `mcp.json` | declared file, `.mcp.json`, or compatible inline form | declared file, `.mcp.json`, or compatible inline form | Bounded stdio or Streamable HTTP tools |
| Commands, agents, hooks, output styles, apps, LSP and marketplace data | extension or package metadata | compatibility metadata | compatibility metadata | Reported in install review and kept inert |

Installation stores the exact ZIP by digest in a private per-Plugin directory,
creates a catalog record, and leaves the Plugin disabled with no MCP or artifact
approval. Replacement is explicit, preserves the separate mutable Plugin data
directory, disables the new package, and clears prior approvals. Runtime files
are materialized from the verified immutable archive into a digest-specific
directory; any mismatch is repaired from the archive rather than trusted.
Catalog entries retain bounded cleanup intent for replaced archives and removed
Plugins. Cleanup is idempotent and retried when the catalog is opened; a Plugin
ID cannot be reinstalled while its prior private data awaits deletion within
the process-wide storage transaction. Concurrent Extension Host processes
sharing one storage directory are not serialized by this queue. The
product command requires a Plugin to be disabled before removal and clears its
namespaced Session Skill selections before deleting the package.
Catalog schema 2 reads historical schema-1 records without rewriting them until
the next mutation; older builds do not read schema-2 catalogs.

### MCP tools and authority

The Inspector separates Session Context, Artifacts, Skills and Tools from
global Agent, Extensions and App settings. `model/session-tabs.ts` owns the stable
Session panel IDs and chat shortcut IDs. The Brief shortcut targets the creative
brief section inside Context. The composer places configured
shortcuts beside its Context summary; `bootstrap` owns their visibility and
`session-timeline` owns the complete Inspector navigation. Shortcuts open existing
panels or sections and preserve their drafts and scroll positions. Inspector navigation,
Session content, Skill activation and tool authorization remain available when a
shortcut is hidden.
Session Skill selection has no installation or
deletion controls; standalone Skill management and Plugin/Connection management
belong to Extensions. Global Custom Instructions belong to Agent settings.
Extensions separates Audio services, MCP, Skills, and Plugins. Audio services
owns audio account editors. MCP owns standalone and package-provided server
connections, launch details, and server permissions. Skills groups built-in,
user, and package-provided definitions by source. Plugin cards own package
lifecycle and link to the capabilities they provide. A Plugin that contributes
only Skills requires no Connection. Both connection views use the same persisted
collection, revision, unique-name rule, and quota. Switching capability pages
preserves nonsecret drafts and clears newly entered credentials. Resource editors
use one bottom action bar: removal on the left, discard and save on the right.
Read-only package and Skill content has no draft-save controls.

Installed package views expose parsed Skill IDs and descriptions independently
of package enablement. Absent Skill summary metadata remains explicitly unavailable;
it is not interpreted as an empty package. Session Skill activation continues to
resolve only enabled packages. Browsing the library neither reads full imported
Skill bodies into the dialog nor starts an MCP server.

The `load_session_tools` handler builds a modal tool directory from canonical
Live and built-in definitions and the ordinary approved MCP discovery path.
The dialog requests it through the read-only `POST /session-tools` endpoint on
startup and when its catalog owner changes. Discovery waits for foreground work
to finish, runs outside the command lock, and keeps errors local to Tools.
Obsolete reads are cancelled; only an owner-matched catalog is merged into the
current browser state. Failed loads wait for an explicit retry. Reading `/state`
alone does not start an MCP connection.
Discovery closes its packages after collecting descriptions and never invokes a
tool. The bounded display snapshot is cleared when its Session, model, Plugin,
or connection owner changes; display limits do not change executable toolsets.
Request-specific inputs and later remote changes may alter the next model turn's
tool list.

`plugins/parameter-panel.ts` derives native parameter controls from a supported
MCP tool input schema. It owns the scalar field contract, argument validation,
and the signature binding the schema to the package digest and Connection
configuration revision and admitted OAuth generation when present. Catalog projections contain bounded form fields and
opaque signatures; they contain no credentials or executable UI content.
Unsupported schemas remain available through the normal model tool path.

`run_plugin_tool` is an explicit Session command. It admits only the active,
unarchived Session in the current Live Set, holds the existing Session mutation
fence, rediscovers the MCP tool, and checks its displayed signature and parameter
values before invoking the ordinary authorized MCP route. Tool calls and results
use Session events. The command shares Stop and command-correlation handling with
other foreground operations; uncertain outcomes are not retried automatically.
MIDI artifacts use the existing grants and private staging path. A panel call
cannot invoke the Live executor. Request resources close on success, failure,
or cancellation.

MIDI import reads and integrity-checks the immutable SMF to derive note-bearing
parts identified by zero-based source track index and 1-based MIDI channel.
Track names are labels, never identities. Part summaries and tempo/meter event
counts are read-derived; historical artifact metadata requires no migration.
The authenticated read-only `/midi-import-preview` endpoint returns part summaries
and currently observed, uniquely named MIDI destinations without note arrays or
filesystem paths. The browser maps selected parts to distinct destination handle
IDs and names and previews each Clip at the common start beat with its source
track duration. Explicit new destinations become `create_midi_track` actions
followed by Clip actions targeting their declared references. Existing
destinations also use preflight-bound references so a new same-name track cannot
redirect later writes. The shared action limit counts both tracks and Clips.
SDK handle IDs travel as exact decimal strings without numeric
coercion or a fixed digit limit; import and continuation boundaries share this
contract. Live object IDs are separate from local storage IDs. Duplicate destination names require renaming in Live.

`create_midi_clip_from_artifact` materializes one exact `partId` into an ordinary
validated `create_midi_clip` action. A multitrack source requires `partId` or
explicit `mergeParts: true`; a single-part source retains its legacy whole-file
duration when no part is selected. `import_midi_artifact` accepts part mappings
or a single destination with explicit merging. It checks destination identities,
then uses the existing observation, full-plan Edit Scope, approval, mutation
queue, drift revalidation and per-action authorization boundaries. Partial
failures persist the same recovery ledger as chat-driven edits and prevent blind
retries. All positions are quarter-note beats; tempo, meter and controller events
are retained only in the source artifact and never materialize Set mutations.

### Bounded MIDI continuation

`app/midi/` owns observed Clip context, generation, and ordered buffer commands.
The shared `agent/midi-continuation-contracts.ts` DTO is consumed by command
parsing, storage and browser validation. The Session's private MIDI directory
owns one atomic `continuation.json` record; immutable source/output SMFs use
the existing artifact store and quotas. The Session send fence serializes setup,
Fill and import. Stop and Session admission use the existing command lifecycle.

`live/midi-clip-timing.ts` crops nominal note intervals at Clip markers and loop
boundaries and expands loops within the selected Clip span. Capture preserves
Arrangement offsets, fingerprints musical note properties and selected Clip
timing plus tempo, and excludes editor note selection. It does not synthesize
probability, velocity variation, instruments or audio. Both raw and expanded
context are bounded to 4096 notes. Importing a new Clip outside the selected
source ranges leaves that fingerprint unchanged.

Each generated section is conditioned on the original saved source and the
previous section. Model generation reuses the provider-neutral agent loop and
Session model admission with only artifact list, inspect and save tools.
`admittedToolNames` is checked before every dispatch, including built-in Live
and recovery tools. `save_midi_artifact` validates structured tracks and writes
format-1 SMF at 960 ticks per quarter note through the shared MIDI writer. Its
provenance identifies the actual Profile/model. Host context exports have explicit
host provenance; future sections carry `generationKind: continuation`.

Local Plugin/MCP generation uses the existing artifact grants and staging path.
A tool declares one `kind: midi` input, one MIDI output and
`continuation: { lengthArgument }` in its artifact contract; that argument must
have a numeric schema. Native parameter controls hide the host-owned input and
length fields. Later calls stage the original and preceding section as independent
tracks in one conditioning file, retaining their names/channels and avoiding
inferred voice identities. Output admission runs this same 960-PPQ conditioning
encoder before publishing a section, enforcing its track/note budgets and timing
representability. Output length, current tool authorization and source fingerprint
are also checked before publishing the next slot. Remote MCP endpoints cannot use this local file contract.

Fill records explicit tool-call/result events, never synthetic chat user events.
Per-section calls bind `parentCandidate` to the actual preceding artifact and
`requestEventId` to the Fill event, leaving the next-chat artifact selection
intact. Each completed slot is saved before generating another. Failure or Stop
preserves completed slots and immutable artifacts. Source checks around byte
persistence cannot make external Live edits atomic; publication and import
revalidate again and reject stale context without deleting saved material.

The head uses the existing MIDI mapping preview and import workflow. A source
revalidation callback runs after approval in the mutation queue and before each
action. The guard checks the materialized plan's actual destinations and Clip
durations against the protected source ranges. Successful execution consumes that exact head inside the import recovery
boundary; cancellation does not consume it. Explicit placement updates the anchor
for subsequent suggested positions. There is no playback clock, launch scheduler
or automatic replenishment; Fill/Refill and Use next are user actions.

### Saved artifacts, versions and lineage

Ordinary chat registers MIDI authoring from `app/midi/midi-artifact-tools.ts`
and shared list/inspection tools from `app/session/session-artifact-tools.ts`
whenever private storage is available. Plugin discovery
contains only Plugin tools; the chat and continuation registries compose the host
MIDI toolsets explicitly. Structured
tracks use the same authoring parser and SMF writer as continuation generation.
Saving needs no Live write scope; import retains its separate approval boundary.
The selected request parent fixes the revision source for model and Plugin saves.
Host-owned source/conditioning snapshots remain readable by artifact tools but
are excluded from the artifact library. Each future section is an independent
version group, while explicit revisions of a section preserve its existing group.

`agent/artifact-contracts.ts` owns the media-neutral version, source and primary
selection contracts. Version metadata remains on each immutable media record.
The shared allocator runs inside its owning store transaction; unavailable bytes
do not release a reserved version number. Legacy records project as independent
v1 groups. Explicit revisions record their actual parent; independent generation
alternatives may share a work without a fabricated parent chain. Cross-media
source provenance does not combine MIDI and audio into one version group. Revisions never overwrite source bytes. The admitted chat request fixes
the source version for its MIDI- and audio-producing tool calls.

Export and attachment commands resolve a Session-owned artifact and verify its
original bytes. `app/midi/artifact-file.ts` supplies a portable `.mid` filename;
`app/chat/media-response.ts` shares binary range and download responses with audio.
Resource-only tickets bind the media kind and expire independently of the bridge
control token. Attaching uses the existing upload admission and pending-attachment
flow, including during an active model request.

`app/session/session-artifacts.ts` projects Session-owned MIDI artifacts and
committed provider audio results and standalone Plugin audio into the paginated
artifact library. Version groups are assembled before pagination. Without a
search filter, each work selects its saved primary when available, otherwise the
latest available version; explicit references still resolve exactly. Audio
catalog/detail reads use metadata and blob presence; consumption validates
complete bytes. MIDI previews validate
the selected small SMF. `/session-artifact` reads one exact version
with the same ownership and projection contract. It creates no media
copies or artifact database. Audio bytes stay behind the existing authenticated
asset route; MIDI overviews contain at most 256 notes with source-part identity
and bounded part summaries. The read-only `/midi-artifact-preview` route reads a
selected part in full. Exact artifact details also return complete notes; both
retain the saved-file limit of 4096 notes, while the paginated catalog keeps its
256-note overview. The browser loads exact details when opening a truncated entry. It reads only saved media and never observes or mutates Live.

`export_artifact` and `attach_artifact` share a typed artifact reference and
read original bytes from the existing MIDI/audio stores. Provider audio results
require committed output ownership. Attachment uses the canonical Session attachment
admission, quotas and normalized-filename/content deduplication; export uses
resource-only download tickets.

`ui/client/artifacts.ts` owns expanded work entries and their selected versions.
Version reads are cancelled when an entry closes or the Session changes; stale
responses cannot replace a newer selection. `app/midi/midi-artifact-diff.ts`
reads the immutable selected file and an explicit same-work comparison version
through the existing MIDI store. Omitting the baseline uses `derivedFromId`;
reverse and sibling comparisons do not change saved lineage. `/midi-artifact-diff` is a cancellable read with Session admission and
no Live or model access. Complete-file counts and changes share the existing
4096-note input bounds, producing at most 8192 additions/removals across both files. Parts first match by unique name/channel, then unmatched parts may use a
channel unique in both complete files; file track indexes are not cross-version
identities. Whole-part uniform transposition matches pitch-sorted notes with
identical timing, length and velocity before multiset and mutual unique
single-property matching. The dedicated difference view selects one part and
uses `ui/client/midi-piano-roll.ts` for before/after overlays; it retains the
canonical source relationship separately from the comparison baseline. The same
read-only piano-roll component renders ordinary previews, owns beat zoom and
horizontal navigation, and clips drawing to its visible beat interval. It accepts
notes and presentation labels without storage, Session or Live dependencies.
Metadata and locale refreshes preserve the viewport; selecting another part resets
the view to its first notes.
`midi-import-dialog.ts` owns transient import fields, automatic observation,
cancellation and stale-response rejection. The bound artifact is fixed when
opened from the library; multi-result tool cards may offer a file choice. The
dialog closes before invoking the shared command/confirmation flow. Plugin
results and buffered continuation use this same importer. `inspect_midi_artifact` in the host artifact toolset reads one exact
source part with a 256-note page and `nextOffset`, allowing subsequent chat turns
to inspect the saved material without first importing it into Live.

The persisted `candidate`, `candidateSelection`, and `parentCandidate` names
remain compatible with existing Session histories. The `candidate` event records
a `continue` selection using a typed `{ kind, id }` reference, or a `primary`
selection containing a typed work reference and an optional exact version.
A null candidate clears the corresponding source or work primary. Primary writes
validate Session ownership and group membership. Model artifact listings expose
`primary` and `defaultForWork` without rewriting explicit references. Historical `prefer` events remain readable but are
not projected into the library or accepted as new selection commands. Selection
events are not chat messages and are omitted from the visible timeline. Pending
continuation survives compaction and reload through these durable events. Only a successfully persisted initial
chat `user` event consumes pending continuation and stores its `parentCandidate`.
The admitted request carries that fixed reference and its user event ID to every
subsequent model `tool_call` as `parentCandidate` and `requestEventId`. Steered
messages and manual tool calls leave pending continuation intact. A failure before
the initial message commit therefore leaves the source available for retry.

Generation provenance references the original tool-call and result events and
their public arguments. Owned artifact or audio-job IDs correlate the result;
initial requests and terminal events bound unmatched calls. Nested calls retain
their enclosing owner, and steering remains within the active request.
Overlapping same-name calls keep their provenance unknown. Artifact views never
read current Connection credentials or pretend missing historical arguments are
known. Shortened parameter previews retain the original event reference. A
source selection does not authorize generation or mutation: Continue prepares
a composer draft, MIDI import uses the ordinary mapped import path, and audio
import uses the existing chat action/preflight path. Read-only browsing, differences and
playback remain available during generation; selection commands share the Session
mutation fence and validate ownership again before writing their event.

Artifact catalog search filters names, version labels and source labels before
group pagination. Source labels include aliases from the supported UI catalogs;
user-authored names remain literal. A matching exact version is selected even
when the group's primary version does not match; the group's complete version
and provenance metadata remains available. The query belongs to the library view and resets
on Session changes. Read cancellation is independent of artifact mutations, so
typing a new query cannot release an outstanding selection or transfer command.
If a catalog shrinks beyond the requested page, the library reads the last valid
page, including page zero for an empty catalog.

`ui/client/plugin-parameters.script.html` renders the native controls inside
Session Tools. Optional parameters have an explicit inclusion control; omitted
fields stay absent from the request. Form drafts survive directory redraws while
their Session, source settings, and definition match. They are dialog-local and
never write Profile, Connection, or Session settings. Author-provided labels,
values, descriptions, and results render as text. Generated DOM control names
remain separate from schema keys; submission preserves the original argument
names and types. Ordinary parameter edits do not run a tool; submission goes
through the authenticated command bridge.

### Plugin configuration and interactive Apps

`plugins/user-config.ts` owns the bounded Claude-compatible `userConfig` contract,
typed values, public projection, and `${user_config.KEY}` substitution. Portable
manifests carry the contract in the Live Smith extension namespace. Configuration
definitions belong to immutable package bytes; `storage/plugins.ts` saves values
and sensitive values in separate maps in the private per-Plugin configuration
record. The record has an independent revision, survives replacement, and is
removed with the package on uninstall. Sensitive values never move into the
public map when an updated declaration changes a field's sensitivity.

The `set_plugin_user_config` command checks the displayed package digest and
configuration revision inside the storage transaction and configuration fence.
It validates the complete resulting configuration, commits atomically, closes
existing Plugin connections, and invalidates public state. The settings panel
owns drafts and writes only on Save; sensitive inputs are write-only. Package
replacement can leave invalid values visible for repair without enabling them.

Request admission snapshots Plugin package digests and configuration revisions
with selected Skill text. MCP discovery must match that snapshot, and each tool
or resource operation rechecks current admission. The MCP client resolves original
path, credential, and user configuration placeholders in one pass before starting
the process or opening HTTP transport. Saved strings are never reinterpreted as
templates. Skill interpolation substitutes non-sensitive values and a fixed
placeholder for sensitive fields before the existing instruction wrapper escapes
the result. Configuration cannot grant tools, permissions, or Live actions.

`plugins/mcp/apps.ts` owns tool-UI metadata and bounded HTML resource validation.
Both modern `_meta.ui.resourceUri` and legacy `ui/resourceUri` metadata are
recognized. App-only tools stay out of `ToolRegistry`'s model-facing definitions;
interactive calls resolve the original tool name within the App's exact admitted
server and named connection. Results keep UI-only `_meta` outside model history.
The reserved `io.github.samkuler/live-smith-artifacts` result metadata is rebuilt
from host-validated artifacts. Server values cannot forge these references;
reopening an App resolves saved references against the current Session store.

`app/plugins/plugin-apps.ts` retains request resources for each open App. Authenticated
bridge endpoints open, call, read/list resources, and close an instance. The
browser allocates the instance ID before sending its open request. One bounded
map owns both pending opens and ready instances; close can cancel and await
creation even before the response body delivers its result. Duplicate live IDs
cannot replace an instance. Opening does not execute the entry tool. Tool calls
revalidate the active Session after acquiring its mutation fence, append history,
and use the existing MCP execution
route and artifact grants. Completed and unconfirmed outcomes invalidate the
current dialog as well as peer dialogs. Instance close aborts pending requests
and releases connections; bridge close also owns pending opens and sandbox
startup. Read-only resources are bounded and restricted to the same admitted
server. Resource and resource-template RPCs preserve server pages and opaque
continuation cursors. Their HTTP request budget derives from the same 4 MiB MCP
message bound with space for the instance ID and JSON envelope; other JSON
requests keep their ordinary 1 MiB bound. Cursors remain opaque strings.

MCP connection cancellation closes the transport during negotiation, including
the SDK's disposable stdio probe process, and awaits its cleanup. The opening
signal detaches after success; a retained connection remains owned by its
request resources until explicit close.

`ui/client/plugin-results.ts` supplies shared composer and MIDI import actions
for App and native parameter results. Result summaries use bounded plain text,
with formatted JSON for structured content when no text content is present.
`import_midi_artifact` admits an explicit Session artifact, track name, and
Arrangement position. `app/midi-artifact-import.ts`
materializes its ordinary action plan and reuses preflight, approval policy,
Edit Scope subscriptions, the shared mutation queue, and executor. Commands
request host-owned confirmation tokens through the bridge; Stop, shutdown, and
command completion settle pending approvals. Partial or uncertain execution
persists the normal recovery ledger and returns an unknown command outcome.
An existing active recovery blocks another direct import until resolved.

`ui/client/plugin-apps.ts` bundles the official MCP Apps AppBridge and uses manual
handlers so every RPC passes through the host. `app/plugins/plugin-app-sandbox.ts` serves
a fixed proxy from a separate loopback origin; its inner App iframe has an opaque
origin. Closing a loading App, changing its owner, or opening a replacement
cancels the pending HTTP open request and its backend discovery. The browser
also closes its known instance ID independently of response delivery. Both
directions check source windows and origins. The proxy receives the HTML through
the standard sandbox handshake and enforces an HTTP CSP. Main bridge
tokens, credentials, and the host DOM remain outside the App. Capability negotiation
advertises only implemented tool/resource access and sandbox configuration.
The detailed author contract and current domain restrictions belong to
[Development](DEVELOPMENT.md#mcp-apps).

Enabled installed Plugins are discovered per request. The request snapshot binds
the package ID, digest, exact MCP server, optional named Connection ID and
private credential snapshot, exposed tool, server approval, and artifact
approvals. Execution rechecks that admission inside the Plugin
authorization fence. A changed, disabled, replaced, or unapproved package cannot
reuse an older model-visible tool call. Package MCP and artifact permission
commands carry the reviewed archive digest. Grant and revoke compare that digest
inside the storage transaction before accepting either a change or a no-op; a
replaced package requires a new review.
Standalone MCP Connections use the same transport, schema, result, and tool
routing boundary without an installed package or digest. Their enabled state
authorizes the exact saved launch configuration or endpoint. Execution rechecks
the named Connection, private credentials, and artifact grants under the same
authorization fence. Changing, disabling, or removing any named MCP Connection
closes its admitted clients before the settings command returns.
Discovery registers each MCP package before opening a connection. Cancellation
closes packages already registered; disabling a Plugin or revoking MCP or
artifact approval closes its active packages before the configuration command
returns. A closed package cannot reopen a process during an in-flight request.

Local MCP commands use no shell, receive a minimal environment, and run as the
current operating-system user. Installed servers resolve package and data
placeholders only inside their owned roots. Standalone commands use literal
arguments, optional working directory, and explicitly saved environment values;
no Plugin paths are injected. Live Smith does not claim an OS sandbox. Remote MCP uses
the proxy-aware Fetch boundary, rejects redirects, permits HTTPS or loopback
HTTP only, and stays bound to its declared origin. Installation and inspection
never start either transport. MCP schemas, names, results, stderr, message sizes,
timeouts, and cancellation are bounded; package paths, private data paths, and
raw process or network errors cannot enter model-visible results.

MCP tools cannot call the Live executor. An approved artifact-input contract
replaces an opaque Session audio or MIDI reference with one read-only temporary file for
the duration of the call. An independently approved artifact-output contract
supplies one host-owned temporary destination, accepts only a regular contained
file, validates its declared MIDI or WAV/MP3 format, and stores an immutable
Session artifact. The output grant covers both audio and MIDI; it grants no Live
mutation authority.
The MIDI bytes are durably written before their metadata commit. Listing under
the storage transaction admits only structurally complete pairs. Unpaired files
remain private and count toward the storage limit; missing blobs retain their
metadata and are reported as unavailable while healthy artifacts remain usable.
An unavailable artifact cannot be imported, and ordinary Session sends continue
with a warning. Import verifies the bytes and parsed MIDI against the saved
metadata; malformed or substituted files fail validation.
MIDI provenance records the installed Plugin, standalone Connection, actual model or host operation identity.
The model receives only its opaque artifact reference. A later
`create_midi_clip_from_artifact` action still passes the ordinary schema, Edit
Scope, Approval, preflight, cancellation, mutation queue, and drift checks.

### Remote MCP OAuth

`app/plugins/mcp-oauth.ts` adapts the MCP SDK's OAuth implementation to explicit
Connection commands and the host network boundary. `start_mcp_oauth` and
`logout_mcp_oauth` accept only an exact saved Connection ID. The first owns the
system-browser interaction; runtime discovery and tool calls may only read and
refresh an existing account. Missing authorization becomes a per-Connection
`authorization_required` issue without disrupting healthy sources. `/state`
projects local account status and generation without network access.

`plugins/mcp/config.ts` validates packaged remote `oauth` declarations against
`mcp/oauth-contract.ts`. The Plugin view carries public defaults into new
Connection drafts; saved Connections remain the runtime authentication owner.
A declared OAuth server requires a named Connection and cannot enter anonymous
discovery. Public client ID and callback port are supported across package
formats; unknown OAuth fields and manual Authorization headers are rejected.

`app/plugins/mcp-oauth-owner.ts` is the canonical owner resolver for interactive
login, silent token use, and status. The private fingerprint binds the Connection,
its enabled state and authentication configuration, exact package digest/server,
and expanded resource URL and headers. User configuration changes revoke only
accounts whose expanded MCP routing changes; unrelated Skill or style parameters
preserve them. Disabling, replacing, removing, or retargeting an owner clears its
credentials. Local writes use the storage transaction and generation CAS, so an
old callback or refresh cannot revive credentials after revocation. Follow-on
metadata write failures after credential revocation report an unknown commit
outcome for state reconciliation.

`storage/mcp-oauth.ts` persists issuer-stamped registration and tokens in a
private bounded store, separate from model Profile OAuth. The browser receives
only public client configuration, status, and an opaque generation. Refreshes
serialize per Connection. The transport associates each response with the bearer
actually sent, allowing a late rejection of an older token to reuse an already
refreshed token. Explicit sign-in creates a new generation; tool-panel and App
ownership includes it. Sign out clears credentials and closes active clients.

The SDK owns discovery, PKCE, resource and issuer validation, registration, and
refresh. Registration uses a public client with either dynamic registration or
an explicit registered client ID and fixed callback port. A dynamic registration
keeps its chosen loopback redirect URI for subsequent sign-ins; failure to bind
that port leaves the prior record unchanged. `runtime/oauth-loopback.ts` owns
the bounded callback listener and state check, including the authorization
response issuer passed to the SDK. The model OAuth wrapper preserves its existing
code-only callback contract. No client-ID metadata URL is fabricated.

OAuth Fetch uses the configured proxy and host cancellation APIs, rejects
redirects, accepts HTTPS or loopback HTTP, and limits each response to 512 KiB
and 30 seconds. The initial resource challenge cancels its body after reading
headers. Resource-specific headers are included only on that resource request,
never on discovered authorization-server endpoints. A manual Authorization
header conflicts explicitly with OAuth. UI errors use bounded local messages
without credential-bearing remote responses or causes.

### Built-in Plugins and Integration Connections

Built-in provider integrations are immutable Plugin definitions and do not
consume installed-package quota. They expose the same request-level
`Toolset` interface and registry routing as installed and standalone MCP sources, while
their trusted host adapters remain explicit local factories. Every built-in
definition owns its complete `tools()/parse()` contract, Connection descriptor,
model constraints, and generation or processing factory; the registry does not
infer tools from a provider switch or central capability table.

An Integration Connection is a separately persisted named user instance with
public configuration and private write-only secrets. Plugin-backed records hold
a Plugin ID and its configuration; standalone MCP records hold their transport
configuration directly. Built-in Connection descriptors belong to the provider
definitions. Installed MCP
servers can bind multiple named Connections to exact package digests and server
IDs, including remote servers without credential placeholders. Such servers use
anonymous discovery only while no named Connection targets the current package
digest and server; a disabled named Connection does not fall back to anonymous
access for that owner. Declared stdio environment and remote header placeholders resolve from
private Connection secrets at transport admission; the browser receives only
credential field names and configured flags, and the model receives no secret
fields or arguments. An omitted credential may inherit only from the same
Plugin, server, and package digest. Replacing a package leaves older Connections
visible but unable to execute until explicitly rebound with new credentials.
The collection revision remains the compare-and-swap owner for all Connections.
Standalone secrets are literal stdio environment values or Streamable HTTP
headers; only configured field names reach the browser. Omitted values inherit
only while the exact MCP transport configuration is unchanged. Empty values
clear saved fields. Standalone artifact grants are independent and local-only.
No installation, settings read, or Connection save starts a process or request.
Its latest-change audio marker lets the client retain audio drafts across one
adjacent MCP-only update; missing revisions or audio changes still conflict.
The settings decoder migrates schema-8 `audioServices` records to
schema-9 `integrationConnections`; schema 10 adds standalone records while
preserving existing Plugin records without rewriting on read. Existing audio job
records retain historical provider, operation, and `serviceId` facts; new records
also persist `pluginId`, `toolId`, and `toolVersion`, and legacy records derive
that identity on read so saved assets and Resume remain valid.

## Skill boundary

### Definitions and presentation

A Skill is one declarative UTF-8 `SKILL.md` definition from the bundled registry,
the standalone User Skill catalog, or an enabled immutable Plugin package. The
standalone parser requires exactly plain `name` and `description` frontmatter;
the compatibility parser requires `description`, permits a matching or omitted
`name`, and validates but does not interpret other plain-scalar fields. Both
require a non-empty Markdown body and reject malformed UTF-8, BOMs, unsafe
controls, ambiguous YAML constructs, and files larger than 64 KiB. The standalone
User Skill catalog permits 32 definitions and 1 MiB total; built-ins and Plugin Skills consume
neither quota. A standalone import is one file: directories, scripts, binaries,
assets, nested references, Plugins, MCP servers, executables, and caller-supplied
paths are outside that route.

`skills/builtins.ts` contains the three canonical arrangement definitions and
merges every available source. Built-ins are available in every Session, start
disabled, never create storage, and cannot be installed, replaced, or deleted.
`skills/plugin-package.ts` reads only direct `<skills-directory>/<id>/SKILL.md`
entries, requires a safe matching local ID, and exposes them as
`<plugin-id>:<skill-id>`. Nested files remain inert package resources. Application
state projects `source: "built-in" | "user" | "plugin"` plus a Plugin ID when
applicable, without a body, hash, archive byte, or path.

For Skills, `ChatDialogState` and `ChatBridgeState` expose only summaries and
active IDs. The composed dialog document separately embeds a script-safe snapshot of
canonical built-in definitions for its local read-only viewer; those bodies are
not part of generic state or HTTP/SSE state payloads. Viewing follows the
available-source discriminator, does not change activation, and reads only the
bundled built-in bodies. User and Plugin Skill bodies never enter generic state.
The viewer shares the conversation's sanitized Markdown
renderer; raw HTML and images remain inert text, and links are limited to HTTP,
HTTPS, and mailto destinations.

### Storage and activation

`storage/skills.ts` derives every path from a validated Skill ID and uses the
same global per-storage transaction queue as Sessions. Install/replace/delete
uses a recoverable pending mutation plus private staging, durable atomic writes,
directory identity checks before and after mutation, and strict catalog
validation. The cleanup boundary includes initial directory creation and staging
before a pending mutation is recorded. Startup removes empty or staging-only
unreferenced owned directories, while rejecting links and foreign contents.
Stable catalog listing reads summaries and safe file metadata only;
only selected definitions are opened, bounded, hash-checked, and parsed. Catalog
capabilities are scoped to an active opaque storage transaction, and detached
operations are drained before the transaction releases.
Enabled Plugin Skill definitions are instead read and hash-verified from the
immutable archive under the same storage transaction that snapshots availability.
Disabling a Plugin removes those Skills from new request admission. Product-level
Plugin disable commits the disabled state before clearing namespaced selections
from Sessions. A failed Session cleanup leaves the Plugin disabled; request and
UI projection ignore those inactive IDs, and later disable, enable, or delete
commands retry the cleanup before enabling or removing the Plugin.

`AgentSession.activeSkillIds` is an optional, sorted, unique list of at most four
safe IDs. Activation validates the Session and the combined available IDs, then
writes the Session inside the same global storage transaction. Normal active
Sessions can add or remove available Skills. Archived and foreign-project
Sessions allow removal-only changes so a user can unblock User Skill deletion
without restoring a historical Live binding. Deletion scans all current,
historical, and archived Sessions in the same transaction and refuses while any
still references the ID.

### Request snapshot and authority

The per-Session mutation fence labels active sends. A cross-dialog
`set_session_skills` command fails immediately while that Session is sending;
otherwise queue order determines whether activation precedes the next send. A
send resolves persistent IDs and lexical `$skill-id` candidates in one storage
transaction before attachments or event append. A historical User Skill with a
built-in ID remains authoritative; deleting that override reveals the built-in
definition. New imports using a reserved built-in ID are rejected. Unknown
mentions remain plain prompt text. Inline code, CommonMark backtick/tilde
fences, email/path tokens, currency-like numeric tokens, and numeric-leading
IDs are not mention syntax. The prompt and persisted user event remain
byte-for-byte unchanged.

Selected definitions are escaped at the wrapper boundary, sorted by ID, and
limited to 128 KiB after final UTF-8 rendering. The same immutable block is used
for every model turn. A send also snapshots the global Custom Instructions value
with its other configuration. System order is the fixed built-in safety
instructions, the hard Session Edit Scope block, the bounded JSON-encoded Custom
Instructions block when present, the lower-priority Skill boundary and rendered
Skill blocks, then the Live action system prompt. Empty optional context uses the
canonical base system instructions without extra wrappers.
Skill IDs/descriptions, their `built-in`, `user`, or `plugin` source, optional
Plugin ID, and active IDs may enter chat state; bodies, hashes, frontmatter
source, archive bytes, and paths never enter chat state, Session events, logs,
or errors.

Skills are declarative workflow guidance. Activating one cannot install or
execute scripts, binaries, MCP servers, Plugins, nested resources, or arbitrary
paths; change Connection settings; grant an MCP or artifact permission; add
tools; or add Live actions. An enabled Plugin may expose separately approved MCP
tools, but its Skill text grants no authority to them. A Skill never expands the
built-in action schema or tool set. Every action remains subject to
observation, schema validation, Approval policy, preflight, cancellation,
process-wide mutation serialization, and state-drift revalidation. Skill
Markdown has lower priority than system and safety instructions and cannot
authorize secrets, filesystem access, unsupported provider fields, or actions
outside the built-in schema.

The current request, selected Skills, and Custom Instructions can choose editable
Live construction, external rendered audio, both, or any supported workflow.
When a request leaves materially different deliverables unresolved, the agent
uses relevant Live context if it resolves the ambiguity and otherwise asks the
user instead of applying a built-in creative preference or a keyword classifier.
External generation tools describe their output as rendered Session audio rather
than Live tracks, MIDI, devices, Scenes, or Arrangement structure. No prompt
keyword classifier hides tools or chooses the deliverable.

### Bridge routes

The authenticated local bridge exposes a raw `POST /skills` route with exact
`text/markdown; charset=utf-8`, a 64-KiB reader, a bounded process-wide read
permit, timeout, optional explicit replacement, and an ID/SHA-256 receipt.
`DELETE /skills/:id` is idempotent after confirmed absence. Both use command
correlation and authoritative-state reconciliation. `/send` stays exactly
`{ prompt, sessionId }`; activation is the strict
`{ kind: "set_session_skills", sessionId, skillIds }` command.

## Attachment boundary

### Size limits and private storage

`src/attachments/contracts.ts` defines the canonical stored media types and
browser import formats. Storage, event validation, and composed WebView scripts
consume that same format contract. The supported categories and concrete
formats are listed in [Sessions, Skills, and attachments](../README.md#sessions-skills-and-attachments).
Attachment admission reuses an identical pending file by name, byte length and
content hash inside the Session attachment mutation fence. Consumed attachments
do not participate in this deduplication.
Pending Session state allows 4 attachments and 256 MiB of raw bytes. Audio is
limited to 2 files, 128 MiB and 15 minutes each. Each image is limited to 5 MiB,
with a 16 MiB subtotal; documents retain their 20 MiB per-file and subtotal limits.
Inline model requests have a separate 128 MiB binary budget, 4-file count and
2-audio count. Audio used only by processing tools does not consume this inline
budget. These are host resource budgets, not claims about remote provider limits.
Audio model input carries original bytes; protocol adapters perform Base64 encoding
only where their wire format requires it. Remote size rejection is reported without
transcoding, truncating or replacing the saved source. A request-size rejection
is persisted as an error named `input_too_large`. Subsequent requests omit
earlier native binary history from automatic replay, retaining its text markers
and local files; newly attached excerpts remain eligible. The server
detects the actual file type and is authoritative over WebView extension/MIME
hints.

MIDI is a locally extracted document with canonical media type `audio/midi`,
limited to 8 MiB. Its MIME name does not grant audio model input or an audio
SampleSource. Image conversion reads at most 20 MiB of source data and applies
the ordinary stored-format quotas to its resulting PNG bytes. Audio formats
requiring conversion are rejected with an explicit export instruction. It runs inside
the serialized attachment operation, so hashing, response reconciliation,
Session controls, and Send admission refer to the converted file. A failed
conversion does not prevent the remaining files in its batch from being added.

Attachment blobs and JSON integrity metadata live under a private
Session-specific directory. Creation is create-only with collision retry;
reads reject symlinks, verify regular-file metadata, byte length, SHA-256,
detected media type, and bounded image dimensions or document structure.
Directory creation, deletion, and orphan cleanup use durable parent
synchronization and explicit unknown commit outcomes. Startup orphan sweeping
occurs before bridge commands are accepted, never from an ordinary state
snapshot that could race Session creation. POSIX directories are tightened to
`0700` and files to `0600`.

### Local inspection

PDFs receive bounded envelope checks and an encryption-token check before use;
this is not PDF sanitization, page-count validation, or visual rendering. A PDF
is carried as a native binary model part only when the active saved
`RuntimeProfile` resolves `inputs.pdf === true` and its protocol is OpenAI
Responses, Anthropic Messages, or Google Antigravity. Live Smith does not
support PDF input through OpenAI Chat Completions, regardless of what a
compatible endpoint may offer.

Audio inspection accepts only RIFF/WAVE with PCM format tag 1 or IEEE-float
format tag 3, and MP3 with MPEG-1 or MPEG-2 Layer III frames. The inspector
checks WAV structure and sample math, channel count, sample rate, MP3 frame
continuity, and duration without decoding the audio. ID3 is not executed or
interpreted as instructions, but inspection is not cleaning or sanitization.
The immutable attachment remains the complete original file, including embedded
metadata.

File upload may create a pending audio attachment without consulting the active
Profile. The beta SDK permits direct file reads only inside the extension's
storage and temporary directories; an observed Audio Clip, Sample, or Simpler
`filePath` therefore cannot be copied into an attachment. Users provide original
source files through the composer's paste or drop boundary. Arrangement audio
model input uses `resources.renderPreFxAudio` and reads only the SDK-created
temporary render through a bounded regular-file snapshot.

DOCX, XLSX, and PPTX are admitted by a bounded local OOXML ZIP/XML inspector. It
rejects malformed packages and packages with detected macro, VBA, ActiveX, or
macrosheet signals, and it never exposes embedded binary parts to the model.
This is not general OOXML sanitization; unrecognized embedded binary parts are
discarded rather than interpreted or sent.
Modern Office and OpenDocument content extraction runs through pinned bundled
officeparser and SheetJS libraries. `scripts/build-document-parser.ts` embeds a
self-contained slim parser script; its native module resolver is disabled so
production workers never require a runtime `node_modules` directory. The
parent Extension VM imports only Node worker APIs and retains its existing
restricted-global compatibility boundary. `runtime/document-parser.ts` admits
two active parsers, cancels queued waits, and terminates active workers on
cancellation or a 30-second deadline. Worker V8 heaps have a 128-MiB old-generation
and 16-MiB young-generation limit; these do not bound ArrayBuffer allocations.
Input, ZIP expansion, XML and output bounds apply separately. Workers receive
document bytes and extraction policy, an empty environment, and no storage
paths or credentials. Worker isolation bounds execution and heap usage; it is
not an operating-system sandbox. Raw diagnostics stay out of host logs.

An adapter constructs parser input from declared semantic OOXML parts, validates
root and namespace identity, and maps relationship-addressed parts to canonical
filenames. Unreferenced archive members cannot match the library's part selectors.
The adapter retains explicit Word/PPTX visibility rules and validates declared
PowerPoint ordering against parsed slides. SheetJS results retain sheet identity,
sparse coordinates, stored values and formulas; formula stubs carry an unavailable
cached-value marker. Hidden XLSX sheets, rows and columns and explicitly hidden
ODS sheets and collapsed or filtered rows and columns are omitted. ODP hidden
pages and their notes are omitted while visible pages retain their slide numbers.
ODF sheet and page visibility resolves referenced and inherited styles from
`content.xml` and `styles.xml`. ODF
namespace aliases are canonicalized before extraction. Spreadsheet input contains
only active semantic branches. The spreadsheet adapter preserves
element and attribute ownership before the library removes namespace prefixes;
style definitions are parsed separately, with cell format references and
calculation date metadata retained for SheetJS. Missing formula caches are marked
from typed source values and semantic paragraph text before library defaults can
replace their absence. XML indentation is not a cache; explicit text spaces,
tabs and line breaks retain their empty-element representation. Sheet names,
IDs and referenced part roles must be unambiguous. Inline ODF text fields retain
their text without introducing new spreadsheet structure. Results carry semantic
text and omission markers. Extraction is capped at 100,000 Unicode code points per file
and 200,000 code points across the request; per-file truncation is labelled in
the untrusted document wrapper, while a current request that exceeds the
aggregate limit fails before event append.

Ordinary text is identified by strict UTF-8 or UTF-16 decoding and content
validation rather than a code-extension allowlist. HTML, XML, scripts, and
configuration files remain inert text. RTF extraction interprets visible text
and Unicode escapes while omitting binary objects and non-text destinations.
OpenDocument text, spreadsheets, and presentations use the same bounded ZIP
inspection and ordered XML parsing, with manifest, encryption, and macro
checks. Legacy DOC, XLS, and PPT ingestion is unsupported. Historical MIME
references remain valid Session data and client wire references. The shared
reference-format registry supplies their display labels without restoring
ingestion support. They become explicit unsupported-context
markers before attachment reads; a pending legacy attachment must be removed
or replaced before sending. Embedded images, chart geometry, and
Office style rendering are outside this local text representation.
These formats share the extracted-text budgets and untrusted-data envelope.

The shared Standard MIDI parser owns both attachment inspection and generated
MIDI artifact validation. Attachment context supports SMF formats 0, 1, and 2
with PPQN timing, at most 256 tracks, 200,000 events, and 100,000 note-ons. Track
summaries precede interleaved event detail so truncation preserves the existence
of every track. Beat positions use quarter notes, channels are numbered 1–16,
and pitch/program values use 0–127. Tempo and meter changes, names, notes,
programs, controllers, pitch bend, and pressure events retain their track and
position. Unfinished notes have an explicit unknown duration; unmatched note
offs are labelled. Text metadata is bounded to 4 KiB per event and 256 KiB
total; unknown metadata and SysEx payloads retain their type and length without
exposing binary contents. The final extraction summary reports total and
represented counts. Generated artifacts retain their existing stricter
format-0/1, track, note, duration, and complete-note requirements before Live
import.

Additional images are rasterized to a static PNG only when the WebView can
decode them; SVG rasterization excludes active content and external resource
references. Image conversion has a 30-second deadline, observes cancellation,
and releases object URLs and canvas buffers. Stored PNG output is authoritative;
source image files are not modified or uploaded alongside it. Audio ingestion
preserves WAV/MP3 bytes without decoding, resampling or channel mixing. Other
audio formats require explicit conversion before ingestion.

### Attachment viewing

Attachment viewing reads one exact Session-owned reference and verifies its
stored bytes before returning them or opening a local copy. Authenticated
attachment GET/HEAD routes are independent of model-send admission. Image bytes
serve previews; audio supports byte-range requests for the inline player.
Read cancellation follows the dialog and HTTP connection lifecycle.

The shared browser attachment viewer owns inline image/audio elements, compact
play/pause and seek controls, and the image dialog. Session changes, removed
elements and dialog close release media resources; ordinary streaming updates
preserve mounted playback controls.
The audio selection dialog reduces WAV samples directly from the verified byte
buffer into bounded waveform peaks; it does not expand the entire WAV to float
samples. Server-side WAV extraction copies sample-aligned PCM/float data and its
format chunk into a new WAV. MP3 waveform inspection uses the browser AudioContext
at the source sample rate with a 128 MiB decoded-sample budget and a 30-second
decode deadline. Only the explicit WAV-export action quantizes the selected
samples to 16-bit PCM, preserving sample rate and channel count. Closing the
dialog aborts reads and discards late decoder results.

Saved copies and excerpts use fresh attachment IDs. Their immutable provenance
records the source ID, optional range, and replaced draft IDs, bounded to 16 KiB
per reference. The pending projection excludes replaced draft IDs; consuming a
reference also excludes those IDs from subsequent pending projections without
reading consumed historical metadata. Deleting an unsent replacement restores
its previous draft source. Original bytes and source metadata remain private,
readable Session attachments. Event and attachment snapshots deep-copy provenance.
The existing attachment fence admits a replacement against the pending snapshot
and quota in one create-only save. The browser rejects replacement of a reference
reserved by its Send, Steer or Queue snapshot; queued work never owns mutable
source bytes. A stale snapshot in another dialog fails send admission rather
than changing an admitted request.

Default-application opening is an explicit command using Session and attachment
IDs. The host writes a private temporary copy with a MIME-derived extension and
launches the OS handler without a shell. Text/code uses `.txt`. Copies handed
to external applications remain after the dialog closes so lazy reads and
external edits can finish; their temporary directory is left to OS/user cleanup.

### Send admission and historical context

Upload, pending-quota validation, deletion, request preparation, and user-event
append share a short process-wide attachment fence per Session. A send holds
the separate Session mutation fence through its agent loop; lifecycle mutations
acquire the Session fence and then the attachment fence. Uploading a later draft
can therefore finish during generation without changing an admitted message.
Each Send and Steer binds an ordered snapshot of attachment IDs; selection is
resolved against the target Session's pending files under the attachment fence.
Operations check cancellation at their defined boundaries; upload hashing, audio/PDF/OOXML inspection, Office
extraction, history reads, and waiting for the fence yield, recheck cancellation,
or terminate the owned parser worker. Pending references are completely
resolved before the user event is appended. A confirmed append consumes those exact immutable IDs even
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

### Model input mapping

The provider-neutral model contract carries typed user text, image, native PDF,
and audio parts. Transports recheck the corresponding input capability before
network I/O. OAuth OpenAI and Google map verified images to product-backend
input parts, while OAuth Anthropic uses the same image blocks as Messages.
Antigravity maps catalog-verified images, PDFs, WAV, and MP3 as inline data.
Audio additionally requires explicit `supported` evidence on the active saved
`RuntimeProfile`; only Direct OpenAI Chat Completions and Google Antigravity
deliver it. OpenAI Responses and Anthropic Messages reject audio locally.
Model tool support is unrelated and is not a gate. Text, rich documents, tables,
and MIDI content are locally
extracted and encoded with its filename and media type in a JSON-escaped block
explicitly labelled untrusted. File names, embedded metadata, document text,
audio, and other binary content have no instruction authority. Attachment IDs
and local paths are not exposed. A current audio attachment may become a Live
sample only through the separate host-created request locator described below;
the model cannot turn attachment content or an arbitrary path into that
capability. See
[Input mapping](MODEL_PROVIDERS.md#input-mapping)
for protocol encodings and capability evidence.

### Current-request audio SampleSources

After the current user event is committed, `request-audio-sources.ts` assigns
each current audio attachment a locator containing that event ID and its stable
audio-only index. The locator is placed in trusted request instructions, while
the file bytes, filename, and embedded metadata remain untrusted model input.
Only the current send owns the locator registry: historical attachments never
enter it, and an old locator fails on the next send. The locator exposes no
attachment storage ID, blob path, staging path, or Live-managed path to model
context, confirmation text, or Apply results. The committed user event retains
its exact internal attachment references for history and ownership checks.

Preflight binds the locator to its exact immutable audio reference without
reading a filesystem path. After confirmation and after the Live mutation queue
is acquired, the app prepares every unique request audio source used by the
plan before executing any Live action. Preparation re-reads the blob with the
exact expected reference, which rechecks ownership, metadata, size, audio
inspection fields, and SHA-256. Verified bytes are written to a private
temporary `.wav` or `.mp3` chosen from the detected media type, passed to
`resources.importIntoProject`, followed by immediate best-effort staging
cleanup. Only the path returned by Live is given to Clip, Simpler, or Drum Pad
SDK calls.

If at least one new file was imported, the complete confirmed plan is
revalidated again before its first Live action. This places imports before all
plan mutations and avoids treating an earlier action in the same plan as
external drift. Cancellation, new steering, scope changes, drift, or a later
action failure after import records the project copy as partial progress. The
managed path is cached only for the current send, so multiple actions using the
same source import it once. Session deletion removes the private attachment but
not the Live Project copy. The beta SDK exposes neither rollback nor deletion
for imported files, so a failed later step may leave an unused project copy.

## Configuration boundaries

### External audio processing

`plugins/builtins/provider-tools.ts` supplies shared schema builders, while every
built-in Plugin directly owns its resulting `tools()/parse()` contract and
protocol factory. `agent/audio-tool-parser.ts` contains only shared strict syntax
parsing. `app/audio/request-audio-tools.ts` binds input references to the current
request's attachments, same-Session saved results, or an isolated Arrangement
Audio Clip range and exposes each Provider's namespaced Plugin toolset.
`app/audio/audio-processing.ts` owns the asynchronous lifecycle and calls the selected
Plugin factory through the proxy-aware Fetch or WebSocket boundary.
`app/audio/audio-generation.ts` owns generation responses and saved-result recovery;
`app/plugins/integration-connections.ts` resolves the exact named Plugin Connection and
credential owner. Tool admission captures immutable private connection snapshots; public
tool choices are derived from those same snapshots. Initial operations reject
changes to the selected connection before uploading input or submitting paid
work, and adapters retain the admitted connection rather than reloading a new
account. Changes to unrelated connections do not invalidate the request.
`audio-job-runtime.ts` shares active-job exclusion and verified local recovery
across operations.
Plugin definitions own generation model selection, account-query methods and
output collection policy. Automatic collection stages completed audio locally;
explicit collection retains observed remote identities until a selected download
is authorized. Shared generation code resolves these behaviors from the Plugin
contract. An adapter that declares submission authorization ownership holds its
own settings lease and acknowledges the actual dispatch through the submission
callback; other adapters use the host's lease after preparation. Neither path
holds the lease while waiting for a user-driven verification window.
Provider rules have one owner across schema construction, request parsing,
pre-job validation and protocol encoding. Mureka's text bounds and model
restrictions live in `audio-services/mureka/mureka-rules.ts`. Plugins select
read-only or paid text invocations; the host retains connection admission,
post-read ownership checks, the paid authorization lease and confirmed result
recording. Text invocations do not create audio jobs or mutate Live.
`app/plugins/built-in-plugin-runtime.ts` binds application facilities to the
existing Plugin factories. Suno account, verification, upload and suggestion
workflows live in `app/audio/suno/`; the service protocol remains in
`audio-services/suno/` and does not access application storage or dialogs.
`audio-services/google-lyria/google-lyria.ts` keeps both Gemini music protocols inside one
provider adapter. Batch models issue one stateless Interactions request and
validate the final inline audio block. The realtime model authenticates in the
WSS header, waits for setup, collects only the requested amount of raw PCM, and
packages it as a local WAV. Model-specific fixed duration and instrumental-only
constraints are projected into the admitted tool schema and rechecked before a
job exists. Interactive steering is outside the current tool contract.
`runtime/suno-website.ts` opens fixed `https://suno.com/create` and
`https://platform.suno.com/` destinations through the system default-browser
handler. Website navigation is independent of saved connections
and is never evidence of authentication. No browser process, profile directory,
extension or debugging connection is owned by Live Smith.
`app/audio/suno/suno-human-verification.ts` separately creates the production Suno adapter
and binds an in-app challenge to the admitted account/configuration and proxy
revision. `runtime/suno-human-verification.ts` stages only our embedded native
capsule in a private temporary directory and executes its fixed entrypoint with
no arguments or inherited environment. A bounded private stdin/stdout exchange
returns the requested proof; raw process errors and causes never escape. The
native helper monitors its parent and enforces its own lifetime; it exits and
removes only the exact owned, credential-free temporary capsule if the host dies.
The macOS helper uses nonpersistent WebKit data and an actual HTTPS Suno
document, accepts only main-frame first-party callbacks, and blocks its own
paid routes. The isolated client uses official components after manual action,
settles stale/expired attempts, and bounds loader and callback waits. An
authenticated loopback CONNECT tunnel supplies explicit direct routing where
WebKit's default settings would otherwise inherit the OS proxy. It tunnels TLS
without changing site origin, certificates or browser identity and closes with
the verification lease. Manual/system proxy routing remains user-selected.
Official Suno Platform connections are ordinary API-key audio connections. Their
transport is isolated from the following website-session lifecycle and never
receives a Suno.com Cookie.
`app/audio/suno/suno-session-manager.ts` binds explicitly imported Suno Cookies to exact
saved audio connection IDs. Import and refresh use the bounded Suno-only
`audio-services/suno/suno-session.ts` verifier through proxy-aware Fetch. The adapter
reads the current Clerk client/session identity; it never automates Google
login or extracts browser data. Both Clerk `__client` token exchange and current
`__session` + `__client_uat` touch/rotation are supported. Verified rotations
are atomically saved to the same private connection without overwriting a
concurrent user reimport. Generation uses a separate private HTTP client that
resolves short-lived account/session-bound tokens only when needed for a request
and supplies a persistent private device ID plus the web protocol's bounded
browser-token header.
`storage/suno-sessions.ts` owns private per-connection credentials outside public
settings. Global settings changes clear the prior credential owner only after
validation and revision checks, before persistence, under the same global-settings
fence as import/refresh/disconnect. Cleanup uses the current storage transaction
rather than nesting it. Failed imports preserve a previously saved credential.
Credential-free verification evidence is shared per storage scope across dialogs,
so one window's failed refresh invalidates the others' status for that credential.
Local views do not trigger network requests and do not present disk-only identity
as freshly verified authentication after an extension-host restart. `sunoAccounts` projects only bounded account
identity and status, never a Cookie. Explicit saved enablement and a private
credential are required for tool admission; UI identity is not runtime authority.
Private admission snapshots bind the exact Suno account and user-controlled
configuration; a verified automatic Cookie rotation reloads only that account's
current private credential. Recovery fingerprints likewise bind verified account
IDs so rotation does not orphan accepted tasks. Custom options are typed,
capability-gated and validated against
the selected account's model catalog. Read-only preparation and the endpoint's
required challenge checks precede the paid submission boundary. `audio-services/suno/suno-verification.ts`
owns transient proof validation and provider-specific lifetimes. A successful
challenge adds only proof fields to the original prepared body, consumed once;
the HTTP boundary rechecks freshness after authentication and the app rechecks
account/network admission before dispatch. Generation holds the shared global
settings lifecycle fence only after preparation, through authentication and the
bounded paid receipt, not while the human solves a challenge. Known pre-dispatch rejections use
`AudioSubmissionNotStartedError`, not the unknown-paid-outcome path. Challenge
preflight applies to the shared `v2-web` generation endpoint. Whole-song and
replacement concatenation validate their source and submit directly to `concat/v2`;
remaster uses its dedicated `upsample` endpoint. These routes retain the same
dispatch authorization and receipt persistence boundaries. A multi-clip receipt is persisted atomically
before polling and has immutable ID/role associations, including failed siblings.
Only library/job-observed clip IDs on the selected connection can be used by the
chat tools for extension/whole-song requests or retrieval of existing songs.
`retrieve_music` is admitted through the model tool path and does not call
generation preparation or submission:
its first durable job record includes the selected immutable clip manifest, and
collection/recovery uses those same IDs. Repeated retrieval reuses an exact existing
Session/service/account/manifest job without replacing unknown generation outcomes.
Remote text is bounded untrusted data; no generic HTTP tool or credential-bearing
locator reaches the chat model.
Closing a dialog neither disconnects the saved account nor closes a user's browser.
`app/audio/suno/suno-model-catalog.ts` owns one modal-only, read-only model catalog for the
explicit `load_suno_models` command. The saved connection ID and verified account
bind its ownership; ordinary display/model/enablement edits and automatic Cookie
rotation do not change the account catalog. Publication revalidates that owner and tags the
current audio-settings revision. Auth lifecycle changes, including a same-Cookie
reimport in another dialog, invalidate it. Public state contains only bounded
model IDs, names and explicit availability/default flags, never private
fingerprints, credentials or raw billing data. Loading never enables a service
or writes a model selection; the existing settings command owns explicit Save.
If credential cleanup succeeds but the following settings write fails, the
compound command reports an uncertain/partial outcome, invalidates peer state
and returns an authoritative readback instead of claiming that nothing changed.
This is an external-effect tool category, separate from Live observations and
Live mutation recovery. Chat transports continue to exchange ordinary function
calls and textual results. When an enabled processing service can consume the
audio but the chat model cannot, the host validates and retains the attachment
without adding its bytes to the model request.

`plugins/builtins/parameter-panel.ts` derives per-connection manual forms from
the same tool schemas and parsers used by model calls. Schema descriptions supply
field help; owner-scoped data supplies suggestions. Catalog signatures bind
the schema and saved connection identity. `run_audio_tool` rederives that
signature under admission authorization, validates the complete arguments, and
uses the existing request audio runtime without invoking a chat model. It holds
the Session send fence, records tool calls and results, and retains the ordinary
generation authorization, cancellation and durable job lifecycle. Manual forms
offer saved Session assets and Arrangement sources; request-only attachment
locators remain exclusive to model requests. Observed Suno clip IDs are scoped
to the Session, connection configuration and verified account; credential
rotation preserves ownership. The host derives Clip, model and Persona
suggestions from matching job ownership and query results tagged with the public
connection/account/model identity. Untagged historical queries remain readable
but supply no suggestions. Private fingerprints never enter the form descriptor.
Browser form drafts are transient and cleared when their Session, account or
saved configuration changes.

For a runtime with function tools plus verified audio-input delivery,
`listen_to_audio_asset` reads one immutable local asset already registered from
the current Session. The tool is absent for incompatible Profiles. Admission
checks the shared request binary quota before reading, revalidates the exact
metadata and content hash, records the textual tool result, and only then attaches
the original WAV or MP3 bytes to the next model turn. The accepted-input callback updates
quota only after trace reporting, so a failed trace cannot admit the audio part.
Remote-only outputs and preview frames are never eligible.

An audio job stores its operation, exact service ID, optional model ID and
user-authored display title, input asset
when applicable, requested stems, credential-owner
fingerprint, accepted remote IDs, status, and collected output records. The key
itself is stored only in private settings. A job exists before submission;
accepted remote IDs are committed before honoring cancellation of the local wait.
A missing submit reply leaves an explicit unknown outcome and is never replayed
automatically. Resume first reconciles and verifies complete local results,
even if the connection has been disabled, removed, or replaced. Only an
incomplete local result proceeds to saved-connection authorization and the
original credential fingerprint check before querying the existing task.

Suno uploads use a separate typed receipt in the same job store. The frozen
source hash, upload ID and initialized clip ID have separate meanings and cannot
be replaced. `stage` retains the last confirmed step while `pendingStage`
records the durable intent for the next remote mutation. An acknowledged reply
advances the confirmed step and clears that intent. Local receipt commits have
a bounded retry independent of provider calls. The owning workflow may clear
an intent only when it establishes that no remote request started. Recovery
polls or advances only acknowledged safe stages; unresolved intents and legacy
mutation-stage markers cannot replay a create, transfer, finish or initialize
request. Signed upload locations and form credentials are never persisted or
projected into Session state, so a receipt at `created` cannot resume transfer.
The Session audio Resume command uses the shared global-settings authorization
fence before advancing a confirmed upload stage, with the original connection
and account rechecked before each remote mutation.

Task-based generation acknowledges an immutable remote output ID/role mapping
before collection. Downloads may refresh their URLs, but cannot change the
confirmed output identities during recovery. Required roles derive from that
mapping, so one- and two-track results can finish local bookkeeping even when
the remote service is offline. Historical role-only records remain readable;
complete local results recover normally, while incomplete records with saved
outputs cannot acquire unverified replacement identities. An old record with no
saved outputs can adopt its first mapping without changing its confirmed shape.
One failed download or invalid audio output does not prevent collecting other
available outputs; systemic storage failures end the current collection attempt.
For Suno, remote completion and local collection have separate meanings. A
`ready` job retains successful `remoteOutputs` as a validated subset of its
immutable manifest, without creating local assets. Generation, existing-song
retrieval and Resume stop at this remote result; they never authorize or fetch
downloads. The UI can lazily open Suno's own embedded player for an exact
successful clip ID. This cross-origin sandbox has no parent credentials or
referrer and does not expose its playback data as a SampleSource or model input.
The active Session's result nodes live in a collapsible shelf above the composer,
not in global App settings. Collapse and Session switches stop embedded/local
playback, while ordinary result refreshes retain unchanged player nodes. A
single preview control opens/closes each result, preferring verified local audio
when downloaded rather than duplicating its online result. Jobs are ordered by
creation time, with derived chronological numbers and a newest marker; download
updates do not make an older generation newest. Historical jobs without display
titles use their operation label. Public `remoteOutcome` derives only from the
confirmed manifest/terminal facts and does not classify a deliberately unchosen
local download as a failed generation. The shelf identifies the latest result
separately from earlier issues.
A failed/unknown job opens its diagnostic details without replacing its durable
record; completed results keep operational detail secondary to Preview/Download.
Audio jobs count as Session content even without a title or chat events. Such
Sessions remain visible in history and cannot be recycled by New Session as
pristine empty drafts. Unreadable content is not evidence of emptiness.

`download_audio_output` is an explicit one-output Session command, separate from
model tools. It owns the job lock, reconciles existing local results, resolves
the original account fingerprint, and downloads only a validated successful
output. Its provider adapter can authorize that single song through Suno's
normal download endpoint after a fresh explicit locked response, then must
recheck unlocked permission before preparing the MP3. Already-unlocked songs
and already-saved local assets do not spend another download allowance. There
are no quota-purchase routes or automatic authorization retries. Preparation and
transfer retain a cancellable deadline, strict media hosts and no forbidden or
playback locator fallback. Download failures preserve remote previews and saved
siblings; they do not turn completed generation into a failed generation.
One process-local owner excludes concurrent execution of the
same job. Remote processing does not acquire the Live mutation queue.

`storage/audio-jobs.ts` and `storage/audio-assets.ts` own bounded, private,
Session-scoped metadata and create-only audio files. An input snapshot and each
output are immutable and integrity-checked. The asset metadata receipt commits
before its audio blob; a metadata-only receipt is not listed as an available
result. A deterministic job/role asset ID allows a complete blob committed before
its job-record update to be recovered and hash-verified without redownloading or
creating another copy. Permission normalization and the complete bounded file
read are coordinated by inode, so parallel readers cannot invalidate each
other's ctime snapshots. Only pending reads retain coordination entries.
Callers that need both jobs and recoverable assets reuse one verified metadata
snapshot; there is no persistent asset cache. Per-file and per-Session limits are
independent of chat attachment limits. Remote readiness does not imply local
completion; local completion requires the required outputs to be stored, while
individual saved results remain usable.
`audio-services/audio-output.ts` maps neutral output roles to musical descriptors.
Provider adapters translate their protocol roles at their boundary. Historical
provider-prefixed role keys are handled by `audio-output-compatibility.ts` and keep
their original asset IDs and recovery manifests. No role normalization renames
already stored files. Job `artifactSource` is fixed at creation, so resumed or
later-downloaded outputs retain their admitted source. Version grouping considers
compatible complete-output categories across the work; stems and source snapshots
retain component provenance independently.

`storage/audio-artifacts.ts` stores standalone Plugin WAV/MP3 outputs with Plugin
ownership and provenance. `readSessionAudioArtifact` resolves either a Plugin
record or a committed provider-job output; playback, export, attachment, Plugin
inputs and managed SampleSources share that admission boundary. Both stores
consume one Session audio byte budget under the storage transaction. Session
deletion and orphan cleanup include both stores. Newly produced Plugin audio is
registered before the tool returns, making it available to the admitted audio
input and SampleSource capabilities in the same request. Audio tools are admitted
when services, saved results or approved audio-producing Plugin tools exist.

The job record is authoritative for provider task UI; conversational tool results describe
the state observed at that turn and are not rewritten on later recovery.

`audio-asset-sources.ts` populates the send-scoped managed SampleSource registry
from saved results belonging to the current Session. `audio_asset` references
carry only an opaque asset reference. Preparation verifies the exact expected
asset, stages owned bytes and imports them through the shared lazy sample-import
helper. The existing preflight, complete-plan Scope check, approval policy,
mutation queue and post-import revalidation remain in force. Processing tools
never create or modify Live objects themselves. Timing metadata records the
input snapshot and is not a promise of sample-accurate separation alignment.

Authenticated local audio-result routes validate Session and asset ownership,
serve verified bytes with byte-range support, and never redirect a WebView to a
provider download URL. `export_artifact` accepts an exact MIDI/audio reference,
verifies the owned local file, and opens
the OS default browser with a short-lived, resource-only ticket. This reads the
saved asset without taking the Session mutation fence, so export remains
available during an active model request. The download
route accepts only GET/HEAD for that asset, checks the loopback host and request
origin, and serves an attachment disposition. Tickets expire after two minutes,
are bounded to 20 per dialog, and are cleared on close; they cannot authenticate
chat, settings or mutation routes. The dialog's control token never leaves with
the export. Native WebView download navigation is not used. The
separate online preview embeds only the fixed Suno player origin on user action,
without routing or persisting its media. The top-level `integrationConnections`
view is the sole browser projection of Connection settings; it includes only
configuration and configured-secret names, while the private secret values and
settings collection are omitted. Saved keys are omitted from full-state and
incremental UI projections. Stop or runtime shutdown cancels unfinished local
work and attempts bounded remote cancellation where available; retained remote
tasks may be resumed explicitly, without replaying a stopped Live plan. Session deletion
and orphan cleanup remove private audio data alongside other Session data, while
Live-managed imported copies remain owned by Live.

User settings, limits, and provider-specific behavior are documented under
[external audio tools](MODEL_PROVIDERS.md#external-audio-tools).

### Write ownership and Profile revisions

Only profile CRUD/activation and the dedicated global-settings command write the
settings file. The global command owns the default Queue/Steer follow-up
behavior, context-usage visibility, chat shortcut visibility, interface mode and
language, network proxy selection, custom instructions, and Integration
Connections. It applies exactly one setting per
transaction, advances only that setting's revision, and is allowed while sends
are active. It broadcasts the complete committed global settings to every open
dialog for the same storage directory. Sending,
discovering models, and creating/selecting/renaming/deleting sessions do not
write configuration. Old flattened provider settings and environment variables
are not configuration sources.

Profile edits use optimistic concurrency without adding a second persistent
revision: the Save command carries a fixed-length SHA-256 revision of the
normalized Saved Profile that opened the Draft, and the settings transaction
recomputes it from the current same-ID record before replacement. The dialog
state projects only the active Profile's revision, so unrelated Profile saves do
not conflict. A mismatch is recoverable, and one window cannot silently erase
models or parameters saved by another.

The `sessionTabs` chat shortcut preference has its own decimal revision. Settings without
these fields use Context, Brief and Artifacts at revision `0`; an empty list hides
the shortcut row. Storage normalizes the selected IDs to the canonical navigation
order. Newer preference events take precedence over delayed snapshots.

### Interface language

The UI language preference (`system` or a registered locale) has its own decimal revision
and uses the existing one-setting global command and complete settings events.
Missing historical language fields resolve to `system` and revision `0` without
rewriting settings on read. Language never changes model prompts, connection
configuration, authorization, or Session ownership.

`src/i18n/languages.ts` is the single language registry. It defines canonical
locale IDs, native picker labels, system-language aliases, and the fallback
locale; settings types and validation derive from it. The same registry is
injected with per-locale catalogs into the client, so its picker and wire
validation accept the same language IDs. Locale resolution checks exact tags and
then less-specific tags against the registry. Missing translations fall back to
the English source message.

`src/ui/i18n/` owns source-message catalogs with named interpolation fields. The
composed client injects escaped catalog data into a dedicated translator. Only
explicitly marked authored template nodes and UI rendering calls are translated;
user/model content, SDK names, Skill bodies and raw provider/SDK output remain
data. Locale refresh updates presentation without replacing drafts. Confirmation
copy binds interpolation values when the decision opens and can translate those
same values again while preserving its pending decision.

`src/i18n/ui-message.ts` owns serializable application-message descriptors and
their English fallback, shared by UI and audio orchestration. Authored audio job
notices, progress and terminal status carry descriptors; historical strings and
provider diagnostics remain original data. Model-facing audio tool results format
descriptor messages into English without translating raw parameters. Storage and
wire readers bound and validate descriptors before rendering them.

Action-confirmation headings and rows carry serializable `{ source, values }`
messages rather than preformatted English. Nested messages describe application
copy; string parameters remain raw names, identifiers, or JSON. The client
validates the message shape before accepting a confirmation and compares replayed
messages structurally while preserving action order and confirmation identity.
Language refresh retains Session menu and deletion controls, keyboard focus,
running status, and command-outcome warnings. Global language values are reapplied
after Session-causal state merging, and the shared operation state owns the
language selector's lock.

### Cross-dialog settings invalidation

Every committed Profile Save, activation, or deletion publishes a
credential-free `profile_settings_changed` invalidation to the other modal
bridges for the same storage directory. The originating bridge suppresses its
own correlated notification because its command response already carries the
new state. Each peer records that publication as a required global Send-state
revision, immediately gates Send, reloads authoritative state, and keeps the
gate closed if that reload fails. User Skill installation, replacement, and
deletion publish the same global barrier. Profile and User Skill mutations hold
a short process-wide request-configuration fence through durable commit and
publication. Send snapshots the saved Profile and exact active Skill
definitions under that fence, then rechecks the client's admitted revision
before appending the prompt. The request therefore uses either the earlier
configuration snapshot or rejects; it cannot silently assemble a request from
an unseen replacement. Each bridge reconnect-replays its latest invalidation so
an SSE gap cannot leave a stale model label or Skill catalog usable.

Each global setting has its own persisted canonical nonnegative decimal-string
revision (`"0"` or a positive value without leading zeroes). A write increments
only the changed setting under a process-wide per-storage fence. Increment and
comparison operate on decimal digits rather than JavaScript numbers, so ordering
has no safe-integer ceiling.
The same fence covers an unknown-commit readback and publication, so another
dialog cannot overtake that reconciliation and have its value attributed to the
wrong command. Each bridge caches the highest revision of each setting, overlays
older fields in full-state snapshots, and replays the merged values when an event
stream connects or reconnects. Each modal bridge likewise reconnect-replays the
latest approval-mode patch for every Session, so an SSE gap cannot leave an ABA
change hidden behind an older full-state cut. The client uses the same
length-first, then lexicographic total order, so an HTTP response serialized
before a newer SSE event cannot roll the control back. A bridge state snapshot
may seed a revision, but a correlated event for the same value and revision
replaces that synthetic provenance and is replayed.

Session edit-scope patches have their own Session-keyed projection and are also
replayed on reconnect. A scope command owns only `editScopes` and `updatedAt`;
an older command or full-state response cannot replace a scope patch published
after its captured causal cut. Scope changes never write Profile or global
settings, and do not change the approval mode.

### Durable local storage

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
Session deletion commits metadata removal before cleaning its event log and
associated files. Uncertain deletion or cleanup enters the Session lifecycle's
pending-cleanup path. Cleanup retries recheck that the Session is absent; startup
reconciliation also removes orphaned Session data.

### Settings schema compatibility

Settings schema version 10 combines model connection Profiles, per-model
configuration collections, Plugin-backed and standalone MCP Integration Connections, the strict
`defaultFollowUpBehavior` value `queue | steer`, the
context-usage visibility flag, the validated `none | system | manual` network
proxy selection, bounded global Custom Instructions, and an independent canonical nonnegative
decimal-string revision for each global setting. It validates legacy
`approvalMode` for compatibility, but runtime authorization never reads that
field. Subscription model configurations persist reasoning mode and optional
effort but no unconsumed output-token placeholder. Direct and subscription
models may both store an optional configured context-window size and automatic
compaction threshold; these fields are local context policy and never become
provider request-body overrides. The decoder removes the historical subscription
output field from older nested Profiles without rewriting on read.

Persisted settings use adjacent migrations: v1 maps `autoApprove` into v2, v2
wraps flat Profiles into the nested v3 connection shape, and v3 is
shape-discriminated before migrating to v4. Version 4's single model becomes
the default entry in a version-5 model configuration list. Version 5 migrates to
version 6 by preserving the follow-up behavior revision and enabling context
usage at its initial revision. Version 6 normalizes legacy Codex subscription
connections into provider-scoped OpenAI OAuth connections in version 7. Version
7 adds the explicit No proxy default and its initial revision in version 8.
Version 8 migrates the historical `audioServices` collection and its secret,
model, callback, enablement, ID, name, and revision facts to Plugin-keyed
`integrationConnections` in version 9. Version 9 preserves those Plugin records
in version 10, whose Connection union also admits standalone MCP configurations.
A v3 containing both
follow-up fields must contain only flat Profiles and preserves its
behavior/revision; a v3 containing neither must contain only nested Profiles
and receives Queue at revision `"0"`. Partial fields, mixed Profile shapes, and
unknown fields fail closed. Reads never rewrite the file; the next authorized
settings mutation persists version 10. A future version or incomplete adjacent
migration chain is reported as settings corruption.

### Capability projections

Capability previews and discovered model lists carry an explicit source identity
in `ChatDialogState`, together with field-level evidence for temperature,
output/context limits, reasoning, and input modalities. Both command HTTP
responses and SSE state events use that identity, so an unsaved Profile draft
cannot be confused with the active saved Profile when the two channels arrive
in either order. Explicit model loading also carries the successful command ID;
the editor applies a catalog only when that receipt matches its own request.
Direct API reloads merge newly discovered IDs for the same connection and
replace after a Draft connection change. Subscription reloads reconcile to the
current auth-generation catalog while retaining settings for model IDs that
remain. Models from different APIs or OAuth Profiles/providers/accounts
therefore cannot mix.
The UI receives only the process-local numeric auth generation, never OAuth
credentials, and keeps auth, editor catalog, and active subscription runtime
projections generation-coherent across delayed HTTP and SSE state merges. An
auth generation belongs to one exact Profile/provider connection: delayed
projections compare generations only when both identities match, while an
authoritative connection switch adopts that connection's projection regardless
of its numeric generation.
On window initialization, an eligible signed-in subscription with a missing
catalog gets one background restoration attempt through
`POST /session-model-capabilities`. This read-only route accepts only the strict
`load_session_model_capabilities` payload, reuses its app handler, and shares
the state-read disconnect and shutdown cancellation lifecycle. It never acquires
the foreground command slot or broadcasts command-state updates. The client
coalesces pending reads for the same Profile revision and auth generation and
uses the existing causal state merge without locking the composer or Session
navigation. If navigation changed the response's target Session, one passive
state read obtains the current runtime projection. It restores same-account
capability evidence for Settings and the composer without saving the Profile,
changing the Session selection, or applying a new Draft model collection.
Failures retain unverified evidence without blocking ordinary UI operations;
the composer model selector or Settings' Load Models can retry explicitly.
Ordinary `/chat` and `/state` hydration remains passive; the restored catalog
is still modal-only and auth-generation scoped.
Failure reconciliation cannot promote a stale durable cache. Conservative
fallback values remain `unverified`; only known
policy, explicit discovery metadata, or a manual override may make the preview
authoritative.

### Profile and Session model state

Profile state has three deliberate boundaries: incomplete `DraftProfile` values
enter through settings commands, only validated `SavedProfile` values reach
storage, and generation plus the active UI summary consume one materialized
`RuntimeProfile`. Each representation retains the same `direct-api` or
`oauth-subscription` discriminant. Model discovery uses the Draft connection
gate and therefore does not require a Profile name or selected model. Secrets
enumeration returns only Direct API keys; OAuth credentials stay inside private
Profile-ID/provider tuple storage.

A Session's model selection stores only `profileId`, `model`, and an optional
`reasoningEffort` override. It does not duplicate connection settings, generation
parameters, capabilities, hosted-tool policy, Extra Body, or credentials. At send
admission, the active saved Profile supplies those values and the selected model
is materialized and validated as one `RuntimeProfile`. A selection from another
Profile or a model removed from that Profile falls back to the active Profile's
default model.
Restoring, selecting, creating, deleting, or archiving a Session can change the
active Session. After the successful command releases its UI lock, a missing
subscription catalog triggers the existing background capability read. The
saved effort therefore becomes selectable once catalog evidence confirms that
the active model supports it; request coalescing and auth-generation guards are
unchanged.

## Adding a model protocol

A new wire protocol requires a new `ModelTransport` implementation and a valid
family/mode branch in `registry.ts`. Keep model-name matching in
`capabilities.ts`; transports must make decisions from the resolved capabilities,
not model names. Add request-capture and multi-step replay tests for the new
transport before changing the registry.

## Adding a Live action

1. Add one descriptor to `src/agent/action-schema.ts`; it derives the action
   type, tool JSON schema, strict runtime parser, and model example together.
2. Add its confirmation summary, protected-action classification, and
   action-to-observation routing in `src/agent/actions.ts`.
3. Implement target binding, preflight fingerprints, and execution in `src/live/`.
4. Add focused parsing, schema, confirmation, execution, and state-drift/recovery
   tests for the action's observable behavior.
5. Run the required [verification](DEVELOPMENT.md#verification).

### Target identity and structural edits

When actions in one `apply_live_actions` call depend on a track that is renamed
or created earlier in that call, express the dependency with top-level
`targets`, creator `ref`, and consumer `trackRef`. Top-level targets and every
name-based action target bind to existing SDK handles. Existing Scenes, Cue
Points, Devices and their parents, Rack Chains, Clips, Clip Slots, Take Lanes, mixer
parameters, and Live sample sources are bound per action as well. Current-request
audio sources instead bind their exact send-scoped locator and immutable
attachment reference. Execution uses those bindings directly, so an earlier
delete or insertion cannot make a later index/path resolve to a different object.
Creating, replacing, or deleting Session Slot content invalidates that Slot's
pre-bound Clip and SampleSource dependencies, so the binder rejects any later
consumer in the same plan before confirmation and requires a staged inspection.
Main Arrangement Clip creation likewise invalidates only existing Clips in the
creation range that Live can replace or truncate. Exact named MIDI reuse and
Clip targets outside that range remain valid; Take Lane creation keeps its
separate empty-range rule. Two SDK Clip creations in one main Arrangement lane
must have non-overlapping ranges; an omitted audio duration keeps the potentially
affected range open because the SDK derives it from the sample at execution.
Replacing an existing Simpler Sample likewise invalidates only that old Sample
source; later actions that depend on the unchanged Simpler remain valid.
Deleting a Track likewise invalidates its complete group-descendant tree; a later
bound Track target or Live SampleSource from that tree is rejected before
confirmation, while unrelated Tracks remain valid in the same plan.
A creator `ref` never
binds to a same-name existing track: execution always creates a new track and
binds the returned handle for later actions. Preflight revalidates existing
handles inside the extension-activation-wide mutation queue after confirmation.
All dialogs opened by that activation share the queue. Do not infer aliases from
display-name changes. Use staged apply/inspect/apply calls when later actions
require state only Live can return.

Regular Track targets use an unambiguous `trackName`. Return targets use the
role-relative zero-based index plus an optional current-name guard; Main uses its
unique role plus an optional name guard. Return and Main targets still bind and
revalidate opaque Track handles. They are accepted only by device-chain actions,
exact device parameter or device duplicate/delete actions, and exact Track or
Rack Chain mixer parameter actions. Their observations and Session-scope restoration enumerate
the separate Song collections without treating them as regular Tracks or reading
regular-only Clip, Take Lane, Arm, group, or structural state.

Scene creation, duplication, and deletion shift Session View row indexes. The
validator therefore rejects a structural Scene edit followed in the same plan
by a Scene-index target, Session Clip Slot target, or Session audio source. This
is staged explicitly: apply the structural edit, inspect the resulting Session
View, then submit the index-dependent work. Prebinding a prior Slot and silently
using it after an insertion would authorize a different sequential meaning.

### MIDI authoring and transforms

Whole-Clip main Arrangement-lane MIDI authoring uses `create_midi_clip` and
accepts 0-4096 notes per action. An empty named Clip is the staging anchor for
longer work. Newly authored notes use `[0, durationBeats]`. Reusing a Clip
requires its start marker and first playback pass to map this complete section
directly; incompatible playback geometry uses the normal replacement policy.
Arrangement, Session and Take Lane paths share this reuse decision.
`replace_midi_clip_segment` then targets that exact arrangement Clip by track,
name, and start beat. Existing note times and segment ranges use Clip source
beats, independent of Arrangement position and playback markers. Each segment
removes only overlapping notes, preserves non-overlapping notes, and sorts the
result deterministically. Overlap checks use the bound Clip handle so different
track locators cannot bypass them. Preflight fingerprints the full current Clip
and execution rechecks the source range before assigning notes.
Every note must state its velocity explicitly; validation never invents a hidden
musical default.

Deterministic whole-Clip MIDI transforms target exactly one Arrangement or
Session MIDI Clip. The action binding captures the Clip handle before
confirmation, preflight fingerprints every current note, and execution applies
transpose, start quantization, velocity scaling, or beat shifting locally. A
transform writes the complete resulting note set only after validation. Pitch
and velocity edits preserve existing source timing, including hidden notes.
Timing edits use the source extent defined by the end marker, active loop end
and stored note ends; the visible Arrangement duration does not truncate that
extent. Invalid output performs no mutation. Optional SDK note fields are
preserved unchanged.

### Take Lane Clip creation

`create_midi_clip` and `create_arrangement_audio_clip` can target an existing
Take Lane with its zero-based lane index and an optional current-name guard.
Without that locator, their original main Arrangement-lane behavior is
unchanged. `inspect_take_lane` resolves the same guarded locator and pages exact
Clip names, types, starts, durations, and MIDI note counts so the model can
inspect every relevant range before proposing a write. Preflight binds the
Track, Take Lane, any exact reusable named MIDI
Clip, and the audio SampleSource before confirmation, then fingerprints the
lane handle and name, the exact reusable MIDI Clip when present, and the audio
SampleSource again inside the mutation queue. The requested range is separately
rechecked for overlap; unrelated Clip changes elsewhere in the lane do not
invalidate confirmation. MIDI creation requires a MIDI Track; audio creation
requires an Audio Track and an explicit duration when it targets a Take Lane.

Take Lane creation uses only an empty requested range. A named MIDI Clip with
the exact name, start, and duration can instead be updated idempotently without
calling the SDK creation method. Other overlap is rejected because the SDK does
not define a safe replacement contract for Take Lane creation. Multiple writes
to one bound lane in a plan must also have non-overlapping ranges. Creating a
lane and then writing it is staged across apply, inspect, and apply calls; no
new Lane reference system or Take Lane-specific Edit Scope is introduced.
Take Lane MIDI is limited to one whole-Clip creation or exact named update of
at most 4096 notes. Segment replacement and deterministic MIDI transforms keep
their existing main Arrangement or Session Clip locators.

### Audio analysis and SDK limits

`analyze_audio_clip` is a client-executed read-only observation. It resolves one
Arrangement Audio Clip on an Audio Track and refuses same-track overlap in the
Clip beat range. The SDK `Resources.renderPreFxAudio` service renders that range
to its extension temp directory using Live's configured Record File Type. Live
Smith opens a supported returned WAV without following symlinks, validates one
stable bounded regular-file snapshot, streams
PCM or IEEE-float samples with cancellation and cooperative yielding, and
returns path-free sample peak, RMS, crest factor, per-channel DC offset,
maximum absolute channel DC offset, silent-frame ratio at a 0.001 amplitude
threshold, and clipped-sample metrics. These are pre-effects track statistics,
not realtime monitoring or integrated LUFS. The Track, Clip, audible-content
settings, beat range, and overlap isolation are snapshotted before rendering
and revalidated afterward; the summary uses only the verified snapshot. An AIFF
render is rejected because the current bounded parser and model input contract
accept WAV but do not transcode host files. Live Smith closes the verified file
handle but does not unlink the pathname afterward because the
beta SDK exposes no atomic handle-based cleanup contract; pathname lifecycle
therefore remains with the SDK temp directory.

`read_arrangement_audio` reuses the same isolated Arrangement Clip resolution,
range render, overlap check, cancellation, and post-render state revalidation.
It is exposed only when the runtime has tools plus verified audio input and the
active protocol can carry audio after a client tool result. The rendered WAV is
requested with explicit Arrangement start/end beats. The actual WAV is checked
against the ordinary per-file duration and byte
limits and the combined request quota. Its bytes are bound to the text tool
result only in the current in-memory agent transcript; trace events and Session
history persist no base64 or local path. OpenAI Chat serializes the complete
tool-result batch before a synthetic untrusted user audio part. The subscription
backend places a
reference in its transcript and sends the bytes as a separate audio input.
OpenAI Responses and Anthropic Messages do not expose the tool and reject any
such part defensively. The render is pre-effects Arrangement audio and excludes
the track device chain, sends, and master mix. The SDK has no equivalent render
for Session View Clips or Take Lanes.

The beta SDK render call has no cancellation parameter. Live Smith cancels the
caller's wait immediately, but keeps the unresolved host render and any returned
temp-file consumption as owner of an activation-scoped queue. Later renders wait
for that work to settle instead of accumulating orphan SDK work or racing a
reused temp path. Waiting callers remain independently cancellable.

SDK `1.0.0-beta.1` exposes no Automation Envelope object or automation-point
read/write operation. Automation is therefore outside the current action and
observation contracts; no parameter-write approximation is presented as
Automation support.

### Device and sample operations

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

Rack Chains use the existing Track plus Rack `devicePath` locator followed by a
zero-based Chain index. `inspect_rack_chain` makes empty Chains observable and
returns direct device indexes and paths, a Drum receiving note when present,
and exact Chain Volume, Panning, and Send parameters. Preflight binds the Rack,
Chain, and target mixer parameter handles; `insert_chain_device` also consumes
the bound Chain instead of resolving its index again during execution.

`create_rack_chain` appends one empty Chain to an existing non-Drum
`RackDevice`. Append-only creation preserves existing Chain indexes. The new
Chain does not exist at plan admission, so later work uses an explicit
apply/inspect/apply stage. A plan creates at most one Chain per Rack locator so
its replay identity remains unambiguous after a later partial failure. Drum Rack
creation stays in `configure_drum_pad`,
where receiving-note uniqueness and composite partial completion already have a
dedicated contract. SDK 1.0.0-beta.1 exposes no Chain name, delete, duplicate,
move, zone, routing, activator, or selection API; Live Smith does not simulate
those operations through child devices.

Drum Pad configuration also has explicit intent. Filling an empty pad refuses to
overwrite a chain that already contains devices. Replacing a sample requires an
exact observed Simpler path and changes only that Simpler, preserving the rest
of the Rack chain. Both replacement forms are protected actions: Manual and
Low Risk require explicit confirmation, while Accept Everything approves
them automatically without bypassing the remaining safety checks.
Sample confirmations show the complete observed source locator, including an
Arrangement start beat and a Simpler path/index. Session audio creation is
explicitly create-or-replace: a source, Warp, or loop mismatch deletes the
existing slot Clip before recreating it with the requested settings.

The model never executes arbitrary JavaScript or unrestricted filesystem/API
operations.

## Sessions and safety

### Scope identity and lifecycle

Sessions are isolated by an activation-scoped project key and the selected Live
object's opaque SDK handle ID. Track, clip, device, and other object scopes stay
distinct even when their action target also retains an owning track; display
labels never determine session identity. Because the beta SDK exposes no stable
Set identifier across activation, historical object names are presented only as
reference labels and never as evidence that two objects are the same. All
unarchived prior-activation Sessions with retained content
remain visible in the Sessions pane. A Session whose scope kind matches the
current opening scope may use Continue here; this does not match names or infer
identity. The command sends only the Session ID,
and `restore_session` atomically binds the history to the current server-owned
handle while preserving the first binding as `originScope`. Rename, archive,
unarchive, and delete operate on current or historical Sessions. `archivedAt`
and `activeSkillIds` are optional additive fields. `approvalMode` is also
optional for backward compatibility; a missing value resolves to `manual`,
while new Sessions initialize `manual`. Existing Session files require
no migration. `editScopes` is likewise additive: missing metadata resolves to all
supported categories, while an empty list is read-only. New Sessions initialize
every current category. Present scope lists must contain distinct,
supported values; malformed persisted permissions fail validation rather than
falling back to All. Deleting a Session removes these settings with the same
metadata record.
The dialog reserves an active Session ID before the first message, but opening
a scope or choosing New Session does not persist an untouched empty Session.
The storage module shares these transient records across dialogs for the same
canonical storage directory. Session reads include them, so Approval mode, model
selection, Skills, attachments, and Send keep using the same ID. An explicit
metadata change, archive/restore, or the first event, attachment, MIDI artifact
or continuation-buffer write persists that Session under the existing storage
transaction; unrelated transient records
are never included in the write. A confirmed saved record supersedes its
in-memory reservation, including after an uncertain commit. The persisted
Session format is unchanged. New and renamed titles are limited to 80 Unicode
code points. Older longer titles remain readable through a bounded projection
and are repaired naturally by the next Session write.

Opening a scope reserves one only when no current unarchived Session already
matches that exact project and scope identity. Default resolution and explicit
New Session creation share a process-wide project-and-scope creation fence, so
concurrent dialogs cannot both
win the same find-or-create race. New Session reuses the current candidate first,
then the newest matching candidate, only when its current state is
pristine: blank title, no origin/archive marker, no model choice or creative
brief, no non-default Approval mode, unrestricted Edit Scope, no active Skills, no events, no
attachments, audio jobs, MIDI content, and no active or queued send. Content absence is
rechecked under the candidate's Session mutation fence, and the final decision
rejects any Session operation queued behind that check. Approval and Edit Scope
writes share a separate
candidate-intent fence so they remain writable during a send without racing
Session reuse. Any current non-default state makes an empty conversation distinct
and preserves it. No navigation or close path implicitly deletes a Session, because
another dialog can still own local draft or running state for that ID;
untouched transient records do not become saved history.
Each open dialog also holds process-local claims for the Sessions it has used.
Automatic empty-Session reuse skips a candidate claimed by another dialog,
because that dialog may own an unsent draft or paused Queue that is intentionally
absent from storage. The claim lasts until that dialog closes; explicit Session
selection may still join a claimed Session.

Current and History lists keep Sessions with a title, creative brief, events,
attachments, audio jobs, MIDI artifacts or continuation settings, or window-local
draft/queued/running work. The current dialog also keeps every
Session that has been active in that dialog, so an untouched empty Session remains
reachable after switching until the dialog closes. With search cleared, unvisited
empty Sessions stay hidden, and a new dialog does not inherit the prior dialog's
visibility. Explicitly archived Sessions remain visible for management. Track identity, timestamps, and
permission or model settings do not count as conversation content.
The app derives `ChatSessionSummary.hasContent` under the storage transaction;
this is UI metadata and is never persisted. MIDI content reads do not reacquire
the transaction held by the state snapshot. Unreadable content remains visible
instead of being assumed empty. The complete Session membership stays in bridge
state because the client uses missing IDs to reconcile deleted Sessions and
their local drafts. Only list rendering and bulk selection omit inactive empty
records; hiding them never deletes or rewrites their saved data.

### Session context, concurrency, and Approval

Session search is an authenticated read-only bridge operation over the same local
Session collection exposed by Current, History and Archived. It matches each
Session's displayed name (`title || scope.label`) and saved user/assistant text,
returning one bounded excerpt per matching
Session with an optional message reference. Results are paginated after matching;
unreadable histories are counted, and deleted Session IDs are removed before
delivery. Search keeps no persistent index and does not inspect model settings,
credentials, binary attachments or Live state. The browser owns query, pagination
and cancellation, validates each response against its query receipt, and retains
the existing list's navigation and mutation boundaries.
Committed chat messages from foreground or background Sessions, peer Session
invalidations and successful event-stream recovery invalidate active searches.
Input composition defers these refreshes until composition ends, even if the
query text is unchanged. Active-message tracking excludes tool and reasoning
events; generic peer invalidations still refresh search because their payload
does not identify which Session fields changed.

Bulk Skill disable submits a remove-one-Skill intent for each confirmed Session.
The server filters the current saved selection inside its Session/storage
mutation boundary, preserving unrelated concurrent additions or removals.

The Live context observer produces both the detailed summary and a structured
presentation for the same resolved interaction. `ChatDialogState.liveContext`
is a Session-owned display projection: it records availability, object kind,
opening-selection provenance, and only verified Arrangement beat positions.
It is not persisted, does not contain SDK handles, and never authorizes a write.
The bridge client validates this projection and reconciles it with the active
Session and context summary under the same causal ownership rules. Missing or
mismatched context cannot leave another Session's target visible in the composer.
There is no global selection subscription; refreshing an opening selection
re-observes its original handles and range.

The context strip opens the existing Inspector without replacing the current draft
or selecting a task mode. Direct requests use the same Session conversation and
Send admission. The Scope read-only shortcut uses the existing explicit
`set_session_edit_scopes` command with an empty list.

Concurrency boundaries have distinct ownership:

| Boundary | Scope | Responsibility |
| --- | --- | --- |
| Storage transaction | Canonical storage directory | Serialize durable settings, Session, event, attachment, and Skill mutations. |
| Session mutation fence | Storage directory and Session ID | Hold one Session's send, Skill activation, and lifecycle boundary through reconciliation. |
| Attachment mutation fence | Storage directory and Session ID | Serialize uploads, pending-file deletion, and admission of attachment snapshots for Send and Steer. Lifecycle operations acquire the Session fence first. |
| OAuth auth/send fence | Canonical storage directory and Profile ID | Keep one editable connection lifecycle coherent with its sends while tracking pending login, activity, and generations per provider. |
| Live mutation queue | Extension activation | Execute one validated Live plan at a time across dialogs, including request-audio import and revalidation after import. |

These are in-process coordination boundaries, not locks between independent
Extension Host processes. Different Sessions may observe and plan in parallel;
the Live mutation queue serializes their writes. Session Approval changes have
their own intent fence and remain available during a send as described below.

Model context uses the complete uncompacted user/assistant history plus
provider-neutral text records of Tool calls, Tool results, and Apply results, or
the latest persisted compaction checkpoint followed by that same newer tail.
Historical activity is labelled untrusted and potentially stale, never restores
opaque provider replay state or binary Tool output, and requires a fresh Live
observation before mutation. A checkpoint's position in the event log is its
boundary; a later checkpoint never reimports raw events already represented by
an older one. The separate recovery projection still uses the latest 12 persisted
Apply results, rejected tool inputs, and errors (at most 12,000 characters).
Recovery records never gain instruction authority. The bridge permits one
active send per Session while different Sessions may observe and plan in
parallel. A process-wide lease keyed by normalized storage directory and
Session ID spans exact Session lookup, attachment consumption, the provider/tool
loop, all trace/error persistence, and the final authoritative state snapshot.
Skill activation and Session rename/archive/unarchive/delete use the same
Session lease. Pending-file upload/deletion uses the separate short attachment
fence; lifecycle operations acquire both in Session-then-attachment order, so
another dialog cannot delete a Session and then have a running send recreate its
event log. A send never falls back to another Session when its requested ID is
missing. Waiting operations recheck cancellation immediately after acquiring
the lease. A committed event, attachment, Skill activation, or lifecycle change
invalidates peer modal state for that Session. The peer bridge records the
invalidation revision before admitting another Send. Different Sessions still
overlap. Within one modal, Profile and model-discovery writes are locked in both
the dialog and bridge while any send is active. A peer Profile mutation may
commit after request assembly; the running request retains its admitted
request-start snapshot. The active
Session's Approval mode and Edit Scope selectors are exceptions: they remain
writable during a send and are read again from that Session before each new Apply
decision. A committed change is broadcast to other open dialogs for the same
storage directory. Manual requests user
approval for every plan. Low Risk automatically approves only plans outside the protected
action set. Accept Everything automatically approves every authorized, validated
plan, including deletes and replacement writes within Edit Scope. An automatic decision persists a
distinct `apply_auto_approved` Session event with the selected mode; this
records the approval source without claiming that Live grouped the plan into a
single Undo entry. Accept Everything changes approval only and cannot bypass
Edit Scope, observation, action-schema validation, preflight, the process-wide mutation
queue, cancellation, or target/state-drift revalidation. Profile,
RuntimeProfile, attachment, and Skill state remain the request-start snapshot.

Committed Session events, attachments, metadata, and lifecycle changes publish
a storage-scoped invalidation to peer dialogs. A peer marks that Session stale
before its SSE refresh begins. `/state?sessionId=...` reads that exact target
while holding its mutation fence, without changing the modal's selected
Session. An inactive Session does not claim full-content coverage from the
currently selected Session; its refresh waits until it is selected, while an
automatic background Send remains fail closed. Unknown storage outcomes publish
the same invalidation because the mutation may already have committed.

The Send JSON contract remains only `prompt` and `sessionId`. The bundled client
adds separate decimal headers for the latest authoritative global state it has
applied and the latest full-content state applied for the target Session. A
bridge compares both acknowledgements with its required revisions before
entering the agent flow and rechecks after the Profile and Skill snapshot. A
409 response, a generated state response, or a lost response never clears the
requirement; only a later request carrying sufficient acknowledgements can pass.
Full state advances target-Session coverage only when that Session is the
state's `activeSessionId`, although an authoritative summary may prove that a
deleted or archived target is no longer sendable.

### Session creative brief

`AgentSession.creativeBrief` is optional private Session metadata, bounded to
8,000 Unicode code points. Missing historical metadata resolves to an empty
brief. A nonblank brief counts as retained content and prevents automatic reuse
of a pristine Session. New Sessions do not copy it from another Session or a
Profile.

The `set_session_creative_brief` command accepts only the Session ID, new text,
and expected saved text. The Session mutation fence and storage transaction
serialize its compare-and-set update; cancellation is checked before persistence.
A mismatch returns a conflict without changing storage. Committed and uncertain
writes publish the existing storage-scoped Session invalidation. Browser command
responses own only the target Session's brief and update timestamp, while each
window retains its separate per-Session draft. Explicit conflict review updates
the draft's base; only Save submits the replacement. Saving waits for active
requests to finish, while local editing remains available during generation.

Each admitted request carries the saved brief separately from conversation
history through the provider-neutral request builder. Automatic and manual
compaction receive the same brief; their checkpoints never replace it. The
next send reads the same saved brief when the Session selects another model.
Current Live facts remain observational context and do not update the brief.
`propose_creative_brief` has no storage or configuration write callback. It emits
a bounded tool result containing the suggested text and its saved base. The
Session editor validates that result and loads it into a draft only on explicit
review; accepting it still uses the same compare-and-set Save command.

### Session Edit Scope

Older Session files may contain the retired `writeBoundary` field. The storage
reader accepts and omits that field from current Session records without rewriting
files on read. A subsequent explicit Session metadata write saves the canonical
format without it. Saved category Edit Scope and Approval remain unchanged; the
retired field does not create a hidden runtime restriction.

The independent categories are `midi`, `audio`, `devices`, `mixer`, and
`structure`; their user-facing meanings are described in
[You control the changes](../README.md#you-control-the-changes). Scope metadata
is distinct from `ConversationScope`, which identifies a Session's context and
does not authorize writes or restrict reads to a particular track.

`live/action-permissions.ts` exhaustively maps action contracts to write scopes.
Generic Clip actions use the actual bound MIDI or Audio Clip type, not an action
or object name. Session Clip replacement includes any occupied slot's existing
content category. Whole-track deletion and duplication include mixer state,
devices, Arrangement and Session Clips, Take Lanes, and grouped descendants.
Scene operations inspect the bound Scene's current row. Range clearing checks
the actual overlapping Arrangement Clips; an empty range remains a no-op. Sample
sources are reads and do not grant or require write permission for the source.
Unidentified dynamic targets fail closed and require inspection or staged work.

A new Rack Chain requires both `devices` and `mixer`, because creation adds a
device container with its own mixer. Duplicating or deleting a Rack that owns
Chains also requires both categories. Drum Pad filling adds `mixer` only when it
must create a new Drum Chain; editing an existing pad does not claim a mixer
write. Exact Chain mixer parameter changes require only `mixer`.

Devices intentionally combines instruments and effects. The beta SDK does not
provide a reliable general device-category field or a catalog to classify an
insertion before it happens. Never use device display names, model claims, or
special-case name lists as authorization evidence.

The app reads authoritative Session permissions before each model turn, the
complete plan's confirmation boundary, and queued execution. Each request
subscribes to committed scope changes before its first refresh. A local event
generation prevents an older in-flight read from replacing a newer committed
policy. The final Live-state check happens after asynchronous policy refresh;
scope assertions after that check and before each action are synchronous, so
authorization adds no disk await between the drift guard and a Live mutation.
The subscription updates later actions when another dialog commits permissions
during an SDK await. Like the mutation queue, this live synchronization is
in-process; direct file edits are picked up by the next authoritative refresh.
An unknown commit immediately invalidates running requests' authorization before
readback begins. Readback publishes recovered permissions while holding the same
Session intent fence; if it also fails, requests stay unauthorized until a
successful refresh or committed update restores their permissions.

Instructions inform the model of the saved policy, but enforcement remains
outside the model. A denial before any actual mutation produces an
explicit tool result without creating an unfinished-operation ledger. If
permissions are narrowed after an action completes, remaining forbidden work
stops and the normal partial-recovery ledger preserves completed mutations.
Permission changes do not roll back changes or interrupt the middle of an SDK
action. Only the explicit `set_session_edit_scopes` Session command changes the
scope; Send, Skills, model tool arguments, and confirmation cannot broaden it.

### Queued follow-ups

Composer control commands use one fixed registry and parser. They are recognized
only when `/` is the first character; unknown commands and invalid arguments stay
in the draft and never fall through to `/send`. `/steer <message>` and
`/queue <message>` select the existing active-send path explicitly and send their
argument as an ordinary request when the Session is idle. Their active-send
forms use that Send's already admitted runtime context, while their idle forms
retain the ordinary Profile and auth admission gates. A failed idle submission
keeps the transport prompt in recovery while restoring the exact Slash source
draft to an untouched composer. `/clear` invokes the
existing `new_session` command, so the previous Session is retained and an old
background send remains bound to it. `/compact [instructions]` invokes the strict
`compact_session` Session command and never creates a user event. Skill and Slash
completion share one accessible listbox, while `$skill` mentions remain ordinary
prompt content. The active-send button remains Stop; Enter submits follow-ups and
control commands, while Cmd/Ctrl+Enter remains an alias. Shift- or Alt-modified
Enter stays a line break even when combined with a send modifier. Repeated keydown
events cannot submit a completed suggestion or resubmit a composer draft. The
composer tracks the input-method composition lifecycle and checks both
`isComposing` and the IME-processing key code 229 before interpreting keyboard
shortcuts. This includes confirmation keys delivered after `compositionend` with
`isComposing: false`; they remain native and cannot select a completion, submit,
queue, steer, or execute a control command. Composition end or blur releases the
lifecycle state, and the next ordinary Enter is not delayed by a cooldown. A
running manual compaction also owns the Stop control. Stop is correlated to the
exact command ID and requests cancellation; it cannot abort a different or later
command. The bridge retains a bounded set of recently admitted or pre-stopped
command IDs and rejects reuse, so a delayed Stop cannot cross command generations.

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
newer draft is preserved. A restored recovery draft, or an explicit edit of its
paused item, remains associated with that item's queue identity. Send consumes
that exact head even when its text has been edited; it never submits both the
edited version and the old original. Consuming the draft as a Slash command or
explicitly editing a historical message ends that recovery-edit association
without dropping the paused item. If the user instead sends the preserved newer
draft, that deliberate
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

### Bridge publications and authoritative receipts

Tool results carry an optional persisted `outcome`: `success`, `failed`,
`unknown` or `stopped`. New Agent and manual tool paths record the known outcome
independently of loop continuation. Storage and browser validators accept it only
on tool results. The timeline uses this field directly; historical results with
no reliable outcome remain readable and display as unconfirmed. Existing Apply
operation metadata retains its own lifecycle.

`agent-flow.ts` produces an unversioned domain state. At the WebView boundary,
each runtime bridge stamps every full `ChatBridgeState` exactly once with its own
monotonic decimal publication revision; the matching HTTP and SSE payload share
that identity. A full state also carries the publication revision captured
before its asynchronous request work as `bridgeStateCoveredThroughRevision`.
Read-only `/state` captures its cut after waiting for pending mutation handlers
and before building the snapshot; mutation responses retain their request cut.
That cut, not the later publication identity, says which projection patches the
snapshot is guaranteed to include. Incremental SSE patches that change the
client-held projection carry revisions from the same local sequence, including
reconnect replays. The sequence is neither persisted nor compared across runtimes
and is not a storage freshness clock: an async snapshot can finish after a newer
patch. Mutable patches are skipped only when the current full-state cut already
covers them. Confirmation state is processed by its exact ID and generation.
The bridge publishes revisioned `send_activity` ownership at admission and
before each active Send's reconnect replay. Pages adopt only known Sessions
and newer, non-retired owners; transient model output cannot establish Send
ownership. A competing local Send retains its own outcome and draft recovery
before reconnecting to the admitted peer. Peer command activity and pending
approval remain deferred while a local command outcome is pending; terminal
or replacement activity invalidates the deferred approval.

Each SSE connection has one ordered writer for initial replay and live publications.
A write that reaches Node's high-water mark is already accepted; the writer waits
for `drain` and queues subsequent frames. Pending work is limited to 4 MiB and
4096 frames per client, with a 15-second drain deadline. Overflow or a stalled
socket retires only that client. One large accepted snapshot or initial replay
can drain without being treated as a failed connection. Closing a connection
releases its queue, timer and listeners.

EventSource reconnection alone is not treated as recovery: the client blocks new
work until one authoritative full state is validated for the current connection.
Disconnect, timeout and page disposal cancel the old read; its late response
cannot apply state, settle Sends or release queued work. A recovery read has a
15-second deadline. Transport errors and HTTP 408, 429 and 5xx responses receive
up to three retries after 500, 1000 and 2000 milliseconds. Invalid state and other
HTTP failures remain blocked. After recovery fails, **Retry connection** starts a
new read sequence without resubmitting commands or prompts. Page restoration
opens a fresh stream and reconciles state. A recovered snapshot also settles
completed Sends whose HTTP and terminal SSE deliveries were both lost.
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

### Message actions

Copy writes the original message text through the browser clipboard API, with
a temporary document-selection fallback for embedded webviews. It does not copy
speaker labels, UI controls, or private attachment paths. Unchanged message DOM
nodes remain mounted across timeline updates so selection, keyboard focus, and
copy feedback survive. Focus on a transient reasoning disclosure transfers only
to its next matching durable event; an intervening durable event or new
reasoning draft expires that handoff before a later Send can claim it. Entry
motion is limited to new messages in the visible Session, not history navigation,
persistence reconciliation, or each stream delta.
Assistant replies and activity use the full conversation content width; only
user bubbles retain a narrower maximum. Initial latest-message positioning waits
for a non-zero timeline layout and the next animation frame. That one-time
intent ends after positioning, a Session change, or user scroll interaction;
there is no scroll-triggered history loading or continuous layout polling.

Use as draft copies historical user text into the current Session's composer;
it never rewrites events, reuses a Send ID, rolls back Live work, or reattaches
consumed attachments. Replacing existing text requires confirmation, followed by
revalidation of the Session, source, draft revision, and draft-edit lock.
Generation and attachment upload leave text editing available. Draft revisions
include file additions and removals. Failed requests are restored automatically
only when their original composer draft was known to be empty and no later
draft edit occurred; other failures remain available for explicit editing. The next
Send uses ordinary admission and preserves all existing recovery history.
Historical text that would parse as a composer command is restored with the
existing idle `/queue` wrapper so its body remains a model request, not a local
command.

### Transient model turns and context usage

Transient model output uses a separate per-send `modelTurnEpoch`, not the
bridge publication revision. A physical provider retry advances the epoch and
atomically restores the assistant, visible-reasoning, and in-flight search
projection checkpoint captured before that logical request; this preserves any
earlier output-limit continuation prefix while discarding only the failed
attempt. A terminal hosted-search event removes its ID from both the active
projection and that checkpoint because durable progress cannot be rolled back.
Replanning or accepting a complete turn advances the epoch and clears the prior
transient projection. Every new `/events` connection receives one
exact `model_turn_state` snapshot for each active, non-stopped send before any
open confirmation is replayed. That snapshot carries the current draft, bounded
search map, progress text, and highest resolved confirmation generation. Its
context-usage field is tri-state: absent before this send accepts a model turn,
an exact pair after an accepted turn with authoritative usage, and `null` after
an accepted turn without it. Absence preserves the Session's prior window-local
value; `null` explicitly clears it. The
reconnectable assistant draft is independently limited to 1 MiB of cumulative
UTF-8 bytes. The client replaces same-epoch transient state atomically, rejects
lower epochs, and uses the confirmation frontier plus each request's generation
to prevent a resolved or steering-superseded decision from reopening.
Background Sessions retain their own projection until selected.

Context utilization is scoped to the latest accepted, non-continuation model
turn. A transport attaches it only when both provider-reported used tokens and
an authoritative context-window size are available. Direct API and OAuth
protocol adapters normalize terminal protocol usage when their model metadata
or the selected model's explicit local context setting supplies the denominator.
Output-limit continuations, reconnect attempts, and
turns superseded by Steer do not advance the meter. The bridge keeps the value
for active-send recovery, while the WebView retains the latest value per Session
for that window. A newly started send preserves the prior value until its first
accepted turn; an accepted turn without authoritative usage clears it and
renders unavailable. It is not persisted in Session history and is not a
traffic or billing accumulator. Missing evidence renders as unavailable rather
than zero or an estimated percentage.

Before each ordinary sampling request, the app compares a provider-neutral
estimate of the assembled request with the selected model's compaction threshold.
After an accepted provider turn, its exact usage is the baseline and only the
estimated newer context is added. Binary wire encodings and duplicate opaque
replay state are not treated as text tokens. The explicit threshold is used when
present; otherwise a known context window defaults to 90%. The active model and
connection summarize the current history with tools and visible deltas disabled,
so Direct API and every OAuth subscription backend share one behavior without a
provider-specific compact endpoint. A later large Tool result can trigger another
checkpoint in the same send. A successful checkpoint is persisted before
in-memory history is replaced, clears the stale exact meter, and the next ordinary
accepted turn restores an exact value. A failed summary writes no checkpoint and
does not silently discard history. The manual `compact_session` command acquires
the same Session mutation boundary and saved Profile/model/OAuth requester as a
Send, but disables tools and appends only a compaction event. Its optional
instructions add one-time preservation priorities without becoming a user turn.
A new manual checkpoint requires conversation activity after the latest
checkpoint, so repeated `/compact` commands cannot accumulate empty checkpoint
markers. Model reconnect notices for a manual checkpoint use command-correlated,
transient SSE updates. They are neither Session activity nor durable state and are
not replayed after reconnect. Stop is definitive only while cancellation is
observed before checkpoint persistence begins. Once the checkpoint append starts,
an acknowledged durable commit wins; an indeterminate commit continues through
the existing unknown-outcome state reconciliation path.

`model_turn_state` is an ephemeral recovery snapshot: it neither advances the
dialog-wide state cut nor claims durable Session history. The bridge does not
retain an SSE event log, accept a durable cursor, or replay arbitrary missed
frames. Durable events and command outcomes still converge through their
existing Session/state reconciliation paths. The EventSource connection error
is only a status overlay; opening the replacement stream reveals the latest
underlying state, Profile gate, command, Queue, Stop, or restored per-send
progress instead of overwriting it.

### Causal field ownership

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

### In-loop steering

An active send can additionally accept bounded text and attachment steering for
its exact bridge-owned send ID. The current send owner persists each steering
message as an ordinary user event before acknowledging it or adding it to model
context. Storage keeps a strict `(sendId, steerId, content SHA-256)` receipt
covering the prompt and ordered attachment IDs for idempotency and conflict
detection. The UI projection removes the storage-only
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

Steered files pass the same extraction and capability checks as initial files,
within the active request's remaining attachment budgets. Rejected file admission
leaves the files pending and lets the active request continue. Accepted files
become typed user parts at the next safe boundary and remain in the durable
user event; audio references also join the request's audio sources.

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

### Loop limits and partial recovery

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
After local Send validation, the timeline immediately projects the submitted
prompt from the in-memory send attempt as an ordinary user message. This local
projection has no Session event ID and is not durable history. The exact persisted
initial user event replaces it when the correlated Session event arrives, without
changing its visible presentation. A definitely
`not_persisted` outcome removes the projection and follows the existing draft
recovery rules, while an unknown outcome keeps it attached to the unresolved
send until authoritative reconciliation. Steering and queued follow-ups retain
their separate projections and cannot acknowledge this initial prompt.
If cancellation arrives after one or more irreversible execution operations,
including a project audio import or a Live action, their partial apply result is
persisted and published before cancellation propagates; later actions in the
plan are not executed. Recovery carries the number of fully completed plan
actions separately from preparation-operation results, so an import never makes
an unstarted action replay-protected. A simultaneous host failure remains a
partial failure rather than being converted into a successful cancellation result.
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
state. `resolve_live_recovery` is the user-authorized exit when remaining steps
should be abandoned. Recovery loaded from an earlier request first requires a
successful `inspect_live_set`; a new partial failure may use its successful
automatic target refresh or a later matching recovery inspection. A mutating
intermediate repair invalidates that evidence and requires another
`inspect_live_set`, while a no-op does not. Rejection preserves the exact ledger;
confirmation persists the normal inactive recovery record without Undo or any
Live mutation.
If the inactive recovery event's commit or publication cannot be confirmed, the
request reports an unconfirmed outcome and invalidates Session state for an
authoritative reload; it does not guess whether the ledger remains active. A
host rejection with zero completed mutations is deliberately transient:
it still blocks a false success in the current loop, but it emits no persistent
replay ledger and a later successful alternative clears it without a model-owned
flag. Cross-request recovery therefore exists only when actual Live side effects
need replay protection. Tool-free completion prose remains subordinate to an
active unresolved failure. The same invalid tool error still
stops at the configured repeated-error limit. If the result cannot be persisted,
the failure remains fatal so the model can never retry without knowing what
already changed. Device parameter values outside the freshly observed range are
rejected rather than silently clamped after confirmation.

### Window host lifetime

Request tool resources have one cleanup owner from the first external resource
acquisition through later initialization, event persistence and execution. Once
the complete tool registry is available it owns that cleanup; earlier setup
failures still release the admitted Plugin connections.

`createAgentRuntime` owns an authenticated loopback HTTP/SSE bridge, Session claims,
subscriptions and provider resources independently of a page. `runAgentFlow` owns
the modal wrapper and closes that runtime when `showModalDialog` returns.
`window-hosts.ts` retains one browser runtime per Extension activation and launches
its exact tokenized URL through the loopback-enabled system browser opener. An
opening failure retires newly created resources and reports a URL-free host error.

The saved `interfaceMode` preference defaults to `modal` for historical settings;
its decimal revision orders command responses and peer publications. The document's
host capability is fixed when created, so changing the preference only affects
future invocations. Browser documents hide the modal Close control.

Repeated browser invocations with the same Set, object and exact selection reuse
the runtime and its Session claim owner, and restore its invocation Session even
if the page selected another Session. A different invocation retires an idle
runtime; a busy runtime rejects that change until its work finishes or is stopped.
A subsequent modal invocation owns a separate runtime without cancelling browser
work. Set changes retire the old browser runtime on the next browser invocation.
The SDK exposes no Extension deactivation hook; otherwise the retained runtime
lasts for the Extension process. `close` remains idempotent and owns resource cleanup.

Disconnecting browser HTTP/SSE connections does not cancel admitted sends or pending
confirmations. Reopening replays authoritative activity, transient model output and
pending confirmation state. The authenticated `command_activity` SSE projection
publishes the admitted command ID, optional Session ID and stopping flag, and
replays its current value before command confirmations. A terminal null clears
remote command ownership on reconnect. Its independent revision ordering rejects
stale activity; fresh pages consume the same command confirmation, progress,
terminal state and Stop protocol as the initiating page.
Stop and runtime shutdown still cancel work. Page-local
drafts and queued follow-ups are not durable background jobs. Set identity is captured before asynchronous opening and checked before exposing
the runtime. It is checked again at send admission, observation, preflight, queued mutation acquisition
and between executor actions; MIDI import consumes the same runtime guard.
Managed sample staging checks that authority immediately before importing into
the project and after recording the completed import. Arrangement-derived audio
carries an ephemeral authority callback through queued rendering, returned-byte
validation and provider dispatch. Persisted attachments and audio artifacts are
independent snapshots and retain their existing upload/resume semantics.

### Reconciliation and dialog shutdown

Command mutations whose follow-up state cannot be built use the same
unknown-outcome reconciliation path as uncertain storage commits. Closing the
modal or retiring its runtime aborts active work and
waits for send and command handlers to finish their terminal cleanup. Read-only
chat/state connections are destroyed instead, so an unresponsive state build
cannot prevent the modal flow from returning.

### Action diagnostics

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

### Strict bridge inputs and Stop

Bridge JSON inputs are strict route-specific contracts. The optional
`X-Live-Smith-Attachment-Ids` header selects up to four unique pending IDs for
Send or Steer. An explicit empty list selects no files; an omitted header keeps
legacy Send selection of all pending files and text-only Steer. Queue entries
retain their attachment references, excluding them from the next composer draft
until the entry is sent or restored for editing. Send accepts only
`prompt` and `sessionId`. Steer accepts the same two fields but requires the
exact active `X-Live-Smith-Send-Id` plus a unique
`X-Live-Smith-Steer-Id`; its prompt is limited to 64 KiB of UTF-8, with at most
eight unsettled and 32 total submissions per send. Same-ID retries are
idempotent only when their prompt and attachment selection are identical and do not supersede a later
confirmation again. The durable receipt remains authoritative after the send
leaves memory, so a terminal same-ID retry can return success only for the exact
original send, prompt, and attachment selection. If a storage commit and the receipt read are both
uncertain, `/steer` returns a prompt-free
`steeringOutcome: "unknown"`; the client retains the same ID. Every terminal
send state also carries the Session events for that send, and the client
reconciles a pending steering receipt before clearing or safely retaining its
draft. Send-owned Session activity carries the exact send ID; reconnect settles
a local attempt from `completed` state only when that ID matches, so an older
completed activity cannot terminate a newly submitted request. Until that
reconciliation, only the byte-identical guidance may retry
with the retained ID; edited Steer text and Queue submission cannot abandon the
possibly committed receipt. Queue starts another request through the unchanged
Send contract; its mode is never added to that body. The global-settings command
accepts `kind: "save_global_settings"` plus exactly one validated field:
`defaultFollowUpBehavior`, `showContextUsage`, `networkProxy`, `interfaceMode`,
`uiLanguage`, `integrationConnections`, `customInstructions`, or `sessionTabs`.
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
the client waits up to the five-second reconciliation budget for a
definitive Send outcome before falling back to unknown recovery. JSON bodies
are bounded to 1 MiB before parsing, except for the MCP App resource-pagination
requests described above, whose budget accommodates opaque MCP cursors. User
Skill Markdown source is never a JSON field; it uses the separate authenticated
raw route described above.
