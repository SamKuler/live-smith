# Live Smith Development Guide

This guide covers installation from source, local execution, verification, and
packaging. For release-package installation, see
[Getting started](../README.md#getting-started). See the [README](../README.md)
for an overview and the [user guide](USER_GUIDE.md) for product workflows.
Contributors should also read [AGENTS.md](../AGENTS.md), the
[architecture](ARCHITECTURE.md), and the [model connection reference](MODEL_PROVIDERS.md).

## Prerequisites

- Node.js 24.16.0 or newer.
- Ableton Live 12 Suite Beta 12.4.15b5 or a later build with Extensions support.
- Ableton Extensions SDK `1.0.0-beta.1` and its Extensions CLI.
- `unzip` on `PATH` for package verification.

Download the SDK through [Ableton's official SDK page](https://ableton.github.io/extensions-sdk/)
and put these archives in `extensions-sdk-1/`:

- `ableton-extensions-sdk-1.0.0-beta.1.tgz`
- `ableton-extensions-cli-1.0.0-beta.1.tgz`

Their paths are declared in [package.json](../package.json). Do not commit or
redistribute the archives, SDK source, examples, documentation, or license copy.
The directory's [README](../extensions-sdk-1/README.md) is public setup guidance.

The CLI's archive dependencies use the `glob` and `minimatch` security overrides
in `package.json`. Their CommonJS APIs are exercised by the release packaging
test, including nested assets and exclusion patterns. Keep these overrides until
the CLI dependency chain accepts patched versions directly. Run `npm run package`
when changing the CLI or these overrides.

## Install and run

From the repository root:

```sh
npm ci
npm start -- --live "/Applications/Ableton Live Beta.app"
```

The document parser bundles pinned `officeparser` and SheetJS distributions.
SheetJS is installed from the public archive under `vendor/`; its source and
integrity are documented in [vendor/README.md](../vendor/README.md). No additional
document-conversion runtime is required by the installed extension.

Adjust the Live application path for your installation. `npm start` builds the
development bundle and starts the Extensions CLI. Enable the extension in the
CLI, then right-click a supported object in Live and choose **Ask Live Smith**.

The Extension Host loads `dist/extension.js` when it starts. To test a new build
in Live, close the Live Smith dialog, stop its Extensions CLI with Ctrl+C, and
start it again with the same storage directory. The Live Set can remain open,
and the existing development data carries over to the restarted host.

Configure a Profile under **Inspector → Agent** to use model features.
Subscription Profiles complete OAuth in the browser using the built-in clients.
Building and running tests do not require a model connection.

Instead of passing `--live`, copy [.env.example](../.env.example) to `.env` and
set `EXTENSION_HOST_PATH` to your Live application. This variable is for host
discovery only. Configure model endpoints, keys, and parameters through saved
Profiles in Live Smith Inspector.

For a production build without starting Live:

```sh
npm run build
```

Both build variants type-check the source, compile the Tailwind entries under
`src/ui/styles/` to static CSS, and verify Extension Host runtime compatibility
before writing the bundle to `dist/extension.js`. The compiled styles are
embedded into the generated dialog HTML; the WebView does not load Tailwind, a CDN,
or a separate stylesheet at runtime.

扩展包内嵌两个面向 macOS 14 及以上版本的 AppKit/WebKit 应用。聊天窗口使用
`src/runtime/native/chat-capsule.json` 中的 `Live Smith.app`，Suno 在请求人工验证时使用
`src/runtime/native/verifier-capsule.json` 中的验证程序。
`scripts/native-app-capsule.ts` 在开发和生产构建中校验程序内容及源文件、Info.plist
和构建脚本的指纹。输入变化后，macOS 构建使用单独安装的 Command Line Tools 生成
arm64/x86_64 通用二进制并执行 ad-hoc 签名。其他平台构建时使用已在 macOS 上生成的
对应版本。

私有存储中的 `live-smith-exports/` 保存原生拖出使用的媒体副本。Extension Host
意外退出时，可能残留未使用的准备副本和临时应用包。清理导出目录前，先使用 DAW 的
收集并保存功能保存工程引用的文件。副本的保留与清理规则见
[原生文件拖放](ARCHITECTURE.md#原生文件拖放)。

## Verification

### 原生窗口与文件拖放

自动化测试覆盖窗口启动、启动取消与回退、拖出消息协议、文件副本生命周期和聊天卡片交互。
在 macOS 的 Ableton Live 中，按[用户指南](USER_GUIDE.md#原生文件拖出)打开原生聊天，
分别将本地 MIDI 和音频从卡片拖到对应轨道，确认 Live 中出现可用的 Clip，并在关闭聊天后
检查工程仍可读取引用的音频。带未保存草稿关闭窗口时，检查取消确认后草稿仍可编辑。
实际投放由 AppKit 和 Live 处理，需在宿主中验证。

### MCP 服务验证

对外 MCP 使用官方 Server 与 Node Adapter，官方 Client 用于互操作验证；
依赖版本由 `package.json` 与锁文件管理。`tests/app/mcp/` 覆盖真实 HTTP 工具发现、调用、凭据撤销、审批后的状态变化、
共享写入队列及 Session 文件隔离。`tests/runtime/mcp-host.test.ts` 在受限 VM 中加载
bundle，再通过真实 MCP Client 完成鉴权请求和工具调用。

`tests/ui/inspector/chat-dialog.mcp-service.test.ts` 通过实际对话脚本的 DOM 事件
验证服务配置、客户端创建、凭据清理和外部 Apply。真实宿主验证使用独立 Live Set：
启用服务、创建客户端、读取上下文、观察目标，然后提交一次可撤销的小幅修改，
确认界面审批和实际 Live 结果。宿主停止后确认监听端口释放。

私有文件 `live-smith-mcp-server-clients.json` 保存 Session 绑定、客户端名称、凭据
代次与摘要。客户端原始凭据由创建命令的一次性结果交付。操作状态和作者信息
存放于已有 Session 事件目录，输出音频复用 Session 附件存储。

Test modules live under `tests/`, mirroring their source module directories.
Test-only helpers and harnesses live in each test module's `support/` directory;
attachment document fixtures live under `tests/attachments/fixtures/`.
Application coordinator and bridge tests use subject directories such as
`tests/app/agent-flow/`, `tests/app/agent-request/`, and
`tests/app/chat/chat-bridge/`. Audio protocol tests use provider directories
under `tests/audio-services/`. UI tests group composer, conversation, audio,
Inspector, Session, layout and internationalization behavior under `tests/ui/`.
Provider application suites use directories such as `tests/app/audio/suno/`;
their protocol suites remain under `tests/audio-services/suno/`.
TypeScript checking includes production source and the complete test tree.
`test:core` runs the core module suites and `test:ui` runs the real-dialog DOM
and UI module suites.

To add an interface language, register its canonical locale ID, native name, and
system-language aliases in `src/i18n/languages.ts`, then add its message catalog to
`uiCatalogs` in `src/ui/i18n/messages.ts`. Preserve named interpolation fields and
keep raw object names and model content out of translation keys. The language
picker, settings type, and client/server validation derive from the registry;
they do not need per-language changes. Catalog tests check translated coverage
and interpolation fields for every registered non-English locale.

Run the required checks before handing off changes:

```sh
npm run verify
```

The verification command runs core behavior, real-dialog DOM
interaction tests, direct plus CONNECT-proxy requests through an Extension
Host-equivalent restricted VM, both development and production builds, the
composed dialog-client syntax check, and `npm audit --json`. It uses fixtures
and does not require provider credentials or call a model provider. Focused
checks remain available as `npm run test:core`, `npm run test:ui`,
and `npm run verify:client`. `npm run verify:plugins`
checks every committed Plugin compatibility fixture for a valid contained
manifest, tracked package data, non-executable files, and credential-shaped
content.

Typed bridge validators and Connection state/editor code are compiled through
`scripts/build-client-script.ts` for both the production dialog and its DOM
harness. `tsc` checks their public DTO references and field names. The composer
injects host-owned constants into this browser bundle before registering the
legacy bridge factory and bootstrapping the UI. Translation coverage scans both
TypeScript modules and authored script fragments recursively.

External pull-request automation must not expose the private Ableton SDK
archives through repository secrets, shared caches, or a privileged workflow
that executes untrusted fork code. Until the full gate can run without giving
fork code access to those archives, maintainers run `npm run verify` against the
exact merge result before accepting a contribution.

DOM tests prove interaction and state behavior, not rendered geometry or live
provider behavior. In the target Live build, separately check dialog layout and
focus, host integration, OAuth browser/device login, refresh, cancellation,
shutdown, and provider requests. Use an authorized test account for provider
checks; ordinary tests must not read a developer's saved credentials.

界面帮助的 DOM 测试覆盖展开、关闭和语言刷新。缩小 Live 内对话框和 macOS 独立窗口，
检查问号提示能在窗口内完整显示或滚动，并验证独立窗口的菜单项随界面语言更新。

### UI styling conventions

The dialogs' shared visual tokens live in `src/ui/styles/tokens.css`; reusable
control and disclosure roles live under `src/ui/styles/components/`;
dialog-specific composition lives in `chat.css` and `result.css`. Tailwind
Preflight is omitted deliberately because the WebView already owns its base
element contract. Keep semantic classes used by the client scripts as stable
behavior hooks, and use the shared theme and component roles for presentation
instead of adding a provider-specific theme or a later override layer.

Use Tailwind theme tokens and `@apply` for reusable, standard presentation such
as spacing, dimensions, typography, colors, borders, visibility, overflow, and
ordinary interaction states. Keep native CSS when it expresses a browser or
layout contract more clearly: custom properties, exact grid or flex formulas,
container queries, keyframes and transforms, pseudo-element content, native or
WebKit appearance, SVG paint, data-URL assets, precise focus outlines, and
state-specific translucent values. Use shared tokens consistently across both
Tailwind utilities and native CSS.

The entries disable source scanning because client fragments contain runtime
strings and use semantic DOM hooks; compose shared rules with complete Tailwind
utilities through `@apply`. If direct template utilities are introduced later,
explicitly register only their source files and never construct utility names
through interpolation. Do not use generated utility classes as client-script
selectors.

For visual changes, compare the affected states in Chromium after transitions
and animations settle. Verification includes keyboard focus, hover, disabled,
open and hidden states, narrow container boundaries, Composer child focus versus
its outer focus boundary, floating panels, Agent and App settings, the
collapsed/open Session audio shelf, Inspector drawer focus, and long translated
labels. Browser-native controls can paint non-deterministically; verify their
geometry and surrounding layout when their appearance varies between runs. The
Suno version picker can be tested with a read-only catalog load; selecting,
saving or discarding a version must not generate audio or implicitly enable a
connection.

### Plugin compatibility and author testing

Plugin packages are ZIP archives with either `plugin.json`,
`.codex-plugin/plugin.json`, or `.claude-plugin/plugin.json` at their package
root. One enclosing distribution directory is accepted. A portable package uses
the Agent Plugins 1.0 schemas and discovers `skills/` plus `mcp.json` by their
fixed names. Codex and Claude compatibility manifests may point to a Skills
directory and MCP configuration; unsupported commands, agents, hooks, output
styles, apps, LSP servers, and marketplace metadata remain inert and appear in
the install review.

MCP transport support is bounded to local stdio and Streamable HTTP. Portable
stdio entries use an executable token, optional arguments, and an optional
working directory contained in `${PLUGIN_ROOT}` or `${PLUGIN_DATA}`. Live Smith
starts no process during inspection or installation. The user must enable the
Plugin and approve each MCP server; local commands then execute without a shell
with the current operating-system user's permissions. Do not put API keys,
tokens, authorization headers, or other credentials in a package or fixture.
For host-managed credentials, declare `${NAME}` or `${NAME:-default}` only in
stdio `env` values or Streamable HTTP `headers` values. Plugin settings expose
each placeholder name as a write-only field on a named Integration Connection.
One MCP server may declare at most eight distinct credential names.
Multiple connections can bind the same server; tool identities include the
Connection ID. Secrets stay in private settings and never enter tool schemas or
arguments. Replacing a package requires an explicit credential rebind.

An MCP tool can opt into the artifact bridge with
`_meta["io.github.samkuler/live-smith-artifacts"]` version 1. MIDI and audio inputs
are opaque Session references in the model schema and read-only temporary files
at call time. Exactly one declared output is written to a host-created temporary
path and validated before immutable Session storage. Its descriptor is
`{ "argument": "destination", "kind": "midi", "label": "Variation" }` or
`{ "argument": "destination", "kind": "audio", "format": "wav", "label": "Processed take" }`.
Audio accepts `wav` (the default) or `mp3`; detected bytes must match the declaration.
Importing saved output into Live is a separate operation. Artifact input and
output permissions are approved independently after the MCP server itself.
Older version 1 declarations may include a `continuation` hint. The host ignores
that hint and uses the tool's declared artifact inputs and outputs normally.

The committed fixtures under `test-fixtures/plugins/` exercise portable, Codex,
and Claude package discovery. `tests/plugins/compatibility-fixtures.test.ts` packs
those exact files and verifies install, disabled defaults, MCP approval, Skill
loading, a real stdio tool call, disable, and uninstall. Add format changes to
these fixtures and tests rather than creating credential-bearing or executable
samples. Keep every fixture file tracked and mode `0644`.

#### Native Plugin parameter panels

Session Tools builds parameter panels directly from MCP `inputSchema`.
No extra manifest component, HTML file, or UI metadata is required. Both
installed Plugins and standalone MCP connections use the same panel contract.
The portable fixture's `echo` tool demonstrates text, bounded integers, an enum,
and a Boolean parameter without external services.

Supported schemas describe an object with up to 32 named scalar properties:
`string`, `number`, `integer`, or `boolean`. Property `title` and `description`
provide labels and hints; `default` initializes a control. `enum` supplies up to
64 typed choices. Numeric fields support `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, and `multipleOf`. Inclusive finite bounds
with a compatible step enable a slider alongside the number input; other numeric
constraints retain the validated number input. Strings support
`minLength` and `maxLength`, measured in Unicode code points, with a 16,384-code-point
panel limit. `required` controls property presence. Optional fields can be
omitted explicitly, including optional Booleans whose value is false.

The object may declare `additionalProperties` as a Boolean; panel calls send
only declared properties. Nested objects, arrays, references, unions, patterns,
formats, and other unsupported constraints disable the form for that tool,
preserving its ordinary chat availability. Parameter payloads are bounded to
64 KiB, individual form descriptions to 16 KiB, and the directory's combined
form descriptions to 256 KiB. Host-managed artifact output paths stay outside
the form; declared audio inputs use existing Session asset references.

Selecting **Run tool** sends one typed argument object directly to the tool.
The host validates values and rechecks the current definition and Connection
before execution. Changing a package, schema, or Connection invalidates an older
form. Results are recorded in Session history and shown in the panel; generated
MIDI is saved as a Session artifact for a separate Live import. **Stop** requests
cancellation; it does not undo work already performed by the external server.
Parameter controls do not establish a persistent background service or playback
scheduler.

Tool descriptions are collapsed separately from their controls. Tools with an
MCP App offer the custom interface first and keep **Standard parameter form**
as an expandable alternative. Completed results share the same host actions:
**Use in chat** appends a reference to the composer without sending it, and
saved MIDI exposes **Import into Live** through the shared import dialog described in
the [user guide](USER_GUIDE.md#importing-saved-midi). Import uses the ordinary
Session Edit Scope, approval, and recovery boundaries and can run independently
of a model connection.

#### Persistent Plugin configuration

Compatibility manifests may declare Claude Code's `userConfig` object. Portable
packages put the same object under
`extensions["io.github.samkuler.live-smith"].userConfig` in root `plugin.json`.
Matching Codex and Claude manifests can coexist in one package; any repeated
configuration declarations must agree. Portable identity and component locations
remain canonical. Without a portable manifest, the Codex manifest selects the
component locations when both compatibility manifests are present.

Each field declares `type`, `title`, and `description`. Supported types are
`string`, `number`, `boolean`, `file`, and `directory`; optional attributes are
`required`, `default`, `options`, `multiple`, `sensitive`, `min`, and `max`.
`multiple` applies to strings. `options` applies to a non-sensitive, single
string and requires a matching default or a required selection. Limits are 64
fields, 64 list entries or choices, 8,192 characters per value, and 64 KiB per
configuration. String limits use UTF-16 code units. File and directory fields
accept path text and grant no file access by themselves.

```json
{
  "userConfig": {
    "style": {
      "type": "string", "title": "Style", "description": "Default music style",
      "options": ["ambient", "jazz"], "default": "ambient"
    },
    "phrase_bars": {
      "type": "number", "title": "Phrase length", "description": "Default phrase length in bars",
      "min": 1, "max": 32, "default": 8
    }
  }
}
```

Users edit these fields under **Extensions → Plugins → Plugin parameters**.
Save commits configuration; Discard restores saved values; Restore defaults
changes the draft without clearing saved secrets. Sensitive inputs are
write-only, with an explicit clear action. Values live in host-owned private
Plugin storage, separately from the immutable package and mutable `PLUGIN_DATA`.
They survive restarts and package replacement; deleting the Plugin removes
them. A replacement revalidates values against its new declaration. Invalid
values remain visible for repair. Missing required values or values that fail
validation prevent enabling the Plugin. Configuration edits take effect on
subsequent requests.

Selected Plugin Skill bodies can reference `${user_config.style}`. MCP launch
and connection fields can reference the same values, for example
`"env": { "BUFFER_BARS": "${user_config.buffer_bars}" }`. Expansion is a single
text substitution; substituted values are never evaluated or expanded again.
Lists expand as JSON arrays, and numbers/Booleans retain their JSON text form.
Sensitive references in Skills become `[sensitive value]`; actual sensitive
values are available only to authorized MCP configuration. Bare `${NAME}`
credential placeholders and package-path placeholders retain their existing
MCP meaning. Live Smith supports these `user_config` references in portable,
Codex-compatible, and Claude-compatible packages.

#### MCP Apps

An approved MCP server can provide an interactive interface using the MCP Apps
extension `io.modelcontextprotocol/ui`. Register a tool with
`_meta.ui.resourceUri: "ui://example/app.html"` and serve the corresponding
resource as `text/html;profile=mcp-app`. The deprecated
`_meta["ui/resourceUri"]` spelling is also accepted. UI metadata is retained
outside the model tool schema. Tools with visibility `["app"]` remain available
to their App and are omitted from model tool lists.

The tool directory shows **Open interface**, and discovered interfaces also
appear on their Plugin card. Opening reads the resource without invoking the
entry tool. The interface may then call its server tools. The host uses the
official `@modelcontextprotocol/ext-apps` AppBridge for initialization, tool
input/result notifications, resource reads/listing, scoped tool calls,
cancellation, sizing, and teardown. A prior saved invocation supplies its
actual input and model-visible result when the interface reopens. UI-only
result `_meta` is delivered to the current interface and is not stored in
Session history. Standard parameter forms remain available for supported
tool input schemas.

Resource and resource-template list RPCs return one server page. Apps pass its
opaque `nextCursor` back as `cursor` to request the next page. MCP messages are
bounded to 4 MiB; pagination requests allow that cursor budget plus the host's
instance ID and JSON envelope. Cursors are not interpreted as URLs or paths.

The host reserves `_meta["io.github.samkuler/live-smith-artifacts"]` in App
results for `{ "version": 1, "artifacts": [...] }`. Its entries contain validated
Session MIDI/audio references and summaries. Server-supplied values at this key are
replaced. Reopening rebuilds these references from saved history and the current
Session artifact store. The host result controls display the entry tool's result;
background App helper calls do not replace it. Other UI-only metadata is not
restored from history.

Views run in an opaque inner iframe behind a sandbox proxy on a separate
loopback origin. The host enforces CSP from the resource's `_meta.ui.csp`.
Supported domain entries are exact HTTPS origins and loopback HTTP origins;
wildcards, WebSocket origins, browser permissions, model-context updates,
chat messages, external-link requests, and downloads are not advertised.
Bundle scripts and styles into the HTML when no external resources are needed.
Images, media, and fonts may use local `data:` and `blob:` resources.
The interface receives neither the chat bridge token nor connection credentials.
Its RPC is restricted to its original server/connection and is revalidated before
execution. Calls and results enter Session history. Closing cancels pending
operations and releases the server connection; cancellation cannot undo effects
already performed by a server. UI-local drafts are not automatically saved as
Plugin configuration; persistent application data can be managed by server tools
under `PLUGIN_DATA`.

Build the offline Pattern Lab example, which uses the official App SDK and a
deterministic local note generator:

```sh
npx tsx scripts/build-plugin-app-example.ts /private/tmp/live-smith-mcp-app.zip
```

Install the ZIP, enable the Plugin, approve its `fixture` MCP server and its
**MIDI output** permission, then open its interface. The fixture includes matching
portable, Codex, and Claude manifests. Its interface exercises mode selection,
parameter controls, scoped App-only tools, and saved MIDI results with a local
generator.

## Packaging

```sh
npm run package
npm run verify:package
```

`package` builds the extension, creates `Live-Smith-<version>.ablx`, and verifies
it against the current `dist/extension.js`. `verify:package` checks an existing
package against that bundle and runs the Plugin fixture checks. It requires
`unzip` on `PATH`. Keep generated bundles and packages out of source control.
Package notices are maintained in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Build and package verification
check declared dependency versions against `package-lock.json` so notices must
be updated with dependency upgrades.

## Development data

`npm start` uses the Git-ignored `.live-smith-data/` directory. Profiles and
Session history therefore survive an Extension Host restart. To choose another
persistent directory, pass it after the npm argument separator:

```sh
npm start -- --storage-directory /absolute/path/to/live-smith-data
```

The later CLI option overrides the development default. Other launch methods
use the storage directory supplied by the Ableton host. When the host supplies
no directory, settings and Session metadata remain in process memory until the
host exits. OAuth credentials, installed Plugins, MIDI/audio artifacts, and
device parameter snapshots require persistent storage.

持久化数据由 `live-smith.sqlite3` 和 `live-smith-media/` 共同保存。数据库包含
Profiles、Integration Connections、Session 元数据与事件、模型缓存、凭据、参数
记录、User Skill、Plugin ZIP/配置及媒体引用。附件、音频和 MIDI 的原件位于独立
媒体目录。数据库与旧源备份可能包含明文 API key、OAuth token 或 Cookie，整个
存储目录均按私有数据维护。

私有存储目录所在的文件系统需要支持硬链接。Windows 可使用本地 NTFS；exFAT 和
FAT32 不满足当前媒体文件发布要求。此要求针对私有存储目录，导入附件的原文件可以
位于其他文件系统。文件发布与引用关系见[持久化契约](ARCHITECTURE.md#durable-local-storage)。

| 位置 | 内容与生命周期 |
| --- | --- |
| `live-smith.sqlite3` | 结构化记录、历史事件、内联内容和媒体引用，含长度、摘要和版本 |
| `live-smith-media/` | 以内容摘要命名的媒体原件，由独立记录共享 |
| `live-smith.sqlite3-journal` | 可能存在的 SQLite 恢复日志 |
| `live-smith.sqlite3.v1-backup` | SQLite v1 升级前生成的只读数据库副本 |
| `live-smith-plugins/data/<pluginId>/<dataGeneration>/` | 新安装的独立可变数据目录。替换保留代次，卸载按代次清理 |
| `live-smith-plugins/data/<pluginId>/` | 迁移前安装沿用的数据目录 |
| `live-smith-plugins/runtime-cache/` | 从数据库中的 ZIP 重建的运行缓存 |
| `live-smith-exports/` | 原生文件拖出副本，生命周期由原生窗口的领取状态控制 |
| 迁移前的 JSON、媒体、Skill、Plugin `packages/` 与 `runtime/` | 保留的历史原件 |

数据库逻辑键沿用原来的相对路径，例如 `live-smith-settings.json`、
`oauth/credentials.json`、`suno-session-<serviceId>.json`、
`live-smith-midi/<sessionId>/` 和 `live-smith-device-parameters/<sessionId>/`。
这些键继续支持原有 ID、格式版本和跨记录引用。各域的存储边界见
[持久化契约](ARCHITECTURE.md#durable-local-storage)。

### 首次打开已有数据

打开旧数据前，关闭使用该目录的 Extension Host 与 Plugin 子进程，为完整目录建立
离线备份。预留能同时容纳旧源、数据库及事务日志、新媒体原件和 SQLite v1 备份的磁盘
空间。每个存储目录由一个 Extension Host 实例使用。

初始化逐块读取旧普通文件，校验源身份、大小、修改时间和导入前后的文件清单。媒体
原件进入 `live-smith-media/`，数据库提交结构化记录、媒体引用和迁移完成标记。
已有 SQLite v1 数据库先生成 `live-smith.sqlite3.v1-backup`，再将内联媒体转为
文件引用。旧源和已有备份保持原样。迁移失败时数据库事务回滚，排除故障后可重新
打开。迁移完成后，使用当前数据库与媒体目录读写。

迁移时的 Plugin data 普通文件另存为数据库中的 `preserved` 快照。已有 Plugin
运行继续访问原 data 目录，该目录可以更新；快照保持迁移时内容。新安装使用独立
的随机代次目录，替换保持代次，卸载后重装创建新代次。目录清理遇到失败时会重试；
断电后可能重现的旧目录与新安装保持逻辑隔离。
Skill 的未完成安装、替换、删除，以及 Plugin 的未完成清理，在导入后的数据库记录上
恢复。Plugin 运行缓存使用独立的 `runtime-cache/` 路径。

### 备份与恢复

完整备份应在 Extension Host 和 Plugin 子进程关闭后复制整个私有数据目录。
同时保存 `live-smith.sqlite3`、完整的 `live-smith-media/`、存在的 SQLite 日志、
Plugin 当前 data 目录、v1 备份及历史原件。异常退出后留存的事务日志属于数据库
恢复状态。恢复前关闭所有使用者，再将整份备份恢复到单独目录并通过
`--storage-directory` 选择该目录。

运行期间备份数据库应使用 [SQLite Online Backup API](https://sqlite.org/backup.html)
或 `VACUUM INTO` 创建一致快照。直接复制正在写入的单个数据库文件可能混合不同
事务的内容；事务日志与数据库也需要保持匹配。详见
[SQLite 备份与事务日志说明](https://sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)。
在线数据库快照只包含 SQLite 记录和媒体引用。完整恢复点需要离线保存同一时点的
数据库、媒体目录和 Plugin data。

旧原件与 v1 备份反映迁移时的状态。需要旧版时，使用独立的迁移前完整备份目录，
同时保留当前数据的完整备份。当前数据库或媒体损坏时，从同一恢复点的完整备份
恢复。

### 长会话读取边界

会话事件逐条写入 SQLite。首次打开和后续分页每次读取至多 100 条事件。用户主动
加载的连续页面保留在当前视图，DOM 随加载量增长。会话附件库读取独立的历史附件
元数据。会话搜索在保存的用户和助手消息文本中匹配子串，扫描成本仍随候选文本量增长。
模型上下文和审批恢复从保存的历史独立读取。

内置 Skills 随扩展打包。已启用 Plugin 的 Skills 来自数据库保存的不可变 ZIP，
使用 `<plugin-id>:<skill-id>` 标识；导入的 User Skills 使用独立数据库键空间。
Suno Cookie 的导入、验证、过期与断开流程见
[Cookie connection workflow](MODEL_PROVIDERS.md#sunocom-website-sign-in)。
历史 `suno-browser/<serviceId>/` 可能包含私有浏览器数据；当前运行时保持其原样，
它们由所有者在关闭相关旧浏览器后单独维护。

私有开发数据的删除、分享、同步和归档遵循所有者授权。移除 worktree 或更换启动
位置时保留该目录。凭据归属见[credential storage](MODEL_PROVIDERS.md#credential-storage)。

### Audio service verification

Audio tests use injected services, synthetic credentials, and local media. They
run without uploading user audio or spending generation credits or processing
minutes. Provider-specific coverage includes:

| Provider | Automated coverage |
| --- | --- |
| Suno Platform | Captured `/v0/audio` requests and responses |
| Mureka | Captured music and lyric requests, task polling, and result validation |
| Google Lyria | Captured Interactions responses, scripted Live Music WebSocket messages, and PCM-to-WAV conversion |
| Suno.com | Captured HTTP requests, injected default-browser handlers, native process replay, and verification-client DOM events |

Real-service checks require a configured test account. Verify account access,
model entitlement, billing or quota, regional availability, safety acceptance,
and media delivery with that account. In Ableton Live, also check separated-stem
timing, Warp settings, playback, Stop, and import behavior.

Suno.com checks use the local Cookie form. Initial sign-in opens the OS default
browser. When generation requests human verification, the native helper loads
the requested official component on an HTTPS Suno page. In the Extension Host,
check that the helper launches, let the account owner complete the challenge,
and confirm both an accepted generation receipt and a valid downloaded file.

Check remote generation, online preview, download authorization, and Live import
as separate steps. Use the Live dialog for the embedded player and download
confirmation. JSDOM covers their interactions; the host check covers WebView
playback and network policy. See [原生窗口与文件拖放](#原生窗口与文件拖放)
for checks involving local audio files dragged from chat.
