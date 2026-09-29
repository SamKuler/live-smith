import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  } else if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture.portable", version: "1.0.0" }
      }
    });
  } else if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{
          name: "echo",
          description: "Echo fixture text",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", title: "Text", maxLength: 256 },
              repeat: { type: "integer", title: "Repetitions", minimum: 1, maximum: 8, default: 1 },
              letterCase: { type: "string", title: "Letter case", enum: ["original", "upper", "lower"], default: "original" },
              showLength: { type: "boolean", title: "Include character count", default: false }
            },
            required: ["text"],
            additionalProperties: false
          }
        }]
      }
    });
  } else if (request.method === "tools/call") {
    const args = request.params.arguments || {};
    let text = String(args.text ?? "");
    if (args.letterCase === "upper") text = text.toUpperCase();
    if (args.letterCase === "lower") text = text.toLowerCase();
    text = Array(args.repeat ?? 1).fill(text).join(" ");
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text }],
        structuredContent: { echoed: text, ...(args.showLength ? { characters: [...text].length } : {}) }
      }
    });
  }
});
