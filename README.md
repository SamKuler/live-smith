<div align="center">

# Live Smith

**A context-aware AI production agent for Ableton Live.**

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B?style=flat-square)](#development-setup)
[![Ableton Extensions SDK](https://img.shields.io/badge/Ableton_Extensions_SDK-1.0.0--beta.1-111111?style=flat-square)](#device-and-content-boundaries)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.16-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](package.json)

[Capabilities](#capabilities) · [Providers](#model-providers) · [Sessions](#sessions-and-history) · [Local data](#local-data-and-privacy) · [Development](#development-setup)

</div>

> [!NOTE]
> Live Smith currently targets the Ableton Extensions SDK `1.0.0-beta.1` and
> requires an Ableton Live build with Extensions support.

## Overview

- Adds `Ask Live Smith` to supported Live context menus.
- Opens a ChatApp-style modal with scoped sessions, tool trace history, Live
  context, named connection profiles, and model capability hints.
- Direct API Profiles support two API families through three explicit modes:
  OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. Compatible
  endpoints use an ordinary Profile for the protocol family they implement.
- Offers **ChatGPT subscription (Experimental)** as a separate, locally managed
  Codex connection. It uses an isolated official Codex CLI login rather than
  treating ChatGPT OAuth as an API key or a fourth HTTP protocol.
- Uses real tool calls for observation and mutation. The agent can inspect the
  Live Set, tracks, devices, and MIDI notes, and can render one isolated
  Arrangement Audio Clip range for objective pre-FX analysis before deciding
  what to apply.
- Can opt a saved OpenAI Responses or Anthropic Messages Profile into
  provider-hosted Web Search. Search is off by default; when enabled, the model
  searches when the request needs current information, and cited answers show
  visible source links in the timeline.
- Shows model/tool/apply/error events in the active chat session.
- Accepts PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3 files by paste
  or drag-and-drop. A selected Live Audio Clip, Sample, or Simpler source
  can also be copied into the pending attachments. Images, native PDFs, and
  audio have explicit provider capability boundaries; Office documents are
  extracted locally as bounded text.
- Installs strict local `SKILL.md` workflow guides, lets each Session keep up to
  four enabled Skills, and supports one-turn `$skill-id` mentions outside
  Markdown code. Skill bodies never enter chat state, events, or logs.
- Renders user and assistant messages with locally bundled, sanitized Markdown,
  including headings, emphasis, nested lists, quotes, safe links, tables, and
  code blocks. Raw HTML remains inert text, while tool traces and errors
  preserve their exact text.
- Shows categorized Apply diffs in the exact execution order, with original
  action numbers. Each Session keeps its own Approval mode. `Manual` asks before
  every plan, `Low Risk` automatically approves only plans outside the
  protected-action set, and `Accept Everything` automatically approves every
  validated plan, including deletes and replacement writes. Accept Everything
  stays visibly red and does not open an extra mode-change warning. Automatic
  approvals receive a distinct `Auto-approved` timeline event. New Sessions and
  older Sessions without a saved mode use `Manual`. The mode can be changed
  while its Session is running; the current value is read for the next Apply
  decision and does not alter an approval prompt that is already open.

## Capabilities

The action executor exposes a deliberately bounded set of Live mutations:

| Area | Supported operations |
| --- | --- |
| Set structure | Set tempo; create, rename, duplicate, or delete Session View Scenes; create, rename, or delete Arrangement Cue Points. |
| Tracks and mixer | Create MIDI or audio tracks; rename, duplicate, mute, solo, arm, or delete tracks; set volume, panning, and sends. |
| MIDI Clips | Create or replace Arrangement and Session MIDI Clips with up to 4096 notes per action; replace bounded ranges of an Arrangement MIDI Clip; transpose, quantize starts, scale velocity, or shift all notes in one exact Arrangement or Session MIDI Clip. |
| Audio Clips | Create Arrangement or Session audio Clips from an observed sample source; edit Clip properties and warp settings; clear Arrangement ranges; delete Arrangement or Session Clips; render an isolated Arrangement Clip beat range pre-FX for sample peak, RMS, crest factor, DC offset, silence, and clipping analysis. |
| Devices and Racks | Insert exact-name native Live devices on tracks or inside Rack chains; inspect and set exposed parameters; duplicate or delete existing devices. |
| Samples | Load an observed sample into Simpler or configure a Drum Rack pad from the selected object, an observed audio Clip, or another observed Simpler. |
| Take Lanes | Create and rename Take Lanes using their observed track and lane identity. |

Creating a MIDI clip requires a MIDI target. A plan that creates a new track
declares a local `ref` on `create_midi_track`, and later actions use the matching
`trackRef`, so the entire plan remains visible in one Apply diff without relying
on a mutable display name. Creation is literal: an existing same-name track is
never silently reused. A named clip with the same track,
start beat, and duration is a create-or-replace operation: its notes are
replaced only after explicit confirmation, and the Apply diff says so. Clip
deletion uses an exact Arrangement start beat or an exact Session slot index.

For a 32/64-bar result, the agent can still submit the complete Clip in one
confirmed action when it fits the 4096-note action limit. For larger or staged
generation, it creates one named empty full-duration Clip, inspects that exact
Clip, and fills non-overlapping relative-time ranges with separately confirmed
`replace_midi_clip_segment` actions. A segment is replacement, not append:
existing notes whose durations overlap the range are removed, while notes
outside it are preserved. The executor rechecks the complete Clip immediately
before every write, so a concurrent edit from another Session invalidates the
pending plan instead of being overwritten. Every MIDI note includes an explicit
velocity; Live Smith does not inject a hidden musical default.

Whole-Clip MIDI transforms are deterministic local operations. They bind the
exact Arrangement start beat or Session slot before confirmation, fingerprint
the complete current note set, preserve optional note metadata, and fail without
mutation when transposition or timing would move any note outside MIDI pitch
0-127 or the Clip duration. Velocity scaling rounds and clamps into 1-127.

`analyze_audio_clip` resolves one Arrangement Audio Clip and uses the SDK to
render that Clip's exact beat range as pre-effects track audio. It refuses the
analysis if another Clip overlaps the range on the same track, because the
render could not be attributed to the requested Clip alone. Results are
objective sample statistics, not realtime listening or integrated LUFS. DC
offset is reported per channel plus the maximum absolute channel offset; the
silence ratio counts frames whose peak amplitude is below 0.001. No
rendered-file path is returned to the model.

The Extensions SDK `1.0.0-beta.1` does not expose Automation Envelopes or
automation-point read/write APIs. Live Smith therefore does not inspect or edit
Automation in this release rather than simulating an unsafe or incomplete
workflow.

The extension does not execute arbitrary code from the model. It parses and
validates a small JSON action schema. `Manual` asks before every plan. `Low
Risk` skips the prompt only when the plan contains no protected action; deletes,
Clip writes, Arrangement clears, and sample replacements remain protected in
this mode. `Accept Everything` skips the prompt for all validated plans,
including those protected actions. These modes control approval only; they do
not promise that Live will record a plan as one Undo step, and none bypasses
observation, validation, preflight, serialization through the process-wide
mutation queue, cancellation, or state-drift revalidation. The agent loop uses
a rolling 12-step no-progress window: every successful or
partially successful Live write and every new distinct observation renews that
window, so a large project is not stopped merely because it has many stages.
Repeating the same observation/result or completing only idempotent no-op Applies
does not renew the window. The first successful automatic refresh for a distinct
failed Apply does renew it even when the rendered state text was seen earlier;
repeating the same failure does not. There is no fixed total-step ceiling or
accumulated tool-call quota; only an oversized batch in one model turn is
rejected without execution and returned to the model so it can regroup the
unfinished stage. Six consecutive host repair failures without a real Live
mutation stop that unproductive repair run; any actual mutation resets this
separate budget, so it does not cap a productive multi-stage project.
If a confirmed multi-action plan partially succeeds, the completed actions and
exact failed action are persisted and returned to the model so it can inspect
the Set and continue only with missing work. It does not automatically replay
completed actions, and an exact device insertion rejected by Live cannot be
retried under another equivalent track selector. A compact structured ledger
stores only SHA-256 action-identity digests, so this protection survives the
next send in the same Session. Intermediate successful repair stages extend the
same ledger instead of clearing it; only a final successful repair Apply marked
`resolvesPriorFailure` clears the operation. A failure that completed no Live
mutation remains visible for the current request but does not create a
cross-request replay ledger; a
later successful alternative in that request clears it automatically. This
keeps an unrelated later prompt from being blocked by a failure that left no
Live side effects, while preserving strict recovery whenever anything changed.
Creator identity is independent of the model's temporary `ref`, so changing an
alias cannot create the same Track again. Tool-free model text can never turn an
unresolved partial Apply into a successful result.

Confirmation and Live Undo are different boundaries. One confirmation may
authorize an ordered plan with multiple Undo entries because the 1.0.0 beta SDK
requires dependent asynchronous mutations (such as create, then rename) to run
as sequential transactions. The UI does not claim that a complete confirmed
plan is always one Undo step.

Before confirmation, Live Smith binds every existing Track, Scene, Cue Point,
Device, Clip, Clip Slot, Take Lane, mixer parameter, and sample source used by
the plan to its opaque SDK handle. Execution consumes those handles instead of
resolving later actions through indexes or paths changed by earlier actions in
the same plan. A replacement while confirmation is open invalidates the plan.
Because creating, duplicating, or deleting a Scene shifts every Session row,
plans must stage any later Scene-index, Clip Slot, or Session-source operation:
apply the structural Scene edit, inspect the resulting Session View, then apply
the index-based work.

### Device and content boundaries

The current Extensions SDK does not expose Live's Browser, preset search, or an
installed-device catalog. Live Smith therefore:

- Inserts a native Live device using an exact built-in name and treats Live's
  success or rejection as authoritative without guessing the cause of a beta-SDK
  failure. A repeated insertion creates another instance; it is not implicit reuse.
- Cannot load a VST by plug-in identifier. Existing VST devices can still be
  inspected, have exposed parameters edited, and be duplicated or deleted.
- Treats a newly inserted Drum Rack or Simpler as empty until a sample source is
  explicitly configured. Filling an empty Drum Pad refuses occupied content;
  replacing an existing sample requires the exact observed Simpler path and
  preserves the rest of the chain.
- Reuses only selected or observed Live sample sources; the model never receives
  or supplies arbitrary filesystem paths. Apply confirmation displays the exact
  observed Arrangement beat or Simpler path/index used as the source.
- Sets device parameters only by an exact observed name after case/whitespace
  normalization; it does not guess substring matches.

Session audio writes are disclosed as create-or-replace operations. If the
source, requested Warp state, or loop settings differ, Live Smith deletes the
existing slot Clip and recreates it with the requested settings.

Example model action shape:

```json
{
  "message": "I will create a simple bass idea.",
  "actions": [
    { "type": "create_midi_track", "ref": "bass", "name": "AI Bass" },
    {
      "type": "create_midi_clip",
      "trackRef": "bass",
      "startBeat": 0,
      "durationBeats": 8,
      "name": "AI Bass Riff",
      "notes": [
        { "pitch": 36, "startTime": 0, "duration": 1, "velocity": 96 }
      ]
    }
  ]
}
```

## Model Providers

Open `Ask Live Smith`, switch to the Inspector's **Model** tab, and create a
named profile. Each Profile saves one connection plus its model and generation
configuration:

- Connection: `Direct API` or **ChatGPT subscription (Experimental)**
- For Direct API, an API family and mode: OpenAI `Responses`, OpenAI
  `Chat Completions`, or Anthropic `Messages`
- For Direct API, a base URL plus an API key unless the endpoint is local
  loopback
- Model
- Connection- and capability-aware generation controls
- For Direct API, maximum output tokens and optional temperature or thinking
  budget
- For Direct API, optional provider-hosted Web Search for Responses or Messages
- For Direct API, optional manual capability overrides and Extra Body JSON

Click **Save & Use** to persist and activate it. Add, Duplicate, Delete, and
Discard operate on profile drafts; sending is blocked while the draft has
unsaved changes. Model discovery can use the current draft without saving or
activating it, even before Profile name or model has been entered.

### Connection backends

`direct-api` is the direct HTTP/SSE connection. Live Smith owns the wire
request and uses the saved Profile's base URL and API key. It is also the
explicit fallback when the experimental subscription connection is unsuitable:
Live Smith never silently switches connections, inherits an environment API
key, or turns a subscription failure into separately billed API usage.

`codex-subscription` appears as **ChatGPT subscription (Experimental)**. It
requires the official Codex CLI `0.148.x` on `PATH` and starts `codex
app-server` over local stdio. App Server owns ChatGPT device-code login and
requests consume the signed-in account's applicable Codex subscription limits;
Live Smith does not extract an OAuth token and send it to `/v1/responses`. Its
`CODEX_HOME` is fixed to the private
`<storageDirectory>/codex-subscription` directory, forces the CLI's file
credential store, and verifies the initialized server reports that canonical
home. It neither reads nor overwrites the user's normal `~/.codex/auth.json` or
uses the normal Codex Keychain entry.

The managed process is not a second tool-running agent. Coding, shell/code
mode, browser/computer use, MCP, apps, plugins, Codex Skills and workspace
dependencies, image generation, multi-agent behavior, hooks, and Web Search
are disabled. Memory use/generation, notifications, request-user-input,
planning/goals, automatic/bundled Codex Skill instructions, and provider-hosted
search are also forced off. Codex's permission, apps, collaboration-mode, and
environment prompt blocks plus its separate Skill/MCP orchestrators are
disabled. Project instruction bytes are capped at zero and project-root
markers are empty, preventing ancestor `AGENTS.md` and `.codex/config.toml`
discovery. CLI history persistence, analytics, feedback, update checks, OTEL
export, remote plugins/sharing, in-app updates, and remote compaction v2 are
disabled as well. Launch-time overrides clear configured MCP servers and custom
model providers, require ChatGPT login, pin the official OpenAI model endpoint,
and each thread pins the built-in OpenAI provider. The separate process-level
ChatGPT product-metadata base is forced to a randomized private loopback policy
responder owned by the same backend. It answers only Codex 0.148's attribution
settings request with attribution disabled and its cloud-config request with an
empty bundle; every other route is rejected. This prevents those upstream
extensions from making external requests or adding Git-attribution developer
instructions. The child receives only an allowlist of executable lookup,
operating-system, temporary-directory, and locale variables plus Live Smith's
controlled `CODEX_HOME`. Ambient proxy variables, custom-CA settings, provider
credentials, and arbitrary parent-process variables are not inherited, so an
untrusted host proxy cannot intercept either the private loopback responder or
Codex's official device-login and token refresh/revoke routes. Enterprise proxy
support would require an explicit trusted configuration; it is not inferred
from the Extension Host environment. An unexpected
persistent `config.toml`, symlinked private directory, linked/non-regular
`auth.json`, or mismatched initialized Codex home fails before use. An existing
isolated auth file is tightened to `0600` on POSIX.
App Server starts only after its private runtime workspace is confirmed empty;
each model call then uses an ephemeral thread with no runtime workspace roots
or environments, empty developer instructions, and a read-only sandbox. Codex
returns a schema-constrained JSON description of text and requested Live Smith
tool calls; unexpected App Server tool activity or an unknown tool name fails
closed. Only Live Smith's provider-neutral outer loop executes the bounded
Live observation and action tools, preserving its normal validation,
confirmation, mutation queue, cancellation, and state-drift checks.

Exact Codex 0.148 has one unavoidable metadata boundary: App Server starts an
online model-catalog refresh when the process starts, repeats it every three
minutes, and may write `models_cache.json` inside the isolated managed home.
There is no supported switch that disables both that worker and disk cache while
retaining account-aware dynamic model discovery. This is catalog metadata
traffic, not a model turn, and Live Smith never copies that file into settings,
Sessions, events, or its Direct API model cache. The upstream file is not keyed
by ChatGPT account and can remain fresh for five minutes, so Live Smith clears
its own modal catalog on every auth generation but does not claim the upstream
catalog itself is account-scoped.

Codex may cache the loopback responder's empty cloud-config result inside the
isolated home. Live Smith does not treat that as authorization to bypass a
managed workspace policy: every exact 0.148 workspace plan type, plus unknown
plan types, is marked ineligible and fails before
model discovery or thread creation. Check and Sign out remain available.

ChatGPT auth mutations and every agent send share a process-wide gate for the
same Ableton storage directory. Login/logout cannot race a send in another
modal, and a pending device login blocks other modals and new sends until a
Check observes signed-in, signed-out, or definitive failure, cancellation or
sign-out succeeds, or its
owner closes. Every modal also acquires one reference to the same canonical-
storage-keyed backend manager and App Server. Canonicalization resolves the
longest existing ancestor before appending any not-yet-created storage suffix,
so a parent-directory symlink cannot split first-open and later-open modals into
different process or fence owners. One `AuthManager`, refresh lock, model
worker, and `models_cache.json` writer own the shared `auth.json`.
The last modal closes the process; closing the owner of an unfinished device
flow retires that shared runtime before releasing the pending-login gate.

Each definitive Check and every login/logout attempt advances an auth
generation that invalidates every modal's credential-free auth/catalog
projection. Each modal clears its projection before its next state, auth,
discovery, or send operation. Successful mutations update the one shared App
Server in place. If a
login/logout outcome is unknown, the owner instead retires that exact shared
backend to confirmed process exit before publishing the generation or
releasing the storage-wide transition. State, auth, discovery, and send in
other modals wait behind that transition. If exit cannot be
confirmed, subscription use for that storage directory is poisoned until the
extension process restarts. Device-login completion notifications clear the
backend's finished or failed flow without exposing upstream error text. Any
modal that subsequently observes an authoritative signed-in, signed-out, or
definitive failed state reconciles the stale pending owner exactly once and
publishes the new auth generation. Pending-login state and Check callers share
one storage-wide readiness refresh, so concurrent modals cannot overlap refresh
work or release the send gate before that read settles; pending and
non-definitive results keep the owner locked. Closing one waiting modal cancels
only that modal's wait; the shared read remains available to other waiters and
is bounded by RPC timeout, terminal connection failure, or the last backend
owner closing.

Explicit Check and every subscription send readiness preflight ask App Server
to refresh the managed credential. Ordinary signed-in or signed-out UI
hydration remains passive; resolving a pending device flow uses the shared
readiness refresh described above.
Before persisting any subscription prompt, the server confirms an eligible
signed-in account, refreshes a generation-scoped catalog miss through the same
managed backend, and validates the selected runtime model. A permanent refresh
failure, failed login, missing model, or other readiness failure remains
unpersisted so a queued head pauses instead of draining the FIFO. Direct
API temperature, output-token, and
reasoning-budget controls do not apply, and reasoning cannot be set to
Disabled; supported effort choices, including `ultra` when advertised, come
from the App Server model catalog. Unknown catalog effort values fail closed
instead of being silently dropped.
Live Smith's subscription catalog projection is modal-scoped, invalidated
whenever auth may change, cleared before that modal's next relevant operation,
and never written to its own disk cache. Signing out requires
an explicit confirmation. Image/audio data is rechecked against catalog
evidence at the backend, and an oversized encoded subscription turn fails
locally with guidance to shorten the Session or remove an attachment.

Every thread and turn explicitly clears inherited service-tier configuration;
with `fast_mode` disabled, Codex must report a null effective tier before a turn
may start, so priority/flex/legacy fast routing cannot be selected. Terminal turns
unsubscribe their ephemeral thread. One backend accepts at most four concurrent
turns and recycles after eight created threads once all active turns and
first-turn reservations drain. Threshold recycling rejects new sends while
allowing already-admitted continuations to finish. When the four instantaneous
turn slots are occupied, continuations from already-persisted sends wait in
arrival order and take priority over new first-turn reservations instead of
failing with a capacity error. The waiters share their owning send's abort
lifetime and do not create independent model work. Unsafe cleanup and any
forbidden App Server runtime item block further turns and retire the process
after owned work drains.
Terminal RPC failures conditionally evict only their exact backend; replacement
waits for confirmed process exit, and an unconfirmed SIGKILL poisons the shared
storage-directory subscription boundary instead of starting a second possibly
overlapping process. Before the prompt is persisted, the backend reserves one
first-turn capacity slot; threshold recycling waits for that reservation and
the first model step consumes it on the preflighted backend. Later agent-loop
steps reacquire the current manager slot, wait for fair admission on an
eligible live backend when necessary, and otherwise hand off to a confirmed
replacement. Child `error`, `exit`, and `close` share one terminal observation,
so a missing executable's `error` followed by `close` is reported as unavailable
without unnecessary shutdown escalation or storage poison.

All subscription Profiles in one Ableton storage directory share this isolated
ChatGPT login. Deleting a Profile does not sign out that shared account; use the
explicit **Sign out** action. The `codex` executable is resolved from `PATH`, so
users must install and trust the official binary. Live Smith verifies its
reported `0.148.x` protocol line and isolated home, not binary provenance.

> [!WARNING]
> This connection is experimental. OpenAI documents `codex app-server` as
> experimental and unsupported for production workloads, and its protocol
> schema is version-specific, so Live Smith accepts only the `0.148.x` line.
> Node subprocess coverage does not establish compatibility with Ableton's real
> Extension Host; that end-to-end subprocess smoke remains pending. Use a
> Direct API Profile when this risk is unacceptable.

OpenAI references: [Codex authentication](https://learn.chatgpt.com/docs/auth),
[subscription and API-key billing](https://learn.chatgpt.com/docs/pricing),
[App Server](https://learn.chatgpt.com/docs/app-server), and
[official CLI releases](https://github.com/openai/codex/releases).

Claude/Anthropic subscription login is not implemented. Anthropic's published
credential policy directs third-party products to Console API keys or supported
cloud providers and does not permit offering Claude.ai login or routing user
requests through consumer subscription credentials without approval. Live
Smith therefore exposes no Claude subscription tier as a connection unless
Anthropic first grants written approval. It does not launch Claude Code for
inference, read `~/.claude` credentials, copy OAuth tokens, or call private
Claude.ai endpoints. Anthropic remains available through the direct
`Anthropic Messages` mode with a Claude Console API key; a paid Claude
subscription is separate from API billing. See Anthropic's [authentication and
credential-use policy](https://code.claude.com/docs/en/legal-and-compliance) and
[subscription/API billing separation](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console).

### Profile lifecycle

The UI keeps configuration in three explicit states:

- `DraftProfile` is the editable preview and may be incomplete. Its connection
  fields can be used by **Connect & Load** before the Profile name or model is filled.
- `SavedProfile` is the fully validated value written by Profile CRUD.
- `RuntimeProfile` combines the active Saved Profile with resolved capabilities;
  model requests and the header summary use the same runtime value. Its
  discriminated connection remains `direct-api` or `codex-subscription`;
  neither connection is inferred from model names.

Compatible Direct API services use a Profile for the protocol family they
implement. OpenAI-family endpoints use `Chat Completions` or `Responses`;
Anthropic-family endpoints use `Messages`. An Anthropic base URL may be the API
root or end in `/v1`, and Live Smith resolves the `/v1/messages` and
`/v1/models` endpoints. Local loopback endpoints can leave API key blank; Live
Smith then sends no authentication header. Every non-loopback endpoint still
requires a key.

Use **Connect & Load** in the Model tab to query the provider's model list.
Direct API endpoints can expose model metadata such as display names, max
output tokens, streaming, tools, and reasoning controls; the subscription
connection instead queries the signed-in App Server catalog. Direct providers
often still return only model IDs, so token limits and reasoning support may
fall back to built-in capability hints or manual Settings values.

OpenAI Responses always sends `store: false`; Live Smith stores and replays the
returned response items locally instead of using remote conversation state.
If Responses stops at `max_output_tokens`, Live Smith replays that exact local
state and automatically asks the model to continue up to two times. Incomplete
function-call items are never executed; a call item the provider separately
marks `completed` may proceed before the next agent turn. Other incomplete
reasons still fail closed, and repeated exhaustion asks you to raise the
Profile's Max Output Tokens or continue the Session.

### Hosted Web Search

The compact **Web search** control below the Model field is a per-Profile,
explicit opt-in. It uses the active provider connection and does not require a
second API key. Live Smith maps it to OpenAI Responses `web_search` or the
Anthropic Messages `web_search_20250305` server tool. OpenAI Chat Completions is
rejected locally before network I/O; Live Smith never silently changes a
Profile's model or protocol.

Enabling the Profile control makes the tool available and gives the model a
clear policy to search for explicit lookup requests and current or changing
facts. Every factual premise that affects a Live mutation must be supported by
evidence in the current request context or obtained through an available tool.
If the evidence is missing and no tool can obtain it, the model asks the user;
model memory is not evidence. When hosted search is unavailable, every request
says so explicitly and forbids promising a search. It does not search every
message, and there is no separate composer switch that overrides the model's
tool decision. Request format compatibility
does not prove that an OpenAI-compatible endpoint implements provider-hosted
search, so the Profile UI states that limitation instead of claiming discovery
verified it.

When a provider reports hosted search activity, the timeline opens a live Web
Search card with the query and any search-result pages returned by the
provider. The same card keeps its expanded or collapsed state when live
activity becomes a terminal Session event. The terminal card remains in Session
history, and every safe source-page URL can be opened directly. Hosted search
keeps page text inside the model context; the source list contains links rather
than page excerpts. A provider-reported search failure is stored and shown
explicitly without exposing its raw error payload. Neither indicator appears
merely because the Profile setting is enabled.

The model may use up to 20 hosted search actions across one send, but it is not
required to search. If a compatible endpoint emits more activity than the
bounded timeline can retain, Live Smith omits the excess activity and preserves
the final answer instead of terminating the send.

Search result content, titles, URLs, excerpts, and citations are untrusted model
data. They cannot authorize Live tools, approvals, filesystem access, or Set
mutations. Provider-specific search/replay blocks remain opaque transport state.
Session history stores only the bounded query plus normalized HTTP(S) result
titles and URLs. The answer's separate **Citations** list contains only URLs the
provider explicitly attached to answer text; it does not promote every search
result into a citation.

### File attachments

Drop a PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, or MP3 onto the composer, or
paste one from the clipboard. Ableton's embedded extension view does not expose
a native system file picker, so Live Smith does not show a file-browse control
that cannot work in the host. The composer's compact **+** menu also offers
**Attach selected Live audio**, which copies the file backing the selected Live
Audio Clip, Sample, or Simpler into the same pending Session state. This command
accepts only the Session ID; the UI and model cannot provide an arbitrary path.
Uploading or copying a supported file does not require the currently active
Profile to support that input, so it can remain pending while you switch
Profiles.

Image sends require the active saved Runtime Profile to resolve `inputs.image`
to `true`. Native PDF sends require that saved Runtime Profile to resolve
`inputs.pdf` to `true` and use either OpenAI Responses or Anthropic Messages.
Live Smith intentionally does not send PDFs through OpenAI Chat Completions in
this milestone. DOCX, XLSX, and PPTX do not require a model document capability:
Live Smith validates their OOXML packages and extracts bounded text locally.

Audio sends are limited to OpenAI Chat Completions or a ChatGPT subscription
model whose App Server catalog explicitly declares audio input. The active
saved Runtime Profile must resolve `inputs.audio` to `true` with explicit
`supported` evidence. Direct API evidence may come from discovery metadata or
a manual override; subscription evidence can come only from App Server model
discovery because subscription capability overrides are disabled. Tool support
is not an audio-input gate. OpenAI Responses and Anthropic Messages reject
audio locally in this milestone, before provider network I/O.

Accepted audio is a RIFF/WAVE file containing PCM or IEEE-float samples, or an
MP3 containing MPEG-1 or MPEG-2 Layer III frames. Each audio file is limited to
20 MiB and 120 seconds. Live Smith sends the complete original file bytes,
including embedded metadata; it does not send Live's warped, processed,
rendered, or mixed output. The local inspector does not execute ID3 metadata,
but neither that inspection nor copying from Live cleans or sanitizes the file.
The file name, metadata, and audio content remain untrusted model context.

The shared attachment policy permits at most 4 attachments and 30 MiB of raw
attachment bytes in pending Session state or one model request. An image may be
at most 5 MiB and all images together at most 16 MiB; a document and the
document subtotal may each be at most 20 MiB; audio has a 20-MiB per-file limit,
a 30-MiB subtotal, and a maximum count of 2. The combined 30-MiB and 4-file
limits still apply. Office extraction is capped at 100,000 Unicode code points
per file and 200,000 across one request. The backend rechecks detected type,
integrity, Session ownership, and quotas; client-side checks are only early
feedback.

Uploads, deletion, send preparation, event append, and existing-Session
lifecycle changes share the same per-Session mutation fence and observe cancellation.
Files stay pending until a user event is durably appended. That append consumes
the same immutable references before the provider call, so a later provider
failure does not resend them as a new prompt. A current incompatible or
over-budget file fails before append and remains pending. Consumed files remain
visible in history and cannot be deleted independently.

Historical attachments are selected newest-first after reserving the current
request budget, then restored to chronological message order; only selected
blobs are opened. Missing, corrupt, incompatible, or omitted historical files
degrade to fixed untrusted markers rather than failing the new send. File names,
metadata, document text, and binary content are untrusted model context only:
they cannot become sample-source arguments or authorize filesystem access.

See [docs/MODEL_PROVIDERS.md](docs/MODEL_PROVIDERS.md) for provider details and
capability resolution.

### Queue and Steer follow-ups

While Live Smith is working, the composer keeps a single running control:
**Stop**. Submit text with the composer shortcut and Live Smith uses the global
**Follow-ups** setting:

- **Queue** (the default) keeps the message under **Up next**, waits for the
  current response to finish, then starts a new ordinary turn with a new send ID
  and fresh Profile, Skill, attachment, history, and Approval state.
- **Steer** persists the text as guidance for the response already in progress,
  interrupts only its current provider call, and replans at a protocol-safe
  boundary. It does not resnapshot request-start configuration.

The setting remains writable during a send and applies to the next follow-up
immediately. Items already queued or submitted keep their captured mode. A
definitely unaccepted original or promoted send pauses its FIFO and restores its
text only into an untouched composer; newer drafts are preserved. An uncertain
turn also pauses the tail until an explicit recovery Send. Stop waits for the
target send's terminal persistence classification before recovering or
advancing work. Deleting, archiving, or losing the target Session cancels its
remaining Queue with a visible count rather than rerouting prompts. Closing the
window warns about and cancels pending items without prematurely appending user
events.

### Local Skills

Open the Inspector's **Skills** tab and either drop one UTF-8 `SKILL.md` into its
import area or paste the Markdown into the keyboard-accessible editor. The
definition must be at
most 64 KiB and use exactly this frontmatter shape before a non-empty Markdown
body:

```markdown
---
name: mix-review
description: Review balance, space, and mix translation
---
Your local workflow guidance goes here.
```

Names use lowercase letters, numbers, and single hyphens. Live Smith stores at
most 32 Skills and 1 MiB of Skill source in total. A Session can enable at most
four; enabled Skill IDs persist with that Session. Typing `$mix-review` at a
normal whitespace boundary adds an installed Skill for one request without
changing the prompt. Mentions inside inline or fenced Markdown code, email/path
tokens, currency-like numbers, and numeric-leading IDs are not activated.

Skills are locally installed declarative workflow guidance. They cannot install
or execute scripts, binaries, MCP servers, plugins, nested resources, or
arbitrary paths; change provider settings; add tools; or add Live actions. A
Skill never expands the built-in action schema or tool set. Every action remains
subject to observation, schema validation, the selected Approval policy,
preflight, cancellation, process-wide mutation serialization, and state-drift
revalidation. Skill Markdown has lower priority than Live Smith's system and
safety instructions and cannot authorize secrets, filesystem access,
unsupported provider fields, or actions outside the built-in schema.

Import and delete use separate authenticated local bridge routes; `/send`
remains exactly `{ prompt, sessionId }`. Only Skill ID/description summaries and
active IDs reach the UI. Selected bodies are read and hash-checked only when a
request actually activates them, then escaped into a bounded 128-KiB system
instruction block. Deleting a Skill is blocked while any current, historical,
or archived Session uses it; the UI can disable it across those Sessions first.

## Local data and privacy

Settings are stored locally in the per-extension directory supplied by the
Ableton Extensions SDK as `context.environment.storageDirectory`. Live Smith
does not choose or hard-code the production path; when Live manages the
Extension Host, Live owns that path and its exact OS location may change during
the SDK beta. Configured Direct API keys are currently stored there as plain
text, so use a restricted provider key and do not share or sync that directory.
ChatGPT subscription credentials are instead owned by the official Codex CLI
under the isolated `codex-subscription/` child directory; they are not copied
into a Profile, Session, event, or log, and the user's normal `~/.codex` login
is not read. Never commit provider credentials or either storage location.

Model configuration is read only from saved profiles; environment variables are
not a model-configuration fallback. Unit and DOM behavior tests do not call a
model provider and do not require an API key.

Attachment bytes are private local Session data and are never embedded in
settings or event JSON. When a user event consumes a file, its immutable
reference metadata (ID, display filename, media type, byte length, and SHA-256)
is persisted on that event; the file bytes remain only in attachment storage.
Provider errors never include their base64 request representation. On POSIX
hosts the attachment directories are restricted to `0700` and files to `0600`,
like the other private Live Smith storage. Do not share or cloud-sync this data
directory.

## Sessions and history

Live Smith stores sessions in the same extension storage directory. Sessions are
scoped by the current extension activation and the resolved conversation
target's opaque SDK handle ID. A device, Sample, or Clip Slot may resolve to its
owning track or clip so related work stays in one conversation; display names
never determine identity, so duplicate names and renames do not mix histories.
Because the current SDK does not expose a documented stable project identifier,
sessions from a previous extension activation are never bound automatically.
When a prior Session has the same object kind and display label as the object
used to open Live Smith, it appears under **Previous sessions**. Restoring it
requires explicit confirmation and rebinds that Session to the current SDK
object; the label is only a recovery hint, not an identity claim.

Each session stores user messages, assistant messages, tool calls, tool results,
Apply requests, Apply results, and errors. Session events are the single source
of conversation history. Only the most recent 24 user/assistant messages in the
active session are sent as model history. The most recent 12 persisted Apply
results, rejected tool inputs, and errors are also included in a separate bounded
recovery block so a later send can continue missing work without forgetting
completed mutations or its last contract repair. This
block is labelled untrusted data and is capped at 12,000 characters.
Unfinished Apply events additionally carry the bounded digest-only replay ledger;
raw action JSON, MIDI note payloads, and credentials are not copied into it.

The directory contains:

- `live-smith-settings.json` — saved Profiles, their `direct-api` or
  `codex-subscription` connection, the active Profile, Direct API keys,
  generation settings, the default Queue/Steer behavior and revision, and a
  legacy Approval field retained only for settings schema compatibility.
  Subscription credentials are not stored in this file, and the legacy
  Approval field no longer affects Apply authorization.
- `live-smith-sessions.json` — Session titles, Live object scopes, and
  timestamps, plus each Session's Approval mode and optional sorted active Skill
  IDs.
- `live-smith-events/<session-id>.json` — conversation messages, tool calls,
  tool results, confirmations, and errors for each Session.
- `live-smith-attachments/<session-id>/` — private attachment blobs and integrity
  metadata owned by that Session.
- `live-smith-models-<profile-id>-<hash>.json` — Direct API model-discovery
  cache; Live Smith's normalized subscription projection is modal-only.
- `live-smith-skills/` — private Skill catalog, recovery metadata, and one
  strict `SKILL.md` definition per installed ID.
- `codex-subscription/` — private official Codex CLI home containing the shared
  ChatGPT file-store credential, Codex's own model-metadata cache, and managed
  runtime state; never share or sync it.

On POSIX systems, Live Smith restricts the directory, JSON files, and attachment
blobs to the current user. If the SDK does not provide a storage directory, data
falls back to process memory and will not survive an Extension Host restart.

During development, `npm start` uses the Git-ignored `.live-smith-data/`
directory in this repository. Profiles saved while running the extension are
therefore retained when the Extension Host restarts. The settings file is:

```sh
.live-smith-data/live-smith-settings.json
```

To use another persistent location, pass it after the npm argument separator;
the later CLI value overrides the development default:

```sh
npm start -- --storage-directory /absolute/path/to/live-smith-data
```

These paths contain private persistent data, not SDK temporary files. Do not
commit, share, or sync them. The current schema is version 4. Its registered
adjacent migrations map schema-version-1 `autoApprove` through the version-2
compatibility field and then wrap version-2 flat API Profiles as version-3
`direct-api` connections. The version-3-to-4 step deliberately recognizes both
earlier development shapes: flat Queue/Steer settings preserve their canonical
decimal-string revision, while nested subscription settings receive Queue at
revision `"0"`. Partial follow-up fields, mixed Profile shapes, and unknown
fields fail closed. Neither legacy Approval value seeds or overrides a
Session's Approval mode. Reading never rewrites the file; the next authorized
settings write persists schema version 4. Future versions and historical
schemas without a complete migration chain are rejected.

If you use `npm start` without passing `--live`, also create `.env` with
`EXTENSION_HOST_PATH` as described in the SDK quick start.

## Development Setup

Prerequisites:

- Node.js 24.14.0 or newer.
- A version of Ableton Live with Extensions support.
- Authorized access to the Ableton Extensions SDK beta.

The Ableton SDK is intentionally not included in this repository. Its license
does not permit redistributing the SDK or its files separately from an
application. Obtain the SDK through Ableton's official developer channel and
place these two archives in `extensions-sdk-1/`:

- `ableton-extensions-sdk-1.0.0-beta.1.tgz`
- `ableton-extensions-cli-1.0.0-beta.1.tgz`

Then install and verify the project:

```sh
npm ci
npm test
npm run build
```

For CLI host discovery, copy `.env.example` to `.env` and adjust
`EXTENSION_HOST_PATH`, or pass the Live application path with `--live`.

## Commands

```sh
npm test
npm run build
npm run package
npm run verify:package
npm start -- --live "/Applications/Ableton Live Beta.app"
```

`npm run package` builds, packages, and verifies that the `.ablx` contains the
exact current `dist/extension.js`. `npm run verify:package` fails with both
SHA-256 hashes when an existing package is stale.

In Live, right-click an audio clip, MIDI clip, audio/MIDI track, clip slot,
scene, Simpler, sample, Drum Rack, arrangement selection, or clip-slot selection
and choose `Ask Live Smith`.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module layout and the
steps for adding model providers, Live entrypoints, and executable actions.
