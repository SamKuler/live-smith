<div align="center">

# Live Smith

**A context-aware AI production agent for Ableton Live.**

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B?style=flat-square)](#development-setup)
[![Ableton Extensions SDK](https://img.shields.io/badge/Ableton_Extensions_SDK-1.0.0--beta.0-111111?style=flat-square)](#device-and-content-boundaries)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.14-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](package.json)

[Capabilities](#capabilities) · [Providers](#model-providers) · [Sessions](#sessions-and-history) · [Local data](#local-data-and-privacy) · [Development](#development-setup)

</div>

> [!NOTE]
> Live Smith currently targets the Ableton Extensions SDK `1.0.0-beta.0` and
> requires an Ableton Live build with Extensions support.

## Overview

- Adds `Ask Live Smith` to supported Live context menus.
- Opens a ChatApp-style modal with scoped sessions, tool trace history, Live
  context, named connection profiles, and model capability hints.
- Supports two API families through three explicit modes: OpenAI Responses,
  OpenAI Chat Completions, and Anthropic Messages. Custom OpenAI-compatible
  base URLs are regular OpenAI profiles.
- Uses real tool calls for observation and mutation. The agent can inspect the
  Live Set, tracks, devices, and MIDI notes before deciding what to apply.
- Shows model/tool/apply/error events in the active chat session.
- Accepts PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3 files by picker,
  paste, or drag-and-drop. A selected Live Audio Clip, Sample, or Simpler source
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
  action numbers. The Approval selector has three modes: `Manual` asks before
  every plan, `Low Risk` automatically approves only plans outside the
  protected-action set, and `Accept Everything` automatically approves every
  validated plan, including deletes and replacement writes. Accept Everything
  stays visibly red and does not open an extra mode-change warning. Automatic
  approvals receive a distinct `Auto-approved` timeline event. The mode can be
  changed while a Session is running; the current value is read for the next
  Apply decision and does not alter an approval prompt that is already open.

## Capabilities

The action executor exposes a deliberately bounded set of Live mutations:

| Area | Supported operations |
| --- | --- |
| Set structure | Set tempo; create, rename, duplicate, or delete Session View Scenes; create, rename, or delete Arrangement Cue Points. |
| Tracks and mixer | Create MIDI or audio tracks; rename, duplicate, mute, solo, arm, or delete tracks; set volume, panning, and sends. |
| MIDI Clips | Create or replace Arrangement and Session MIDI Clips with up to 4096 notes per action; replace bounded ranges of an Arrangement MIDI Clip. |
| Audio Clips | Create Arrangement or Session audio Clips from an observed sample source; edit Clip properties and warp settings; clear Arrangement ranges; delete Arrangement or Session Clips. |
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
`resolvesPriorFailure` clears the operation. Creator identity is independent of
the model's temporary `ref`, so changing an alias cannot create the same Track
again. Tool-free model text can never turn an unresolved partial Apply into a
successful result.

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

Open `Ask Live Smith`, switch to Settings, and create a named profile. Each
profile saves the complete connection and generation configuration:

- API family and mode: OpenAI `Responses`, OpenAI `Chat Completions`, or
  Anthropic `Messages`
- API key, base URL, and model
- Temperature and maximum output tokens
- Capability-aware reasoning effort or thinking budget
- Optional manual capability overrides and Extra Body JSON

Click `Save Changes` to persist and activate it. Add, Duplicate, Delete, and
Discard operate on profile drafts; sending is blocked while the draft has
unsaved changes. Model discovery can use the current draft without saving or
activating it, even before Profile name or model has been entered.

### Profile lifecycle

The UI keeps configuration in three explicit states:

- `DraftProfile` is the editable preview and may be incomplete. Its connection
  fields can be used by Load Models before the Profile name or model is filled.
- `SavedProfile` is the fully validated value written by Profile CRUD.
- `RuntimeProfile` combines the active Saved Profile with resolved capabilities;
  model requests and the header summary use the same runtime value.

OpenAI-compatible services use an OpenAI profile with `Chat Completions` (or
`Responses` if the service implements it) and the service's base URL. Anthropic
profiles always use `Messages`; their base URL may be the API root or end in
`/v1`, and Live Smith resolves the `/v1/messages` and `/v1/models` endpoints.

Use `Load Models` in the Connection section to query the provider's model list.
Endpoints can expose model metadata such as display names, max output
tokens, streaming, tools, and reasoning controls. Providers
often still return only model IDs, so token limits and reasoning support may
fall back to built-in capability hints or manual Settings values.

OpenAI Responses always sends `store: false`; Live Smith stores and replays the
returned response items locally instead of using remote conversation state.

### File attachments

The **Attach file** control accepts PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV,
and MP3. **Attach selected source** can copy the file backing the selected Live
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

Audio sends are limited to OpenAI Chat Completions and require the active saved
Runtime Profile both to resolve `inputs.audio` to `true` and to have explicit,
supported capability evidence from discovery metadata or a manual override.
Tool support is not an audio-input gate. OpenAI Responses and Anthropic
Messages reject audio locally in this milestone, before provider network I/O.

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

### Local Skills

Open **Settings → Skills** to import one UTF-8 `SKILL.md`. The file must be at
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
the SDK beta. API keys are currently stored there as plain text, so use a
restricted provider key and do not share or sync that directory. Never commit
provider credentials.

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

- `live-smith-settings.json` — saved Profiles, the active Profile, API keys,
  generation settings, and the global Approval mode.
- `live-smith-sessions.json` — Session titles, Live object scopes, and
  timestamps, plus optional sorted active Skill IDs.
- `live-smith-events/<session-id>.json` — conversation messages, tool calls,
  tool results, confirmations, and errors for each Session.
- `live-smith-attachments/<session-id>/` — private attachment blobs and integrity
  metadata owned by that Session.
- `live-smith-models-<profile-id>-<hash>.json` — provider model-discovery cache.
- `live-smith-skills/` — private Skill catalog, recovery metadata, and one
  strict `SKILL.md` definition per installed ID.

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
commit, share, or sync them. The current build migrates schema-version-1
`autoApprove` settings in memory: `false` becomes `Manual`, and `true` becomes
`Low Risk`. Settings upgrades use registered adjacent-version steps, so future
schemas add one `vN` to `vN+1` migration instead of branching inside the current
validator. Reading never rewrites the file; the next settings write persists
schema version 2 without dropping Profiles or credentials. Future versions and
historical schemas without a complete migration chain are rejected. Files
written under other earlier development names are not migrated.

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

- `ableton-extensions-sdk-1.0.0-beta.0.tgz`
- `ableton-extensions-cli-1.0.0-beta.0.tgz`

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
