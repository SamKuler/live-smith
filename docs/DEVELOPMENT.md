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

Configure a Profile in Live Smith Settings to use model features. The optional
ChatGPT subscription backend needs the supported official Codex CLI installation
described in [model connections](MODEL_PROVIDERS.md#chatgpt-subscription-experimental).
Building and running tests do not require a model connection.

Instead of passing `--live`, copy [.env.example](../.env.example) to `.env` and
set `EXTENSION_HOST_PATH` to your Live application. This variable is for host
discovery only. Model endpoints, keys, and parameters are configured through
saved Profiles in Live Smith Settings, not environment variables.

For a production build without starting Live:

```sh
npm run build
```

Both build variants type-check the source and verify Extension Host runtime
compatibility before writing the bundle to `dist/extension.js`.

## Verification

Run the required checks before handing off changes:

```sh
npm test
npm run build
npm --cache /private/tmp/live-smith-npm-cache audit --json
```

The test suite includes structural limits, core behavior, and real-dialog DOM
interaction tests. It uses fixtures and does not require provider credentials
or call a model provider. Focused suites are available as `npm run test:core`,
`npm run test:ui`, and `npm run test:structure`.

After editing dialog client fragments, also check the composed JavaScript:

```sh
node -e "const fs=require('fs');const files=['host-adapter','profile-editor','bridge-client','attachments','skill-manager','session-timeline','bootstrap'];new Function(files.map((name)=>fs.readFileSync('src/ui/client/'+name+'.script.html','utf8')).join('\\n'));"
```

DOM tests prove interaction and state behavior, not rendered geometry or
Extension Host subprocess compatibility. In the target Live build, separately
check dialog layout and focus, host integration, and managed-backend startup,
cancellation, and shutdown. Use an authorized test account for provider checks;
ordinary tests must not read a developer's saved credentials.

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
`codex-subscription/` contains the isolated managed login and runtime state.
Built-in Skills are bundled and do not create imported Skill files.

Do not commit, share, cloud-sync, or delete private development data without the
owner's approval. Preserve it when removing a worktree or changing run locations.
See [credential storage](MODEL_PROVIDERS.md#credential-storage) for the connection
boundary and [architecture](ARCHITECTURE.md#configuration-boundaries) for
persistence ownership.
