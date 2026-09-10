#!/usr/bin/env node

import {
  connectStdio,
  connectStreamableHttp,
  resolveTransportMode,
} from "./server/transport.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { registerAllTools } from "./server/register-tools.js";

const main = async () => {
  // stdio keeps a single process-wide server: one client, one process.
  // streamable-http builds a server per request instead, because the SDK routes
  // responses by the client's JSON-RPC id and concurrent clients reuse ids.
  if (resolveTransportMode() === "streamable-http") {
    const { host, port } = await connectStreamableHttp(() => {
      const perRequest = QuickbooksMCPServer.CreateServer();
      registerAllTools(perRequest);
      return perRequest;
    });
    // stdout carries the MCP protocol under stdio, so log to stderr only.
    console.error(`QuickBooks MCP server listening on http://${host}:${port}/mcp`);
  } else {
    const server = QuickbooksMCPServer.GetServer();
    registerAllTools(server);
    await connectStdio(server);
  }
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});