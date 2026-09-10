/**
 * Tests for transport selection and the streamable-http listener.
 *
 * The behaviours worth pinning down are the ones with security or availability
 * consequences: an unknown MCP_TRANSPORT must not open a port, the listener
 * must default to localhost, and the body reader must not accept unbounded
 * input.
 */

import { jest } from "@jest/globals";

const handleRequest = jest.fn(
  async (_req: unknown, res: { writeHead: Function; end: Function }) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  },
);
const StreamableHTTPServerTransport = jest.fn(function (this: any, opts: unknown) {
  this.options = opts;
  this.handleRequest = handleRequest;
});
const StdioServerTransport = jest.fn(function (this: any) {
  this.kind = "stdio";
});

jest.unstable_mockModule("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport,
}));
jest.unstable_mockModule("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport,
}));

const {
  resolveTransportMode,
  resolveBindAddress,
  connectStdio,
  connectStreamableHttp,
  createMcpRequestHandler,
} = await import("../../../src/server/transport.js");

const fakeServer = () => ({ connect: jest.fn(async () => undefined) }) as any;

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

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
});

describe("resolveBindAddress", () => {
  it("defaults to localhost so the server is not reachable off-box", () => {
    expect(resolveBindAddress({})).toEqual({ host: "127.0.0.1", port: 8933 });
  });

  it("honours explicit host and port", () => {
    expect(resolveBindAddress({ MCP_HOST: "0.0.0.0", MCP_PORT: "9000" })).toEqual({
      host: "0.0.0.0",
      port: 9000,
    });
  });

  it("treats port 0 as a request for an ephemeral port", () => {
    expect(resolveBindAddress({ MCP_PORT: "0" }).port).toBe(0);
  });

  it.each(["", "abc", "65536", "-1"])(
    "ignores the unusable port %p and uses the default",
    (port) => {
      expect(resolveBindAddress({ MCP_PORT: port }).port).toBe(8933);
    },
  );
});

describe("connectStdio", () => {
  it("connects the server over stdio", async () => {
    const server = fakeServer();
    await connectStdio(server);
    expect(StdioServerTransport).toHaveBeenCalled();
    expect(server.connect).toHaveBeenCalledTimes(1);
  });
});

describe("connectStreamableHttp", () => {
  let handle: { host: string; port: number; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("listens on localhost and serves /mcp", async () => {
    const server = fakeServer();
    handle = await connectStreamableHttp(server, { MCP_PORT: "0" });

    expect(handle.host).toBe("127.0.0.1");
    const res = await post(`http://127.0.0.1:${handle.port}/mcp`, JSON.stringify({ a: 1 }));

    expect(res.status).toBe(200);
    expect(handleRequest).toHaveBeenCalled();
  });

  it("enables DNS rebinding protection with an explicit host allowlist", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    const opts = (StreamableHTTPServerTransport.mock.calls.at(-1) as any[])[0];

    expect(opts.sessionIdGenerator).toBeUndefined();
    expect(opts.enableDnsRebindingProtection).toBe(true);
    expect(opts.allowedHosts).toContain(`127.0.0.1:${handle.port}`);
  });

  it("returns 404 for any path other than /mcp", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    const res = await fetch(`http://127.0.0.1:${handle.port}/elsewhere`);

    expect(res.status).toBe(404);
  });

  it("rejects a malformed JSON body with 400", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    const res = await post(`http://127.0.0.1:${handle.port}/mcp`, "{not json");

    expect(res.status).toBe(400);
  });

  it("passes undefined for an empty body", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    await post(`http://127.0.0.1:${handle.port}/mcp`, "");

    expect(handleRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("does not read a body for GET", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    await fetch(`http://127.0.0.1:${handle.port}/mcp`);

    expect(handleRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });

  it("refuses an oversized body instead of buffering it", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    const huge = JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) });

    await expect(post(`http://127.0.0.1:${handle.port}/mcp`, huge)).rejects.toThrow();
  });

  it("destroys the response when handleRequest fails after headers are sent", async () => {
    handleRequest.mockImplementationOnce(async (_req: any, res: any) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      throw new Error("late failure");
    });
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });

    await expect(
      post(`http://127.0.0.1:${handle.port}/mcp`, JSON.stringify({ a: 1 })),
    ).rejects.toThrow();
  });

  it("surfaces a listen failure rather than resolving", async () => {
    handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });

    await expect(
      connectStreamableHttp(fakeServer(), { MCP_PORT: String(handle.port) }),
    ).rejects.toThrow();
  });
});


describe("createMcpRequestHandler fallbacks", () => {
  const fakeRes = () => {
    const res: any = {
      headersSent: false,
      statusCode: 0,
      body: "",
      writeHead(code: number) {
        res.statusCode = code;
        res.headersSent = true;
      },
      end(chunk?: string) {
        res.body = chunk ?? "";
        res.done?.();
      },
      destroy: jest.fn(),
    };
    return res;
  };

  const fakeReq = (over: Record<string, unknown> = {}) =>
    ({ method: "GET", url: "/mcp", headers: {}, on: () => undefined, ...over }) as any;

  const settled = (res: any) => new Promise<void>((resolve) => (res.done = resolve));

  it("uses the fallback host when the Host header is absent", async () => {
    const handler = createMcpRequestHandler({
      getTransport: () => ({ handleRequest: handleRequest as any }),
      fallbackHost: "127.0.0.1:9999",
    });
    const res = fakeRes();
    const done = settled(res);

    handler(fakeReq({ headers: {} }), res);
    await done;

    expect(res.statusCode).toBe(200);
  });

  it("treats a missing url as the root path and 404s", async () => {
    const handler = createMcpRequestHandler({
      getTransport: () => ({ handleRequest: handleRequest as any }),
      fallbackHost: "127.0.0.1:9999",
    });
    const res = fakeRes();
    const done = settled(res);

    handler(fakeReq({ url: undefined }), res);
    await done;

    expect(res.statusCode).toBe(404);
  });

  it("reports a non-Error throw without crashing", async () => {
    const handler = createMcpRequestHandler({
      getTransport: () => ({
        handleRequest: async () => {
          throw "plain string failure";
        },
      }),
      fallbackHost: "127.0.0.1:9999",
    });
    const res = fakeRes();
    const done = settled(res);

    handler(fakeReq(), res);
    await done;

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("plain string failure");
  });
});

describe("environment defaults", () => {
  it("reads process.env when no environment is supplied", () => {
    const previous = process.env.MCP_TRANSPORT;
    process.env.MCP_TRANSPORT = "streamable-http";
    try {
      expect(resolveTransportMode()).toBe("streamable-http");
      expect(resolveBindAddress().host).toBe("127.0.0.1");
    } finally {
      if (previous === undefined) delete process.env.MCP_TRANSPORT;
      else process.env.MCP_TRANSPORT = previous;
    }
  });
});


describe("connectStreamableHttp lifecycle", () => {
  it("defaults to process.env when no environment is passed", async () => {
    const previous = process.env.MCP_PORT;
    process.env.MCP_PORT = "0"; // ephemeral, so this never collides with a daemon
    try {
      const handle = await connectStreamableHttp(fakeServer());
      expect(handle.port).toBeGreaterThan(0);
      await handle.close();
    } finally {
      if (previous === undefined) delete process.env.MCP_PORT;
      else process.env.MCP_PORT = previous;
    }
  });

  it("rejects when closing a listener that has already stopped", async () => {
    const handle = await connectStreamableHttp(fakeServer(), { MCP_PORT: "0" });
    await handle.close();

    await expect(handle.close()).rejects.toThrow();
  });
});
