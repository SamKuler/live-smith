import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";

interface Note { pitch: number; startBeat: number; durationBeats: number; velocity: number }
interface Pattern { kind: "pattern"; bars: number; key: string; style: string; notes: Note[]; callCount: number; generatedCount: number }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const prompt = element<HTMLTextAreaElement>("prompt");
const lyrics = element<HTMLTextAreaElement>("lyrics");
const bars = element<HTMLInputElement>("bars");
const generate = element<HTMLButtonElement>("generate");
const status = element("status");
let mode: "instrumental" | "lyrics" = "instrumental";
let style = "ambient";
let edited = false;
let receivedInput = false;
let disposed = false;
let pending: AbortController | undefined;
const app = new App({ name: "Pattern lab", version: "1.0.0" }, { availableDisplayModes: ["inline"] });

function setMode(next: typeof mode): void {
  mode = next;
  for (const candidate of ["instrumental", "lyrics"] as const) {
    const selected = candidate === mode;
    const tab = element<HTMLButtonElement>(candidate + "Tab");
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element(candidate + "Panel").hidden = !selected;
  }
}

function setStyle(next: string): void {
  style = next === "jazz" ? "jazz" : "ambient";
  document.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.style === style));
  });
}

function updateBars(): void { element("barsLabel").textContent = `${bars.value} bars`; }

const svgNode = (name: string, attributes: Record<string, string>, text?: string): SVGElement => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};
const noteName = (pitch: number): string => `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][pitch % 12]}${Math.floor(pitch / 12) - 1}`;

function drawRoll(pattern?: Pattern): void {
  const svg = document.getElementById("pianoRoll")!;
  svg.replaceChildren();
  const length = pattern?.bars ?? Number(bars.value);
  svg.append(svgNode("title", {}, pattern ? `${pattern.notes.length} notes across ${length} bars in ${pattern.key}` : "Empty D minor piano roll"));
  for (let row = 0; row < 24; row += 1) {
    const pitch = 72 - row;
    const y = 24 + row * 8;
    svg.append(svgNode("rect", { x: "38", y: String(y), width: "714", height: "8", fill: [1, 3, 6, 8, 10].includes(pitch % 12) ? "#25292b" : "#333a3d" }));
    if (pitch % 12 === 0) svg.append(svgNode("text", { x: "6", y: String(y + 7), fill: "#abb5b5", "font-size": "8", "font-family": "monospace" }, noteName(pitch)));
  }
  for (let beat = 0; beat <= length * 4; beat += 1) {
    const x = 38 + beat / (length * 4) * 714;
    svg.append(svgNode("line", { x1: String(x), x2: String(x), y1: "24", y2: "216", stroke: "#495456", "stroke-width": beat % 4 === 0 ? "1.3" : ".4" }));
    if (beat % 4 === 0 && beat < length * 4) svg.append(svgNode("text", { x: String(x + 4), y: "14", fill: "#abb5b5", "font-size": "9", "font-family": "monospace" }, String(beat / 4 + 1)));
  }
  for (const note of pattern?.notes ?? []) {
    const x = 38 + note.startBeat / (length * 4) * 714;
    const y = 24 + (72 - note.pitch) * 8;
    const rect = svgNode("rect", { x: String(x + 1), y: String(y + 1), width: String(Math.max(3, note.durationBeats / (length * 4) * 714 - 2)), height: "6", rx: "1", fill: "#83b3ab", opacity: String(.5 + note.velocity / 254) });
    rect.append(svgNode("title", {}, `${noteName(note.pitch)} · beat ${note.startBeat + 1} · velocity ${note.velocity}`));
    svg.append(rect);
  }
  svg.setAttribute("aria-label", pattern ? `${length}-bar ${pattern.style} pattern in ${pattern.key}` : "Empty piano roll");
}

function renderResult(result: CallToolResult): void {
  if (disposed) return;
  if (result.isError) {
    status.textContent = result.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") || "The pattern could not be generated.";
    return;
  }
  const value = result.structuredContent;
  if (!record(value) || value.kind !== "pattern" || !Number.isInteger(value.bars) || Number(value.bars) < 1 || Number(value.bars) > 8 ||
      typeof value.key !== "string" || typeof value.style !== "string" ||
      !Array.isArray(value.notes) || value.notes.length > 64 || value.notes.some((note: Note) =>
        !note || !Number.isInteger(note.pitch) || note.pitch < 49 || note.pitch > 72 ||
        !Number.isFinite(note.startBeat) || note.startBeat < 0 || note.startBeat >= Number(value.bars) * 4 ||
        !Number.isFinite(note.durationBeats) || note.durationBeats <= 0 || note.durationBeats > 4 ||
        !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 127)) return;
  const pattern = value as unknown as Pattern;
  drawRoll(pattern);
  element("callCount").textContent = String(pattern.callCount);
  element("patternSummary").textContent = `${pattern.bars} bars · ${pattern.notes.length} notes · ${pattern.key}`;
  element("resultTag").textContent = `${pattern.style.toUpperCase()} · ${pattern.generatedCount}`;
  element("empty").hidden = true;
  element("noteDetails").hidden = false;
  element("notesList").replaceChildren(...pattern.notes.map((note) => {
    const item = document.createElement("li");
    item.textContent = `${noteName(note.pitch).padEnd(3)}  bar ${Math.floor(note.startBeat / 4) + 1} · beat ${(note.startBeat % 4 + 1).toFixed(2)}`;
    return item;
  }));
  const metadata = result._meta?.["io.github.samkuler/live-smith-artifacts"];
  const saved = record(metadata) && metadata.version === 1 && Array.isArray(metadata.artifacts) &&
    metadata.artifacts.some((artifact) => record(artifact) && artifact.kind === "midi" && typeof artifact.artifactRef === "string");
  status.textContent = saved ? "MIDI saved in this Session. Use the result controls to continue in chat or add it to Live."
    : "Pattern ready. Edit the source to explore another variation.";
}

app.ontoolinput = ({ arguments: input }) => {
  if (edited || !input || !Object.keys(input).length) return;
  receivedInput = true;
  if (typeof input.prompt === "string") {
    const text = input.prompt;
    const selectedMode = /^Mode: (instrumental|lyrics)$/mu.exec(text)?.[1];
    const selectedStyle = /^Style: (ambient|jazz)$/mu.exec(text)?.[1];
    if (selectedMode) setMode(selectedMode as typeof mode);
    if (selectedStyle) setStyle(selectedStyle);
    const body = text.replace(/^Mode: (?:instrumental|lyrics)\nStyle: (?:ambient|jazz)\n\n/u, "");
    (mode === "lyrics" ? lyrics : prompt).value = body.slice(0, 3000);
  }
  if (typeof input.bars === "number") bars.value = String(Math.min(8, Math.max(1, Math.round(input.bars))));
  updateBars();
};
app.ontoolresult = renderResult;
app.ontoolcancelled = () => { pending?.abort(); status.textContent = "Pattern generation stopped."; };
app.onteardown = async () => { disposed = true; pending?.abort(); return {}; };

document.querySelectorAll<HTMLButtonElement>("[data-style]").forEach((button) => button.addEventListener("click", () => {
  edited = true; setStyle(button.dataset.style!);
}));
for (const candidate of ["instrumental", "lyrics"] as const) {
  const tab = element<HTMLButtonElement>(candidate + "Tab");
  tab.addEventListener("click", () => { edited = true; setMode(candidate); });
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); edited = true;
    setMode(event.key === "Home" ? "instrumental" : event.key === "End" ? "lyrics" : mode === "lyrics" ? "instrumental" : "lyrics");
    element<HTMLButtonElement>(mode + "Tab").focus();
  });
}
for (const input of [prompt, lyrics, bars]) input.addEventListener("input", () => { edited = true; updateBars(); });
generate.addEventListener("click", async () => {
  const source = (mode === "lyrics" ? lyrics : prompt).value.trim();
  if (!source) { status.textContent = "Add a few words before generating a pattern."; return; }
  generate.disabled = true;
  status.textContent = "Building note pattern…";
  pending = new AbortController();
  try {
    renderResult(await app.callServerTool({ name: "pattern_lab", arguments: {
      prompt: `Mode: ${mode}\nStyle: ${style}\n\n${source}`, bars: Number(bars.value),
    } }, { signal: pending.signal }));
  } catch { if (!disposed) status.textContent = "The result was not confirmed. Check Session history before generating again."; }
  finally { pending = undefined; if (!disposed) generate.disabled = false; }
});

drawRoll();
void (async () => {
  try {
    await app.connect();
    if (disposed) return;
    const result = await app.callServerTool({ name: "get_settings", arguments: {} });
    const settings = result.structuredContent;
    if (disposed) return;
    if (!record(settings) || settings.kind !== "settings") throw new Error("Saved defaults are unavailable.");
    element("callCount").textContent = String(settings.callCount);
    element("savedDefaults").textContent = `Saved default: ${settings.defaultStyle} · ${settings.defaultBars} bars`;
    if (!edited && !receivedInput) {
      setStyle(String(settings.defaultStyle));
      bars.value = String(Math.min(8, Math.max(1, Math.round(Number(settings.defaultBars)))));
      updateBars(); drawRoll();
    }
    if (!element("empty").hidden) status.textContent = "Ready to build a note pattern.";
    generate.disabled = false;
  } catch { if (!disposed) status.textContent = "The workbench could not connect. Close the App and reopen it."; }
})();
