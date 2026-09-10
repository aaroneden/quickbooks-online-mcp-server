import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Anything that can accept a transport. Structural rather than tied to a
 * concrete class, so this works with both the high-level McpServer and the
 * low-level Server without forcing a cast at the call site.
 */
export type ConnectableServer = {
  connect(transport: Transport): Promise<void>;
};

/**
 * Transport selection for the QuickBooks MCP server.
 *
 * stdio is the default and remains correct for local development and for any
 * client that spawns the server itself. It is a 1:1 transport: the pipe is the
 * connection, so one client means one process. A host that opens many sessions
 * therefore spawns one server process per session, which is what exhausted the
 * openclaw gateway's live-runtime cap and left ~256 idle copies of this server
 * resident.
 *
 * streamable-http runs the server once as a daemon and lets every session share
 * it. Stateless mode (sessionIdGenerator: undefined) is what makes that sharing
 * safe: no session state is retained between requests, so concurrent clients
 * cannot observe each other.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8933;
const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type TransportMode = "stdio" | "streamable-http";

export function resolveTransportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  // Anything unrecognised falls back to stdio. Defaulting an unknown value to
  // the network transport would silently open a listening port.
  return env.MCP_TRANSPORT === "streamable-http" ? "streamable-http" : "stdio";
}

export function resolveBindAddress(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  const port = Number.parseInt(env.MCP_PORT ?? "", 10);
  // Port 0 is meaningful: it asks the kernel for a free port. Tests rely on it
  // so they never collide with a running daemon on the default port.
  const usable = Number.isInteger(port) && port >= 0 && port < 65536;
  return {
    // Localhost by default. This server holds QuickBooks OAuth credentials, so
    // it must not be reachable off-box unless that is asked for explicitly.
    host: env.MCP_HOST || DEFAULT_HOST,
    port: usable ? port : DEFAULT_PORT,
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        // JSON.parse only ever throws SyntaxError.
        reject(error as Error);
      }
    });
  });
}

/**
 * The HTTP request handler, separated from server construction so its fallback
 * paths can be exercised directly. Reaching them through a real socket is not
 * possible: Node always populates req.url, and any HTTP client sends a Host
 * header.
 */
export function createMcpRequestHandler(options: {
  getTransport: () => { handleRequest: (req: any, res: any, body?: unknown) => Promise<void> };
  fallbackHost: string;
}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? options.fallbackHost}`);
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await options.getTransport().handleRequest(req, res, body);
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
    })();
  };
}

export async function connectStdio(server: ConnectableServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}

export async function connectStreamableHttp(
  server: ConnectableServer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const { host, port: requestedPort } = resolveBindAddress(env);

  // The listener starts first so the real port is known before the transport is
  // built: with port 0 the kernel picks it, and the DNS-rebinding allowlist has
  // to name the port that was actually bound.
  let transport: StreamableHTTPServerTransport;

  const httpServer = createServer(
    createMcpRequestHandler({
      getTransport: () => transport,
      fallbackHost: host,
    }),
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  /* istanbul ignore next -- address() is always an AddressInfo for a TCP listener */
  const port = (httpServer.address() as AddressInfo | null)?.port ?? requestedPort;

  transport = new StreamableHTTPServerTransport({
    // Stateless: no per-session state, so one transport serves every client.
    sessionIdGenerator: undefined,
    // A localhost port is reachable by any page the browser loads, so a
    // malicious site could POST to it via DNS rebinding. Binding to 127.0.0.1
    // does not prevent that on its own; host validation does.
    enableDnsRebindingProtection: true,
    allowedHosts: [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`],
  });

  await server.connect(transport);

  return {
    host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
