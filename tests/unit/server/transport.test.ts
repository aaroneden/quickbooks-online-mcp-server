/**
 * Transport tests.
 *
 * The concurrency and Host-header cases run against the REAL SDK transport, not
 * a mock. A fully-mocked suite passed while responses were being routed to the
 * wrong client, because the defect lived in SDK behaviour the mock replaced.
 */

import { jest } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connect, createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, ServerResponse } from "node:http";

/** Ask the OS for a currently-free port. MCP_PORT=0 is rejected by design. */
async function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(String(port)));
    });
  });
}

const {
  createMcpRequestHandler,
  resolveTransportMode,
  resolveBindAddress,
  resolveAllowedHosts,
  connectStdio,
  connectStreamableHttp,
} = await import("../../../src/server/transport.js");

/** Send a request with a chosen Host header. fetch forbids setting Host. */
async function rawRequest(port: number, host: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: ${host}\r\n` +
          "Content-Type: application/json\r\n" +
          "Accept: application/json, text/event-stream\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

/** A server whose one tool echoes back which caller asked, so replies are traceable. */
function buildServer(): McpServer {
  const server = new McpServer({
    name: "test",
    version: "1.0.0",
    capabilities: { tools: {} },
  });
  server.tool(
    "whoami",
    "Echo the caller name back",
    { caller: z.string() },
    async ({ caller }: { caller: string }) => ({
      content: [{ type: "text" as const, text: `hello ${caller}` }],
    }),
  );
  return server;
}

async function rpc(port: number, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

const callWhoami = (id: number, caller: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "whoami", arguments: { caller } },
});

describe("resolveTransportMode", () => {
  it("selects streamable-http only on an exact match", () => {
    expect(resolveTransportMode({ MCP_TRANSPORT: "streamable-http" })).toBe("streamable-http");
  });

  it("defaults to stdio when unset", () => {
    expect(resolveTransportMode({})).toBe("stdio");
  });

  it("falls back to stdio for an unrecognised value rather than opening a port", () => {
    expect(resolveTransportMode({ MCP_TRANSPORT: "http" })).toBe("stdio");
    expect(resolveTransportMode({ MCP_TRANSPORT: "STREAMABLE-HTTP" })).toBe("stdio");
  });

  it("reads process.env when no environment is supplied", () => {
    expect(resolveTransportMode()).toBe("stdio");
  });
});

describe("resolveBindAddress", () => {
  it("defaults to loopback so the server is not reachable off-box", () => {
    expect(resolveBindAddress({})).toEqual({ host: "127.0.0.1", port: 8933 });
  });

  it("honours explicit host and port", () => {
    expect(resolveBindAddress({ MCP_HOST: "0.0.0.0", MCP_PORT: "9000" })).toEqual({
      host: "0.0.0.0",
      port: 9000,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveBindAddress({ MCP_PORT: " 9000 " }).port).toBe(9000);
  });

  it.each(["abc", "8080abc", "0x1F", "8.5", "0", "65536", "-1", "1_000", "+80"])(
    "throws on the unusable port %p instead of binding something unexpected",
    (port) => {
      expect(() => resolveBindAddress({ MCP_PORT: port })).toThrow("MCP_PORT must be 1-65535");
    },
  );

  it("reads process.env when no environment is supplied", () => {
    expect(resolveBindAddress().host).toBe("127.0.0.1");
  });
});

describe("resolveAllowedHosts", () => {
  it("covers every loopback spelling, including IPv6", () => {
    const hosts = resolveAllowedHosts("127.0.0.1", 8933, {});

    expect(hosts).toEqual(
      expect.arrayContaining(["127.0.0.1:8933", "localhost:8933", "[::1]:8933"]),
    );
  });

  it("returns undefined for a wildcard bind rather than an allowlist that matches nothing", () => {
    // A remote client reaching 0.0.0.0 sends its own address in Host, which no
    // list derived from "0.0.0.0" could contain -- it would 403 every request.
    expect(resolveAllowedHosts("0.0.0.0", 8933, {})).toBeUndefined();
  });

  it("reads process.env when no environment is supplied", () => {
    expect(resolveAllowedHosts("127.0.0.1", 8933)).toEqual(
      expect.arrayContaining(["127.0.0.1:8933"]),
    );
  });

  it("uses an explicit MCP_ALLOWED_HOSTS list when given", () => {
    const hosts = resolveAllowedHosts("0.0.0.0", 8933, {
      MCP_ALLOWED_HOSTS: "box.local:8933, 192.168.1.20:8933",
    });

    expect(hosts).toEqual(["box.local:8933", "192.168.1.20:8933"]);
  });
});

describe("connectStdio", () => {
  it("connects the server over stdio", async () => {
    const connectSpy = jest.fn(async () => undefined);
    await connectStdio({ connect: connectSpy } as never);

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("streamable-http against the real SDK", () => {
  let handle: { host: string; port: number; close: () => Promise<void> };

  beforeEach(async () => {
    handle = await connectStreamableHttp(buildServer, { MCP_PORT: await freePort() });
  });

  afterEach(async () => {
    await handle.close();
  });

  it("answers a tools/call", async () => {
    const res = await rpc(handle.port, callWhoami(1, "solo"));

    expect(res.status).toBe(200);
    expect(res.text).toContain("hello solo");
  });

  it("does not cross responses between concurrent clients using the same id", async () => {
    // Every MCP client numbers requests from 1. With one shared transport the
    // SDK keys its reply routing on that id, so these two would swap answers.
    const [a, b] = await Promise.all([
      rpc(handle.port, callWhoami(1, "alice")),
      rpc(handle.port, callWhoami(1, "bob")),
    ]);

    expect(a.text).toContain("hello alice");
    expect(a.text).not.toContain("hello bob");
    expect(b.text).toContain("hello bob");
    expect(b.text).not.toContain("hello alice");
  });

  it("keeps replies straight across many same-id callers", async () => {
    const callers = Array.from({ length: 12 }, (_, i) => `caller${i}`);
    const results = await Promise.all(callers.map((c) => rpc(handle.port, callWhoami(1, c))));

    results.forEach((res, i) => {
      expect(res.text).toContain(`hello ${callers[i]}`);
    });
  });

  it.each(["a b", "127.0.0.1:99999", "%"])(
    "survives the malformed Host header %p instead of terminating the daemon",
    async (badHost) => {
      // Sent raw: fetch would reject these before they left the client. Each one
      // makes the URL constructor throw; unhandled, that kills the whole daemon.
      const raw = await rawRequest(handle.port, badHost, "{}");

      expect(raw).toContain("HTTP/1.1 400");
    },
  );

  it("keeps serving after a malformed Host header", async () => {
    await rawRequest(handle.port, "a b", "{}");

    // The listener must still be serving; an unhandled rejection would have
    // killed the process and taken every other session with it.
    const after = await rpc(handle.port, callWhoami(1, "survivor"));
    expect(after.text).toContain("hello survivor");
  });

  it("returns 404 for any path other than /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/elsewhere`);

    expect(res.status).toBe(404);
  });

  it("returns 405 for a non-POST request to /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`);

    expect(res.status).toBe(405);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
  });

  it("rejects an empty body with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    expect(res.status).toBe(400);
  });

  it("refuses an oversized body instead of buffering it", async () => {
    const huge = JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) });

    await expect(
      fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      }),
    ).rejects.toThrow();
  });

  it("rejects a Host header outside the allowlist", async () => {
    const raw = await rawRequest(
      handle.port,
      "evil.example.com",
      JSON.stringify(callWhoami(1, "x")),
    );

    expect(raw).toContain("HTTP/1.1 403");
  });

  it("surfaces a listen failure rather than resolving", async () => {
    await expect(
      connectStreamableHttp(buildServer, { MCP_PORT: String(handle.port) }),
    ).rejects.toThrow();
  });

  it("rejects when closing a listener that has already stopped", async () => {
    const extra = await connectStreamableHttp(buildServer, { MCP_PORT: await freePort() });
    await extra.close();

    await expect(extra.close()).rejects.toThrow();
  });
});


describe("failure after the response has started", () => {
  /** Minimal Transport whose handleRequest writes headers, then fails. */
  const failingTransportFactory = (closed: { count: number }) => () => ({
    start: async () => undefined,
    send: async () => undefined,
    close: async () => {
      closed.count += 1;
      // A rejecting close must be swallowed: unhandled, it would take the
      // whole daemon down the same way a malformed Host header would.
      throw new Error("close failed");
    },
    handleRequest: async (_req: unknown, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      throw new Error("failed mid-response");
    },
  });

  it("destroys a half-written response and still releases the transport", async () => {
    const closed = { count: 0 };
    const serverClose = jest.fn(async () => {
      throw new Error("server close failed");
    });
    const handler = createMcpRequestHandler({
      createServer: () => ({ connect: async () => undefined, close: serverClose }),
      getAllowedHosts: () => undefined,
      fallbackHost: "127.0.0.1:1",
      createTransport: failingTransportFactory(closed),
    });

    const http = createHttpServer(handler);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;

    // The socket is destroyed mid-response, so the client sees a broken read.
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }).then(
      (r) => r.text().catch(() => ""),
      () => "",
    );

    expect(closed.count).toBeGreaterThan(0);
    expect(serverClose).toHaveBeenCalled();
    await new Promise<void>((r) => http.close(() => r()));
  });
});


describe("bind addresses without an allowlist", () => {
  it("serves without rebinding protection when no allowlist applies", async () => {
    // A wildcard bind yields no usable allowlist, so the real transport is built
    // without host validation. Driven through the handler so the default
    // transport factory runs without needing a non-loopback address.
    const handler = createMcpRequestHandler({
      createServer: buildServer,
      getAllowedHosts: () => undefined,
      fallbackHost: "127.0.0.1:1",
    });
    const http = createHttpServer(handler);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(callWhoami(1, "loose")),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("hello loose");
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });

  it("reads process.env when no environment is supplied", async () => {
    const previous = process.env.MCP_PORT;
    process.env.MCP_PORT = await freePort();
    try {
      const handle = await connectStreamableHttp(buildServer);
      expect(handle.host).toBe("127.0.0.1");
      await handle.close();
    } finally {
      if (previous === undefined) delete process.env.MCP_PORT;
      else process.env.MCP_PORT = previous;
    }
  });
});


describe("request fields Node always populates", () => {
  const fakeRes = () => {
    const res: any = {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      writeHead(code: number) {
        res.statusCode = code;
        res.headersSent = true;
      },
      end() {
        res.writableEnded = true;
        res.settle?.();
      },
      on: () => undefined,
      destroy: () => undefined,
    };
    return res;
  };

  const run = (req: Record<string, unknown>) => {
    const handler = createMcpRequestHandler({
      createServer: buildServer,
      getAllowedHosts: () => undefined,
      fallbackHost: "127.0.0.1:1",
    });
    const res = fakeRes();
    const done = new Promise<void>((resolve) => (res.settle = resolve));
    handler({ method: "GET", headers: {}, on: () => undefined, ...req } as never, res as never);
    return done.then(() => res);
  };

  it("treats a missing url as the root path and 404s", async () => {
    const res = await run({ url: undefined });

    expect(res.statusCode).toBe(404);
  });

  it("falls back to the configured host when no Host header is present", async () => {
    // Reaching the 405 proves URL construction succeeded on the fallback.
    const res = await run({ url: "/mcp", headers: {} });

    expect(res.statusCode).toBe(405);
  });
});


describe("cleanup failures never reach the process", () => {
  it("swallows a rejecting close on the normal response path", async () => {
    const closes: string[] = [];
    const handler = createMcpRequestHandler({
      createServer: () => ({
        connect: async () => undefined,
        close: async () => {
          closes.push("server");
          throw new Error("server close failed");
        },
      }),
      getAllowedHosts: () => undefined,
      fallbackHost: "127.0.0.1:1",
      createTransport: () => ({
        start: async () => undefined,
        send: async () => undefined,
        close: async () => {
          closes.push("transport");
          throw new Error("transport close failed");
        },
        handleRequest: async (_req: unknown, res: ServerResponse) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        },
      }),
    });

    const http = createHttpServer(handler);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });

      expect(res.status).toBe(200);
      // Give the "close" listener a turn to run its rejecting closes.
      await new Promise((r) => setTimeout(r, 50));
      expect(closes).toEqual(expect.arrayContaining(["transport", "server"]));
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
