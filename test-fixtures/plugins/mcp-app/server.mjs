import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { URL } from "node:url";

const RESOURCE_URI = "ui://pattern-lab/app.html";
const MIME_TYPE = "text/html;profile=mcp-app";
const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");
const defaultStyle = process.env.DEFAULT_STYLE === "jazz" ? "jazz" : "ambient";
const configuredBars = Number(process.env.DEFAULT_BARS ?? 8);
const defaultBars = Number.isFinite(configuredBars) && configuredBars >= 1 && configuredBars <= 8 ? Math.round(configuredBars) : 4;
let callCount = 0;
let generatedCount = 0;

const tools = [{
  name: "pattern_lab",
  description: "Build a deterministic D minor MIDI note pattern from a prompt. Opens the Pattern lab workbench.",
  inputSchema: {
    type: "object",
    properties: {
      outputMidi: { type: "string", description: "Host-owned MIDI output path." },
      prompt: { type: "string", title: "Prompt", minLength: 1, maxLength: 4096 },
      bars: { type: "number", title: "Bars", minimum: 1, maximum: 8, multipleOf: 1, default: defaultBars },
    },
    required: ["prompt", "bars", "outputMidi"], additionalProperties: false,
  },
  _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["model", "app"] },
    "io.github.samkuler/live-smith-artifacts": { version: 1, inputs: [],
      outputs: [{ argument: "outputMidi", kind: "midi", label: "Pattern lab MIDI" }] } },
}, {
  name: "get_settings",
  description: "Read saved workbench defaults and the current server call count.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  _meta: { ui: { visibility: ["app"] } },
}];

function pattern(argumentsValue) {
  const args = argumentsValue ?? {};
  if (typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some((key) => key !== "prompt" && key !== "bars" && key !== "outputMidi") ||
      typeof args.outputMidi !== "string" || !args.outputMidi ||
      typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 4096 ||
      !Number.isInteger(args.bars) || args.bars < 1 || args.bars > 8) {
    return { isError: true, content: [{ type: "text", text: "Enter a prompt and a whole number of bars from one to eight." }] };
  }
  const styleMatch = /^Style: (ambient|jazz)$/mu.exec(args.prompt);
  const style = styleMatch?.[1] ?? defaultStyle;
  let seed = 2166136261;
  for (const character of args.prompt) seed = Math.imul(seed ^ character.codePointAt(0), 16777619) >>> 0;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const scale = [50, 53, 55, 57, 60, 62, 65, 67, 69];
  const steps = style === "jazz" ? 8 : 4;
  const notes = Array.from({ length: args.bars * steps }, (_unused, index) => ({
    pitch: scale[next() % scale.length],
    startBeat: Math.floor(index / steps) * 4 + index % steps * (4 / steps) + (style === "jazz" && index % 2 ? 0.12 : 0),
    durationBeats: style === "jazz" ? 0.32 : 0.82,
    velocity: 66 + next() % 35,
  }));
  writeFileSync(args.outputMidi, midiFile(notes, args.bars * 4), { flag: "wx", mode: 0o600 });
  generatedCount += 1;
  return {
    content: [{ type: "text", text: `${args.bars} bars of ${style} notes in D minor: ${notes.length} notes.` }],
    structuredContent: { kind: "pattern", prompt: args.prompt, bars: args.bars, key: "D minor", style, notes, callCount, generatedCount },
  };
}

function midiFile(notes, durationBeats) {
  const ticksPerBeat = 480;
  const events = notes.flatMap((note) => [
    { tick: Math.round(note.startBeat * ticksPerBeat), bytes: [0x90, note.pitch, note.velocity] },
    { tick: Math.round((note.startBeat + note.durationBeats) * ticksPerBeat), bytes: [0x80, note.pitch, 0] },
  ]).sort((a, b) => a.tick - b.tick || a.bytes[0] - b.bytes[0]);
  events.push({ tick: durationBeats * ticksPerBeat, bytes: [0xff, 0x2f, 0] });
  let previous = 0;
  const track = [];
  for (const event of events) {
    let delta = event.tick - previous;
    const encoded = [delta & 0x7f];
    while ((delta >>>= 7)) encoded.unshift((delta & 0x7f) | 0x80);
    track.push(...encoded, ...event.bytes);
    previous = event.tick;
  }
  const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0]);
  const chunk = Buffer.alloc(8);
  chunk.write("MTrk"); chunk.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, chunk, Buffer.from(track)]);
}

function handle(request) {
  switch (request.method) {
    case "server/discover": return { error: { code: -32601, message: "Legacy initialize supported." } };
    case "initialize": return { result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fixture.mcp-app", version: "1.0.0" },
    } };
    case "ping": return { result: {} };
    case "tools/list": return { result: { tools } };
    case "resources/list": return { result: { resources: [{ uri: RESOURCE_URI, name: "Pattern lab", mimeType: MIME_TYPE }] } };
    case "resources/templates/list": return { result: { resourceTemplates: [] } };
    case "resources/read": return request.params?.uri === RESOURCE_URI
      ? { result: { contents: [{ uri: RESOURCE_URI, mimeType: MIME_TYPE, text: html, _meta: { ui: { prefersBorder: true } } }] } }
      : { error: { code: -32602, message: "Resource is unavailable." } };
    case "tools/call": {
      if (!tools.some((tool) => tool.name === request.params?.name)) return { error: { code: -32602, message: "Tool is unavailable." } };
      callCount += 1;
      if (request.params.name === "pattern_lab") return { result: pattern(request.params.arguments) };
      if (Object.keys(request.params.arguments ?? {}).length) return { error: { code: -32602, message: "Settings takes no arguments." } };
      return { result: { content: [{ type: "text", text: `Default style: ${defaultStyle}. Default length: ${defaultBars} bars. Server calls: ${callCount}.` }],
        structuredContent: { kind: "settings", defaultStyle, defaultBars, callCount, generatedCount } } };
    }
    default: return { error: { code: -32601, message: "Method is unavailable." } };
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); }
  catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } })}\n`); return; }
  if (request.id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...handle(request) })}\n`);
});
