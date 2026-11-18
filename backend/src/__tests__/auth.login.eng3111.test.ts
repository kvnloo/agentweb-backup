/**
 * ENG-3111: login makes one user read and one user write.
 * Runs the real `login` controller and the real `userDb` against a mocked
 * DynamoDB client, so the counts below are DynamoDB calls, not mocked methods.
 */
jest.mock("aws-sdk", () => {
  const get = jest.fn();
  const update = jest.fn();
  const query = jest.fn();
  (global as any).__ddb = { get, update, query };
  const client = new Proxy({ get, update, query }, {
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
jest.mock("bcryptjs", () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock("jsonwebtoken", () => ({ sign: jest.fn(() => "signed.jwt") }));
jest.mock("../services/serverSignalEmitter", () => ({ emitAppSignal: jest.fn() }));

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { login } from "../controllers/auth";
import { userDb } from "../services/db";

const ddb = (): { get: jest.Mock; update: jest.Mock; query: jest.Mock } => (global as any).__ddb;
const resolves = (v: unknown) => ({ promise: async () => v });
const rejects = (code: string) => ({ promise: async () => { throw Object.assign(new Error(code), { code }); } });

const stored = {
  userId: "u-1",
  email: "user@example.com",
  password: "stored-hash",
  isActive: true,
  roles: ["customer"],
  isAdmin: false,
  sessionVersion: 7,
  firstName: "Pat",
  brandGuidelines: { brandData: { brandName: "Acme" } },
  designSystem: { status: "ready" },
};

function call(body: any) {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return login({ body } as any, res).then(() => res);
}
const noWrite = () => expect(ddb().update).not.toHaveBeenCalled();

let errorLog: jest.SpyInstance;
beforeEach(() => {
  ddb().get.mockReset().mockReturnValue(resolves({ Item: { ...stored } }));
  ddb().update.mockReset().mockReturnValue(resolves({}));
  ddb().query.mockReset().mockReturnValue(resolves({ Items: [{ ...stored }] }));
  (bcrypt.compare as jest.Mock).mockReset().mockResolvedValue(true);
  (jwt.sign as jest.Mock).mockClear();
  errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe("ENG-3111 login database calls", () => {
  it("a successful login is one read by primary key and one write, with no index query", async () => {
    const res = await call({ email: "USER@Example.com", password: "pw" });

    expect(res.status).not.toHaveBeenCalled();
    expect(ddb().get).toHaveBeenCalledTimes(1);
    expect(ddb().update).toHaveBeenCalledTimes(1);
    expect(ddb().query).not.toHaveBeenCalled();
    expect(ddb().get.mock.calls[0][0]).toEqual(expect.objectContaining({ Key: { email: "user@example.com" } }));
    expect(ddb().get.mock.calls[0][0].IndexName).toBeUndefined();
  });

  it("the write stores lastLoginTime only, on the row that was read, and cannot create a row", async () => {
    await call({ email: "user@example.com", password: "pw" });

    const p = ddb().update.mock.calls[0][0];
    expect(p.Key).toEqual({ email: "user@example.com" });
    expect(p.UpdateExpression).toBe("SET #lastLoginTime = :lastLoginTime");
    expect(p.ExpressionAttributeNames).toEqual({ "#userId": "userId", "#lastLoginTime": "lastLoginTime" });
    expect(Object.keys(p.ExpressionAttributeValues).sort()).toEqual([":lastLoginTime", ":userId"]);
    expect(new Date(p.ExpressionAttributeValues[":lastLoginTime"]).toISOString()).toBe(p.ExpressionAttributeValues[":lastLoginTime"]);
    expect(p.ConditionExpression).toBe("#userId = :userId");
    expect(p.ExpressionAttributeValues[":userId"]).toBe("u-1");
    expect(p.ReturnValues).toBeUndefined();
  });

  it("the write also stores lastTouch when the client sent attribution", async () => {
    await call({ email: "user@example.com", password: "pw", attribution: { utm_source: "newsletter" } });

    const p = ddb().update.mock.calls[0][0];
    expect(p.UpdateExpression).toBe("SET #lastLoginTime = :lastLoginTime, #lastTouch = :lastTouch");
    expect(p.ExpressionAttributeNames["#lastTouch"]).toBe("lastTouch");
    expect(p.ExpressionAttributeValues[":lastTouch"]).toEqual(expect.objectContaining({ utm: expect.objectContaining({ source: "newsletter" }) }));
  });

  it("login still succeeds, and the failure is logged, when the write fails", async () => {
    ddb().update.mockReturnValue(rejects("ProvisionedThroughputExceededException"));
    const res = await call({ email: "user@example.com", password: "pw" });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: "signed.jwt" }));
    expect(errorLog).toHaveBeenCalledWith("Error updating last login time:", expect.objectContaining({ code: "ProvisionedThroughputExceededException" }));
  });

  it("login still succeeds when the row was replaced between the read and the write", async () => {
    ddb().update.mockReturnValue(rejects("ConditionalCheckFailedException"));
    const res = await call({ email: "user@example.com", password: "pw" });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: "signed.jwt" }));
    expect(errorLog).toHaveBeenCalledWith("Error updating last login time:", expect.objectContaining({ code: "ConditionalCheckFailedException" }));
  });
});

describe("ENG-3111 login responses are unchanged", () => {
  it("200: token, and the stored user without the password plus the two derived flags", async () => {
    const res = await call({ email: "user@example.com", password: "pw" });
    const { password: _omit, ...rest } = stored;

    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0]).toEqual({
      token: "signed.jwt",
      user: { ...rest, hasBrandGuidelines: true, hasDesignSystem: true },
    });
  });

  it("the token carries the same claims, with sv from the record that was read", async () => {
    await call({ email: "user@example.com", password: "pw" });

    expect(jwt.sign).toHaveBeenCalledWith(
      { userId: "u-1", email: "user@example.com", roles: ["customer"], isAdmin: false, sv: 7 },
      expect.any(String),
      { expiresIn: "90d" },
    );
  });

  it("400 without email, and without password, before any database call", async () => {
    for (const body of [{ password: "pw" }, { email: "user@example.com" }]) {
      const res = await call(body);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: "Email and password are required" });
    }
    expect(ddb().get).not.toHaveBeenCalled();
    noWrite();
  });

  it("404 user_not_found when there is no row, and for a deleted user's row", async () => {
    for (const item of [undefined, { ...stored, userId: "deleted_u-1" }]) {
      ddb().get.mockReturnValue(resolves({ Item: item }));
      const res = await call({ email: "user@example.com", password: "pw" });
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        message: "User not found. Please create an account to continue.",
        code: "user_not_found",
      });
    }
    expect(bcrypt.compare).not.toHaveBeenCalled();
    noWrite();
  });

  it("403 account_deactivated", async () => {
    ddb().get.mockReturnValue(resolves({ Item: { ...stored, isActive: false } }));
    const res = await call({ email: "user@example.com", password: "pw" });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: "Account has been deactivated. Please contact support.",
      code: "account_deactivated",
    });
    expect(bcrypt.compare).not.toHaveBeenCalled();
    noWrite();
  });

  it("401 invalid_credentials on a wrong password, with no token and no write", async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    const res = await call({ email: "user@example.com", password: "wrong" });

    expect(bcrypt.compare).toHaveBeenCalledWith("wrong", "stored-hash");
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      message: "Invalid credentials. Please check your email and password.",
      code: "invalid_credentials",
    });
    expect(jwt.sign).not.toHaveBeenCalled();
    noWrite();
  });

  it("401 temp_password_expired, with no token and no write", async () => {
    ddb().get.mockReturnValue(resolves({
      Item: { ...stored, mustChangePassword: true, tempPasswordExpires: new Date(Date.now() - 60_000).toISOString() },
    }));
    const res = await call({ email: "user@example.com", password: "pw" });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      message: "Your temporary password has expired. Please reset your password to continue.",
      code: "temp_password_expired",
    });
    expect(jwt.sign).not.toHaveBeenCalled();
    noWrite();
  });

  it("500 server_error when the read fails", async () => {
    ddb().get.mockReturnValue(rejects("InternalServerError"));
    const res = await call({ email: "user@example.com", password: "pw" });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Error logging in", code: "server_error" });
    noWrite();
  });
});

describe("ENG-3111 userDb.recordLogin", () => {
  it("lowercases the key and omits a null lastTouch", async () => {
    await userDb.recordLogin("User@Example.com", "u-1", { lastLoginTime: "2026-11-16T00:00:00.000Z", lastTouch: null });

    const p = ddb().update.mock.calls[0][0];
    expect(p.Key).toEqual({ email: "user@example.com" });
    expect(p.UpdateExpression).toBe("SET #lastLoginTime = :lastLoginTime");
    expect(ddb().query).not.toHaveBeenCalled();
    expect(ddb().get).not.toHaveBeenCalled();
  });

  it("throws on a failed condition instead of reporting success", async () => {
    ddb().update.mockReturnValue(rejects("ConditionalCheckFailedException"));
    await expect(userDb.recordLogin("user@example.com", "u-1", { lastLoginTime: "2026-11-16T00:00:00.000Z" }))
      .rejects.toMatchObject({ code: "ConditionalCheckFailedException" });
  });
});
