import type { AudioParameterPanel, AudioParameterSuggestions } from "../../plugins/builtins/parameter-panel.js";
export type { AudioParameterPanel } from "../../plugins/builtins/parameter-panel.js";

type Schema = Record<string, unknown>;
type Scalar = string | number | boolean;
interface Draft { included: boolean; value?: unknown; children?: Record<string, Draft>; items?: Draft[]; variant?: number; variants?: Draft[] }
interface AudioTool { name: string; description?: string; audioPanel: AudioParameterPanel }
interface Dependencies {
  getState(): { activeSessionId?: string; integrationConnections?: { revision: string }; plugins?: unknown[]; audioJobs?: unknown[]; sunoAccounts?: { serviceId: string; accountId?: string }[]; events?: { kind: string; name?: string; content: string }[] };
  runCommand(kind: string, input: Record<string, unknown>, options: { cancellable: boolean }): Promise<unknown>;
}
export interface AudioParameterPanels { open(tool: AudioTool, connectionLabel?: string): void; close(): void; sync(): void; setBusy(value: boolean): void }
const record = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown): value is Scalar => typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const keys = new Set(["type", "title", "description", "default", "const", "enum", "properties", "required", "additionalProperties", "items", "oneOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems"]);
const properties = (schema: Schema): Record<string, Schema> => (schema.properties ?? {}) as Record<string, Schema>;
const variants = (schema: Schema): Schema[] | undefined => schema.oneOf as Schema[] | undefined;
const choices = (schema: Schema): Scalar[] | undefined => schema.enum as Scalar[] | undefined;
const fixed = (schema: Schema): boolean => Object.hasOwn(schema, "const") || choices(schema)?.length === 1;
const constant = (schema: Schema): unknown => Object.hasOwn(schema, "const") ? schema.const : choices(schema)?.[0];

function supported(schema: unknown, depth = 0): schema is Schema {
  if (!record(schema) || depth > 12 || Object.keys(schema).some((key) => !keys.has(key))) return false;
  if (["title", "description", "pattern"].some((key) => schema[key] !== undefined && typeof schema[key] !== "string")) return false;
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems"].some((key) => schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key])))) return false;
  if (["minLength", "maxLength", "minItems", "maxItems"].some((key) => schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0))) return false;
  if (schema.minItems !== undefined && Number(schema.minItems) > 256) return false;
  if (schema.multipleOf !== undefined && Number(schema.multipleOf) <= 0) return false;
  if (schema.pattern !== undefined) { try { new RegExp(schema.pattern as string, "u"); } catch { return false; } }
  if (schema.type !== undefined && !["object", "array", "string", "integer", "number", "boolean"].includes(String(schema.type))) return false;
  if (Object.hasOwn(schema, "const") && !scalar(schema.const)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every(scalar))) return false;
  if (schema.oneOf !== undefined && (!Array.isArray(schema.oneOf) || !schema.oneOf.length || !schema.oneOf.every((entry) => supported(entry, depth + 1)))) return false;
  if (schema.properties !== undefined && (!record(schema.properties) || !Object.values(schema.properties).every((entry) => supported(entry, depth + 1)))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string" && Object.hasOwn(properties(schema), name)))) return false;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false;
  if (schema.type === "object" && (!record(schema.properties) || schema.additionalProperties !== false)) return false;
  if (schema.items !== undefined && !supported(schema.items, depth + 1)) return false;
  if (schema.type === "array" && !supported(schema.items, depth + 1)) return false;
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") return false;
  if (!schema.type && !schema.oneOf && !schema.enum && !Object.hasOwn(schema, "const")) return false;
  return schema.default === undefined || valid(schema, schema.default);
}

export function isAudioParameterPanel(value: unknown): value is AudioParameterPanel {
  return record(value) && Object.keys(value).every((key) => ["toolName", "signature", "connectionId", "schema", "suggestions"].includes(key)) &&
    (value.suggestions === undefined || validSuggestions(value.suggestions)) &&
    typeof value.toolName === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.toolName) &&
    typeof value.signature === "string" && /^[a-f0-9]{64}$/u.test(value.signature) &&
    (value.connectionId === undefined || typeof value.connectionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.connectionId)) && JSON.stringify(value.schema ?? null).length <= 32768 && supported(value.schema) &&
    (value.schema.type === "object" || variants(value.schema)?.every((branch) => branch.type === "object") === true);
}

function validSuggestions(value: unknown): value is AudioParameterSuggestions {
  return record(value) && Object.entries(value).every(([kind, entries]) => ["clips", "models", "personas"].includes(kind) &&
    Array.isArray(entries) && entries.length <= 40 && entries.every((entry) => record(entry) &&
      Object.keys(entry).every((key) => key === "id" || key === "label") &&
      typeof entry.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.id) &&
      typeof entry.label === "string" && [...entry.label].length <= 160 && !entry.label.includes("\0")));
}

function valid(schema: Schema, value: unknown): boolean {
  if (Object.hasOwn(schema, "const") && value !== schema.const || choices(schema) && !choices(schema)!.includes(value as Scalar)) return false;
  if (variants(schema) && variants(schema)!.filter((entry) => valid(entry, value)).length !== 1) return false;
  switch (schema.type) {
    case "object": {
      if (!record(value) || Object.keys(value).some((key) => !Object.hasOwn(properties(schema), key))) return false;
      if ((schema.required as string[] | undefined)?.some((key) => !Object.hasOwn(value, key))) return false;
      return Object.entries(value).every(([key, entry]) => valid(properties(schema)[key]!, entry));
    }
    case "array": return Array.isArray(value) && value.length >= Number(schema.minItems ?? 0) && value.length <= Number(schema.maxItems ?? Infinity) &&
      (!schema.uniqueItems || new Set(value.map((entry) => JSON.stringify(entry))).size === value.length) && value.every((entry) => valid(schema.items as Schema, entry));
    case "string": return typeof value === "string" && !value.includes("\0") && [...value].length >= Number(schema.minLength ?? 0) && [...value].length <= Number(schema.maxLength ?? Infinity) &&
      (schema.pattern === undefined || new RegExp(schema.pattern as string, "u").test(value));
    case "integer": case "number": return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) &&
      value >= Number(schema.minimum ?? -Infinity) && value <= Number(schema.maximum ?? Infinity) &&
      value > Number(schema.exclusiveMinimum ?? -Infinity) && value < Number(schema.exclusiveMaximum ?? Infinity) &&
      (schema.multipleOf === undefined || Math.abs(value / Number(schema.multipleOf) - Math.round(value / Number(schema.multipleOf))) < 1e-8);
    case "boolean": return typeof value === "boolean";
    default: return true;
  }
}

function initial(schema: Schema, included = true, seed: unknown = schema.default): Draft {
  const draft: Draft = { included };
  const options = variants(schema);
  if (options) { draft.variant = Math.max(0, options.findIndex((entry) => seed !== undefined && valid(entry, seed))); draft.variants = options.map((entry) => initial(entry, true, seed !== undefined && valid(entry, seed) ? seed : undefined)); }
  else if (schema.type === "object") draft.children = Object.fromEntries(Object.entries(properties(schema)).map(([key, field]) =>
    [key, initial(field, (schema.required as string[] | undefined)?.includes(key) || record(seed) && Object.hasOwn(seed, key) || field.default !== undefined, record(seed) ? seed[key] : field.default)]));
  else if (schema.type === "array") draft.items = Array.isArray(seed) ? seed.map((entry) => initial(schema.items as Schema, true, entry)) : Array.from({ length: Number(schema.minItems ?? 0) }, () => initial(schema.items as Schema));
  else draft.value = fixed(schema) ? constant(schema) : seed ?? choices(schema)?.[0] ?? (schema.type === "boolean" ? false : "");
  return draft;
}
function valueOf(schema: Schema, draft: Draft): unknown {
  if (variants(schema)) return valueOf(variants(schema)![draft.variant!]!, draft.variants![draft.variant!]!);
  if (schema.type === "object") return Object.fromEntries(Object.entries(properties(schema)).filter(([key]) => draft.children![key]!.included)
    .map(([key, field]) => [key, valueOf(field, draft.children![key]!)]));
  if (schema.type === "array") return draft.items!.map((item) => valueOf(schema.items as Schema, item));
  if (fixed(schema)) return constant(schema);
  if (schema.type === "integer" || schema.type === "number") return draft.value === "" ? undefined : Number(draft.value);
  return draft.value;
}

export function createAudioParameterPanels(deps: Dependencies): AudioParameterPanels {
  const t = (value: string, params?: Record<string, string>): string => window.LiveSmithI18n?.t(value, params) ?? value;
  const label = (name: string): string => t(name.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase()));
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element;
  };
  let busy = false;
  let counter = 0;
  let owner = "";
  let active: { dialog: HTMLDialogElement; owner: string; focus: Element | null } | undefined;
  const drafts = new Map<string, Draft>();
  let offeredSuggestions: AudioParameterSuggestions = {};
  let toolName = "";
  function suggestions(path: string): Array<[string, string]> {
    const jobs = (deps.getState().audioJobs ?? []).filter(record);
    if (path.endsWith("jobId")) return jobs.filter((job) => job.resumable === true && typeof job.id === "string").map((job) => [String(job.id), String(job.title ?? job.id)]);
    if (path.endsWith("assetRef")) return jobs.flatMap((job) => Array.isArray(job.outputs) ? job.outputs.filter(record).filter((asset) => typeof asset.id === "string").map((asset): [string, string] => [String(asset.id), String(asset.label ?? asset.id)]) : []);
    const kind = /(?:^|\.)(?:clipId|clipIds(?:\.\d+)?)$/u.test(path) ? "clip" : path.endsWith("personaId") ? "persona" : path.endsWith("modelId") ? "model" : undefined;
    if (!kind) return [];
    const entries = kind === "clip" ? offeredSuggestions.clips : kind === "model" ? offeredSuggestions.models : offeredSuggestions.personas;
    return (entries ?? []).map(({ id, label }) => [id, label]);
  }
  const currentOwner = () => { const state = deps.getState(); return JSON.stringify([state.activeSessionId, state.integrationConnections?.revision, state.plugins,
    (state.sunoAccounts ?? []).map(({ serviceId, accountId }) => [serviceId, accountId]).sort((left, right) => left[0]!.localeCompare(right[0]!))]); };
  const sync = () => { if (owner !== currentOwner()) { close(); drafts.clear(); owner = currentOwner(); } };
  const close = () => { const previous = active; active = undefined; previous?.dialog.remove(); if (previous?.focus instanceof HTMLElement && previous.focus.isConnected) previous.focus.focus(); };

  function render(schema: Schema, draft: Draft, name: string, path: string, required: boolean, checks: (() => boolean)[]): HTMLElement {
    const row = node("div", "audio-parameter-field"); row.dataset.parameterPath = path;
    const title = typeof schema.title === "string" ? t(schema.title) : label(name);
    const heading = node("div", "audio-parameter-heading");
    const caption = node("label", "", title); heading.append(caption); row.append(heading);
    const contents = node("fieldset", "audio-parameter-value"); contents.disabled = !draft.included; contents.setAttribute("aria-label", title); row.append(contents);
    if (!required) {
      const optional = node("label", "audio-parameter-optional"); const include = node("input"); include.type = "checkbox"; include.checked = draft.included;
      include.setAttribute("aria-label", t("Include {name}", { name: title }));
      include.addEventListener("change", () => { draft.included = include.checked; contents.disabled = !draft.included; });
      optional.append(include, document.createTextNode(t("Use parameter"))); heading.append(optional);
    }
    if (schema.description) row.append(node("p", "field-hint", t(String(schema.description))));
    const error = node("p", "audio-parameter-error error"); error.hidden = true; error.setAttribute("role", "alert"); row.append(error);
    const options = variants(schema);
    if (options) {
      row.classList.add("audio-parameter-wide");
      const select = node("select"); select.setAttribute("aria-label", title); select.dataset.variant = path;
      options.forEach((entry, index) => {
        const discriminator = Object.entries(properties(entry)).find(([key, field]) => key !== "connectionId" && Object.hasOwn(field, "const"));
        const text = typeof entry.title === "string" ? t(entry.title) : discriminator ? label(String(discriminator[1].const)) :
          properties(entry).options ? t("Custom lyrics") : properties(entry).prompt ? t("Description") : t("Mode {number}", { number: String(index + 1) });
        const option = node("option", "", text); option.value = String(index); select.append(option);
      });
      select.value = String(draft.variant); contents.append(select);
      const region = node("div", "audio-parameter-variant"); contents.append(region);
      let branchChecks: (() => boolean)[] = [];
      const paint = () => { branchChecks = []; region.replaceChildren(render(options[draft.variant!]!, draft.variants![draft.variant!]!, name, path + ".variant", true, branchChecks)); };
      select.addEventListener("change", () => { draft.variant = Number(select.value); paint(); }); paint();
      checks.push(() => !draft.included || branchChecks.map((check) => check()).every(Boolean));
    } else if (schema.type === "object") {
      row.classList.add("audio-parameter-wide", "audio-parameter-object"); contents.classList.add("audio-parameter-grid");
      const children: (() => boolean)[] = [];
      for (const [key, field] of Object.entries(properties(schema))) {
        if (key === "connectionId" && fixed(field)) continue;
        contents.append(render(field, draft.children![key]!, key, path ? path + "." + key : key, (schema.required as string[] | undefined)?.includes(key) ?? false, children));
      }
      checks.push(() => !draft.included || children.map((check) => check()).every(Boolean));
    } else if (schema.type === "array") {
      row.classList.add("audio-parameter-wide");
      const itemSchema = schema.items as Schema;
      let itemChecks: (() => boolean)[] = [];
      if (choices(itemSchema) && schema.uniqueItems) {
        draft.items = draft.items!.filter((item, index, items) => items.findIndex((other) => other.value === item.value) === index);
        for (const choice of choices(itemSchema)!) {
          const option = node("label", "audio-parameter-choice"); const input = node("input"); input.type = "checkbox";
          input.checked = draft.items!.some((item) => item.value === choice);
          input.addEventListener("change", () => { draft.items = choices(itemSchema)!.filter((entry) => entry === choice ? input.checked : draft.items!.some((item) => item.value === entry))
            .map((value) => ({ included: true, value })); });
          option.append(input, document.createTextNode(label(String(choice)))); contents.append(option);
        }
      } else {
        const list = node("div", "audio-parameter-items"); const add = node("button", "secondary", t("Add item")); add.type = "button";
        const paint = () => {
          itemChecks = []; list.replaceChildren();
          draft.items!.forEach((item, index) => {
            const wrapper = node("div", "audio-parameter-item");
            wrapper.append(render(itemSchema, item, t("Item {number}", { number: String(index + 1) }), path + "." + index, true, itemChecks));
            const remove = node("button", "secondary", t("Remove")); remove.type = "button"; remove.setAttribute("aria-label", t("Remove item {number}", { number: String(index + 1) }));
            remove.addEventListener("click", () => { draft.items!.splice(index, 1); paint(); add.focus(); }); wrapper.append(remove); list.append(wrapper);
          });
          add.disabled = draft.items!.length >= Number(schema.maxItems ?? Infinity);
        };
        add.addEventListener("click", () => { draft.items!.push(initial(itemSchema)); paint(); list.lastElementChild?.querySelector<HTMLElement>("input,textarea,select")?.focus(); });
        contents.append(list, add); paint();
      }
      checks.push(() => !draft.included || itemChecks.map((check) => check()).every(Boolean));
    } else if (fixed(schema)) {
      contents.append(node("span", "audio-parameter-fixed", label(String(constant(schema)))));
    } else {
      const id = "audio-parameter-" + ++counter;
      let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (choices(schema)) {
        control = node("select");
        choices(schema)!.forEach((value, index) => { const option = node("option", "", label(String(value))); option.value = String(index); control.append(option); });
        control.value = String(choices(schema)!.indexOf(draft.value as Scalar));
      } else if (schema.type === "string" && schema.pattern === undefined && (schema.maxLength === undefined || Number(schema.maxLength) > 256)) {
        control = node("textarea"); control.rows = Number(schema.maxLength) >= 3000 ? 8 : 3; control.value = String(draft.value); row.classList.add("audio-parameter-wide");
      } else {
        control = node("input"); control.type = schema.type === "boolean" ? "checkbox" : ["number", "integer"].includes(String(schema.type)) ? "number" : "text";
        if (control.type === "checkbox") control.checked = Boolean(draft.value); else control.value = String(draft.value);
        if (control.type === "number") { control.step = schema.type === "integer" ? "1" : "any"; if (schema.minimum !== undefined) control.min = String(schema.minimum); if (schema.maximum !== undefined) control.max = String(schema.maximum); }
      }
      control.id = id; control.name = path; caption.htmlFor = id; if (required) control.setAttribute("aria-required", "true");
      const update = () => { draft.value = choices(schema) ? choices(schema)![Number(control.value)] : control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value; control.setCustomValidity(""); error.hidden = true; };
      control.addEventListener("input", update); control.addEventListener("change", update);
      if (!choices(schema) && ["number", "integer"].includes(String(schema.type)) && schema.minimum !== undefined && schema.maximum !== undefined && Number(schema.minimum) < Number(schema.maximum)) {
        const range = node("input"); range.type = "range"; range.min = String(schema.minimum); range.max = String(schema.maximum); range.step = String(schema.multipleOf ?? (schema.type === "integer" ? 1 : "any")); range.value = String(draft.value || schema.minimum); range.setAttribute("aria-label", title);
        range.addEventListener("input", () => { control.value = range.value; update(); }); control.addEventListener("input", () => { range.value = control.value; }); contents.classList.add("audio-parameter-numeric"); contents.append(range);
      }
      if (control instanceof HTMLInputElement && control.type === "text") {
        const values = suggestions(path);
        if (values.length) {
          const list = node("datalist"); list.id = id + "-suggestions";
          for (const [value, text] of values) { const option = node("option"); option.value = value; option.label = text; list.append(option); }
          control.setAttribute("list", list.id); contents.append(list);
        }
        if (path.endsWith("modelId")) row.append(node("p", "field-hint", t(toolName.endsWith("write_lyrics") ? "Run Inspect lyric models to load this connection's lyrics model IDs." : "Run the catalog query in Inspect music service to load this connection's model IDs.")));
        if (path.endsWith("personaId")) row.append(node("p", "field-hint", t("Inspect a Persona ID from your Suno account first; confirmed results appear as suggestions.")));
        if (/(?:^|\.)(?:clipId|clipIds(?:\.\d+)?)$/u.test(path)) row.append(node("p", "field-hint", t("Choose a clip ID from this connection's library or saved jobs.")));
      }
      contents.append(control);
      checks.push(() => { const okay = !draft.included || valid(schema, valueOf(schema, draft)); control.setCustomValidity(okay ? "" : t("Check the value for {name}.", { name: title })); return okay; });
    }
    checks.push(() => { const okay = !draft.included || valid(schema, valueOf(schema, draft)); error.hidden = okay; error.textContent = okay ? "" : t("Check the value for {name}.", { name: title }); return okay; });
    return row;
  }

  return {
    open(tool, connectionLabel) {
      sync(); close(); if (!deps.getState().activeSessionId) return;
      const dialog = node("dialog", "audio-parameter-dialog"); const focus = document.activeElement;
      active = { dialog, owner, focus }; const opened = active;
      const heading = node("h3", "", label(tool.name)); heading.id = "audio-parameter-title"; dialog.setAttribute("aria-labelledby", heading.id);
      const dismiss = node("button", "secondary", t("Close")); dismiss.type = "button"; dismiss.addEventListener("click", close);
      const header = node("header", "audio-parameter-header"); header.append(heading, dismiss); dialog.append(header);
      if (connectionLabel) dialog.append(node("p", "audio-parameter-connection", connectionLabel));
      if (tool.description) { const details = node("details", "audio-parameter-description"); details.append(node("summary", "", t("Tool details")), node("p", "", tool.description)); dialog.append(details); }
      const form = node("form", "audio-parameter-form"); form.noValidate = true; dialog.append(form);
      if (!isAudioParameterPanel(tool.audioPanel)) form.append(node("p", "error", t("This tool's parameters cannot be edited here.")));
      else {
        const panel = tool.audioPanel; offeredSuggestions = panel.suggestions ?? {}; toolName = panel.toolName; const key = JSON.stringify([panel.toolName, panel.signature, panel.connectionId, panel.schema]);
        if (!drafts.has(key)) drafts.set(key, initial(panel.schema)); const draft = drafts.get(key)!;
        const checks: (() => boolean)[] = []; const fields = render(panel.schema, draft, "Parameters", "", true, checks); fields.classList.add("audio-parameter-root"); form.append(fields);
        form.append(node("p", "field-hint", t("Running uses the current connection's allowance. Results appear in this Session's audio area or tool history.")));
        const run = node("button", "primary", t("Run tool")); run.type = "submit"; run.disabled = busy; const footer = node("footer", "audio-parameter-footer"); footer.append(run); form.append(footer);
        form.addEventListener("submit", async (event) => {
          event.preventDefault(); if (busy || active !== opened || owner !== currentOwner()) return;
          const okay = checks.map((check) => check()).every(Boolean); if (!okay) { form.reportValidity(); return; }
          const argumentsValue = valueOf(panel.schema, draft); if (!record(argumentsValue)) return;
          const sessionId = deps.getState().activeSessionId; close();
          await deps.runCommand("run_audio_tool", { sessionId, toolName: panel.toolName, signature: panel.signature, arguments: argumentsValue }, { cancellable: true });
        });
      }
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
      document.body.append(dialog); if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); dismiss.focus();
    }, close, sync,
    setBusy(value) {
      busy = value;
      const run = active?.dialog.querySelector<HTMLButtonElement>("button[type=submit]");
      if (run) run.disabled = busy;
    },
  };
}
window.LiveSmithFactories = window.LiveSmithFactories || {};
window.LiveSmithFactories.createAudioParameterPanels = createAudioParameterPanels;
window.LiveSmithFactories.isAudioParameterPanel = isAudioParameterPanel;
