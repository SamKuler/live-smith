# Live Smith Contributor Guide

This file defines durable collaboration rules. It is not a product manual,
implementation plan, or record of individual changes.

## Documentation responsibilities

- `README.md` introduces the product, user workflow, limits, and privacy.
- `docs/DEVELOPMENT.md` owns setup, build, verification, packaging, and local
  development data instructions.
- `docs/ARCHITECTURE.md` owns module responsibilities, lifecycle, and safety
  invariants; `docs/MODEL_PROVIDERS.md` owns model and connection contracts.
- Keep documentation about the implemented product and lasting constraints.
  Do not add task narratives, review outcomes, commit references, temporary
  checklists, or conversation context. Keep migration compatibility details
  where they describe supported data formats.
- Never commit superpowers workflow documents or temporary execution plans.
  Keep execution notes outside repository documentation.

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
- `src/attachments/` validates and extracts supported attachment formats;
  `src/skills/` owns Skill format rules and bundled definitions.
- `src/storage/` persists Profiles, sessions, session events, and raw model
  discovery metadata, and owns private attachment and User Skill storage.
- `src/ui/` contains state serialization, dialogs, and the real DOM behavior
  tests for the chat interface.

See `docs/ARCHITECTURE.md` and `docs/MODEL_PROVIDERS.md` before changing a
cross-module contract.

## Provider contracts

There are two API families and three supported modes:

- OpenAI Responses
- OpenAI Chat Completions
- Anthropic Messages

A named Profile owns one complete connection plus one or more model
configurations. Each model configuration owns its generation parameters,
capability overrides, hosted-tool policy, and Extra Body. A `direct-api`
connection owns family, mode, base URL, and API key. A `codex-subscription`
connection owns only the fixed OpenAI managed-backend identity; its supported
models, reasoning efforts, and input evidence come from the signed-in catalog.
Do not add endpoint or vendor presets. OpenAI-compatible services use an
ordinary Direct API OpenAI Profile with the protocol they implement.

Keep Direct API provider-specific request mapping, streaming, tool-call replay,
and opaque response state inside `src/model/transports/`; keep managed runtime
protocol and lifecycle mapping inside `src/model/backends/`. The agent loop and
Live executor must remain provider-neutral. Resolve feature decisions from
capabilities, not from model-name checks inside either boundary.

Preserve supported, unsupported, and unverified capability evidence. Direct API
discovery metadata belongs to its exact Profile connection; managed catalogs
stay modal-only and scoped to the current auth generation. Configuration,
discovery evidence, and Session model selection have separate owners.

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
- A Session model selection stores only Profile ID, model ID, and an optional
  reasoning-effort override. Resolve and validate the complete runtime model
  from the active saved Profile at send admission.
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
- Diagnose the root cause and reproduce behavior before changing it. Fix the
  responsible layer without model-specific exceptions, speculative abstractions,
  redundant state, or checks that no caller consumes.
- Keep the three transport modes explicit; do not reintroduce flattened legacy
  settings or implicit environment-variable provider configuration.
- Add request-capture and replay tests when transport mapping changes.
- Drive the real `chat-dialog.html` script through DOM events for UI behavior
  changes instead of relying only on source-pattern assertions.
- Test observable state, protocol, or DOM behavior instead of checking isolated
  prompt phrases or static CSS values. Keep generated-instruction assembly in
  one canonical contract test rather than repeating copy assertions across
  layers.
- JSDOM tests cover event and DOM semantics, not rendered geometry. Do not use
  computed-style assertions as proof of visual layout in the Ableton host.
- Keep test modules below the structural limits enforced by
  `npm run test:structure`; split shared harnesses from behavior domains.
- Keep configuration writes limited to Profile CRUD/activation, explicit
  Session metadata commands, and the dedicated global-settings command.
- Update the document that owns a changed user workflow or contract; link to it
  from other documents instead of copying detailed implementation explanations.

## Verification

Run before handing off a change:

```sh
npm test
npm run build
npm --cache /private/tmp/live-smith-npm-cache audit --json
```

After editing dialog client fragments, also run the composed-client syntax check
in [Development verification](docs/DEVELOPMENT.md#verification). Report what was
actually checked; automated tests do not establish visual or live-provider
behavior in the Ableton host.
