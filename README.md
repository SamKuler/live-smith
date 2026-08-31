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
  Existing Rack Chains, including empty Chains, expose their direct devices and
  Volume, Panning, and Sends; ordinary Racks can append new empty Chains.
- **Keep conversations organized.** Use separate Sessions for different parts
  of your Set, revisit their history, or collapse the Sessions panel for more space.
- **Choose models in the composer.** Save several models in one connection
  Profile, then switch models and supported reasoning levels below the message box.
  The context meter shows reported usage when available.
- **Guide the musical approach.** Enable arrangement Skills per Session or
  mention one for a single request. Open a built-in Skill to read its instructions
  before enabling it.
- **Bring reference material.** Paste or drag images, documents, or audio into
  the composer. Input support depends on the model and connection.
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
endpoint. See the [Gemini setup](docs/MODEL_PROVIDERS.md#google-gemini-direct-api) for the
connection fields and capability settings.

Hosted Web Search is available through supported OpenAI Responses and Anthropic
Messages connections. It is off by default and configured per model.

### Account subscription — experimental

Sign in inside Live Smith with ChatGPT, Claude, or Google Antigravity. Live
Smith owns the OAuth session and calls the provider product backend directly;
customers do not install Codex CLI, Claude Code, Gemini CLI, Antigravity, or
provide an API key.
Each subscription Profile has its own sign-in state, even when another Profile
uses the same provider. Creating a new Profile therefore starts signed out, and
signing out affects only that Profile.

After the provider returns a pending authorization, the Extension Host opens
the default system browser on macOS or Windows. ChatGPT displays its device
code in the dialog. Claude completes browser PKCE through a local callback.
Antigravity returns to Google's hosted callback page; copy
the authorization code shown there into Live Smith to finish sign-in. Live
Smith checks the account automatically after that submission. If Google
requires an additional account verification before
enabling Antigravity, the dialog shows the verified Google page and asks you to
sign in again after completing it.

ChatGPT uses the Codex backend API, Claude uses OAuth-authenticated Anthropic
Messages, and Google uses the Antigravity product backend. Anthropic currently
assigns third-party OAuth traffic to Claude Extra Usage when it is enabled.
Antigravity uses the account's default entitlement and region; Live Smith does
not import CLI-local license-tier or project-region overrides.
Hosted Web Search is not exposed through subscription Profiles. If an account
check is unavailable, use Sign out to clear its saved OAuth session before
signing in again.

See [model connections](docs/MODEL_PROVIDERS.md) for setup requirements and
provider-specific limitations.

## Network proxy

**Settings → Network** provides three global modes: **No proxy**, **System
proxy**, and **Manual proxy**. The selected route applies consistently to
Direct API requests and to subscription sign-in, token refresh, model catalog,
and model traffic. Loopback endpoints remain direct so local model servers keep
working.

System proxy discovery currently follows the active macOS HTTP, HTTPS, or SOCKS
settings. Automatic PAC/WPAD configuration is not evaluated; use Manual proxy
for that route instead. Manual proxy accepts an `http://`, `https://`,
`socks://`, or `socks5://` URL without embedded credentials. Existing installs
remain on No proxy until this setting is changed.

Proxy modes are strict: Live Smith does not silently fall back to a different
route. If the selected Manual or System proxy cannot be reached, provider
requests stop with an actionable proxy message so you can start the proxy,
correct the setting, or choose another mode.

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

Live Smith can write MIDI or audio Clips into an existing Take Lane after it
has inspected that lane. Take Lane Clip content uses the MIDI or Audio scope;
creating or renaming the lane itself uses Structure. A newly created lane must
be inspected before a later request writes into it, and Live Smith refuses to
create over an occupied range whose overlap behavior cannot be verified.

Rack Chain creation uses the Devices and Mixer scopes because each new Chain
owns both a device container and a Chain mixer. Existing Chain mixer parameter
edits use Mixer. Drum Rack pad creation remains the dedicated Drum Pad workflow,
which verifies the receiving note and reports partial completion. The current
SDK does not expose Chain names, deletion, duplication, or reordering.

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
sent to every model. Model loading consumes provider-returned input modalities
and MIME support for both Direct API and subscription Profiles. Raw provider
evidence remains visible, while a usable input is marked Supported only when the
provider covers Live Smith's concrete formats and the selected protocol can
encode them; missing or coarse-only evidence stays unverified. Provider-reported
video capability is shown, but Live Smith does not yet accept video attachments.
Use paste or drag-and-drop rather than a system file picker.
The Extensions SDK does not expose selected Audio Clip, Sample, or Simpler source
bytes to extensions, so export or locate the source file and drop it into the
composer when you need the original file as an attachment.
During that send, a compatible audio attachment can also be used as the source
for an Arrangement, Session, or Take Lane Audio Clip, a Simpler sample, or a
Drum Rack pad. When a confirmed plan first uses it, Live Smith copies the file
into the Live Project and uses Live's managed copy. The source locator expires
when the send ends.
For compatible audio models, the agent can instead call `read_arrangement_audio`
to read an isolated Arrangement Audio Clip range without creating a saved
attachment. This sends a temporary pre-effects render for the current request;
Session View Clips and the track device chain are not included. That temporary
render is model input only and is not an attachment SampleSource.

Deleting a Session removes its private chat attachments, but it does not remove
audio already imported into the Live Project. If import succeeds and post-import
validation or a later Live action stops the plan, an unused project copy may
remain because the beta SDK does not expose deletion or rollback for imported
files.

Queue and Steer are configured under **Settings → Conversation Behavior**.
The same section can show or hide the compact context-window indicator in the
composer.
Queued follow-ups belong to the open window; Live Smith warns before closing
with pending work.

## Privacy

Profiles, Sessions, attachments, and imported Skills are stored locally.
Prompts, relevant Live context, selected Skill guidance, supported attachment
content, and any Arrangement audio range read by the agent are sent to the model
provider you choose.

Direct API keys are stored in local Profile settings as plain text. A separate
private local credential file stores OAuth credentials under exact Profile and
provider identities. Saving a connection keeps only the provider selected by
that Profile; Direct API and Profile deletion clear that Profile's OAuth
credentials. Do not commit, share, or cloud-sync either storage location.

The selected proxy mode and credential-free Manual proxy URL are stored in the
same private local settings file. Proxy usernames and passwords are not accepted
in that URL.

## Documentation

- [Development guide](docs/DEVELOPMENT.md): prerequisites, local setup, validation,
  packaging, and development data.
- [Model connections](docs/MODEL_PROVIDERS.md): connection requirements, model
  settings, capability evidence, and protocol limits.
- [Architecture](docs/ARCHITECTURE.md): module responsibilities, data flow, and
  safety boundaries.
- [Contributor guide](AGENTS.md): working conventions and required checks.
- [Third-party notices](THIRD_PARTY_NOTICES.md).
