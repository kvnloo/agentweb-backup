// ENG-724 (UTM slice B): storage accessors for the customer-level UTM default
// and the per-lander override. DynamoDB mocked (same convention as
// durableLandingService.test.ts); the user record goes through userDb so the
// AW-Users key handling stays in one place.

const mockUpdate = jest.fn();
const mockGet = jest.fn();

jest.mock("aws-sdk", () => {
  const client = () => ({ update: mockUpdate, get: mockGet });
  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock("../services/db", () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
}));

import {
  getCustomerUtmDefault,
  setCustomerUtmDefault,
  getLanderUtmOverride,
  setLanderUtmOverride,
} from "../services/landerUtmStore";

const ok = (value: any) => ({ promise: () => Promise.resolve(value) });
const fail = (err: any) => ({ promise: () => Promise.reject(err) });

beforeEach(() => {
  mockUpdate.mockReset();
  mockGet.mockReset();
  mockGetUserById.mockReset();
  mockUpdateUser.mockReset();
  mockUpdateUser.mockResolvedValue({});
});

describe("customer-level UTM default (AC 1)", () => {
  it("writes a validated default through userDb and reads it back", async () => {
    const config = { utm_source: "newsletter", utm_medium: "email" };
    const stored = await setCustomerUtmDefault("user-1", config);
    expect(stored).toEqual(config);
    expect(mockUpdateUser).toHaveBeenCalledWith("user-1", {
      landerUtmDefault: config,
    });

    mockGetUserById.mockResolvedValue({ userId: "user-1", landerUtmDefault: config });
    expect(await getCustomerUtmDefault("user-1")).toEqual(config);
  });

  it("trims values on write and rejects reserved/unknown keys and blank values", async () => {
    const stored = await setCustomerUtmDefault("user-1", { utm_source: "  ads  " });
    expect(stored).toEqual({ utm_source: "ads" });

    await expect(setCustomerUtmDefault("user-1", { gclid: "x" } as any)).rejects.toThrow(/reserved/);
    await expect(setCustomerUtmDefault("user-1", { nope: "x" } as any)).rejects.toThrow(/unsupported/);
    await expect(setCustomerUtmDefault("user-1", { utm_source: "  " })).rejects.toThrow(/empty/);
  });

  it("rejects an empty config object — clearing is explicit via null", async () => {
    await expect(setCustomerUtmDefault("user-1", {})).rejects.toThrow(/null/);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("clears the default with null (REMOVE semantics via userDb)", async () => {
    await setCustomerUtmDefault("user-1", null);
    expect(mockUpdateUser).toHaveBeenCalledWith("user-1", { landerUtmDefault: null });
  });
});

describe("per-lander override (AC 2)", () => {
  it("writes the override to the lander record only, never via userDb", async () => {
    mockUpdate.mockReturnValue(ok({}));
    const stored = await setLanderUtmOverride("page-1", { utm_campaign: "launch" });
    expect(stored).toEqual({ utm_campaign: "launch" });

    expect(mockUpdateUser).not.toHaveBeenCalled();
    const arg = mockUpdate.mock.calls[0][0];
    expect(arg.TableName).toMatch(/AW-LandingPages$/);
    expect(arg.Key).toEqual({ id: "page-1" });
    expect(arg.UpdateExpression).toBe("SET utmOverride = :utmOverride");
    expect(arg.ExpressionAttributeValues).toEqual({ ":utmOverride": { utm_campaign: "launch" } });
    // Guard against materializing a phantom lander record.
    expect(arg.ConditionExpression).toMatch(/attribute_exists\(id\)/);
  });

  it("reads the override back independently of the customer default", async () => {
    mockGet.mockReturnValue(
      ok({ Item: { id: "page-1", utmOverride: { utm_campaign: "launch" } } })
    );
    expect(await getLanderUtmOverride("page-1")).toEqual({ utm_campaign: "launch" });
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it("clears the override with null via REMOVE", async () => {
    mockUpdate.mockReturnValue(ok({}));
    await setLanderUtmOverride("page-1", null);
    const arg = mockUpdate.mock.calls[0][0];
    expect(arg.UpdateExpression).toBe("REMOVE utmOverride");
  });

  it("surfaces a missing lander record as a named error, not a silent write", async () => {
    mockUpdate.mockReturnValue(
      fail(Object.assign(new Error("conditional"), { code: "ConditionalCheckFailedException" }))
    );
    await expect(setLanderUtmOverride("nope", { utm_source: "x" })).rejects.toThrow(/no landing page/i);
  });
});

describe("a default write never touches lander records (AC 3, AC 4)", () => {
  it("setCustomerUtmDefault performs zero DynamoDB writes against AW-LandingPages", async () => {
    await setCustomerUtmDefault("user-1", { utm_source: "ads" });
    expect(mockUpdate).not.toHaveBeenCalled();
    // The single user write sets ONLY the default field — it cannot clobber an
    // override because the override does not live on the user record at all.
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockUpdateUser.mock.calls[0][1])).toEqual(["landerUtmDefault"]);
  });
});

describe("absent is a legal state (AC 5) and old records still read (AC 6)", () => {
  it("returns null for a user record written before this change", async () => {
    mockGetUserById.mockResolvedValue({ userId: "user-1", email: "a@b.c" });
    expect(await getCustomerUtmDefault("user-1")).toBeNull();
  });

  it("returns null for a missing user", async () => {
    mockGetUserById.mockResolvedValue(null);
    expect(await getCustomerUtmDefault("user-1")).toBeNull();
  });

  it("returns null for a lander record without the field, and for a missing record", async () => {
    mockGet.mockReturnValueOnce(ok({ Item: { id: "page-1" } }));
    expect(await getLanderUtmOverride("page-1")).toBeNull();

    mockGet.mockReturnValueOnce(ok({}));
    expect(await getLanderUtmOverride("page-2")).toBeNull();
  });

  it("normalizes a corrupt stored shape ({} or non-object) to null rather than emitting it", async () => {
    mockGetUserById.mockResolvedValue({ userId: "user-1", landerUtmDefault: {} });
    expect(await getCustomerUtmDefault("user-1")).toBeNull();

    mockGet.mockReturnValue(ok({ Item: { id: "page-1", utmOverride: "bogus" } }));
    expect(await getLanderUtmOverride("page-1")).toBeNull();
  });
});
