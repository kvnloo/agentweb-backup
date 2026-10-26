/**
 * ENG-2110 PR 3: how the hosted service picks its host client in a real process. The test environment's unix socket (AW_LOGIN_HOST_SOCKET)
 * wins over the production provider, and the service only trusts "no such connection" from a worker the provider VERIFIED.
 */
const providerStub = { client: jest.fn(), protocolStatus: jest.fn() };
jest.mock("../loginHostProvider", () => ({ getLoginHostProvider: () => providerStub }));

import { defaultClient, getHostedSubscriptionService } from "../hostedSubscriptionService";
import { LoginHostClient } from "../loginHostClient";

describe("default host client selection", () => {
  const saved = process.env.AW_LOGIN_HOST_SOCKET;
  beforeEach(() => {
    providerStub.client.mockReset();
    providerStub.protocolStatus.mockReset();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AW_LOGIN_HOST_SOCKET;
    else process.env.AW_LOGIN_HOST_SOCKET = saved;
  });

  it("prefers the unix socket from the environment over the provider (test environment)", () => {
    process.env.AW_LOGIN_HOST_SOCKET = "/run/aw-login-host-test1/host.sock";
    providerStub.client.mockReturnValue("PROVIDER-CLIENT");
    const c = defaultClient();
    expect(c).toBeInstanceOf(LoginHostClient);
    expect(providerStub.client).not.toHaveBeenCalled();
  });

  it("without the variable it is the production provider's client, or undefined while that is not loaded", () => {
    delete process.env.AW_LOGIN_HOST_SOCKET;
    const fake = new LoginHostClient({ json: async () => ({ status: 200, json: {} }), stream: async () => { throw new Error("n/a"); } });
    providerStub.client.mockReturnValueOnce(fake);
    expect(defaultClient()).toBe(fake);
    providerStub.client.mockReturnValueOnce(undefined);
    expect(defaultClient()).toBeUndefined();
  });

  it("the production service trusts 'no such connection' only from a VERIFIED worker; the socket environment always does", () => {
    const trusted = () => (getHostedSubscriptionService() as unknown as { deps: { workerSpeaksOurProtocol: () => boolean } }).deps.workerSpeaksOurProtocol();
    delete process.env.AW_LOGIN_HOST_SOCKET;
    for (const [status, expected] of [["match", true], ["mismatch", false], ["unknown", false]] as const) {
      providerStub.protocolStatus.mockReturnValue(status);
      expect(trusted()).toBe(expected);
    }
    process.env.AW_LOGIN_HOST_SOCKET = "/x/host.sock";
    providerStub.protocolStatus.mockReturnValue("unknown");
    expect(trusted()).toBe(true);
  });
});
