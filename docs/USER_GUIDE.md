# Live Smith User Guide

This guide covers the interface and production workflows in the current source.
For features included in a published build, see its
[release notes](https://github.com/SamKuler/live-smith/releases). Start with
the [project overview](../README.md) or follow the
[installation guide](../README.md#getting-started) to install the release package.
Model and audio-service setup lives in the [connection reference](MODEL_PROVIDERS.md).

- [Workspace](#workspace) and [Sessions](#sessions-and-creative-brief)
- [Tools](#running-tools) and [Plugins](#plugins-and-mcp-connections)
- [Saved artifacts](#artifacts-and-versions), [MIDI import](#importing-saved-midi) and [device settings](#device-parameter-snapshots)
- [Approvals](#editing-and-approvals), [attachments](#attachments) and [interface preferences](#interface-preferences)

## Workspace

Live Smith helps you understand, arrange, and edit a Live Set through conversation.
Select a track, Clip, device, or another supported Live object and choose
**Ask Live Smith**. Your conversation starts with that musical context.

The **Context** row above the message input shows the Live object or selection
that opened the Session. Select it to see the detailed Context view, including
Arrangement positions in beats when available. This context stays with the
Session as you select other objects in Live. If its object becomes unavailable,
the row shows that status. The Session's **Scope** control sets the categories
of edits the assistant may make throughout the Set.

Describe what you want to do in the message box and continue the conversation
as the work develops. You can inspect Context while keeping your message draft.
The message box grows as you type, then scrolls within a fixed maximum height
to leave room for conversation history.

The Inspector separates **Session** views (**Context**, **Artifacts**, **Skills**, **Tools**)
from global **Settings** (**Agent**, **Extensions**, **App**). Context contains the
creative brief, bound Live object, context usage and the next message's
attachments. **Skills** lets you choose workflow instructions for the Session.
**Artifacts** provides a compact saved-work summary. Select a work to open its full detail page.

## Sessions and creative brief

### Finding a Session

**Search sessions** finds displayed Session names and saved user/assistant messages
across current, historical and archived Sessions. Untitled Sessions use their
saved Live context label. Message matches show an excerpt. Search ignores
letter case and matches literal text. Clear the search or press Escape to
restore the full list. If a saved history cannot be read, the list reports it.
Within Current, History and Archived, results are ordered by the latest saved
message or Session settings change. The **Updated** date shows that activity
time.

### Saved context and drafts

**Sessions** keep conversation and action history with their Live context.
If the original Live object is deleted, the Session can still receive messages
and compact its conversation. Its context is marked unavailable. Choose an
available Live object explicitly when asking for an operation that needs a
target.

A Session is saved when you send a message, change its settings or add an
attachment. Opening a new, untouched conversation keeps it temporary. With
search cleared, Current and History keep empty Sessions you opened in the
current window visible until you close it. Other empty entries in those groups
are hidden, with saved data preserved. Archived entries and Sessions with
conversations or unsent drafts stay visible.
The Live modal's **Close** button asks before discarding unsaved drafts, including
messages and creative briefs from other Sessions used in that window.
Previous Sessions can be restored explicitly; matching names alone do not make
an old conversation the same Live object.

### Creative brief

**Creative brief** keeps the current Session's style, references, section structure,
track roles, and material to preserve in one editable document. Open
**Session → Context**, or use the **Brief** shortcut above the message input,
edit the brief and choose **Save brief**. It can hold up to 8,000 characters and
stays available after model changes and context compaction.

The model can suggest a brief. **Edit suggestion** puts it into a local draft;
**Save brief** accepts it. Unsaved drafts remain separate for each Session in
that window. If another window changes the saved brief, review the current
text before keeping or replacing your draft. Use the brief for creative intent;
the assistant reads current tempo and other Live state directly from Live.

### Reusing messages

Hover over a message, or focus its controls with the keyboard, to copy its
original text. **Use as draft** copies a user message into the composer. Edit it
and choose **Send** to start a new request. The earlier message stays in history,
and existing Live edits stay applied. Failed requests that are paused also offer
**Edit and resend** to replace the pending request with your edited version. Replacing an existing
draft asks for confirmation. Add any files you want to send with the new request.
Text drafts stay editable during generation and attachment upload.

### Chat commands

Press Enter to submit the composer. Shift+Enter inserts a line break, and the
Cmd/Ctrl+Enter shortcut also submits it. Place a command at the start of the
message to use one of these actions:

- `/compact [instructions]` summarizes the current Session into a checkpoint;
  optional instructions describe what to preserve. It requires an idle Session
  with new conversation activity since the last checkpoint. **Stop** requests
  cancellation, though a checkpoint already being saved may still finish.
- `/steer <message>` guides an active response immediately; while idle, it starts
  an ordinary request.
- `/queue <message>` schedules a turn after the active response; while idle, it
  starts an ordinary request.
- `/clear` switches to a fresh Session. The previous Session and any work still
  running there remain available in History.

## Running tools

**Session → Tools** lists the available tools. The list loads when the dialog
opens and refreshes when the Session or tool sources change. You can also
choose **Reload tools** to refresh it or retry a failed load. Loading waits
for current work to finish, while the composer stays editable. It reads tool
descriptions from enabled, approved MCP sources; running a tool is a separate
action. Available tools can change with the next request's inputs and connection
settings.

Expand an MCP tool to edit its supported parameters and select **Run tool**.
Parameter forms remain editable during generation; **Run tool**
becomes available when the current operation finishes.
Native controls use the tool's defaults, choices, and value limits. The tool
runs directly, and its result appears in the panel and Session history without
a model request. Use the composer's **Stop** control to cancel a running tool.
Parameter drafts last within the current dialog and Session; switching Sessions
or changing connections resets them.
Tools that provide an MCP App also offer **Open interface**. The Plugin supplies
the layout and interaction; its interface runs in an isolated frame and uses the
same approved MCP server. Closing the interface cancels pending operations.

Chat keeps consecutive tool activity in an expandable group. Open a card to read
its result or input parameters; long details scroll inside the card.

## Artifacts and versions

**Artifacts** collects this Session's saved MIDI, downloaded service audio,
Plugin WAV/MP3 results and device parameter snapshots. Other supported
file formats remain chat attachments. Each entry represents a piece of work and
holds its versions. The Artifacts shortcut opens the Session summary in the
Inspector. It shows the first catalogue page, its displayed/total count, and any
available last operation with that operation's own version. Select a row to open
the exact displayed version in the standalone detail page. **Open all** opens the
complete library with its search and type filters cleared. The Session list keeps
its existing collapse control, and the Inspector remains available over the
current main page. Narrow artifact pages initially collapse Sessions; its header
control opens the Session list over the page. Escape or the backdrop closes the
list. Returning to chat restores the chat's previous Session-list layout.
**Browse works** opens the work list at narrow widths. Parameter tables and
expanded source details follow the detail page's vertical scroll.
Switching works stops the previous audio preview. Select a version to inspect,
export or continue working on. Each version shows its source, which can be an older
version in the same group. Choose **Default** to set the version selected
when you next open the entry. Choose the pressed **Default** button again to restore the latest available
version as the default. Export, attachment and revision actions always use the
version you have selected.

**Search artifacts** searches names, version labels and localized sources across
this Session's complete saved catalog. Results are grouped and paginated after
matching; opening a match selects its matching version. Clear the search to
return to the full catalog. Type filters combine with search across the complete catalog before pagination. Searching does not call a model or audio provider.

Alternative results from the built-in generators are grouped together when
they have compatible output types. Revisions keep their source information
when you resume a job or download it later. Stems are listed as separate
components of their source audio. MIDI and audio have separate version groups,
including when one was generated from the other.

**Attach** and **Export** are available for both MIDI and audio.
They use the selected version's saved file. Attaching the same file again
reuses its pending attachment; distinct versions and outputs stay separate.
Model input support and attachment limits still apply when sending.
**Generation parameters** appears
when the original tool call is available. Refreshing the list retains the
selected version and audio playback; **Back to chat** pauses artifact audio and
returns to the composer with its draft and attachments. Continuing in chat,
preparing an audio import and attaching a saved file also return to chat.
A manual parameter or MIDI approval opens the corresponding timeline review.
Saved audio offers a decoded waveform, seek, volume and
loop controls. Waveform failures offer retry while keeping playback available.
**Operation history** shows persisted parameter applications and associated import
outcomes. Version links only change the preview. Interrupted operations remain
unknown; partial results retain their status. Older imports without a saved source
association have no version history entry. Historical receipts describe past
operations; parameter comparisons read current Live values separately.

**Continue creating** selects the version
as the source for your next chat request and adds a message draft. Describe the
changes you want, then send it through the usual model and tool permissions.
The source selection clears when that message is saved; Steer and manual tool
calls leave it available for the next request. Results from the request retain
their link to that source. Clearing the selection preserves the saved files.
Use **Add to Live** for MIDI import; ask in chat to prepare an audio import.
Both use the Session's Edit Scope and approval settings.

### Comparing and previewing MIDI

**Version comparison** compares the selected version with its source by default.
You can choose another version in the same work as the baseline. It reads both
complete MIDI files and shows a change summary and an overlaid piano roll for
the selected part. Summaries cover transposition, pitch, timing, length and
velocity. The chart places both versions on the same beat and pitch scales.
Renamed parts can still match through a unique MIDI channel; ambiguous parts
or notes may appear as additions and removals. The comparison covers note data;
tempo, meter and controller events remain in the saved files.

MIDI preview and comparison share a scrollable piano roll. Zoom, move
horizontally, focus the first notes or changes, or choose **Full view**. Long
files initially show a 16-beat window near the first relevant note. **Preview
part** selects one MIDI track/channel part to display. The saved file and export
keep every part; **Add to Live** carries the part choice into the import dialog.

Newly saved model and Plugin MIDI results also appear in chat. Expand the tool
result for a note preview, part selection and the **Export MIDI**, **Add to Live**
and **Open artifact** actions. Each card refers to its saved version. Older
text-only results remain available through Artifacts. Saving a MIDI file uses
local artifact storage; importing it into Live is a separate edit.

### Importing saved MIDI

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

### MIDI export and revisions

Ask the current model to save a MIDI artifact to generate a standalone file.
MIDI revisions are grouped as **v1, v2, …**. Creating a revision preserves every
previous file, including when starting from an older version. **Attach to message**
adds the selected version to the next message as a MIDI attachment. **Export MIDI**
downloads that exact version as a standard `.mid` file with its original tracks,
channels and events. Import the file into Live, Cubase or another compatible DAW,
or drag it from the file manager into your DAW. Use **Export MIDI** to save the
file first. MIDI contains note and event data; choose instruments and effects
in the destination DAW to play it.

### 原生文件拖出

在 macOS 14 或更高版本中，按[界面偏好设置](#interface-preferences)选择
**原生窗口（macOS）**，然后重新打开 Live Smith。按住产物卡片上的
**拖出 MIDI（Drag MIDI）** 或 **拖出音频（Drag audio）**，拖到 Live 中的对应轨道
或 Finder 文件夹。聊天窗口可以保持打开。产物库、聊天中的 MIDI 预览、Plugin 文件结果和
已下载的音频均可使用卡片上的拖出控件。远程音频需先下载到 Session。

MIDI 保留原文件的轨道、通道和事件，音频保留原始 WAV 或 MP3 格式。开始拖出后，
本机副本会继续保留，供 DAW 在聊天关闭或 Session 删除后引用。
宿主意外退出时，导出目录里可能留下仅为拖出准备的副本。清理目录前，先用 DAW
的收集并保存功能保存工程引用的文件。
**Export** 仍可通过默认浏览器下载文件。需要让 Live Smith 按 Session 编辑范围和审批流程
执行导入时，可使用 **Add to Live**。

### Device parameter snapshots

**Save device parameter snapshot** captures all exposed parameters of one selected
device, including devices inside Racks. Captured snapshots and AI-proposed versions
have distinct source labels. Ask the model to capture a device or select a saved
snapshot as the next-chat source to propose a new version. Saving and comparing
versions do not change Live. The parameter table shows complete saved values and
ranges, with filtering and a **Compare with** choice for current Live values or
another version in the same work.

When finished sounds are ready for audition, the agent can offer a **Sound
comparison** card for one device. It chooses which saved versions to present
according to the conversation. Capturing and saving parameters keep the versions
in Artifacts; the comparison card appears through an explicit presentation.
Its choices include **Original** and the selected sound candidates.
Long choice names stay on one line; their full names are available in the
tooltip and **Sound details**. Select a candidate to hear it, or
select **Original** to return to the values from before auditioning. The selected
choice stays highlighted across browser reconnection. **Sound details** shows
saved parameters against current Live values, device selection, snapshots and application
records. Artifacts also offers **Audition**. Play a Clip or your instrument
in Live to hear each version. Clicking a candidate or **Original** confirms that
selection and applies it directly, including in Manual mode. Each audition keeps
the Session's Scope, device binding and state checks. The changed parameters are
submitted together after preparation, followed by result verification. Choose another candidate for the same
device to switch directly between
versions. Each switch checks the complete device state and preserves the values
from before the first audition.
Applying or restoring through Artifacts follows the Session's approval mode.
When approval is required, the proposed changes and Apply/Cancel controls appear
in the current chat, using the same review flow as agent edits.

The first audition saves a **Before audition** parameter artifact.
**Open original snapshot** opens its complete values. Every candidate remains
saved in Artifacts. The comparison card switches directly between the candidates
and Original. In Artifacts, **Keep** finishes a confirmed audition with
the current values; **Restore** remains available afterward.
Restoration preserves the earlier decision in history and rechecks the device's
current values before writing. Unconfirmed or externally changed results offer
**Finish audition** with their inspection details.
**Default** continues to control the version selected by default in the
artifact library. A later audition captures a new starting snapshot.

The application history keeps original values, confirmed results and unfinished
changes across browser reconnection. Restore checks the target and all current
values again. Conflicting edits, changed parameter layouts and unconfirmed writes
require inspection before continuing. An unfinished switch retains confirmed
changes from earlier candidates for recovery. Finish the current audition before
choosing another device.
Live Smith also checks whether changing one parameter affected others on the
device. Application can stop partway through and can create several Live Undo
steps.

After the Extension Host restarts or you switch Live Sets, choose a compatible
destination to apply a saved snapshot. Restoring a previous application requires
the original device in the same running Live Set and Extension Host.

Snapshots store raw parameter values exposed by Live. Their scope covers
parameters; automation, sample files and private plug-in preset state require
other capture methods. Display labels are shown as supplied by Live, while
comparisons and edits use raw numeric values. A snapshot can hold up to 4,096
parameters and 4 MiB. Capture succeeds with the complete snapshot or reports
that a limit was exceeded.

### MIDI continuation

**Session → Tools → MIDI continuation** builds an ordered buffer of up to four
future sections from selected MIDI Clips. Choose the current Session model or an
approved local Plugin/MCP tool that declares MIDI conditioning, then save the
source selection, section length and capacity. **Fill buffer** generates only the
vacant slots; each section uses the original context and its preceding section.
The current model uses the Session's saved creative brief. **Import next section** offers the
usual part-to-track import preview. Only a successful import advances the buffer;
cancelling the preview leaves it intact. **Fill buffer** continues from the last saved
section, and **Stop** retains completed artifacts.

Live Smith checks source notes, Clip markers, loops and Live tempo again before
generation and import. If the sources or generator settings change, save a new
setup. You control when to audition and import each section.

Source capture uses the Clip's stored notes, cropped to its markers and expanded
across its loops. Instrument audio and playback variations from note probability
or velocity randomization stay in Live. The context supports up to 16 source
Clips and 4,096 expanded notes. Each future section starts its own version group;
revising a saved artifact leaves the queued section intact. Local Plugin tools
receive source parts as separate MIDI tracks at 960 ticks per beat, within
32-track and 4,096-note limits. Their output is checked for compatible timing
and overlapping notes of the same pitch before it enters the buffer.

## Audio services

Configure named audio accounts under **Settings → Extensions → Audio services**.
Enable a connection to make its supported tools available in chat. To run a tool
directly, open **Session → Tools**, expand the tool and choose **Open controls**.
Its form exposes the connection's supported inputs and uses its saved account
and model settings. **Run tool** calls the audio service directly; **Stop**
cancels the current operation.

| Service | Setup and supported workflows |
| --- | --- |
| ElevenLabs | [Music and sound effects](MODEL_PROVIDERS.md#music-and-sound-effects) |
| Google Lyria | [Gemini API music generation](MODEL_PROVIDERS.md#google-lyria-through-the-gemini-api) |
| Mureka | [Official API](MODEL_PROVIDERS.md#mureka-official-api) |
| Suno Platform | [Official API](MODEL_PROVIDERS.md#suno-platform-official-api) |
| SunoAPI.org | [Third-party service](MODEL_PROVIDERS.md#suno-through-a-third-party-api) |
| Suno.com | [Experimental website account connection](MODEL_PROVIDERS.md#sunocom-website-sign-in) |
| LALAL.AI | [Stem separation](MODEL_PROVIDERS.md#stem-separation) |

Audio services start disabled and use their own account allowances. Generation
sends the requested description to the selected service; separation uploads the
chosen audio. Saved results belong to the active Session and can be previewed,
reused or imported into Live. See [saved results and recovery](MODEL_PROVIDERS.md#saved-results-and-recovery)
for downloads, interrupted jobs and provider-specific limits.

## Editing and approvals

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
Sessions with no saved scope selection use All. Scope controls writes;
inspection can read other Live objects. Instruments and effects both use Devices.

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

All modes inspect the relevant Live objects, validate actions and recheck the
Set before editing. One approved plan may create several Live Undo steps.
In a Sound comparison card, clicking a candidate or Original supplies the
confirmation for that selection directly.

With **Manual** approval, the review shows an ordered action list above
**Apply** and **Cancel**. Expand any action to see its complete parameters and
target reference.
Device-parameter summaries show the operation, target and parameter count;
individual names and values stay in the expanded region. Automatically approved
operations use the same list in their history. Long details scroll inside the
card. Reopening a saved plan shows its saved parameters; older records may
contain only a summary.

Live edits appear in expandable tool cards, grouped when they occur
consecutively. Session history keeps each proposal and its execution result.
Status shows whether an operation was applied, cancelled, failed or partially
applied. An approved proposal shows its execution outcome separately.

For a single supported MIDI Clip creation, note edit, device parameter set, or device/mixer parameter edit,
expand the card to view the observed **Before** and **Proposed after**.
MIDI previews use Clip-relative beats and the same pitch/time scales on both
sides. They retain the complete validated note set and draw notes in the visible
time range. Parameter previews show raw numeric values and observed ranges.
The full action list remains
visible. MIDI creation previews cover empty Arrangement or Session destinations
and exact reusable MIDI Clips. Plans involving several actions, other new
objects, overlapping Arrangement Clips, or unavailable before/after data use the
action list. Previews show proposed data changes; listen in Live after applying
them to hear the result. The selected approval mode applies to every plan.

Scope changes are saved per Session and synchronized across open dialogs. You
can change them during a request; queued plans and subsequent actions recheck
the saved permissions. An action already in progress may finish, and completed
changes are not rolled back when permissions are narrowed.

The assistant uses a fixed set of validated Live actions. Current device
inspection and editing cover the parameters Live exposes. Automation, installed
preset browsing and loading a VST by plug-in identifier are outside the action
set. Return and Main tracks have a smaller action set: Clip and Take Lane edits,
arm, mute/solo, rename, duplicate and delete-track actions are limited to
ordinary tracks.

## Skills

**Skills** provide musical workflow guidance. Three built-ins cover section
energy, musical variation, and instrument roles. They start disabled; **View**
opens the full instructions without enabling them. Import and manage standalone
[SKILL.md](ARCHITECTURE.md#definitions-and-presentation) files in
**Settings → Extensions → Skills**. The library groups built-in, user, and
Plugin-provided Skills by source, including disabled Plugin packages. Enable up to four Skills in
**Session → Skills**, or use `$skill-id` for one request.
Skills do not grant additional permissions or tools.

**Settings → Agent → Custom Instructions** stores standing creative, workflow
and tool preferences across Sessions. Use the current request for task-specific
directions.

## Plugins and MCP connections

### 对外 MCP 服务

在 **Settings → Extensions → MCP → External tool access** 中启用本机服务，
选择端口并保存。默认地址为 `http://127.0.0.1:17853/mcp`。
运行状态会显示监听是否成功；端口占用时可修改端口后重新保存。

选择 **Add external client**，填写名称并选择一个已有 Session，或新建外部工具
Session。新 Session 使用全部编辑范围和 Manual 审批。选择 **Create access
credential** 后复制配置到支持 Streamable HTTP 和 Bearer Header 的 MCP 客户端。
访问凭据仅在创建或轮换后显示一次。**Rotate credential** 立即替换旧凭据；
**Revoke access** 撤销访问并停止该客户端尚未结束的操作。

每个客户端授权绑定一个 Session。聊天界面切换 Session 时，该绑定保持稳定。
外部客户端可以先调用 `livesmith_get_context`，读取 Session、编辑范围、审批策略
和附件入口。工具目录包含当前启用的 Live、Artifact、音频服务、Plugin 和外部
MCP 工具，调用这些工具可独立于内部模型 Profile 进行。音频服务和 Plugin 继续
使用其原有连接授权与额度。

Plugin 启停、连接或授权变化时，服务会发送工具目录变更通知。客户端可据此重新
读取目录；使用固定工具快照的客户端需要重新连接后发现新工具。普通执行进度和
历史更新沿用当前目录。工具调用始终按最新的启用状态与授权校验。

Live 修改通过 `apply_live_actions` 提交完整方案。Manual、Low Risk 和 Accept
Everything 使用现有规则；所有模式均执行 Scope 校验、预检查和执行前状态复查。
需要确认时，系统浏览器打开对应 Session，用户通过现有 Apply 预览决定。
关闭浏览器后，审批仍保留在 Session 中，可再次打开处理。

需要审批或较长时间的调用会返回操作 ID。使用 `livesmith_get_operation` 查询结果，
省略 ID 可查看最近 20 项；使用 `livesmith_cancel_operation` 停止后续工作。
客户端断连后，已接受的操作继续保留。重新连接时先查询记录，再决定后续调用。
宿主重启后的未完成记录显示为 Interrupted；音频任务可使用原有恢复工具继续查询。
Live 的已完成步骤和部分失败记录保留在历史中。结果尚未确认的 Live 修改需要先
通过 `inspect_live_set` 重新观察，再通过 `resolve_live_recovery` 和界面确认恢复决定，
之后可继续提交修改。

资源通过 `livesmith://sessions/<sessionId>/artifacts/<kind>/<id>` 访问。
较大的资源返回同一服务上的下载地址，下载请求使用相同 Bearer 凭据。
新文件通过 `livesmith_get_context` 返回的上传入口提交；音频附件可使用
`{"kind":"session_audio_attachment","attachmentId":"..."}` 作为工具来源。
上传和读取沿用 Session 文件格式、大小和完整性校验。
外部上传记录在对应操作中；聊天消息使用用户明确选择的附件。

外部客户端凭据绑定 Session 的工具与资源访问，服务仅监听本机回环地址。
工程身份沿用 Extension 与 SDK 的生命周期；切换工程前停止外部操作，切换后
重新启动 Extension 并建立当前工程的客户端授权。具体流程见
[界面与浏览器设置](#interface-preferences)。Profile 登录、连接设置和审批策略
通过 Live Smith 界面管理。

### Installing Plugins

**Plugins** are installed packages that can contribute namespaced Skills and MCP
tools. Manage packages in **Settings → Extensions → Plugins**; each package links
to its capabilities in **MCP** and **Skills**. A Plugin starts disabled.
Local MCP servers require explicit approval and run with your operating-system
user's permissions.
Remote MCP servers also require approval. A Plugin tool cannot edit Live directly:
declared MIDI/audio inputs are staged as temporary read-only files, and declared
MIDI or WAV/MP3 outputs are validated and saved to the Session. Import remains a
separate scoped and approved Live action. To delete a Plugin, disable it and
remove its connections. Saved Session artifacts remain available after deletion.

Plugins can declare persistent **Plugin parameters** on their package card.
Choose **Save** to use the values in subsequent requests. Sensitive fields
remain write-only.
Parameters survive restarts and package updates, and selected Skills and MCP
configuration can reference them through `${user_config.KEY}`. Discovered MCP
Apps can also be opened from the Plugin card. See the [configuration and UI
author guide](DEVELOPMENT.md#persistent-plugin-configuration) for supported
formats, scope, and a runnable offline example.

### Configuring connections

**Connections** save named accounts or servers. **Settings → Extensions → Audio
services** manages audio accounts; **MCP** manages directly configured servers and
servers provided by Plugins, including their permissions. One source can have
multiple named connections. Skill-only Plugins work through their instructions.
Package MCP servers without
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
individual arguments. Local commands run directly without a shell. Supported
remote endpoints use HTTPS or loopback HTTP through Streamable HTTP.

### MCP sign-in and credentials

Remote MCP connections offer **Manual headers** or **OAuth** authentication.
Plugins can supply OAuth defaults and a server URL. New connections inherit
these defaults, and saved authentication choices take precedence.
New Plugin connections receive a unique default name. For an enabled, approved
OAuth server, **Connect and sign in** saves the connection and opens the system
browser. A cancelled or failed login keeps the connection for **Sign in** to
retry. Packaged client defaults remain editable under **Advanced sign-in
settings**. Other OAuth connections use **Save**, then **Sign in**. Sign-in uses
browser PKCE and the server's discovery metadata. Servers
with dynamic client registration choose a local callback port automatically;
a later sign-in reuses that registration and port. If a server requires an
existing public client, enter its client ID and registered callback port. Its
redirect URI must be `http://127.0.0.1:PORT/mcp/oauth/callback`. This setup supports
public clients through dynamic registration or a supplied client ID.
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

Credentials are saved privately and passed to the server through its configured
environment variables, HTTP headers or OAuth connection. Plugin connections
bind to the exact installed package and
server; direct connections bind to their exact launch configuration or URL.
Changing that target requires entering credentials again. Direct local MCP
connections have separate audio/MIDI-input and audio/MIDI-output grants. Disabling or
removing a connection closes its active MCP clients and preserves saved Session
artifacts.

## Attachments

### Adding and reusing files

Drop **attachments** anywhere in the chat surface or paste them into the
composer, including while a response is running. **Follow-ups → Steer** submits
the message and its files to the current task at its next safe boundary;
**Queue** keeps them together for a new request after the current response.
Later files stay with the next composer draft. Images appear as thumbnails that
open a larger preview when clicked; audio includes playback and seek controls.
Select another file's name to open it with the system's default application.
External applications receive a temporary copy, so their edits do not replace
the saved chat attachment. Text and code copies open as `.txt` files.
The original remains saved in the Session. **Use again** on a history attachment
adds a saved copy to the next request. Removing that copy preserves the source.
Attachment changes affect the next draft; files already submitted through Send,
Steer or Queue stay with their request.

### Audio excerpts

**Select excerpt** opens an audio waveform with start/end times and loop playback.
Choose **Use whole file** or **Use selected excerpt**; the **Next request** list
shows the exact files and excerpt ranges being sent. WAV selection copies whole
samples without changing encoding, sample rate or channels. MP3 selection requires
**Export selection as WAV and attach**, which explicitly produces 16-bit PCM WAV
at the original sample rate and channel count. MP3 preview/export depends on the
browser decoder, has a 30-second decoding deadline and a 128 MiB decoded-sample
budget. Files above that decoding budget can still be played and sent intact;
export a shorter WAV in an audio editor to create an excerpt.

**Use original file** restores the original to the next request. Removing an
unsent excerpt restores the previous draft file. Excerpts and reused files
share the same attachment limits as newly added files.

### Supported formats and limits

Supported categories include:

| Category | Formats and handling |
| --- | --- |
| Text and code | UTF-8 and UTF-16 text with any filename extension, including Markdown, CSV/TSV, JSON, YAML, XML, HTML, configuration files, logs, subtitles, and source code. Files are read as text. |
| Documents and tables | PDF; DOCX, XLSX, PPTX; RTF; ODT, ODS, and ODP. Non-PDF documents are extracted as text. |
| MIDI | Standard MIDI Files (`.mid` and `.midi`), with format 0, 1, or 2 and PPQN timing. Context retains tracks, channels, note timing and velocity, tempo, meter, program changes, and control events. |
| Images | PNG, JPEG, and WebP are retained directly. Additional browser-decodable images, including GIF, BMP, SVG, AVIF, TIFF, and HEIC/HEIF, are converted to a static PNG. |
| Audio | WAV and MP3 retain their original bytes, sample rate, bit depth, and channels. Other audio formats require an explicit WAV/MP3 export before attaching; Live Smith does not automatically transcode audio. |

Image conversion depends on the codecs available in the Live modal or system
browser. A conversion failure names the file and leaves other files in the batch
available to add. Converted images use the new PNG filename and bytes; the source
file is not changed. Animated images contribute one static frame. MIDI uses at
most 8 MiB; its context is symbolic music data and does not require an audio
model. SMPTE-timed MIDI, RMID, and MIDI 2 UMP are not supported.
Image, PDF and audio analysis depends on the selected model and connection.
**Load Models** reads the provider's capability information. An input is marked
Supported when both the provider and connection support Live Smith's file
formats; incomplete evidence stays Unverified. See
[model capabilities](MODEL_PROVIDERS.md#capability-resolution) for details.
Video capability may appear in provider metadata; the attachment formats above
cover the inputs Live Smith accepts.

Each Session can hold four pending files and 256 MiB total, with these category
limits:

| Category | Limits |
| --- | --- |
| Images | 5 MiB per image and 16 MiB total. Source images being converted can be up to 20 MiB. |
| Documents, text and MIDI | 20 MiB total; each MIDI file can be up to 8 MiB. |
| Audio | Two files, up to 128 MiB and 15 minutes each. |

Model requests have a separate 128 MiB binary-file budget across the current
message and included history. Provider limits can be lower. If a request is
too large, choose a shorter excerpt or fewer files; attached audio retains
its saved quality and length. Extracted text has a separate context limit and
shows a truncation notice when reached.

Office and OpenDocument extraction uses bundled libraries and runs locally,
with a 30-second parsing deadline and a memory limit. Spreadsheets retain sheet
names, coordinates, stored values and formulas; missing cached formula results
are marked unavailable.
Explicitly hidden Word runs, PPTX slides/shapes, ODP pages, and XLSX sheets/rows/columns
are omitted, along with explicitly hidden ODS sheets and collapsed or filtered rows and columns.
ODS sheet and ODP page visibility includes referenced and inherited styles.
The extracted text covers document content and spreadsheet data; visual layout,
embedded images and chart geometry require a suitable image or PDF attachment.
Convert legacy DOC/XLS/PPT and XLSB files to a supported format before attaching
them. Older Session references to these formats remain in history and are
marked unsupported for model input. Export WebM/MP4 audio as WAV or MP3 first.

### Using audio with Live

To attach an Audio Clip, Sample or Simpler's original file, export or locate
that file and drop it into chat. The SDK provides these objects' metadata,
while original source bytes must be supplied separately.

A compatible audio attachment can also supply an Arrangement, Session or Take
Lane Audio Clip, a Simpler sample or a Drum Rack pad. Include the file with
the request that will use it. When an approved plan first uses the file, Live
Smith copies it into the Live Project and uses that managed copy.

If the model supports audio input, you can ask it to listen to an isolated
Arrangement Audio Clip range. The `read_arrangement_audio` tool sends a temporary
render from before the track's effects. This covers Arrangement Audio Clips;
Session View Clips and instrument/effect-chain output require an exported audio
attachment. The temporary render is used for analysis. Attach a saved file when
you want to import audio into another destination.

You can also ask the model to listen to an exact saved Session audio result.
The file must be downloaded locally and supported by the selected model;
remote-only Suno players remain available for playback in Live Smith.

Deleting a Session removes its private chat attachments, but it does not remove
audio already imported into the Live Project. If import succeeds and post-import
validation or a later Live action stops the plan, an unused project copy may
remain because the beta SDK does not expose deletion or rollback for imported
files.

## Interface preferences

**Settings → App → Chat shortcuts** controls the entries above the message input.
Context, Brief and Artifacts appear together by default; Skills and Tools can be enabled
individually. Brief opens the creative brief section in Context; Artifacts opens
its compact Session summary. Its visibility setting controls both the shortcut
and Session tab. Context, Skills and Tools keep their Inspector navigation when
shortcuts are hidden. Saved content, enabled Skills and tool permissions remain
available. Saved artifact links in chat open their exact versions. The preference
is shared across windows.

Choose **Settings → App → Interface language** to use **English**, **简体中文**, or follow the
system language. The preference is shared across Live Smith windows. Switching
languages keeps drafts and ongoing work; user messages, model replies, object
names, and raw provider/SDK output stay in their original language.

在 **设置 → 应用 → 对话与显示 → 界面打开方式** 中选择 **Live 模态窗口**（默认）、
**系统浏览器** 或 **原生窗口（macOS）**。英文界面对应 **Settings → App →
Conversation & Display → Open Live Smith in**，原生选项为 **Native window (macOS)**。
设置在下次打开 Live Smith 时生效。原生窗口在 macOS 14 或更高版本上提供非模态聊天，
可同时操作 Live。
原生窗口不可用或启动失败时，Live Smith 会打开 Live 模态对话框，应用偏好仍可访问。
加载期间主动关闭原生窗口会取消这次打开。

The browser lets you keep working in Live. Closing its tab preserves admitted
tasks and pending approvals while the Extension is running.
Use **Ask Live Smith** on the same object or selection to reopen its Session, or
use **Stop** to cancel its current task. Asking about a different selection replaces
an idle browser runtime; finish or Stop its work first when it is busy.

每个页面独立选择当前 Session。同一 Session 的消息、审批、编辑范围和任务状态
在各页共享；一页切换 Session 时，其他页保留各自选择。刷新或复制页面会创建
独立视图，并恢复地址中仍有效的 Session 选择；短暂断线继续使用当前页面的视图。
关闭页面后，视图在全部在途任务结束后保留五分钟，再释放其临时资源；
重新打开的新页面从调用时的 Session 开始。草稿和待发送队列属于页面，关页后清除。

切换 Live Set 前，先 Stop 所有任务并处理待审批操作；切换后重新启动 Live Smith
Extension。当前 Ableton SDK 可能在切换 `.als` 时沿用工程句柄，自动工程身份检查
存在覆盖缺口。重新启动后使用新运行环境重新绑定 Session 与外部客户端。

After a connection interruption, Live Smith refreshes the current state before
accepting new work. Temporary failures retry automatically; if recovery still
fails, use **Retry connection** beside the status message. Recovery preserves
unsent drafts and does not resend prompts or commands.

Queue and Steer are configured under
**Settings → App → Conversation & Display**.
The same section can show or hide the compact context-window indicator in the
composer.
待发送消息归当前页面所有。Live 模态窗口和 macOS 原生窗口在存在待处理工作或
未保存草稿时会询问是否关闭。系统浏览器使用标签页的关闭控件。

## Model and network settings

Profiles are configured under **Settings → Agent**. The
[connection reference](MODEL_PROVIDERS.md) covers Direct API and subscription
setup, model settings and input support. Global proxy modes are configured under
**Settings → App → Network Proxy**; see [network routing](MODEL_PROVIDERS.md#network-routing)
for supported configurations.

The composer selects the current Session's model and supported reasoning level.
Context-window overrides and automatic compaction settings belong to each saved
model configuration; see [named Profiles](MODEL_PROVIDERS.md#named-profiles).

## Privacy and local data

See [Privacy](../README.md#privacy) for what stays local and what is sent to
providers or tools. The [development data guide](DEVELOPMENT.md#development-data)
describes the private local storage used by source installations.
