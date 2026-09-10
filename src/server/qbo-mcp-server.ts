import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class QuickbooksMCPServer {
  private static instance: McpServer | null = null;

  /* istanbul ignore next -- private, exists only to force static-only use */
  private constructor() {}

  /**
   * A brand new server instance.
   *
   * Under streamable-http every request builds its own server and transport.
   * The SDK routes responses by the client's JSON-RPC request id, so sharing
   * one instance across concurrent clients would let two sessions that both
   * send id 1 receive each other's replies -- financial data crossing sessions.
   */
  public static CreateServer(): McpServer {
    return new McpServer(
      {
        name: "QuickBooks Online MCP Server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  }

  /** The process-wide instance, used by the stdio transport. */
  public static GetServer(): McpServer {
    if (QuickbooksMCPServer.instance === null) {
      QuickbooksMCPServer.instance = QuickbooksMCPServer.CreateServer();
    }
    return QuickbooksMCPServer.instance;
  }
}
