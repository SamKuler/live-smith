# Live Smith

**Work on your Ableton Live Set through conversation.**

Live Smith is an AI assistant inside Ableton Live. Start from a track, Clip or
device, ask for a change, and follow its plan and results in the conversation.
Conversations, saved MIDI, audio results and device snapshots stay together in
Sessions.

[Download](https://github.com/SamKuler/live-smith/releases/latest) · [Get started](#getting-started) · [User guide](docs/USER_GUIDE.md) · [Model connections](docs/MODEL_PROVIDERS.md)

> **Beta.** Requires Ableton Live 12 Suite Beta **12.4.15b5 or later** with
> Extensions support.

## What it does

- **Understand your Set.** Inspect tracks, Clips, notes, devices and mixer
  settings, and ask questions about the current musical context.
- **Create and reshape MIDI.** Write parts, transform existing notes, arrange
  Clips, and organize tracks and Scenes.
- **Explore device settings.** Capture parameter snapshots, compare variations,
  apply a saved version, and restore the previous values after listening.
- **Keep useful versions.** Save MIDI and audio results as artifacts, compare
  MIDI revisions, export files, or use a saved version as the source for more work.
- **Generate and process audio.** Connect optional music, sound-effect and stem
  separation services, then preview and import their saved results.
- **Extend your workflow.** Add musical instructions through Skills, connect
  MCP tools directly, or install Plugin packages with their own tools and controls.

For example:

> Create a four-bar bass MIDI idea on this track.

> Inspect this device and explain what its current settings are doing.

> Save these device settings, then propose a brighter variation.

## Getting started

1. Download the `.ablx` file from the
   [latest release](https://github.com/SamKuler/live-smith/releases/latest).
   Each release includes notes describing its features and requirements.
2. In Live, open **Settings → Extensions** and drag the `.ablx` file onto the
   Extensions page. Enable Live Smith and restart Live if prompted.
3. Right-click a track, Clip, device or another supported object and choose
   **Ask Live Smith**.
4. Open **Settings → Agent**, create a named Profile, and configure a model
   connection. Use **Load Models**, choose a default model, then **Save & Use**.
   Direct API connections also accept a model ID entered manually.
5. Send a request. Review its proposed changes using the Session's approval and
   Edit Scope controls.

Once a Profile is saved, switch models from the composer. Live Smith supports
English and 简体中文. Open it in a **Live dialog**, your **System browser**, or a
**Separate window (macOS)**. On macOS 14 or later, the separate window lets you
drag saved MIDI and audio from chat into Live.

The [user guide](docs/USER_GUIDE.md) covers the interface, saved work, attachments,
tools and day-to-day workflows.

To build or contribute from source, follow the
[development guide](docs/DEVELOPMENT.md#prerequisites) for Node.js, SDK and CLI setup.

## Model connections

Configure a model connection under **Settings → Agent**:

| Connection | Options |
| --- | --- |
| Direct API | OpenAI Responses, OpenAI Chat Completions and Anthropic Messages, including compatible endpoints. |
| Subscription account (experimental) | ChatGPT, Claude and Google Antigravity sign-in inside Live Smith. |

Each Profile owns its connection and model settings. Provider and account
capabilities determine which inputs, reasoning options and Web Search features
are available. See [model setup and compatibility](docs/MODEL_PROVIDERS.md).

Optional audio-service accounts and MCP servers live under **Settings → Extensions**.

Live Smith 也提供本机 MCP 服务。外部 AI 客户端可以使用完整工具目录，
通过绑定的 Session 观察和编辑 Live、调用音频服务及管理产物。
服务默认关闭；访问凭据绑定一个 Session，编辑范围与审批策略由该 Session 管理。
配置步骤见[对外 MCP 服务](docs/USER_GUIDE.md#对外-mcp-服务)。
Audio generation and processing use those services' own billing and allowances,
separately from chat-model usage. See [audio services](docs/USER_GUIDE.md#audio-services)
and [Plugins and MCP connections](docs/USER_GUIDE.md#plugins-and-mcp-connections).

## You control the changes

Each Session has an **Edit Scope** for MIDI, Audio, Devices, Mixer and Structure.
Choose the categories the assistant may change, or select **Read only** for
inspection. Its **Approval** setting controls when a proposed plan asks for
confirmation:

| Mode | Behavior |
| --- | --- |
| Manual | Asks before every edit plan. |
| Low Risk | Applies lower-risk plans automatically; asks before protected actions such as deletes, Clip writes and sample replacements. |
| Accept Everything | Automatically approves all validated plans within the selected scope, including deletes and replacement writes. |

Every mode observes the relevant Live objects, validates the plan, enforces
Edit Scope and rechecks Live state before editing.

Plans list operations in execution order, with complete parameters available for
each action. History retains the proposal and its outcome. **Stop** cancels
remaining work; completed edits stay applied. A plan can partially complete and
may create several Live Undo steps. See [editing and approvals](docs/USER_GUIDE.md#editing-and-approvals)
for previews, scope boundaries and recovery.

## Current limits

- Live editing follows the operations exposed by the Extensions SDK. Automation
  editing, installed-preset browsing and loading a VST by plug-in identifier
  remain outside the current action set.
- MIDI export contains the saved MIDI data. Instruments, effects and rendered
  sound are separate from the exported file.
- Device snapshots cover SDK-exposed parameter values. Automation, sample files
  and private plug-in preset state remain separate from these snapshots.
- Attachment support and audio analysis depend on the chosen model and connection.
  External audio services have their own supported inputs, account requirements
  and usage limits.

See the [user guide](docs/USER_GUIDE.md) and
[connection reference](docs/MODEL_PROVIDERS.md) for feature-specific limits.

## Privacy

Profiles, connections, Sessions, attachments, Skills and Plugin data are stored
locally. Model requests send your prompt, relevant Live context, saved creative
brief, selected Skill guidance and supported attachment content to the provider
you choose. Requested audio listening can also send an Arrangement render or a
saved Session audio asset.

Audio services and MCP servers receive the inputs used by their tools. Local
MCP processes run as your operating-system user; review their code, launch
commands and permissions before enabling them.

Direct API keys are stored as plain text in local Profile settings. OAuth
credentials use separate private local storage. Keep these storage locations
private and outside shared repositories or cloud sync. See
[local data](docs/DEVELOPMENT.md#development-data) and
[credential storage](docs/MODEL_PROVIDERS.md#credential-storage).

## Documentation

The guides describe the current source. See the
[release notes](https://github.com/SamKuler/live-smith/releases) for the features
included in each published build.

| Guide | Contents |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | Sessions, artifacts, MIDI import, device settings, tools, attachments and interface preferences. |
| [Development](docs/DEVELOPMENT.md) | Source setup, local execution, verification, packaging and Plugin authoring. |
| [Model connections](docs/MODEL_PROVIDERS.md) | Profiles, providers, audio services, capabilities and network settings. |
| [Architecture](docs/ARCHITECTURE.md) | Module responsibilities, data flow, persistence and safety boundaries. |
| [Contributing](AGENTS.md) | Working conventions and required checks. |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Bundled dependencies and their notices. |
