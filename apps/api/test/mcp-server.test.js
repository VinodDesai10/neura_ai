import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

for (const name of [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "MONGODB_URI",
  "POSTGRES_URL",
  "REDIS_URL",
  "QDRANT_URL",
  "NEO4J_URI"
]) {
  process.env[name] = "";
}

const { requestHandler } = await import("../src/app.js");

test("MCP memory app exposes and executes the memory turn tools", async () => {
  const httpServer = createServer(requestHandler);
  await new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");

  const client = new Client(
    { name: "neura-mcp-test-client", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:" + address.port + "/mcp")
  );

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["neura_retrieve_context", "neura_record_turn"]
    );
    assert.match(client.getInstructions(), /neura_retrieve_context/);
    assert.match(client.getInstructions(), /neura_record_turn/);

    const retrieved = await client.callTool({
      name: "neura_retrieve_context",
      arguments: { message: "What do you know about my current work?" }
    });
    assert.equal(retrieved.isError, undefined);
    assert.equal(
      retrieved.structuredContent.workingMemory.recentContext.length,
      0
    );

    const recorded = await client.callTool({
      name: "neura_record_turn",
      arguments: {
        userMessage: "Remember that I am testing the Neura ChatGPT app.",
        assistantResponse: "I will remember that you are testing the Neura ChatGPT app.",
        turnId: "mcp-test-turn"
      }
    });
    assert.equal(recorded.structuredContent.stored, true);
    assert.equal(recorded.structuredContent.deduplicated, false);
    assert.equal(recorded.structuredContent.memoryJobsQueued, 2);

    const afterRecord = await client.callTool({
      name: "neura_retrieve_context",
      arguments: { message: "What do you know about testing the Neura app?" }
    });
    assert.equal(
      afterRecord.structuredContent.workingMemory.recentContext.length,
      2
    );

    const duplicate = await client.callTool({
      name: "neura_record_turn",
      arguments: {
        userMessage: "Remember that I am testing the Neura ChatGPT app.",
        assistantResponse: "I will remember that you are testing the Neura ChatGPT app.",
        turnId: "mcp-test-turn"
      }
    });
    assert.equal(duplicate.structuredContent.stored, true);
    assert.equal(duplicate.structuredContent.deduplicated, true);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
