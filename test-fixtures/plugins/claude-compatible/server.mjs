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
        serverInfo: { name: "fixture.claude", version: "1.0.0" }
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
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false
          }
        }]
      }
    });
  } else if (request.method === "tools/call") {
    const text = String(request.params.arguments?.text ?? "");
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text }],
        structuredContent: { echoed: text }
      }
    });
  }
});
