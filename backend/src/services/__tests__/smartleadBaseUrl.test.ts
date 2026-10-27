import { __configureSmartleadClient, smartleadRequest } from "../smartleadService";

// SMARTLEAD_API_BASE_URL lets a test environment point at test-env/smartlead-stub.js (ENG-673).
// BASE_URL is read once at import, so each case loads a fresh copy of the module.
const KEY = "sk_live_supersecret123";

function loadWith(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const request = jest.fn().mockResolvedValue({ data: [] });
  let mod!: { smartleadRequest: typeof smartleadRequest; __configureSmartleadClient: typeof __configureSmartleadClient };
  jest.isolateModules(() => {
    jest.doMock("axios", () => ({ __esModule: true, default: { request } }));
    mod = require("../smartleadService");
  });
  process.env = saved;
  mod.__configureSmartleadClient({ options: { requestsPerMinute: 0 } });
  return { mod, request };
}

describe("SMARTLEAD_API_BASE_URL override", () => {
  it("uses the real Smartlead URL by default", async () => {
    const { mod, request } = loadWith({ NODE_ENV: "development", SMARTLEAD_API_BASE_URL: undefined });
    await mod.smartleadRequest(KEY, "GET", "/email-accounts");
    expect(request.mock.calls[0][0].url).toBe("https://server.smartlead.ai/api/v1/email-accounts");
  });

  it("uses the override outside production, ignoring a trailing slash", async () => {
    const { mod, request } = loadWith({ NODE_ENV: "development", SMARTLEAD_API_BASE_URL: "http://smartlead-stub:4010/api/v1/" });
    await mod.smartleadRequest(KEY, "GET", "/email-accounts");
    expect(request.mock.calls[0][0].url).toBe("http://smartlead-stub:4010/api/v1/email-accounts");
  });

  it("honours the override in test", async () => {
    const { mod, request } = loadWith({ NODE_ENV: "test", SMARTLEAD_API_BASE_URL: "http://localhost:4010/api/v1" });
    await mod.smartleadRequest(KEY, "GET", "/email-accounts");
    expect(request.mock.calls[0][0].url).toBe("http://localhost:4010/api/v1/email-accounts");
  });

  it("ignores the override when NODE_ENV is unset, as in a real deployment", async () => {
    const { mod, request } = loadWith({ NODE_ENV: undefined, SMARTLEAD_API_BASE_URL: "http://evil.example/api/v1" });
    await mod.smartleadRequest(KEY, "GET", "/email-accounts");
    expect(request.mock.calls[0][0].url).toBe("https://server.smartlead.ai/api/v1/email-accounts");
  });

  it("ignores the override in production", async () => {
    const { mod, request } = loadWith({ NODE_ENV: "production", SMARTLEAD_API_BASE_URL: "http://evil.example/api/v1" });
    await mod.smartleadRequest(KEY, "GET", "/email-accounts");
    expect(request.mock.calls[0][0].url).toBe("https://server.smartlead.ai/api/v1/email-accounts");
  });
});
