/**
 * Unit tests for mcpClientService.callToolDirect — the backend "call one tool on
 * a named MCP server" helper used by Seedance video generation. The SDK Client is
 * mocked so no real network/OAuth happens.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing";

const store = new Map<string, string>();
jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) =>
      store.has(name) ? { settingName: name, settingValue: store.get(name) } : null
    ),
    setSetting: jest.fn(async (name: string, value: string) => {
      store.set(name, value);
      return { settingName: name, settingValue: value };
    }),
  },
}));

const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockCallTool = jest.fn();
const mockClose = jest.fn().mockResolvedValue(undefined);
jest.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

import { McpClientService } from "../mcp/client/mcpClientService";

let service: McpClientService;

beforeEach(() => {
  store.clear();
  store.set(
    "mcp_servers",
    JSON.stringify([
      { name: "higgsfield", transport: "streamable-http", url: "https://mcp.higgsfield.ai/mcp", authType: "oauth" },
      { name: "bravesearch", transport: "stdio", command: "npx" },
    ])
  );
  mockConnect.mockClear();
  mockCallTool.mockReset();
  mockClose.mockClear();
  service = new McpClientService();
});

afterEach(async () => {
  await service.shutdown().catch(() => {});
});

describe("callToolDirect", () => {
  it("connects, calls the named tool with the given args, and closes", async () => {
    mockCallTool.mockResolvedValue({
      structuredContent: { job_id: "job-123" },
      content: [{ type: "text", text: '{"job_id":"job-123"}' }],
    });

    const args = { params: { model: "seedance_2_0", prompt: "a sunrise", duration: 5 } };
    const result = await service.callToolDirect("higgsfield", "generate_video", args);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith(
      { name: "generate_video", arguments: args },
      undefined,
      { timeout: 3600000 }
    );
    expect(result.structuredContent.job_id).toBe("job-123");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("honors a custom timeout", async () => {
    mockCallTool.mockResolvedValue({ structuredContent: {} });
    await service.callToolDirect("higgsfield", "job_status", { id: "x" }, { timeoutMs: 5000 });
    expect(mockCallTool).toHaveBeenCalledWith(expect.anything(), undefined, { timeout: 5000 });
  });

  it("throws for an unknown server", async () => {
    await expect(service.callToolDirect("ghost", "generate_video", {})).rejects.toThrow(/not found/i);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("closes the client even if the tool call fails", async () => {
    mockCallTool.mockRejectedValue(new Error("boom"));
    await expect(service.callToolDirect("higgsfield", "generate_video", {})).rejects.toThrow("boom");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

describe("withServerSession", () => {
  it("runs multiple tool calls over ONE connected client, then closes", async () => {
    mockCallTool.mockResolvedValue({ structuredContent: { ok: true } });

    const results = await service.withServerSession("higgsfield", async (callTool) => {
      const a = await callTool("generate_video", { x: 1 });
      const b = await callTool("job_status", { id: "j" });
      return [a, b];
    });

    expect(mockConnect).toHaveBeenCalledTimes(1); // single session for both calls
    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    // Each call passes a timeout + abort signal.
    expect(mockCallTool.mock.calls[0][2]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("hard-aborts (rejects) a tool call that hangs past its timeout", async () => {
    jest.useFakeTimers();
    mockCallTool.mockReturnValue(new Promise(() => {})); // never resolves

    const p = service.withServerSession("higgsfield", (callTool) =>
      callTool("generate_video", {}, { timeoutMs: 1000 })
    );
    const expectation = expect(p).rejects.toThrow(/timed out after 1000ms/);
    await jest.advanceTimersByTimeAsync(1100);
    await expectation;

    expect(mockClose).toHaveBeenCalledTimes(1); // session still cleaned up
    jest.useRealTimers();
  });
});
