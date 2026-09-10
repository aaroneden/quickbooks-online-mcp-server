import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Transport selection for the QuickBooks MCP server.
 *
 * stdio is the default and remains correct for local development and for any
 * client that spawns the server itself. It is a 1:1 transport: the pipe is the
 * connection, so one client means one process. A host that opens many sessions
 * therefore spawns one server process per session, which is what exhausted the
 * openclaw gateway's live-runtime cap and left ~256 idle copies resident.
 *
 * streamable-http runs one process and builds a server and transport PER
 * REQUEST. That per-request part is not incidental. The SDK routes responses
 * using the client's own JSON-RPC request id:
 *
 *     this._requestToStreamMapping.set(message.id, streamId)
 *
 * Every MCP client numbers its requests from 1, so two concurrent sessions that
 * both send id 1 against a shared transport would have their replies swapped --
 * one session's QuickBooks data delivered to another. The SDK's own README says
 * to build a transport per request in stateless mode for exactly this reason.
 *
 * Per-request state also cannot accumulate: there is no session map to leak,
 * which is the failure this whole change exists to remove.
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8933;
const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PORT_PATTERN = /^[0-9]{1,5}$/;

export type TransportMode = "stdio" | "streamable-http";

export type ConnectableServer = {
  connect(transport: Transport): Promise<void>;
  close?(): Promise<void>;
};

export function resolveTransportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  // Anything unrecognised falls back to stdio. Defaulting an unknown value to
  // the network transport would silently open a listening port.
  return env.MCP_TRANSPORT === "streamable-http" ? "streamable-http" : "stdio";
}

export function resolveBindAddress(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  const host = (env.MCP_HOST ?? "").trim() || DEFAULT_HOST;
  const raw = (env.MCP_PORT ?? "").trim();
  if (!raw) {
    return { host, port: DEFAULT_PORT };
  }
  // Number.parseInt would accept "8080abc" as 8080 and "0x1F" as 0, the latter
  // silently binding an ephemeral port that no configured client can reach.
  if (!PORT_PATTERN.test(raw)) {
    throw new Error(`MCP_PORT must be 1-65535, got ${JSON.stringify(raw)}`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`MCP_PORT must be 1-65535, got ${JSON.stringify(raw)}`);
  }
  return { host, port };
}

/**
 * Host values the DNS-rebinding check will accept.
 *
 * The SDK compares the Host header literally, so a wildcard bind cannot be
 * covered by guessing: a remote client connecting to 192.168.1.20 sends that
 * address, which no allowlist derived from "0.0.0.0" would contain. When the
 * bind address is not loopback, the operator must state the reachable names in
 * MCP_ALLOWED_HOSTS; otherwise protection is left off rather than pretending to
 * work while rejecting every legitimate request.
 */
export function resolveAllowedHosts(
  host: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const configured = (env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length > 0) {
    return configured;
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"];
  if (!loopback.includes(host)) {
    return undefined;
  }
  return [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    `${host}:${port}`,
  ];
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
        // Resolving undefined would make the SDK re-read the already-drained
        // stream and report a confusing parse error, so reject here instead.
        reject(new Error("request body is empty"));
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

export async function connectStdio(server: ConnectableServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}

/** An SDK transport plus the HTTP entry point this module drives. */
export type RequestTransport = Transport & {
  handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
};

export function createMcpRequestHandler(options: {
  createServer: () => ConnectableServer;
  /** Read lazily: the allowlist is only known once the port is bound. */
  getAllowedHosts: () => string[] | undefined;
  /** Used only when a request omits Host, which HTTP/1.1 forbids. */
  fallbackHost: string;
  /** Injectable so the partially-written-response paths can be tested. */
  createTransport?: (allowedHosts: string[] | undefined) => RequestTransport;
}) {
  const buildTransport =
    options.createTransport ??
    ((allowedHosts: string[] | undefined): RequestTransport =>
      new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
      }));

  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // Everything is inside the try. A Host header of "a b" or an out-of-range
      // port makes the URL constructor throw, and an unhandled rejection here
      // would terminate the daemon that every session depends on -- reachable
      // by any local process, before the SDK's own host check ever runs.
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? options.fallbackHost}`);
        if (url.pathname !== MCP_PATH) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (req.method !== "POST") {
          // Without shared session state there is no standalone SSE stream to
          // attach to, so only request/response POSTs are meaningful.
          res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }

        const body = await readBody(req);

        const server = options.createServer();
        const transport = buildTransport(options.getAllowedHosts());
        // Cleanup is bound to the response, not to handleRequest returning.
        // handleRequest resolves once the request is dispatched; the reply is
        // written later when the server answers, so closing there truncates it.
        // "close" fires on every outcome -- normal end, client abort, and the
        // res.destroy() in the catch below -- so this is the single release
        // point for the per-request objects.
        res.on("close", () => {
          void transport.close().catch(() => undefined);
          void server.close?.()?.catch(() => undefined);
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        } else {
          // Destroying emits "close", so the listener above releases the
          // per-request objects; doing it here too would close them twice.
          res.destroy();
        }
      }
    })();
  };
}

export async function connectStreamableHttp(
  createMcpServer: () => ConnectableServer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const { host, port: requestedPort } = resolveBindAddress(env);

  let allowedHosts: string[] | undefined;
  const httpServer = createServer(
    createMcpRequestHandler({
      createServer: createMcpServer,
      getAllowedHosts: () => allowedHosts,
      // A bare IPv6 literal has to be bracketed or the fallback URL will not parse.
      fallbackHost: host.includes(":") && !host.startsWith("[") ? `[${host}]` : host,
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
  allowedHosts = resolveAllowedHosts(host, port, env);

  return {
    host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
