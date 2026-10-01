# Live Smith Development Guide

This guide covers installation from source, local execution, verification, and
packaging. For product usage, see the [README](../README.md). Contributors should
also read [AGENTS.md](../AGENTS.md), the [architecture](ARCHITECTURE.md), and the
[model connection reference](MODEL_PROVIDERS.md).

## Prerequisites

- Node.js 24.16.0 or newer.
- An Ableton Live build with Extensions support.
- Authorized access to the Ableton Extensions SDK `1.0.0-beta.1`.

The SDK is not distributed with this repository. Obtain it through Ableton's
developer channel and put these archives in `extensions-sdk-1/`:

- `ableton-extensions-sdk-1.0.0-beta.1.tgz`
- `ableton-extensions-cli-1.0.0-beta.1.tgz`

Their paths are declared in [package.json](../package.json). Do not commit or
redistribute the archives, SDK source, examples, documentation, or license copy.
The directory's [README](../extensions-sdk-1/README.md) is public setup guidance.

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

Rebuilding `dist/extension.js` does not replace code already loaded by a running
Extension Host. Before testing changed code in Live, close the Live Smith dialog,
stop its Extensions CLI with Ctrl+C, and start it again with the same storage
directory. The Live Set can remain open; do not discard private development data
to refresh the extension.

Configure a Profile under **Inspector → Agent** to use model features.
Subscription Profiles complete OAuth in the browser and require no provider CLI installation.
Building and running tests do not require a model connection.

Instead of passing `--live`, copy [.env.example](../.env.example) to `.env` and
set `EXTENSION_HOST_PATH` to your Live application. This variable is for host
discovery only. Model endpoints, keys, and parameters are configured through
saved Profiles in Live Smith Inspector, not environment variables.

For a production build without starting Live:

```sh
npm run build
```

Both build variants type-check the source, compile the Tailwind entries under
`src/ui/styles/` to static CSS, and verify Extension Host runtime compatibility
before writing the bundle to `dist/extension.js`. The compiled styles are
embedded into each data-URL dialog; the WebView does not load Tailwind, a CDN,
or a separate stylesheet at runtime.

The Suno verification helper is our own macOS AppKit/WebKit application, not a
browser extension. Its universal arm64/x86_64 capsule is embedded in the bundle;
installation does not require a compiler or a source checkout. Both builds
validate its source/content receipt. A changed native source or build recipe
recompiles and ad-hoc signs the capsule with the separately installed macOS
Command Line Tools. Builds on other platforms require a current capsule produced
on macOS. Only this helper requires macOS 14 or later; no-challenge generation
does not start it. The capsule contains no Ableton SDK or account data.

## Verification

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

The verification command runs structural limits, core behavior, real-dialog DOM
interaction tests, direct plus CONNECT-proxy requests through an Extension
Host-equivalent restricted VM, both development and production builds, the
composed dialog-client syntax check, and `npm audit --json`. It uses fixtures
and does not require provider credentials or call a model provider. Focused
checks remain available as `npm run test:core`, `npm run test:ui`,
`npm run test:structure`, and `npm run verify:client`. `npm run verify:plugins`
checks every committed Plugin compatibility fixture for a valid contained
manifest, tracked package data, non-executable files, and credential-shaped
content.

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
state-specific translucent values. The goal is one tokenized design system,
not zero handwritten declarations.

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
geometry and surrounding surface separately from native-chrome pixel noise. The
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
as the current operating-system user, not in an OS sandbox. Do not put API keys,
tokens, authorization headers, or other credentials in a package or fixture.
For host-managed credentials, declare `${NAME}` or `${NAME:-default}` only in
stdio `env` values or Streamable HTTP `headers` values. Plugin settings expose
each placeholder name as a write-only field on a named Integration Connection.
One MCP server may declare at most eight distinct credential names.
Multiple connections can bind the same server; tool identities include the
Connection ID. Secrets stay in private settings and never enter tool schemas or
arguments. Replacing a package requires an explicit credential rebind.

An MCP tool can opt into the artifact bridge with
`_meta["io.github.samkuler/live-smith-artifacts"]` version 1. Audio inputs are
opaque Session references in the model schema and read-only temporary files at
call time. The one declared MIDI output is written to a host-created temporary
path, parsed and bounded before immutable Session storage, and never imported
into Live automatically. Artifact input and output permissions are approved
independently after the MCP server itself.

The committed fixtures under `test-fixtures/plugins/` exercise portable, Codex,
and Claude package discovery. `src/plugins/compatibility-fixtures.test.ts` packs
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
saved MIDI exposes **Insert into Live** with an existing MIDI track name and a
one-based Arrangement start beat. Import does not require a model connection.
The host observes and validates the destination, checks Session Edit Scope,
applies the saved approval policy, and revalidates in the Live mutation queue.
Uncertain or partial writes leave a recovery record and are not retried.

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
configuration. File and directory fields accept path text and grant no file
access by themselves.

```json
{
  "userConfig": {
    "style": {
      "type": "string", "title": "Style", "description": "Default music style",
      "options": ["ambient", "jazz"], "default": "ambient"
    },
    "buffer_bars": {
      "type": "number", "title": "Buffer bars", "description": "Target buffered bars",
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
validation prevent enabling the Plugin. Configuration edits take effect on subsequent
requests; they are not Session overrides or live automation controls.

Selected Plugin Skill bodies can reference `${user_config.style}`. MCP launch
and connection fields can reference the same values, for example
`"env": { "BUFFER_BARS": "${user_config.buffer_bars}" }`. Expansion is a single
text substitution; substituted values are never evaluated or expanded again.
Lists expand as JSON arrays, and numbers/Booleans retain their JSON text form.
Sensitive references in Skills become `[sensitive value]`; actual sensitive
values are available only to authorized MCP configuration. Bare `${NAME}`
credential placeholders and package-path placeholders retain their existing
MCP meaning. OpenAI hosts do not expand Claude `user_config` references; reading
this declaration in a Codex-compatible package is a Live Smith capability.

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
Session MIDI references and summaries. Server-supplied values at this key are
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
**MIDI output** permission, then open its interface. The authored fixture includes matching portable, Codex, and
Claude manifests; its UI exercises mode selection, parameter controls, scoped
App-only tools, and saved MIDI results without a model or external service.

## Packaging

```sh
npm run package
npm run verify:package
```

`package` builds, packages, and verifies the `.ablx` against the current bundle.
`verify:package` can check an existing package and rejects a stale bundle or an
unsafe Plugin compatibility fixture. Keep generated bundles and packages out of
source control. Package notices are maintained in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Development data

`npm start` uses the Git-ignored `.live-smith-data/` directory. Profiles and
Session history therefore survive an Extension Host restart. To choose another
persistent directory, pass it after the npm argument separator:

```sh
npm start -- --storage-directory /absolute/path/to/live-smith-data
```

The later CLI option overrides the development default. Outside this command,
Live Smith uses the storage directory supplied by the Ableton host; it does not
hard-code a production path. Without a host-provided directory, data falls back
to process memory and does not survive a host restart.

The data directory is private, not disposable build output. It contains saved
Profiles, Integration Connections, Session metadata and events, attachments,
imported Skills, installed Plugin archives, private Plugin data, and model
metadata. `live-smith-settings.json` contains Direct API and built-in Plugin
connection keys as plain text;
`oauth/credentials.json` contains private provider OAuth credentials.
Audio-processing jobs and input/output assets are stored under
`live-smith-audio/<sessionId>/`. Immutable installed archives, their catalog,
materialized runtime files, and mutable per-Plugin data live under
`live-smith-plugins/`; do not edit or partially copy that directory.
Processing tests use injected services and local audio fixtures; they do not
upload user audio or consume generation credits or processing minutes.
Real-service validation requires an explicitly configured account. Verify
separated-stem timing, Warp settings, playback, Stop, and import behavior
separately in the Ableton host.
Suno Platform tests use synthetic API keys and captured `/v0/audio` requests;
they do not establish live Platform access. Mureka tests likewise use synthetic
keys and captured song/instrumental task requests; they do not establish live
account access, model entitlement, credits, regional availability, or provider
media delivery. Google Lyria tests use captured Interactions responses and
scripted Live Music WebSocket messages, including PCM-to-WAV validation; they do
not establish live Gemini key access, billing, quota, model entitlement,
regional availability, safety acceptance, or provider media delivery. Suno.com
Cookie tests use synthetic credentials, captured HTTP requests, injected
default-browser handlers, native process replay and real verification-client
DOM events. They do not read browser profiles or log into real accounts. Initial
sign-in opens the OS default browser without discovery,
extensions or automation flags. Generation verification uses the owned native
helper and the requested official component on an actual HTTPS Suno document.
No fixture establishes official challenge acceptance: verify native launch in
the real Extension Host, let the user complete the challenge, then check one
accepted generation receipt and a valid locally downloaded file. Callback
success alone does not establish account-bound generation or file delivery.
Explicitly imported Cookies are reduced to required Suno/Clerk fields and stored
in private `suno-session-<serviceId>.json`
files in the extension storage directory, separately per audio connection, and must
never enter source, fixtures, logs, screenshots or shared artifacts. See the
[Cookie connection workflow](MODEL_PROVIDERS.md#sunocom-website-sign-in) for
import, validation, expiry and disconnect semantics. Real-provider verification
requires the owner to enter a Cookie in the local form; passing fixture tests
does not establish live authentication, subscription generation or download support.
Suno result verification must distinguish remote generation, online preview,
explicit download authorization and local Live import. Use the actual Live
dialog to check the embedded player and download confirmation: JSDOM does not
establish WebView playback, network policy or native file-export behavior.
Legacy `suno-browser/<serviceId>/` directories may contain private browser data;
the current runtime leaves them untouched. Close any old managed browser window
before manually cleaning up a known legacy directory. Never delete or migrate
these directories automatically.
Built-in Skills are bundled and do not create imported Skill files. Enabled
Plugin Skills are read from their Plugin's immutable package and use
`<plugin-id>:<skill-id>` identities; they do not become standalone User Skills.

Do not commit, share, cloud-sync, or delete private development data without the
owner's approval. Preserve it when removing a worktree or changing run locations.
See [credential storage](MODEL_PROVIDERS.md#credential-storage) for the connection
boundary and [architecture](ARCHITECTURE.md#configuration-boundaries) for
persistence ownership.
