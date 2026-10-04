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

The compact **Context** row inside the composer shows the bound object or
opening selection. Select it to open the detailed Context view. Positions use
Arrangement beats when available; the strip does not follow later Live selections
or restrict edits to the displayed object. An unavailable object is labelled
explicitly. Use the Session's **Scope** control to choose allowed edit categories.

Describe what you want to do in the message box and continue the same conversation
as the work develops. The context strip and detailed Context view remain available
without changing the draft or choosing a task mode.
The message box starts at one line, grows with its content, and scrolls within a
bounded height for long drafts so conversation history remains visible.

The Inspector separates **Session** views (**Context**, **Artifacts**, **Skills**, **Tools**)
from global **Settings** (**Agent**, **Extensions**, **App**). Context contains the
creative brief, bound Live object, context usage, and the next message's attachments. Skills selects
workflow instructions for the current Session. Tools automatically loads its
directory when the dialog opens and refreshes it when the Session or tool sources
change. Discovery waits for foreground work to finish and leaves the composer
usable. **Reload tools** refreshes descriptions; a failed load can be retried.
Only enabled, approved MCP sources are contacted, and no tool is executed.
The directory is a snapshot; the next request's inputs and connection settings
can change which tools are available.
Expand an MCP tool to edit its supported parameters and select **Run tool**.
Cached tool parameter forms remain editable during generation; **Run tool**
becomes available when the current operation finishes.
Native controls use the tool's defaults, choices, and value limits. The tool
runs directly, and its result appears in the panel and Session history without
a model request. Use the composer's **Stop** control to cancel a running tool.
Parameter drafts last within the current dialog and Session; switching Sessions
or changing connections resets them.
Tools that provide an MCP App also offer **Open interface**. The Plugin supplies
the layout and interaction; its interface runs in an isolated frame and uses the
same approved MCP server. Closing the interface cancels pending operations.
Completed tool results offer **Use in chat**, which adds a reference to the
composer. Saved MIDI offers **Add to Live**, opening a separate import dialog
that reads the file's source parts and current Live tracks automatically. Select
the parts to import, use new MIDI tracks or map them to existing destinations,
and choose a common Arrangement start beat. A single part can use the Session's
bound MIDI track; a bound Arrangement range supplies the suggested start.
**Merge all parts into one Clip** combines the complete file explicitly. The
preview shows new tracks and resulting Clip boundaries before the ordinary
Session approval flow. New tracks require the corresponding Edit Scope.
Tempo, meter and controller events remain in the saved file; import writes notes
only and leaves the Set's tempo and meter unchanged. An interrupted import
preserves recovery information and must be inspected before retrying.

**Session → Artifacts** collects this Session's saved MIDI, downloaded service audio and Plugin WAV/MP3 results. Other supported
file formats remain chat attachments. Each MIDI or audio work has one entry containing its
versions. Open the entry and choose a version to inspect, export, attach or add
to Live. The version's source is shown explicitly; the source can be an older
version in the same group. **Make primary** saves the work's default version;
reopening its entry selects that version, while an explicitly selected version
remains the target of export, attachment and further work. Clearing the primary
returns the default to the latest available version.

For MIDI, **Version comparison** defaults to the source version and allows any other
version in the same work as the comparison baseline. It reads both complete MIDI files and
shows a short change summary and an overlaid piano roll for the selected part.
Uniform transposition is identified across complete parts; other summaries cover
pitch, timing, length and velocity changes. The chart marks the two versions on
one beat/pitch scale. Newly saved model and Plugin MIDI results also appear in
chat inside the existing tool result. Expand it for a compact note preview,
part selection, Export MIDI, Add to Live, and
Open artifact actions. Each card refers to its exact saved version. Saving MIDI
does not edit Live or require Live edit approval. Older text-only results remain
available through Artifacts. Both MIDI preview and comparison use the same scrollable
piano roll: zoom in or out, move horizontally, focus the first notes/changes, or
choose **Full view**. Long files initially show a 16-beat window near the
first relevant note. The compared files retain their actual timing and length. Renamed parts can retain their correspondence through a unique MIDI channel;
ambiguous parts or notes may remain additions and removals. Tempo,
meter and controller events are not compared.

Built-in generation alternatives share a work when their output kinds are
compatible. Revisions retain their explicit source across resume and later
download. Stem files remain separate components with source provenance; they are
not numbered as alternative versions of a complete song. MIDI and audio files
have separate version groups even when one was produced from the other.

**Preview part** isolates one MIDI track/channel part. Opening an artifact loads
its complete notes within the saved-file limit; catalog entries retain a small overview. It does not alter the
saved file or export; **Add to Live** carries the part choice into the import dialog.

**Attach to message** and **Export** are available for both MIDI and audio.
They reuse the exact saved file without calling a model or audio provider.
Repeated attachment of the same pending file reuses its existing reference;
distinct MIDI versions and audio outputs remain separate. Model input support
and attachment budgets still apply when sending. A missing historical tool call
leaves its generation parameters unavailable. Refreshing the list retains the
selected version and audio playback; **Back to chat** pauses artifact audio and
returns to the composer.

**Continue in chat** (or **Create next version** for MIDI) selects a source for the next chat request and adds a draft
to the composer. Add the desired changes and send it through the usual model and
tool permissions. The source is consumed when that initial user message is saved;
Steer and manual tool calls do not consume it. The resulting tool calls retain
their parent artifact even if a later request uses another source. Clearing the
next-request source leaves the original files intact. MIDI artifacts use the
same mapped import preview; audio import is prepared in chat and uses the existing
scoped audio action and approval preview. The artifact library does not audition
Live instruments or roll back applied changes.

Ask the current model to save a MIDI artifact to generate a file without changing
Live; no external MIDI generator is required. MIDI revisions are grouped as
**v1, v2, …**. Creating a revision preserves every
previous file, including when starting from an older version. **Attach to message**
adds the selected version to the next message as a MIDI attachment. **Export MIDI**
downloads that exact version as a standard `.mid` file with its original tracks,
channels and events. Import the file into Live, Cubase or another compatible DAW,
or drag it from the file manager. Direct file dragging out of the extension panel
is not supported. Export does not include instruments, effects or rendered audio.

**Session → Tools → MIDI continuation** builds an ordered buffer of up to four
future sections from selected MIDI Clips. Choose the current Session model or an
approved local Plugin/MCP tool that declares MIDI conditioning, then save the
source selection, section length and capacity. **Fill buffer** generates only the
vacant slots; each section uses the original context and its preceding section.
The current model uses the Session's saved creative brief. **Import next section** offers the
usual part-to-track import preview. Only a successful import advances the buffer;
cancelling the preview leaves it intact. **Fill buffer** continues from the last saved
section, and **Stop** retains completed artifacts.

Source notes, Clip markers/loops and Live tempo are checked again before generation
and import. Changed sources or generator configuration require a new setup. The
buffer has no playback clock or automatic Clip launch: auditioning and advancing
sections are explicit actions. Source capture exports nominal MIDI notes with
marker cropping and bounded loop expansion; instrument sound, probability and
velocity randomization are not rendered. The context is limited to 16 source Clips
and 4096 expanded notes. Each future section starts its own version group; revising
one of its saved artifacts does not replace a queued section. Local tool conditioning retains original and previous
parts as separate SMF tracks within the existing 32-track/4096-note file limits.
Plugin output must fit the 960-PPQ conditioning format. Same-pitch overlaps and
notes that collapse to zero ticks are rejected before entering the buffer.

**Settings → App → Chat shortcuts** controls the entries above the message input.
Context, Brief and Artifacts appear together by default; Skills and Tools can be enabled
individually. Brief opens the creative brief section in Context; other shortcuts open
their Inspector panels. Hiding shortcuts preserves
all Inspector tabs, saved content, enabled Skills and tool permissions. The preference
is shared across windows.

Choose **Settings → App → Interface language** to use **English**, **简体中文**, or follow the
system language. The preference is shared across Live Smith windows. Switching
languages keeps drafts and ongoing work; user messages, model replies, object
names, and raw provider/SDK output stay in their original language.

> [!NOTE]
> Live Smith is beta software. See the [development guide](docs/DEVELOPMENT.md#prerequisites)
> for supported Live versions and installation from source.

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
  The context meter shows the active model context when reported. Each model can
  override its context-window size and auto-compaction threshold; a blank
  threshold defaults to 90% when the context window is known.
- **Guide the musical approach.** Enable arrangement Skills per Session or
  mention one for a single request. Open a built-in Skill to read its instructions
  before enabling it in **Session → Skills**. **Settings → Agent → Custom Instructions** stores
  standing creative, workflow, and tool preferences across Sessions; the current
  request can choose a different workflow at any time.
- **Install extension packages.** **Settings → Extensions → Plugins** accepts portable
  Agent Plugin ZIPs and compatible Codex or Claude Code packages. Installation
  runs nothing: enable the Plugin, review each MCP server, and grant artifact
  input or output separately. Platform-only commands, hooks, agents, and apps are
  reported as unsupported rather than executed.
- **Connect MCP tools directly.** **Settings → Extensions → MCP** accepts
  a Streamable HTTP endpoint or a local stdio command without a Plugin package.
  Review the endpoint or process before enabling it; loading the Tools directory
  discovers its tools without invoking them.
- **Bring reference material.** Paste or drag images, documents, or audio into
  the composer. Input support depends on the model and connection.
- **Keep work moving.** Queue a follow-up for the next turn, steer the response
  already in progress, or stop it. Long runs of tool and Apply activity collapse
  into one expandable timeline item so the conversation stays readable. When a
  provider returns a visible reasoning stage or summary, Live Smith shows it in
  a separate Thinking item. Visible content is expandable; a stage with no text
  shows Thinking while in progress and disappears when complete. See
  [visible reasoning output](docs/MODEL_PROVIDERS.md#visible-reasoning-output)
  for connection-specific summary behavior.
- **Search when needed.** Compatible Direct API connections can enable hosted
  Web Search, with search activity and citations visible in the conversation.
- **Generate music and sound effects.** Add an ElevenLabs connection under
  **Settings → Extensions → Audio services**, then describe the music or sound you want.
  Multiple named audio connections, including separate accounts at the same
  provider, can be enabled together.
- **Run audio tools from a parameter panel.** Open **Session → Tools**, choose
  a named audio connection, expand a tool and select **Open controls**. The form
  offers that connection's supported inputs, including custom lyrics, sliders,
  sound parameters and source selection. **Run tool** invokes the audio service
  directly without a chat-model request. Results and tool history belong to the
  active Session; generation can consume the connection's allowance. Form drafts
  last while that Session, account and connection configuration remain active. Saved
  connection settings continue to supply credentials and the default model.
- **Generate songs or instrumentals with Mureka.** Add a **Mureka** connection
  with an API key from [Mureka API Platform](https://platform.mureka.ai/), then
  use prompt-based music generation. Live Smith polls the accepted task, saves
  the returned track locally, and can resume a missing download without
  submitting the generation again.
- **Generate music with Google Lyria.** Add a **Google Lyria (Gemini API)**
  connection with a [Gemini API key](https://aistudio.google.com/apikey).
  Choose `lyria-3.5` for full songs,
  `lyria-3-clip-preview` for fixed 30-second previews, or the experimental
  `lyria-realtime-exp` transport for bounded instrumental generation. Realtime
  PCM is saved as an ordinary WAV result, so preview, model listening, and Live
  import use the same Session audio workflow as other generators.
- **Generate through the official Suno Platform API.** Add a separate
  **Suno Platform (official API)** connection and use an API key managed at
  [platform.suno.com](https://platform.suno.com/). Platform access and usage
  are separate from the consumer website subscription.
- **Use an optional third-party Suno service.** The explicitly labeled
  SunoAPI.org connection uses that provider's own key, billing, and callback.
  It is neither Suno Platform nor Suno subscription access.
- **Connect a Suno.com account.** Open Suno in your system's default browser,
  then explicitly import its Suno request Cookie in the local connection form.
  Both `__client` and current `__session` + `__client_uat` sessions are
  supported. Live Smith verifies, privately saves, and refreshes only the required fields without a browser extension or
  access to your Google credentials. Enable the saved experimental connection
  to generate music using your subscription credits, supply lyrics/styles and
  supported sliders, select male or female vocals, request a supported 10–480
  second duration, browse songs/models, extend songs and get whole songs. The
  same connection offers Sounds with loop/BPM/key controls, Cover, Remaster,
  audio upload, Add Vocals, Add Instrumental, section replacement, native stem
  extraction and lyric writing. Source
  permissions and model capabilities are checked before submission. Replacement
  candidates are finalized through a separate explicit operation.
  Load account versions in the connection editor and choose a fixed version or
  follow the account default. The active Session's generated and processed audio
  appears above the chat composer, separately from connection settings. Completed
  songs generated through Live Smith can be auditioned through Suno's embedded
  player without downloading them. The embedded player is for human listening and
  is never model input. **Download to Live Smith** saves the selected song in its
  Session, after a separate confirmation that may consume one download allowance;
  **Export MP3/WAV** saves another copy through the default browser without requesting
  the audio service. Live Smith never buys extra
  quota. A verified audio-input model can then listen to that saved Session asset
  when asked. On macOS 14 or later, a generation challenge opens Live Smith's
  own verification window. Complete any challenge yourself; a successful result
  continues the original request once. Cancel or close the window to stop before
  submission. Initial sign-in still happens in your normal browser. Other hosts
  can generate only when Suno does not require a challenge.
  This is not full Suno website parity; see the supported features and limits in the
  [website sign-in workflow](docs/MODEL_PROVIDERS.md#sunocom-website-sign-in). The
  connection uses an unofficial website protocol and remains subject to
  [Suno's current terms](https://suno.com/terms).
- **Separate audio into stems.** Add a LALAL.AI connection, then ask to extract vocals, drums, bass, piano, or guitars from
  an audio attachment or an isolated Arrangement Audio Clip range. Saved results
  can be previewed, reused in later requests, and imported through ordinary Live
  edits. A verified audio-input model can also listen to a chosen saved stem when
  asked. Separation itself needs tool support but does not require model audio input.

Try requests such as:

> “Create a four-bar bass MIDI idea on this track.”
>
> “Help the chorus stand out using the parts already in this Set.”
>
> “Inspect this device and explain what its current settings are doing.”
>
> “Separate this Clip into vocals and drums, then place the results on new audio tracks.”
>
> “Use my ElevenLabs connection to generate ten seconds of instrumental ambient piano.”
>
> “Use my Mureka connection to generate an instrumental synthwave idea.”
>
> “Use my Google Lyria connection to generate a 30-second instrumental preview.”

Audio processing is disabled by default. Each connection has its own saved key
and uses that provider's allowance, separately from chat-model usage. Generation
sends the requested description to the selected service; separation uploads the
chosen audio and consumes LALAL.AI processing minutes for each requested stem,
also returning the residual mix. Saved results can be previewed and imported
through ordinary scoped Live edits. See [external audio tools](docs/MODEL_PROVIDERS.md#external-audio-tools)
for supported inputs, limits, and recovery.

Composer commands are recognized only at the start of a message:

Press Enter to submit the composer. Shift+Enter inserts a line break, and the
existing Cmd/Ctrl+Enter shortcut remains available.

- `/compact [instructions]` compacts the current Session now and can name what
  the checkpoint should preserve. The Session must have no active request and
  new conversation activity since its latest checkpoint. While manual
  compaction is running, the composer’s Stop control requests cancellation;
  once checkpoint persistence has begun, a successfully saved checkpoint takes
  priority.
- `/steer <message>` guides an active response immediately; while idle, it starts
  an ordinary request.
- `/queue <message>` schedules a turn after the active response; while idle, it
  starts an ordinary request.
- `/clear` switches to a fresh Session. The previous Session and any work still
  running there remain available in History.

## Getting started

1. Install and run the extension using the [development guide](docs/DEVELOPMENT.md).
2. In Live, right-click a supported object and choose **Ask Live Smith**.
3. Open **Settings → Agent**, create a named Profile, and choose a connection.
4. Use **Load Models**, choose a default model, and **Save & Use** the Profile.
   Direct API connections also allow entering a model ID manually.
5. Ask for help. Review proposed edits according to the Session’s approval mode.

A Profile groups one connection and its model settings. Once it is saved, the
composer lets you change the active Session’s model without returning to Inspector.

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

**Settings → App → Network Proxy** provides three global modes: **No proxy**,
**System proxy**, and **Manual proxy**. The selected route applies consistently to
Direct API requests, subscription sign-in, token refresh, model catalog and
model traffic, and external audio-service HTTP or WebSocket traffic. Loopback
endpoints remain direct so local model servers keep working.

System proxy discovery follows static macOS HTTP, HTTPS, or SOCKS settings and
the current Windows user's static Internet Settings. It uses a fixed, read-only
Windows registry query; it does not run a shell or modify the registry.
Automatic PAC/WPAD configuration is not evaluated. An automatic setting found
in this static key is rejected; connection-specific or machine-scoped settings
are not read and provide no static route. PAC/WPAD URLs cannot be entered in
Manual mode; enter the concrete proxy URL instead. Windows System mode supports
static HTTP and HTTPS destination entries through ordinary HTTP proxies; use
Manual mode for an HTTPS proxy transport or SOCKS5.
Manual proxy accepts an `http://`, `https://`, `socks://`, or `socks5://` URL
without embedded credentials. Existing installs remain on No proxy until this
setting is changed.

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
clearing all or choosing **Read only** inside Scope makes the Session read-only
while keeping inspection available. To allow edits again, select the categories
you want to permit.
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

Live edits use the existing expandable tool activity and retain their proposal
and execution result in Session history. A single operation has one disclosure;
consecutive operations share a group. **Manual** shows Apply and Cancel; automatic approval
runs without those buttons. Applied, cancelled, failed, and partially applied
operations have distinct states. Approval alone never counts as a completed edit.

For a single supported MIDI Clip creation, note edit, or device/mixer parameter edit,
expand the card to view the observed **Before** and **Proposed after**.
MIDI previews use Clip-relative beats and the same pitch/time scales on both
sides. Large previews show at most 256 notes per side and state how many were
omitted. Parameter previews show raw SDK values and observed ranges; they do not
guess display units or map value labels to numbers. The full action list remains
visible. MIDI creation previews cover empty Arrangement or Session destinations
and exact reusable MIDI Clips. Plans involving several actions, other new
objects, overlapping Arrangement Clips, or unavailable before/after data use the
action list without a preview. A preview describes the proposal,
not a completed edit or an audio audition; the selected approval mode still applies.

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

**Creative brief** keeps the current Session's style, references, section structure,
track roles, and material to preserve in one editable document. Open
**Session → Context**, or use the **Brief** shortcut above the message input,
then choose **Save brief**. The limit is
8,000 characters. Saved briefs remain available after model changes and context
compaction. The model can offer a suggestion; **Edit suggestion** puts it into a
local draft and **Save brief** explicitly accepts it. Suggestions never save
preferences automatically. Unsaved drafts remain separate for each Session in
that window. If another window changes the saved brief, review its current text
before keeping or replacing your draft. The brief records creative intent;
current BPM, meter, and other Live facts are read from the Set.

Hover over a message, or focus its controls with the keyboard, to copy its
original text. **Use as draft** puts a user message back in the composer;
it does not change history or undo Live edits. Choose Send after editing.
Paused failed requests also offer **Edit and resend**. Editing
their restored draft replaces that pending request instead of sending its old
text again. Existing drafts require confirmation before replacement; historical
attachments are not reattached automatically. Text drafts remain editable during
generation and attachment upload.

**Skills** provide musical workflow guidance. Three built-ins cover section
energy, musical variation, and instrument roles. They start disabled; **View**
opens the full instructions without enabling them. Import and manage standalone
[SKILL.md](docs/MODEL_PROVIDERS.md#skill-instructions) files in
**Settings → Extensions → Skills**. The library groups built-in, user, and
Plugin-provided Skills by source, including disabled Plugin packages. Enable up to four Skills in
**Session → Skills**, or use `$skill-id` for one request.
Skills do not grant additional permissions or tools.

**Plugins** are installed packages that can contribute namespaced Skills and MCP
tools. Manage packages in **Settings → Extensions → Plugins**; each package links
to its capabilities in **MCP** and **Skills**. A Plugin starts disabled. Local MCP servers require explicit approval and
run as your operating-system user; Live Smith does not provide an OS sandbox.
Remote MCP servers also require approval. A Plugin tool cannot edit Live directly:
declared MIDI/audio inputs are staged as temporary read-only files, and declared
MIDI or WAV/MP3 outputs are validated and saved to the Session. Import remains a
separate scoped and approved Live action. Removing a Plugin does not remove already saved Session
artifacts. Remove a Plugin's connections and stop referencing its Skills before
deleting the Plugin.

Plugins can declare persistent **Plugin parameters** on their package card.
Save commits values for subsequent requests; sensitive fields remain write-only.
Parameters survive restarts and package updates, and selected Skills and MCP
configuration can reference them through `${user_config.KEY}`. Discovered MCP
Apps can also be opened from the Plugin card. See the [configuration and UI
author guide](docs/DEVELOPMENT.md#persistent-plugin-configuration) for supported
formats, scope, and a runnable offline example.

**Connections** save named accounts or servers. **Settings → Extensions → Audio
services** manages audio accounts; **MCP** manages directly configured servers and
servers provided by Plugins, including their permissions. One source can have multiple named
connections; a Skill-only Plugin needs none. Package MCP servers without
credential fields can run anonymously under their server approval. Adding a named
Connection for that package version and server selects its account configuration.
Select **Edit** to configure a connection. Its bottom action bar places **Remove**
on the left and **Discard** / **Save** on the right. Removal requires confirmation;
unchanged saved connections disable Discard and Save, and new connections have no
Remove action. Switching between Audio services and MCP preserves nonsecret drafts
and clears newly entered credentials.
In **Extensions → MCP**, **Add connection** opens the direct server configuration.
For a Plugin server, use **Add connection** beside that server. Direct connections
support Streamable HTTP with a URL, or a local process with a command and
individual arguments. Local commands run without a shell. Only HTTPS and
loopback HTTP endpoints are supported; legacy SSE is not supported.

Remote MCP connections offer **Manual headers** or **OAuth** authentication.
Plugin servers can declare `oauth: {}` for discovery-based registration, or
`oauth: { "clientId": "…", "callbackPort": 49321 }` for a registered public
client. New connections inherit these defaults and use the packaged MCP URL;
saved authentication choices take precedence. Unsupported OAuth fields are
reported as invalid server configuration.
New Plugin connections receive a unique default name. For an enabled, approved
OAuth server, **Connect and sign in** saves the connection and opens the system
browser. A cancelled or failed login keeps the connection for **Sign in** to
retry. Packaged client defaults remain editable under **Advanced sign-in
settings**. Other OAuth connections use **Save**, then **Sign in**. Live Smith uses browser PKCE and the server's discovery metadata. Servers
with dynamic client registration choose a local callback port automatically;
a later sign-in reuses that registration and port. If a server requires an
existing public client, enter its client ID and registered callback port. Its
redirect URI must be `http://127.0.0.1:PORT/mcp/oauth/callback`. Confidential
clients and hosted client-ID metadata registration are not configured here.
An occupied callback port reports an error; close its other listener or sign out
to discard a dynamic registration before trying again.

Saved OAuth accounts can refresh during MCP use; ordinary discovery never opens
a browser. **Sign out** cancels pending sign-in, removes local credentials, and
closes active clients. A manual Authorization header cannot be combined with
OAuth. Other configured resource headers remain available for workspace routing.
Changing the server, package, routing parameters, authentication configuration,
or enabled state requires a new sign-in. Unrelated creative Plugin parameters
preserve the account. OAuth tokens and registration secrets stay in private local
storage, scoped to the exact Connection, and never enter model or dialog state.

Credentials remain write-only environment variables or HTTP headers, never model
tool arguments. Plugin connections bind to the exact installed package and
server; direct connections bind to their exact launch configuration or URL.
Changing that target requires entering credentials again. Direct local MCP
connections have separate audio-input and MIDI-output grants. Disabling or
removing a connection closes its active MCP clients and preserves saved Session
artifacts.

**Attachments** can be dropped anywhere in the chat surface or pasted into the
composer, including while a response is running. **Follow-ups → Steer** submits
the message and its files to the current task at its next safe boundary;
**Queue** keeps them together for a new request after the current response.
Later files stay with the next composer draft. Images appear as thumbnails that
open a larger preview when clicked; audio includes playback and seek controls.
Select another file's name to open it with the system's default application.
External applications receive a temporary copy, so their edits do not replace
the saved chat attachment. Text and code copies open as `.txt` files.
**Select excerpt** opens an audio waveform with start/end times and loop audition.
Choose **Use whole file** or **Use selected excerpt**; the **Next request** list
shows the exact files and excerpt ranges being sent. WAV selection copies whole
samples without changing encoding, sample rate or channels. MP3 selection requires
**Export selection as WAV and attach**, which explicitly produces 16-bit PCM WAV
at the original sample rate and channel count. MP3 preview/export depends on the
browser decoder, has a 30-second decoding deadline and a 128 MiB decoded-sample
budget. Files above that decoding budget can still be played and sent intact;
export a shorter WAV in an audio editor to create an excerpt.

The original remains saved in the Session. **Use original file** restores it to
the next request; removing an unsent selection undoes that selection and restores
the previous draft file. **Use again** on a history attachment creates a fresh
reference to a saved copy without uploading the source again. Removing a history
copy leaves its saved source unchanged. Selection and reuse share pending quotas
and leave files already captured by Send, Steer or Queue unchanged.

Supported categories include:

| Category | Formats and handling |
| --- | --- |
| Text and code | UTF-8 and UTF-16 text with any filename extension, including Markdown, CSV/TSV, JSON, YAML, XML, HTML, configuration files, logs, subtitles, and source code. Content is read as inert text. |
| Documents and tables | PDF; DOCX, XLSX, PPTX; RTF; ODT, ODS, and ODP. Non-PDF documents are extracted as text. |
| MIDI | MID and MIDI Standard MIDI Files with format 0, 1, or 2 and PPQN timing. Context retains tracks, channels, note timing and velocity, tempo, meter, instruments, and control events. |
| Images | PNG, JPEG, and WebP are retained directly. Additional browser-decodable images, including GIF, BMP, SVG, AVIF, TIFF, and HEIC/HEIF, are converted to a static PNG. |
| Audio | WAV and MP3 retain their original bytes, sample rate, bit depth, and channels. Other audio formats require an explicit WAV/MP3 export before attaching; Live Smith does not automatically transcode audio. |

Browser conversion depends on the codecs available in the Ableton window. A
conversion failure names the file and leaves other files in the batch available
to add. Converted images use the new PNG filename and bytes; the source
file is not changed. Animated images contribute one static frame. MIDI uses at
most 8 MiB; its context is symbolic music data and does not require an audio
model. SMPTE-timed MIDI, RMID, and MIDI 2 UMP are not supported.
Image, native PDF, and audio use depends on
the selected model and connection; attaching a file does not guarantee it can be
sent to every model. Model loading consumes provider-returned input modalities
and MIME support for both Direct API and subscription Profiles. Raw provider
evidence remains visible, while a usable input is marked Supported only when the
provider covers Live Smith's concrete formats and the selected protocol can
encode them; missing or coarse-only evidence stays unverified. Provider-reported
video capability is shown, but Live Smith does not yet accept video attachments.
Use paste or drag-and-drop rather than a system file picker. Each Session may
hold up to four pending files and 256 MiB total. Images are limited to 5 MiB each;
their subtotal is 16 MiB. Documents are limited to 20 MiB total; audio to two
files, 128 MiB each, and 15 minutes each.
Image-conversion source files are limited to 20 MiB. Model requests have a separate
128 MiB inline binary budget, including history. Provider limits can be lower;
if a request is too large, select a shorter audio excerpt or fewer files. Original
audio is not automatically compressed or truncated. Locally extracted context
is bounded and labels truncation.
Modern Office and OpenDocument extraction uses bundled `officeparser` and
SheetJS libraries. No additional runtime or local service is required. Parsing
runs in workers with a 30-second deadline and a V8 heap limit. RTF retains a
bounded built-in text reader. Spreadsheets retain sheet names, coordinates,
stored values and formulas; missing formula caches are marked unavailable.
Explicitly hidden Word runs, PPTX slides/shapes, ODP pages, and XLSX sheets/rows/columns
are omitted, along with explicitly hidden ODS sheets and collapsed or filtered rows and columns.
ODS sheet and ODP page visibility includes referenced and inherited styles.
Office formatting, embedded images, and chart geometry are not
rendered by local text extraction. Legacy DOC/XLS/PPT, XLSB, and video frames
are not accepted as model context; historical legacy Office references remain
in saved Sessions and are marked unsupported during context assembly;
WebM/MP4 audio also requires an explicit WAV/MP3 export.
The Extensions SDK does not expose selected Audio Clip, Sample, or Simpler source
bytes to extensions, so export or locate the source file and drop it into the
chat when you need the original file as an attachment.
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
Saved Session audio results follow the same verified model-capability gate: the
agent can listen to one exact local asset when asked, while remote-only Suno
players and their URLs are never sent to the model.

Deleting a Session removes its private chat attachments, but it does not remove
audio already imported into the Live Project. If import succeeds and post-import
validation or a later Live action stops the plan, an unused project copy may
remain because the beta SDK does not expose deletion or rollback for imported
files.

Queue and Steer are configured under
**Settings → App → Conversation & Display**.
The same section can show or hide the compact context-window indicator in the
composer.
Queued follow-ups belong to the open window; Live Smith warns before closing
with pending work.

## Privacy

Profiles, Integration Connections, Sessions, attachments, imported Skills, and
installed Plugin packages and private Plugin data are stored locally.
Prompts, the active Session's saved creative brief, relevant Live context,
selected Skill guidance, supported attachment content, any Arrangement audio
range read by the agent, and any saved Session audio the user asks an
audio-capable model to hear are sent to the model provider
you choose.

Direct API keys are stored in local Profile settings as plain text. A separate
private local credential file stores OAuth credentials under exact Profile and
provider identities. Saving a connection keeps only the provider selected by
that Profile; Direct API and Profile deletion clear that Profile's OAuth
credentials. Do not commit, share, or cloud-sync either storage location.

An enabled MCP server receives the arguments declared by its tool. A
local server can access anything available to the current operating-system user,
subject to that program's own behavior; a remote server receives network traffic
at its declared endpoint. Review third-party code, launch commands, and permissions before
enabling a server. MCP tool results are treated as untrusted data and cannot grant
Live permissions or bypass confirmation.

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
