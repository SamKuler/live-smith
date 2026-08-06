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
- Shows grouped Apply diffs. Changes require `Apply` by default; Auto approve
  may skip confirmation for undoable actions. Deletes and MIDI clip
  writes that may replace existing notes always require explicit confirmation.
  Auto approve can be changed while a Session is running; the current value is
  read for the next proposed Apply decision and does not alter a confirmation
  that is already open.

## Capabilities

The action executor exposes a deliberately bounded set of Live mutations:

| Area | Supported operations |
| --- | --- |
| Set structure | Set tempo; create, rename, duplicate, or delete Scenes; create, rename, or delete Cue Points. |
| Tracks and mixer | Create MIDI or audio tracks; rename, duplicate, mute, solo, arm, or delete tracks; set volume, panning, and sends. |
| MIDI Clips | Create or replace Arrangement and Session MIDI Clips with up to 4096 notes per action; replace bounded ranges of an Arrangement MIDI Clip. |
| Audio Clips | Create Arrangement or Session audio Clips from an observed sample source; edit Clip properties and warp settings; clear Arrangement ranges; delete Arrangement or Session Clips. |
| Devices and Racks | Insert exact-name native Live devices on tracks or inside Rack chains; inspect and set exposed parameters; duplicate or delete existing devices. |
| Samples | Load an observed sample into Simpler or configure a Drum Rack pad from the selected object, an observed audio Clip, or another observed Simpler. |
| Take Lanes | Create and rename Take Lanes using their observed track and lane identity. |

Creating a MIDI clip requires a MIDI target. A plan that creates a new track
declares a local `ref` on `create_midi_track`, and later actions use the matching
`trackRef`, so the entire plan remains visible in one Apply diff without relying
on a mutable display name. A named clip with the same track,
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
pending plan instead of being overwritten.

The extension does not execute arbitrary code from the model. It parses and
validates a small JSON action schema. Changes require confirmation by default;
Auto approve may skip confirmation for undoable actions, while deletes
and MIDI create-or-replace actions always require explicit confirmation. The
agent loop uses a rolling 12-step no-mutation window: every successful or
partially successful Live write renews that window, so a large project is not
stopped merely because it has many stages. Observation-only or repeatedly
failing loops stop when they make no mutation progress. A broad 64-step
per-request runaway guard preserves completed work and asks the agent to
continue in the same Session. There is no accumulated tool-call quota; only an
oversized batch in one model turn is rejected without execution and returned to
the model so it can regroup the unfinished stage.
If a confirmed multi-action plan partially succeeds, the completed actions and
exact failed action are persisted and returned to the model so it can inspect
the Set and continue only with missing work. It does not automatically replay
completed actions, and an exact device insertion rejected by Live cannot be
retried under another equivalent track selector during the same request.

Confirmation and Live Undo are different boundaries. One confirmation may
authorize an ordered plan with multiple Undo entries because the 1.0.0 beta SDK
requires dependent asynchronous mutations (such as create, then rename) to run
as sequential transactions. The UI does not claim that a complete confirmed
plan is always one Undo step.

### Device and content boundaries

The current Extensions SDK does not expose Live's Browser, preset search, or an
installed-device catalog. Live Smith therefore:

- Inserts a native Live device using an exact built-in name and treats Live's
  success or rejection as authoritative.
- Cannot load a VST by plug-in identifier. Existing VST devices can still be
  inspected, have exposed parameters edited, and be duplicated or deleted.
- Treats a newly inserted Drum Rack or Simpler as empty until a sample source is
  explicitly configured.
- Reuses only selected or observed Live sample sources; the model never receives
  or supplies arbitrary filesystem paths.

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

See [docs/MODEL_PROVIDERS.md](docs/MODEL_PROVIDERS.md) for provider details and
capability resolution.

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
active session are sent as model history.

The directory contains:

- `live-smith-settings.json` — saved Profiles, the active Profile, API keys,
  generation settings, and the global Auto-approve setting.
- `live-smith-sessions.json` — Session titles, Live object scopes, and
  timestamps.
- `live-smith-events/<session-id>.json` — conversation messages, tool calls,
  tool results, confirmations, and errors for each Session.
- `live-smith-models-<profile-id>-<hash>.json` — provider model-discovery cache.

On POSIX systems, Live Smith restricts the directory and JSON files to the
current user. If the SDK does not provide a storage directory, data falls back
to process memory and will not survive an Extension Host restart.

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
commit, share, or sync them. The current pre-release build does not migrate
files written under earlier development names or schemas.

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
