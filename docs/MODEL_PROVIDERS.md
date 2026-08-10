# Model Profiles and API Modes

Live Smith has two API families and three supported protocol combinations:

| API family | API mode |
| --- | --- |
| OpenAI | Responses |
| OpenAI | Chat Completions |
| Anthropic | Messages |

There are no endpoint or vendor presets. A service that implements the OpenAI
protocol is configured as an ordinary OpenAI profile with its own base URL,
model, API mode, and parameters.

For all three modes, a non-2xx HTTP response reports the API family/mode, status
code, and status text only. Its response body is untrusted and is never read or
persisted, because a provider or proxy can echo prompts, Live context, replay
state, or Extra Body fields in that body. Error events inside a successful SSE
response likewise expose only fixed protocol context, never an arbitrary
provider message.

## Named profiles

Each Profile stores a complete connection:

- name, API family, and API mode;
- base URL, API key, and model;
- output limit, optional temperature, and reasoning controls;
- optional capability overrides and Extra Body JSON.

Add and Duplicate create an unsaved draft. **Save & Use** validates and persists
the entire draft and makes it active. Changing session or sending a message does
not save the draft. Send remains disabled until the draft is saved or discarded.
Switching a saved Profile switches the whole connection and parameter set.

The implementation keeps three Profile representations explicit:

- `DraftProfile` is the editable, possibly incomplete form. **Connect & Load** checks
  only its connection fields, so name and model may still be blank.
- `SavedProfile` is the fully validated value persisted by Profile CRUD.
- `RuntimeProfile` combines the active Saved Profile with resolved capabilities.
  Model requests and the active header both read this same runtime value; an
  unsaved Draft only changes the labelled Inspector preview.

The first run contains no Profiles. Old provider settings are not migrated. An
invalid or legacy settings file is preserved and blocks settings mutations until
it is repaired or removed, preventing a later save from silently overwriting
recoverable Profiles or credentials.

## API behavior

### OpenAI Responses

- Sends the protocol directly over HTTP/SSE without an OpenAI SDK runtime
  dependency.
- Uses `max_output_tokens` and `reasoning.effort`.
- Always sends `store: false`.
- Requests encrypted reasoning output when available.
- Replays local typed output items and links tool results with `call_id`.
- Does not use `previous_response_id`.
- Treats `response.completed` and `response.incomplete` as terminal lifecycle
  events and cancels the reader without waiting for EOF or `[DONE]`.
- Rejects tool calls unless the overall response is complete and every call has
  a non-empty, unique protocol ID, a non-empty function name, and a string
  argument representation. A malformed declared call invalidates the entire
  turn even when text output is also present.

### OpenAI Chat Completions

- Sends the protocol directly over HTTP/SSE without an OpenAI SDK runtime
  dependency.
- Uses `max_completion_tokens` and `reasoning_effort`.
- Uses assistant `tool_calls` followed by `role: tool` messages.
- Requires a complete `stop` or `tool_calls` finish reason before returning a
  turn to the agent loop; truncated, filtered, unknown, and unterminated
  responses fail before any tool call can run.
- Preserves unknown JSON-compatible assistant fields for compatible endpoints
  that require them during later tool turns.
- Rejects missing, empty, or duplicate tool-call IDs, empty function names, and
  missing or non-string argument representations before any Live action can
  run. Every call must have type `function`, `tool_calls` must be an array, and
  the parsed calls must agree bidirectionally with the terminal finish reason.
  Ordinary assistant text cannot hide a malformed or missing declared call.

### Anthropic Messages

- Uses `max_tokens`, content-block tools, and `tool_result` blocks.
- Sends the versioned Messages HTTP protocol directly and parses SSE events
  locally, without an Anthropic SDK runtime dependency.
- Supports adaptive thinking plus `output_config.effort` for models whose policy
  advertises it.
- Supports token-budget thinking for models whose policy advertises it.
- Replays complete assistant content blocks, including thinking signatures.
- Completes and cancels the stream reader at the protocol-terminal
  `message_stop` event rather than requiring EOF or a nonstandard `[DONE]`.
- Requires a complete `end_turn`, `tool_use`, or `stop_sequence` stop reason;
  truncation, refusal, pause, context exhaustion, unknown reasons, and missing
  terminal metadata fail before any tool call can run.
- Rejects missing, empty, or duplicate tool-use IDs, empty tool names, and
  non-object tool input before any Live action can run. Parsed `tool_use` blocks
  must agree bidirectionally with the terminal stop reason. Ordinary text blocks
  cannot hide a malformed or missing declared `tool_use` block.

### Image, document, and audio input mapping

Live Smith assembles attachment context once as provider-neutral user input
parts. Assistant history remains text-only, while current and historical user
images are mapped to each protocol's native blocks:

- OpenAI Responses uses `input_text` and `input_image` with a base64 data URL.
- OpenAI Chat Completions uses `text` and `image_url` with a base64 data URL.
- Anthropic Messages uses `text` and a base64 `image` source block.

The active saved Runtime Profile must resolve `inputs.image` to `true`; every
transport checks that capability again before making a network request. Image
file names, attachment IDs, and local storage paths are not sent in image
blocks.

PDF is the only native document part. When the active saved Runtime Profile
resolves `inputs.pdf` to `true`, OpenAI Responses maps it to `input_file` and
Anthropic Messages maps it to a base64 `document` source. Live Smith
intentionally does not implement PDF input for OpenAI Chat Completions in this
milestone; this is a Live Smith boundary, not a claim about every compatible
endpoint.

Audio is mapped only by OpenAI Chat Completions, using `input_audio` with
canonical base64 data and `wav` or `mp3` format. A send requires the active
saved Runtime Profile to use OpenAI Chat Completions, resolve `inputs.audio` to
`true`, and carry explicit `supported` evidence for that input capability.
Discovery metadata and a manual capability override can provide that evidence;
an unverified fallback cannot. `capabilities.tools` is not an audio-input gate.
OpenAI Responses and Anthropic Messages reject audio locally in this milestone,
before making a provider request.

DOCX, XLSX, and PPTX never reach a provider as binary document parts. Live
Smith validates and extracts them locally, then sends their bounded text in a
JSON-escaped block labelled as untrusted data. This is semantic text extraction,
not Office visual rendering. Packages with detected macro, VBA, ActiveX, or
macrosheet signals are rejected; this is not general OOXML sanitization, and
unrecognized embedded binary parts are discarded. File names and extracted
content remain untrusted and cannot authorize tools, filesystem access, or a
Live sample source.

The shared policy accepts PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX, WAV, and MP3.
It permits at most 4 attachments and 30 MiB of raw attachment bytes in pending
state or one model request. Each image is limited to 5 MiB and the image
subtotal to 16 MiB; each document and the document subtotal are limited to
20 MiB. Each audio file is limited to 20 MiB and 120 seconds, with a 30-MiB
audio subtotal and at most 2 audio attachments. The combined 30-MiB and 4-file
limits still apply. Office text is limited to 100,000 Unicode code points per
file and 200,000 per request. The server validates detected type, structure,
ownership, integrity, and quota; the WebView checks shared limits only for early
feedback. PDF checks do not promise sanitization, page-count validation, or
visual rendering.

Supported audio is narrowly defined as RIFF/WAVE containing PCM or IEEE-float
samples, or MP3 containing MPEG-1 or MPEG-2 Layer III frames. Live Smith sends
the complete original file bytes, including embedded metadata. It does not
upload Live's warped, processed, rendered, or mixed output. ID3 metadata is not
executed locally, but the parser is not a cleaning or sanitization step. File
names, embedded metadata, and audio content are untrusted model input.

Audio may enter pending state through ordinary file upload or by copying the
file backing a selected Live Audio Clip, Sample, or Simpler. Neither path is
gated by the current Profile, which allows the user to attach first and select a
compatible Profile before sending. The selected-source command accepts only a
Session ID; no UI or model request can supply an arbitrary path.

Files remain pending until the associated user event is durably appended. A
confirmed append consumes those immutable IDs before provider I/O, including
when the provider later fails. Current files take the request budget first;
historical user files are selected newest-first within the remaining budgets,
then emitted in chronological conversation order. Only selected/current blobs
are opened. Missing, corrupt, incompatible, or omitted historical files degrade
to fixed untrusted markers. Duplicate attachment IDs across events are storage
corruption, and consumed IDs cannot be removed or attached to another prompt.

### Local Skill instructions

Local Skills are provider-neutral system guidance. Before reading attachments
or appending the user event, Live Smith combines the Session's saved active IDs
with installed one-turn `$skill-id` mentions, sorts and deduplicates the result,
and reads and hash-checks only those selected bodies in one storage snapshot.
The prompt and conversation history remain unchanged, and at most four Skills
can guide one request.

The final escaped Skill block is limited to 128 KiB of UTF-8. It follows the
built-in safety instructions and a fixed lower-priority boundary, precedes the
Live action system prompt, and remains identical across all model turns for the
request. Transports receive it only through the ordinary provider system
instruction field. They do not receive Skill IDs, descriptions, hashes, paths,
frontmatter, or a separate Skill protocol field. With no active Skill, the
system text remains byte-for-byte identical to the legacy request.

Skills are locally installed declarative workflow guidance. They cannot install
or execute scripts, binaries, MCP servers, plugins, nested resources, or
arbitrary paths; change provider settings; add tools; or add Live actions. A
Skill never expands the built-in action schema or tool set. Every action remains
subject to observation, schema validation, the selected Approval policy,
preflight, cancellation, process-wide mutation serialization, and state-drift
revalidation. Skill Markdown has lower priority than Live Smith's system and
safety instructions and cannot authorize secrets, filesystem access,
unsupported provider fields, or actions outside the built-in schema.

## Capability resolution

Capabilities resolve in this order:

1. Profile manual overrides.
2. Explicit discovery metadata.
3. Known model policy.
4. Conservative API-mode fallback.

Input capabilities also retain the evidence behind the resolved Boolean. A
manual override wins over a valid discovery hint, which wins over documented
known-model policy. An explicit `false` is unsupported; the conservative
fallback value remains unknown/unverified in the UI rather than being presented
as provider evidence. This distinction gates the corresponding image or native
PDF input. Audio uses the stricter rule above and requires `supported` evidence
in addition to the OpenAI Chat Completions mode. None of these gates ordinary
text sends, local Office text extraction, or creation of a pending attachment.

Anthropic discovery reads the official
`capabilities.image_input.supported` and `capabilities.pdf_input.supported`
fields when they are explicit Booleans. Modality arrays are accepted only as a
secondary compatibility hint, and only when every entry is a string; malformed
or partial values are ignored instead of erasing stronger known-model policy.
Custom OpenAI-compatible model names receive no image capability from name
guessing and require discovery metadata or a manual override.

Unknown models remain usable with standard protocol fields, while explicit
reasoning stays at Provider default until discovery or a manual override says it
is supported. The backend validates capability-dependent parameters again before
every request.

Anthropic discovery treats explicit-disable support conservatively: the UI only
offers Disabled when model metadata, known policy, or a manual override says the
model can disable thinking. Missing discovery fields do not erase known-model
policy; a custom endpoint's explicit capability fields are used when present.
Budget thinking is validated at Profile save and request time; its budget must
be at least 1024 tokens and remain below the requested output-token limit.

An absent output-token limit remains unknown. The 8192 value shown for a new
Profile is only an initial requested value, not a model capability limit. Live
Smith constrains and validates that field only when discovery metadata, known
model policy, or a manual capability override provides an explicit limit.

The discovery cache stores only raw provider metadata. Known-model policy and
manual Profile overrides are applied when the UI is rendered and again when a
request is sent, so removing an override takes effect immediately and cached
policy does not become stale after an extension update.

Reasoning has three modes:

- Provider default: omit explicit controls.
- Disabled: send an explicit disable only when supported.
- Enabled: use the policy's effort, adaptive-thinking, or budget-thinking
  strategy.

## Custom OpenAI-compatible endpoints

Create an OpenAI Profile and choose the protocol the endpoint actually supports.
Enter its base URL exactly as required, including `/v1` when applicable. Use
**Connect & Load** if it implements the OpenAI model-list endpoint, or type the
model ID manually.

Advanced capability overrides describe endpoint/model features without adding a
vendor-specific adapter. Extra Body JSON can add or override nonstandard
generation fields. It cannot replace `model`, `input`/`messages`, `tools`, or
`stream`, because Live Smith owns those structures. Responses additionally
protects `instructions`, `store`, `previous_response_id`, and `conversation` to
enforce instruction and local-state ownership, and always retains
`reasoning.encrypted_content` when merging `include`. Chat Completions also
protects top-level `modalities` and `audio`; audio attachments do not request
audio output. Anthropic Messages likewise protects `system`. Base URLs must not
contain username/password credentials.
Provider connections must use HTTPS. Plain HTTP is accepted only for loopback
providers such as `localhost`, `127.0.0.1`, or `::1`; private-LAN and remote HTTP
endpoints are rejected before a Profile can be saved or used for discovery.

Live context and tool results are sent as explicitly labelled untrusted data.
Track, Clip, Device, parameter, and MIDI names/content never gain instruction
authority merely because they appear in a Live Set or tool response.

## Credential storage

API keys are stored as plain text in Ableton's local extension storage directory.
Use a dedicated key with provider-side spending and rate limits. Do not commit,
share, or cloud-sync the storage directory. Environment variables and `.env`
files are not read as model configuration. On POSIX hosts, Live Smith creates or
tightens its storage directories to mode `0700` and private JSON and attachment
blob files to `0600`.

## Running

```sh
npm test
npm run build
npm run package
npm run verify:package
npm start
```

`npm start` builds the development bundle and launches the Ableton Extensions
CLI. Install/enable the extension in the CLI, then open Live and invoke **Ask
Live Smith** from a supported context menu.
