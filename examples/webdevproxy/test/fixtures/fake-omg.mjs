#!/usr/bin/env node
// A stand-in for `omg mcp -C <dir>`: an MCP stdio server with one tool, `ping`,
// which reports the workspace it was started for. Lets the proxy be tested end
// to end without the real engine or the network.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const args = process.argv.slice(2);
if (args[0] !== "mcp") {
  console.error(`fake-omg: expected \`mcp -C <dir>\`, got ${args.join(" ")}`);
  process.exit(2);
}
const workspace = args[args.indexOf("-C") + 1] ?? null;

const server = new McpServer({ name: "fake-omg", version: "0.0.0" });
server.registerTool("ping", { description: "reports the workspace" }, async () => ({
  content: [{ type: "text", text: JSON.stringify({ workspace, pid: process.pid }) }],
}));
await server.connect(new StdioServerTransport());
