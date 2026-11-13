/**
 * ENG-2935: org-secret writes used by the ClickUp/Foreplay connect + disconnect flows.
 * Runs the real orgDb against a mocked DynamoDB `update`.
 */
jest.mock("aws-sdk", () => {
  const update = jest.fn();
  const query = jest.fn();
  (global as any).__update = update;
  (global as any).__query = query;
  const client = new Proxy({ update, query }, {
    get: (t: any, k) => (k in t ? t[k] : jest.fn(() => ({ promise: async () => ({}) }))),
  });
  const inert = () => new Proxy({}, { get: () => jest.fn(() => ({ promise: async () => ({}) })) });
  const sdk: any = new Proxy(
    { DynamoDB: { DocumentClient: jest.fn(() => client) }, config: { update: jest.fn() } },
    { get: (target: any, key) => (key in target ? target[key] : jest.fn(inert)) },
  );
  sdk.default = sdk;
  return sdk;
});

import { orgDb, userDb } from "../services/db";

const update = (): jest.Mock => (global as any).__update;
const ok = () => ({ promise: async () => ({}) });
const ok2 = (v: unknown) => ({ promise: async () => v });
const fail = (code: string, message = code) => ({ promise: async () => { throw Object.assign(new Error(message), { code }); } });

beforeEach(() => update().mockReset());

describe("orgDb.removeOrgSecret", () => {
  it("resolves when the key is removed", async () => {
    update().mockReturnValueOnce(ok());
    await expect(orgDb.removeOrgSecret("o1", "clickup_access_token")).resolves.toBeUndefined();
  });

  it("treats a missing secrets map as already removed", async () => {
    update().mockReturnValueOnce(fail("ValidationException", "The document path provided in the update expression is invalid for update"));
    await expect(orgDb.removeOrgSecret("o1", "clickup_access_token")).resolves.toBeUndefined();
  });

  it("does NOT swallow real failures (throttling, outage) — the caller must not report a successful disconnect", async () => {
    update().mockReturnValueOnce(fail("ProvisionedThroughputExceededException"));
    await expect(orgDb.removeOrgSecret("o1", "clickup_access_token")).rejects.toThrow();
  });
});

describe("orgDb.setOrgSecretIfAbsent", () => {
  it("writes and returns true when the key is absent", async () => {
    update().mockReturnValueOnce(ok());
    await expect(orgDb.setOrgSecretIfAbsent("o1", "clickup_access_token", "enc")).resolves.toBe(true);
    expect(update().mock.calls[0][0].ConditionExpression).toMatch(/attribute_not_exists\(#secrets\.#key\)/);
  });

  it("returns false and leaves the existing value when the key is already set", async () => {
    update()
      .mockReturnValueOnce(fail("ConditionalCheckFailedException"))
      .mockReturnValueOnce(fail("ConditionalCheckFailedException"));
    await expect(orgDb.setOrgSecretIfAbsent("o1", "clickup_access_token", "enc")).resolves.toBe(false);
  });

  it("creates the secrets map (conditionally) when it does not exist yet", async () => {
    update().mockReturnValueOnce(fail("ConditionalCheckFailedException")).mockReturnValueOnce(ok());
    await expect(orgDb.setOrgSecretIfAbsent("o1", "clickup_access_token", "enc")).resolves.toBe(true);
    const second = update().mock.calls[1][0];
    expect(second.ConditionExpression).toBe("attribute_not_exists(#secrets)");
    expect(second.ExpressionAttributeValues[":secretsMap"]).toEqual({ clickup_access_token: "enc" });
  });

  it("propagates non-conditional failures", async () => {
    update().mockReturnValueOnce(fail("InternalServerError"));
    await expect(orgDb.setOrgSecretIfAbsent("o1", "clickup_access_token", "enc")).rejects.toThrow();
  });
});

describe("userDb.removeUserSecret (ENG-2935: no whole-map rewrite)", () => {
  const query = () => (global as any).__query as jest.Mock;

  it("removes only the one key with an atomic REMOVE, never SETting the secrets map", async () => {
    query().mockReturnValue(ok2({ Items: [{ userId: "u1", email: "a@b.com" }] }));
    update().mockReturnValueOnce(ok());
    await userDb.removeUserSecret("u1", "clickup_access_token");
    const params = update().mock.calls[0][0];
    expect(params.Key).toEqual({ email: "a@b.com" });
    expect(params.UpdateExpression).toMatch(/^REMOVE #secrets\.#key/);
    expect(params.UpdateExpression).not.toMatch(/SET #secrets\b(?!\.)/);
    expect(params.ExpressionAttributeNames["#key"]).toBe("clickup_access_token");
  });

  it("is a no-op when the secrets map does not exist", async () => {
    query().mockReturnValue(ok2({ Items: [{ userId: "u1", email: "a@b.com" }] }));
    update().mockReturnValueOnce(fail("ValidationException", "The document path provided in the update expression is invalid for update"));
    await expect(userDb.removeUserSecret("u1", "clickup_access_token")).resolves.toBeUndefined();
  });

  it("surfaces real failures", async () => {
    query().mockReturnValue(ok2({ Items: [{ userId: "u1", email: "a@b.com" }] }));
    update().mockReturnValueOnce(fail("ProvisionedThroughputExceededException"));
    await expect(userDb.removeUserSecret("u1", "clickup_access_token")).rejects.toThrow();
  });
});
