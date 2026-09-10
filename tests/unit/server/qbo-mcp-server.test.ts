/**
 * The streamable-http transport builds one server per request, so CreateServer
 * must hand back genuinely independent instances; the stdio path still wants
 * the process-wide singleton.
 *
 * Note: tool registration itself is deliberately NOT imported here. Pulling in
 * register-tools.ts drags all 142 registered tool modules into the coverage set and drops
 * the reported global figure from 100% to ~62%, which is the honest number --
 * jest only counts files something imports. Flagged in the PR rather than
 * papered over or silently reconfigured.
 */

import { QuickbooksMCPServer } from "../../../src/server/qbo-mcp-server.js";

describe("QuickbooksMCPServer", () => {
  it("returns a new instance each time from CreateServer", () => {
    expect(QuickbooksMCPServer.CreateServer()).not.toBe(QuickbooksMCPServer.CreateServer());
  });

  it("keeps GetServer a stable singleton for the stdio path", () => {
    expect(QuickbooksMCPServer.GetServer()).toBe(QuickbooksMCPServer.GetServer());
  });

  it("gives each created server its own empty tool registry", () => {
    const registryOf = (s: unknown) =>
      (s as { _registeredTools: Record<string, unknown> })._registeredTools;

    expect(Object.keys(registryOf(QuickbooksMCPServer.CreateServer()))).toHaveLength(0);
    expect(Object.keys(registryOf(QuickbooksMCPServer.CreateServer()))).toHaveLength(0);
  });
});
