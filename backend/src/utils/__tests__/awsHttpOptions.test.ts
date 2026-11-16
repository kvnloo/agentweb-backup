/**
 * ENG-749 #3 — the aws-sdk v2 global config reuses connections.
 */
import https from "https";
import { AWS_HTTP_MAX_SOCKETS, buildAwsHttpOptions, getAwsKeepAliveAgent, isPlainHttpDynamoEndpoint } from "../awsHttpOptions";

describe("ENG-749 awsHttpOptions", () => {
  it("returns a keep-alive https agent", () => {
    const agent = getAwsKeepAliveAgent() as https.Agent & { keepAlive?: boolean };
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent.keepAlive).toBe(true);
  });

  it("keeps the SDK default concurrency (maxSockets 50)", () => {
    expect(AWS_HTTP_MAX_SOCKETS).toBe(50);
    expect(getAwsKeepAliveAgent().maxSockets).toBe(50);
  });

  it("shares one agent per process", () => {
    expect(buildAwsHttpOptions().agent).toBe(buildAwsHttpOptions().agent);
  });

  describe("ENG-2598 DynamoDB Local", () => {
    const saved = process.env.DYNAMODB_LOCAL_ENDPOINT;
    afterEach(() => {
      if (saved === undefined) delete process.env.DYNAMODB_LOCAL_ENDPOINT;
      else process.env.DYNAMODB_LOCAL_ENDPOINT = saved;
    });

    it("attaches no agent for an http:// endpoint, so an https agent never meets an http request", () => {
      process.env.DYNAMODB_LOCAL_ENDPOINT = "http://127.0.0.1:8125";
      expect(buildAwsHttpOptions()).toEqual({});
    });

    it("keeps the keep-alive https agent with no override or an https override", () => {
      delete process.env.DYNAMODB_LOCAL_ENDPOINT;
      expect(buildAwsHttpOptions().agent).toBe(getAwsKeepAliveAgent());
      process.env.DYNAMODB_LOCAL_ENDPOINT = "https://dynamodb.us-west-2.amazonaws.com";
      expect(buildAwsHttpOptions().agent).toBe(getAwsKeepAliveAgent());
    });

    it("recognises only http:// URLs", () => {
      expect(isPlainHttpDynamoEndpoint("HTTP://localhost:8000")).toBe(true);
      expect(isPlainHttpDynamoEndpoint("https://localhost:8000")).toBe(false);
      expect(isPlainHttpDynamoEndpoint("")).toBe(false);
      expect(isPlainHttpDynamoEndpoint(undefined)).toBe(false);
    });
  });

  it("is applied to the global AWS config when services/db loads", () => {
    const savedEndpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
    delete process.env.DYNAMODB_LOCAL_ENDPOINT;
    const update = jest.fn();
    let agent: (https.Agent & { keepAlive?: boolean }) | undefined;
    jest.isolateModules(() => {
      // setup.ts doMocks services/db globally; this test needs the real module's top level,
      // with an aws-sdk whose config.update we can observe.
      jest.doMock("aws-sdk", () => {
        const actualStub = jest.requireActual("../../__mocks__/aws-sdk");
        const sdk = { ...actualStub, config: { update } };
        return { __esModule: true, ...sdk, default: sdk };
      });
      jest.unmock("../../services/db");
      jest.requireActual("../../services/db");
    });
    for (const [cfg] of update.mock.calls) {
      const a = (cfg as { httpOptions?: { agent?: https.Agent & { keepAlive?: boolean } } })?.httpOptions?.agent;
      if (a) agent = a;
    }
    if (savedEndpoint !== undefined) process.env.DYNAMODB_LOCAL_ENDPOINT = savedEndpoint;
    expect(update).toHaveBeenCalled();
    expect(agent?.keepAlive).toBe(true);
  });
});
