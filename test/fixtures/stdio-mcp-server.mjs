import readline from "node:readline";

const respond = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "test-stdio-server", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "echo",
          description: "Echoes an input value.",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
    });
  }
});
