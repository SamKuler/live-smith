# Live Smith Contributor Guide

## Project map

- `src/app/` owns the chat bridge and orchestration. Model-request assembly and
  session-context selection live in dedicated app modules.
- `src/agent/` contains the provider-neutral bounded tool loop and strict Live
  action schemas.
- `src/live/` observes Ableton state, resolves targets, and executes validated
  actions.
- `src/model/` contains Profiles, capability resolution, transport selection,
  and provider protocol adapters.
- `src/runtime/` owns explicit extension-host capability boundaries for Fetch
  and cancellation APIs.
- `src/storage/` persists Profiles, sessions, session events, and raw model
  discovery metadata.
- `src/ui/` contains state serialization, dialogs, and the real DOM behavior
  tests for the chat interface.

See `docs/ARCHITECTURE.md` and `docs/MODEL_PROVIDERS.md` before changing a
cross-module contract.

## Provider contracts

There are two API families and three supported modes:

- OpenAI Responses
- OpenAI Chat Completions
- Anthropic Messages

A named Profile owns the complete connection and generation configuration:
family, mode, base URL, API key, model, parameters, capability overrides, and
Extra Body. Do not add endpoint or vendor presets. OpenAI-compatible services
use an ordinary OpenAI Profile with the protocol they implement.

Keep provider-specific request mapping, streaming, tool-call replay, and opaque
response state inside `src/model/transports/`. The agent loop and Live executor
must remain provider-neutral. Resolve feature decisions from capabilities, not
from model-name checks inside transports.

## Safety invariants

- Observe the relevant Live state before mutating it.
- Execute only actions accepted by the descriptors in
  `src/agent/action-schema.ts` and the plan validator in `src/agent/actions.ts`.
- Apply approval is an explicit three-mode policy: Manual asks for every plan,
  Low Risk asks for protected actions, and Accept Everything automatically
  approves every validated plan, including deletes and replacement writes.
  Every mode still requires observation, schema validation, preflight, the
  process-wide mutation queue, cancellation, and state-drift revalidation.
- Send requests contain only `prompt` and `sessionId`. Session commands contain
  only their command-specific fields. Neither path may carry Profile settings
  or credentials.
- OpenAI Responses uses local state and `store: false`.
- Import Node runtime values such as `URL`, `Buffer`, and process data from
  their `node:` modules. Resolve host-provided Fetch and Abort APIs only through
  `src/runtime/host.ts`; do not use ambient runtime globals elsewhere.
- The extension bundle must not depend on `structuredClone`; clone
  provider/profile JSON through `cloneJsonValue`. The build enforces these host
  compatibility boundaries and smoke-loads the bundle without ambient Web APIs.
- Provider errors must include useful family/mode context without exposing API
  keys, authorization headers, raw credential-bearing causes, or request bodies.

## Local-only files

Do not publish the Ableton Extensions SDK, its archives, examples,
documentation, API reference, or license copy. Contributors obtain the SDK from
Ableton and keep it under `extensions-sdk-1/`; only that directory's README is
public.

Do not delete or publish `.env.local`, `.claude/`, `node_modules/`, `dist/`, or
other local SDK files unless the owner explicitly requests it. Provider keys
belong only in locally saved Profiles and must never enter source, fixtures,
logs, screenshots, or documentation.

## Editing rules

- Preserve unrelated user changes and avoid destructive Git operations.
- Keep the three transport modes explicit; do not reintroduce flattened legacy
  settings or implicit environment-variable provider configuration.
- Add request-capture and replay tests when transport mapping changes.
- Drive the real `chat-dialog.html` script through DOM events for UI behavior
  changes instead of relying only on source-pattern assertions.
- Keep configuration writes limited to Profile CRUD/activation and the
  dedicated global-settings command.

## Verification

Run before handing off a change:

```sh
npm test
npm run build
npm --cache /private/tmp/live-smith-npm-cache audit --json
```

Also validate the composed dialog client after editing it:

```sh
node -e "const fs=require('fs');const files=['host-adapter','profile-editor','bridge-client','capability-preview','session-timeline','bootstrap'];new Function(files.map((name)=>fs.readFileSync('src/ui/client/'+name+'.script.html','utf8')).join('\\n'));"
```
