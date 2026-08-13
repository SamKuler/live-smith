# Model Profiles and API Modes

Live Smith has two API families and three supported protocol combinations:

| API family | API mode |
| --- | --- |
| OpenAI | Responses |
| OpenAI | Chat Completions |
| Anthropic | Messages |

There are no endpoint or vendor presets. A compatible service is configured as
an ordinary Profile for the OpenAI or Anthropic protocol family it implements,
with its own base URL, model, API mode, and parameters.

For all three modes, a non-2xx HTTP response reports the API family/mode, status
code, and status text only. Its response body is untrusted and is never read or
persisted, because a provider or proxy can echo prompts, Live context, replay
state, or Extra Body fields in that body. Error events inside a successful SSE
response likewise expose only fixed protocol context, never an arbitrary
provider message.

## Named profiles

Each Profile stores a complete connection:

- name, API family, and API mode;
- base URL and model, plus an API key unless the endpoint is local loopback;
- output limit, optional temperature, and reasoning controls;
- optional provider-hosted Web Search;
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
- Maps an opted-in provider-neutral hosted search tool to `web_search`, keeps
  `web_search_call` items in local replay state, and exposes bounded
  `url_citation` sources to the Session timeline.
- Does not use `previous_response_id`.
- Treats `response.completed` and `response.incomplete` as terminal lifecycle
  events and cancels the reader without waiting for EOF or `[DONE]`.
- Replays an `incomplete: max_output_tokens` response locally and automatically
  continues it at most twice. Partial text and citations are retained, while
  a function call is executable only when the item itself is marked
  `completed`; partial call items are replayed but never executed.
- Rejects other incomplete reasons and rejects executable tool calls unless the
  overall response is complete and every call has a non-empty, unique protocol
  ID, a non-empty function name, and a string argument representation. A
  malformed declared call invalidates the entire turn even when text output is
  also present.

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
- Maps an opted-in provider-neutral hosted search tool to
  `web_search_20250305`, including a fixed local `max_uses` budget. Server tool
  calls, encrypted result content, and citation metadata are replayed unchanged.
- Completes and cancels the stream reader at the protocol-terminal
  `message_stop` event rather than requiring EOF or a nonstandard `[DONE]`.
- Requires a complete `end_turn`, `tool_use`, or `stop_sequence` stop reason.
  A server `pause_turn` is continued internally with the exact assistant
  content, up to three times; truncation, refusal, context exhaustion, unknown
  reasons, and missing terminal metadata fail before any client tool can run.
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

### Provider-hosted Web Search

Hosted Web Search is an explicit Saved Profile setting, not a model-name guess
or a client-tool capability override. It is disabled by default. OpenAI
Responses maps it to `{ "type": "web_search" }`; Anthropic Messages maps it to
the versioned `web_search_20250305` server tool. Each native request gives the
model the remaining portion of a 20-call send budget; this is a ceiling, not a
forced number of searches. Live Smith displays and persists at most 20 distinct
search activities across the complete agent send, shrinking or removing the
tool in later model turns as that bound is reached. If a compatible endpoint
ignores the request field and emits additional activity, Live Smith omits the
overflow without discarding the model's final answer.
OpenAI Chat Completions rejects the hosted tool before body construction or
HTTP rather than switching to a special search model.

Enabling the setting makes hosted search available with automatic tool choice.
Fixed system policy tells the model to search for explicit lookup requests and
current or changing facts, and forbids claiming a search or inventing citations
unless the provider actually executes the server tool. Independently of search,
every factual premise that affects a Live mutation must have evidence in the
current request context or be obtained through an available tool. Missing
evidence is requested from the user when no tool can obtain it; model memory is
not evidence. When hosted search is absent, the request contains an explicit
unavailable capability statement and the model may not promise a search. This
does not require a search when the necessary evidence is already available.

The composer does not contain a second search switch. The saved Profile setting
only makes the hosted tool available; the model decides whether the current
request needs it.

Protocol compatibility is not capability discovery. A compatible Responses
endpoint may omit OpenAI's hosted tool, so the Profile UI does not claim that
model discovery verified search support. Chat Completions disables the control
and announces when changing formats turns an enabled Draft setting off.

Live Smith opens a live Web Search timeline card only after a provider event
indicates search activity. The card shows the bounded query and safe result
pages as they arrive, then reconciles to one persisted terminal card for each
provider call. A provider-reported search error becomes a fixed failed card
with no raw provider error payload or invented result URL. Enabling the Profile
setting or receiving uncited assistant prose cannot create that status.

The provider executes this tool; it never appears as a client `tool_use` for the
Live agent loop to run. Complete provider search blocks remain in opaque local
replay state. OpenAI Responses requests the complete
`web_search_call.action.sources` list; Anthropic uses returned
`web_search_tool_result` pages. Only normalized, bounded HTTP(S) titles and URLs
enter Web Search Session events. Answer citations are stored separately and
only when the provider returns citation annotations, so a reviewed result is
never presented as cited merely because it appeared in the search list. Search
page text stays inside the provider-hosted model context; neither provider
exposes that text as a safe user-facing excerpt in Live Smith's source list.
Search results and citations are untrusted data and cannot authorize a Live tool,
approval, filesystem operation, or mutation.

Protocol references: [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)
and [Anthropic Web Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).

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

## Compatible endpoints

Create an OpenAI or Anthropic Profile for the protocol family the endpoint
actually implements. OpenAI Profiles choose Responses or Chat Completions;
Anthropic Profiles use Messages. Enter the base URL exactly as required,
including `/v1` when applicable. Use **Connect & Load** if the endpoint
implements the corresponding model-list API, or type the model ID manually.

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
Loopback endpoints may leave API key blank, in which case Live Smith omits the
authentication header entirely. Every non-loopback endpoint requires a key.

Live context and tool results are sent as explicitly labelled untrusted data.
Track, Clip, Device, parameter, and MIDI names/content never gain instruction
authority merely because they appear in a Live Set or tool response.

## Credential storage

Configured API keys are stored as plain text in Ableton's local extension
storage directory.
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
