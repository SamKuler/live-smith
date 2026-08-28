<div align="center">

# Live Smith

**An AI production assistant that works with your Ableton Live.**

[![Status: Beta](https://img.shields.io/badge/status-beta-F59E0B?style=flat-square)](#getting-started)
[![Ableton Extensions SDK](https://img.shields.io/badge/Ableton_Extensions_SDK-1.0.0--beta.1-111111?style=flat-square)](docs/DEVELOPMENT.md#prerequisites)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.16-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](package.json)

[What it does](#what-it-does) · [Getting started](#getting-started) · [Connections](#model-connections) · [Safety](#you-control-the-changes) · [Privacy](#privacy)

</div>

Live Smith helps you understand, arrange, and edit a Live Set through conversation.
Select a track, Clip, device, or another supported Live object and choose
**Ask Live Smith**. Your conversation starts with that musical context.

> [!NOTE]
> Live Smith is beta software and requires an Ableton Live build with Extensions
> support. See the [development guide](docs/DEVELOPMENT.md) for installation from source.

## What it does

- **Work with your Set.** Inspect tracks, Clips, devices, and MIDI notes, then
  create or edit MIDI parts, organize tracks and Scenes, adjust mixer settings,
  and work with observed samples and native Live devices. Analyze isolated
  Arrangement audio ranges for level measurements. With a verified audio-input
  model, Live Smith can also render a requested Arrangement Clip range directly
  into the active request for listening or transcription. Return and Main tracks
  can be inspected and used for bounded device-chain and mixer-parameter edits.
- **Keep conversations organized.** Use separate Sessions for different parts
  of your Set, revisit their history, or collapse the Sessions panel for more space.
- **Choose models in the composer.** Save several models in one connection
  Profile, then switch models and supported reasoning levels below the message box.
  The context meter shows reported usage when available.
- **Guide the musical approach.** Enable arrangement Skills per Session or
  mention one for a single request. Open a built-in Skill to read its instructions
  before enabling it.
- **Bring reference material.** Paste or drag images, documents, or audio into
  the composer. You can also attach a selected Live audio source. Input support
  depends on the model and connection.
- **Keep work moving.** Queue a follow-up for the next turn, steer the response
  already in progress, or stop it.
- **Search when needed.** Compatible Direct API connections can enable hosted
  Web Search, with search activity and citations visible in the conversation.

Try requests such as:

> “Create a four-bar bass MIDI idea on this track.”
>
> “Help the chorus stand out using the parts already in this Set.”
>
> “Inspect this device and explain what its current settings are doing.”

## Getting started

1. Install and run the extension using the [development guide](docs/DEVELOPMENT.md).
2. In Live, right-click a supported object and choose **Ask Live Smith**.
3. Open **Settings**, create a named Profile, and choose a connection.
4. Use **Load Models**, choose a default model, and **Save & Use** the Profile.
   Direct API connections also allow entering a model ID manually.
5. Ask for help. Review proposed edits according to the Session’s approval mode.

A Profile groups one connection and its model settings. Once it is saved, the
composer lets you change the active Session’s model without returning to Settings.

See [model settings](docs/MODEL_PROVIDERS.md#named-profiles) for catalog loading,
generation options, and capability indicators.

## Model connections

### Direct API

Connect an OpenAI, Anthropic, or compatible API service using its endpoint and API
key. Supported request formats are OpenAI Responses, OpenAI Chat Completions,
and Anthropic Messages. API usage is billed by the provider.

Google Gemini works through its official OpenAI Chat Completions compatibility
endpoint. See the [Gemini setup](docs/MODEL_PROVIDERS.md#google-gemini) for the
connection fields and capability settings.

Hosted Web Search is available through supported OpenAI Responses and Anthropic
Messages connections. It is off by default and configured per model.

### ChatGPT subscription — experimental

Sign in through an isolated official Codex CLI connection to use an eligible
ChatGPT account’s Codex allowance. It requires a supported Codex CLI installation
and does not use or change your normal Codex login.

This connection does not fall back to API-key billing. Hosted Web Search and
workspace-managed accounts are not supported by this experimental integration.
Claude subscription login is not supported; use an Anthropic API connection instead.

See [model connections](docs/MODEL_PROVIDERS.md) for setup requirements and
provider-specific limitations.

## You control the changes

Each Session has separate **Approval** and **Edit Scope** controls in the
composer, initially labelled **Manual** and **All scopes**. Changes save
immediately. The **?** hints inside Scope explain the less obvious category
boundaries.

| Edit Scope | Allowed changes |
| --- | --- |
| MIDI | MIDI Clips, notes, and Clip properties. |
| Audio | Audio Clips, Warp, and Clip properties. |
| Devices | Instruments, effects, Racks, Drum Pads, and Simpler samples. |
| Mixer | Mixer parameters, mute, solo, and arm. |
| Structure | Tracks, Scenes, Cue Points, Take Lanes, and tempo. |

Scopes can be combined. The **All** checkbox selects or clears every category;
clearing all makes the Session **Read only** while keeping inspection available.
New and historical Sessions without a saved scope selection use All. The scope controls
edits, not which Live information the assistant can read. Instruments and effects
share Devices because the current SDK cannot reliably classify every device.

Plans outside the selected scope are rejected before any action runs. Container
operations also need permissions for their contents: deleting or duplicating a
track requires structure and mixer permissions, plus the scopes of its Clips and
devices. Approval cannot grant a missing scope.

Within the selected scope, the approval mode controls confirmation:

- **Manual** asks before every proposed edit plan.
- **Low Risk** applies lower-risk plans automatically and asks before protected
  actions such as deletes, Clip writes, and sample replacements.
- **Accept Everything** automatically approves all authorized, validated plans,
  including deletes and replacement writes within the selected scope.

All modes still inspect the relevant Live state, validate actions, and check that
the Set has not changed before applying an edit. One approved plan may create
more than one Live Undo step.

Scope changes are saved per Session and synchronized across open dialogs. You
can change them during a request; queued plans and subsequent actions recheck
the saved permissions. An action already in progress may finish, and completed
changes are not rolled back when permissions are narrowed.

Live Smith does not run arbitrary model-generated code. It does not inspect or
edit Automation, browse installed presets, or load a VST by plug-in identifier.
Existing devices can be inspected and edited where Live exposes their parameters.
Return and Main tracks intentionally exclude Clip, Take Lane, Arm, mute/solo,
rename, duplicate, and delete-track actions.

## Sessions, Skills, and attachments

**Sessions** keep conversation and action history with their Live context.
Opening the dialog or choosing New Session does not save an untouched empty
conversation. Messages, Session settings, and attachments are saved when used;
the Sessions list keeps empty entries that were active in the current window and
hides unvisited empty entries across tracks and History. Closing the window clears
that temporary visibility. Conversations and unsent drafts remain visible; hiding
empty entries does not delete existing data.
Previous Sessions can be restored explicitly; matching names alone do not make
an old conversation the same Live object.

**Skills** provide musical workflow guidance. Three built-ins cover section
energy, musical variation, and instrument roles. They start disabled; **View**
opens the full instructions without enabling them. You can import a local
[SKILL.md](docs/MODEL_PROVIDERS.md#skill-instructions), enable up to four Skills
per Session, or use `$skill-id` for one request.
Skills do not grant additional permissions or tools.

**Attachments** support PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3.
Office documents are read as text. Image, native PDF, and audio use depends on
the selected model and connection; attaching a file does not guarantee it can be
sent to every model. Use paste or drag-and-drop rather than a system file picker.
For compatible audio models, the agent can instead call `read_arrangement_audio`
to read an isolated Arrangement Audio Clip range without creating a saved
attachment. This sends a temporary pre-effects render for the current request;
Session View Clips and the track device chain are not included.

Queue and Steer are configured under **Settings → Conversation Behavior**.
Queued follow-ups belong to the open window; Live Smith warns before closing
with pending work.

## Privacy

Profiles, Sessions, attachments, and imported Skills are stored locally.
Prompts, relevant Live context, selected Skill guidance, supported attachment
content, and any Arrangement audio range read by the agent are sent to the model
provider you choose.

Direct API keys are stored in local Profile settings as plain text. The
subscription connection keeps its login in a separate local Codex home. Do not
commit, share, or cloud-sync either storage location.

## Documentation

- [Development guide](docs/DEVELOPMENT.md): prerequisites, local setup, validation,
  packaging, and development data.
- [Model connections](docs/MODEL_PROVIDERS.md): connection requirements, model
  settings, capability evidence, and protocol limits.
- [Architecture](docs/ARCHITECTURE.md): module responsibilities, data flow, and
  safety boundaries.
- [Contributor guide](AGENTS.md): working conventions and required checks.
- [Third-party notices](THIRD_PARTY_NOTICES.md).
