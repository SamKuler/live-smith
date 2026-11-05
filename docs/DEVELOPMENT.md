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
`src/runtime/native/chat-capsule.json` 中的 `NativeChat`，Suno 在请求人工验证时使用
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

The private data directory holds saved Profiles, Integration Connections,
Session metadata and events, attachments, imported Skills, installed Plugins,
and model metadata. Important locations include:

| Path | Contents |
| --- | --- |
| `live-smith-settings.json` | Profiles, Integration Connections, and Direct API, built-in Plugin, and MCP connection keys in plain text |
| `oauth/credentials.json` | Model provider OAuth credentials |
| `live-smith-mcp-oauth.json` | MCP OAuth client registrations and tokens |
| `suno-session-<serviceId>.json` | Suno/Clerk Cookie fields saved separately for each audio connection |
| `live-smith-audio/<sessionId>/` | Built-in audio jobs and their input/output assets |
| `live-smith-audio-artifacts/<sessionId>/` | Audio results from external Plugins |
| `live-smith-midi/<sessionId>/` | MIDI artifacts and retained historical continuation files |
| `live-smith-device-parameters/<sessionId>/` | Device parameter snapshots, application baselines, progress, and results |
| `live-smith-plugins/` | Installed archives, catalog, runtime files, configuration, and mutable Plugin data |

Preserve complete Session directories when copying media and parameter data.
Copy `live-smith-plugins/` as a whole and leave its contents under host management.
Built-in Skills are bundled. Enabled Plugin Skills are read from their immutable
packages with `<plugin-id>:<skill-id>` identities. Imported User Skills have
their own private storage.

Suno Cookies belong only in private storage and the local connection form.
Keep them out of source, fixtures, logs, screenshots, and shared artifacts.
See the [Cookie connection workflow](MODEL_PROVIDERS.md#sunocom-website-sign-in)
for import, validation, expiry, and disconnect behavior.
Legacy `suno-browser/<serviceId>/` directories may contain private browser data;
the current runtime leaves them untouched. Close any old managed browser window
before manually cleaning up a known legacy directory. Never delete or migrate
these directories automatically.

Do not commit, share, cloud-sync, or delete private development data without the
owner's approval. Preserve it when removing a worktree or changing run locations.
See [credential storage](MODEL_PROVIDERS.md#credential-storage) for the connection
boundary and [architecture](ARCHITECTURE.md#configuration-boundaries) for
persistence ownership.

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
