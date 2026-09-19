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
Host-equivalent restricted VM, the production build, the composed dialog-client
syntax check, and `npm audit --json`. It uses fixtures and does not require
provider credentials or call a model provider. Focused checks remain available
as `npm run test:core`, `npm run test:ui`, `npm run test:structure`, and
`npm run verify:client`.

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

## Packaging

```sh
npm run package
npm run verify:package
```

`package` builds, packages, and verifies the `.ablx` against the current bundle.
`verify:package` can check an existing package and rejects a stale bundle. Keep
generated bundles and packages out of source control. Package notices are
maintained in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

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
Profiles, Session metadata and events, attachments, imported Skills, and model
metadata. `live-smith-settings.json` contains Direct API keys as plain text;
`oauth/credentials.json` contains private provider OAuth credentials.
Audio-service connection keys also live in private settings. Audio-processing
jobs and input/output assets are stored under `live-smith-audio/<sessionId>/`.
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
Built-in Skills are bundled and do not create imported Skill files.

Do not commit, share, cloud-sync, or delete private development data without the
owner's approval. Preserve it when removing a worktree or changing run locations.
See [credential storage](MODEL_PROVIDERS.md#credential-storage) for the connection
boundary and [architecture](ARCHITECTURE.md#configuration-boundaries) for
persistence ownership.
