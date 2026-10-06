import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

jest.mock("../services/landerUtmStore", () => ({
  getCustomerUtmDefault: jest.fn(),
  setCustomerUtmDefault: jest.fn(),
  getLanderUtmOverride: jest.fn(),
  setLanderUtmOverride: jest.fn(),
}));
jest.mock("../services/v0Service", () => ({
  getLandingPagesByOwner: jest.fn(),
  getLandingPagesByOrg: jest.fn(),
  getLandingPageById: jest.fn(),
}));
jest.mock("../services/db", () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock("../services/evaluationPolicy", () => ({ isEvaluationUser: () => false }));

import router from "../routes/landerUtm";
import * as store from "../services/landerUtmStore";
import * as pages from "../services/v0Service";
import { userDb } from "../services/db";

const mockStore = jest.mocked(store);
const mockPages = jest.mocked(pages);
const mockUser = jest.mocked(userDb.getUserById);
const app = express();
app.use(express.json());
app.use("/api/lander-utm", router);
const base = "/api/lander-utm";
const ownPage = { id: "p1", name: "Launch", userId: "u1" };
const defaults = { utm_source: "newsletter", utm_medium: "email" };
const override = { utm_source: "partner" };
const token = () => jwt.sign({ userId: "u1", email: "u1@example.com" }, process.env.JWT_SECRET!);
const get = (path: string) => request(app).get(base + path).auth(token(), { type: "bearer" });
const put = (path: string, body: object) => request(app).put(base + path).auth(token(), { type: "bearer" }).send(body);

beforeEach(() => {
  jest.resetAllMocks();
  mockUser.mockImplementation(async (id) => ({ userId: id, email: `${id}@example.com`, orgId: "org1" }) as any);
  mockStore.getCustomerUtmDefault.mockResolvedValue(null);
  mockStore.getLanderUtmOverride.mockResolvedValue(null);
  mockStore.setCustomerUtmDefault.mockImplementation(async (_id, config) => config);
  mockStore.setLanderUtmOverride.mockImplementation(async (_id, config) => config);
  mockPages.getLandingPagesByOwner.mockResolvedValue([ownPage] as any);
  mockPages.getLandingPagesByOrg.mockResolvedValue([]);
  mockPages.getLandingPageById.mockResolvedValue(ownPage as any);
});

describe("lander UTM authentication", () => {
  it.each([
    ["get", "/default"], ["put", "/default"],
    ["get", "/landers"], ["put", "/landers/p1/override"],
  ] as const)("rejects unauthenticated %s %s", async (method, path) => {
    const response = await request(app)[method](base + path).send({ default: null, override: null });
    expect(response.status).toBe(401);
    expect(mockStore.getCustomerUtmDefault).not.toHaveBeenCalled();
    expect(mockStore.setCustomerUtmDefault).not.toHaveBeenCalled();
    expect(mockStore.setLanderUtmOverride).not.toHaveBeenCalled();
    expect(mockPages.getLandingPagesByOwner).not.toHaveBeenCalled();
    expect(mockPages.getLandingPageById).not.toHaveBeenCalled();
  });
  it("rejects an invalid bearer token", async () => {
    expect((await request(app).get(base + "/default").auth("invalid", { type: "bearer" })).status).toBe(401);
  });
});

describe("customer default", () => {
  it.each([null, defaults])("reads the caller's default: %j", async (value) => {
    mockStore.getCustomerUtmDefault.mockResolvedValue(value);
    const response = await get("/default");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ default: value });
    expect(mockStore.getCustomerUtmDefault).toHaveBeenCalledWith("u1");
  });
  it.each([null, { utm_source: "  newsletter  " }])("writes/clears only the default: %j", async (value) => {
    const response = await put("/default", { default: value });
    const stored = value === null ? null : { utm_source: "newsletter" };
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ default: stored });
    expect(mockStore.setCustomerUtmDefault).toHaveBeenCalledWith("u1", stored);
    expect(mockStore.setLanderUtmOverride).not.toHaveBeenCalled();
    expect(mockPages.getLandingPagesByOwner).not.toHaveBeenCalled();
    expect(mockPages.getLandingPagesByOrg).not.toHaveBeenCalled();
  });
});

describe("lander state", () => {
  it.each([
    [null, null, "not_set", null],
    [defaults, null, "inherited", defaults],
    [defaults, override, "overridden", { ...defaults, ...override }],
    [null, override, "overridden", override],
  ])("resolves default %j and override %j as %s", async (customerDefault, landerOverride, state, effective) => {
    mockStore.getCustomerUtmDefault.mockResolvedValue(customerDefault as any);
    mockStore.getLanderUtmOverride.mockResolvedValue(landerOverride as any);
    const response = await get("/landers");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ landers: [{ pageId: "p1", name: "Launch", override: landerOverride, effective, state }] });
    expect(mockPages.getLandingPagesByOwner).toHaveBeenCalledWith("u1");
    expect(mockStore.getLanderUtmOverride).toHaveBeenCalledWith("p1", "u1");
  });
  it("includes same-org landers with caller-scoped overrides", async () => {
    mockPages.getLandingPagesByOrg.mockResolvedValue([{ id: "p2", name: "Team", userId: "u2" }] as any);
    const response = await get("/landers");
    expect(response.status).toBe(200);
    expect(response.body.landers.map((p: any) => p.pageId)).toEqual(["p1", "p2"]);
    expect(mockPages.getLandingPagesByOrg).toHaveBeenCalledWith("org1", "u1");
    expect(mockStore.getLanderUtmOverride).toHaveBeenCalledWith("p2", "u1");
  });
  it("does not list org landers for an unaffiliated caller", async () => {
    mockUser.mockResolvedValue({ userId: "u1" } as any);
    mockPages.getLandingPagesByOwner.mockResolvedValue([]);
    const response = await get("/landers");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ landers: [] });
    expect(mockPages.getLandingPagesByOrg).not.toHaveBeenCalled();
  });
});

describe("lander override writes", () => {
  it.each([null, { utm_source: "  partner  " }])("writes/clears only the override: %j", async (value) => {
    const response = await put("/landers/p1/override", { override: value });
    const stored = value === null ? null : override;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ override: stored });
    expect(mockStore.setLanderUtmOverride).toHaveBeenCalledWith("p1", stored);
    expect(mockStore.setCustomerUtmDefault).not.toHaveBeenCalled();
  });
  it("returns to inherited after clearing an override", async () => {
    mockStore.getCustomerUtmDefault.mockResolvedValue(defaults);
    mockStore.getLanderUtmOverride.mockResolvedValue(override);
    mockStore.setLanderUtmOverride.mockImplementation(async (_id, config) => {
      mockStore.getLanderUtmOverride.mockResolvedValue(config);
      return config;
    });
    expect((await put("/landers/p1/override", { override: null })).status).toBe(200);
    expect((await get("/landers")).body.landers[0]).toMatchObject({ override: null, effective: defaults, state: "inherited" });
    expect(mockStore.setCustomerUtmDefault).not.toHaveBeenCalled();
  });
  it("allows another member of the owner's org to write", async () => {
    mockPages.getLandingPageById.mockResolvedValue({ ...ownPage, userId: "u2" } as any);
    expect((await put("/landers/p1/override", { override })).status).toBe(200);
    expect(mockUser).toHaveBeenCalledWith("u2");
    expect(mockStore.setLanderUtmOverride).toHaveBeenCalledWith("p1", override);
  });
  it.each(["foreign", "missing", "no-org", "missing-owner", "ownerless"])("hides %s landers with 404", async (kind) => {
    mockPages.getLandingPageById.mockResolvedValue(kind === "missing" ? null : { ...ownPage, userId: kind === "ownerless" ? undefined : "u2" } as any);
    mockUser.mockImplementation(async (id) => {
      if (id === "u1") return { userId: id, orgId: kind === "no-org" ? undefined : "org1" } as any;
      if (kind === "missing-owner") return null;
      return { userId: id, orgId: kind === "no-org" ? undefined : "foreign-org" } as any;
    });
    const response = await put("/landers/p1/override", { override });
    expect(response.status).toBe(404);
    expect(mockStore.setLanderUtmOverride).not.toHaveBeenCalled();
    expect(mockStore.setCustomerUtmDefault).not.toHaveBeenCalled();
  });
});

describe.each([["/default", "default"], ["/landers/p1/override", "override"]])("validation on %s", (path, field) => {
  it.each([{}, [], "wrong-type", 42, true, { gclid: "x" }, { fbclid: "x" }, { aw_lander: "x" }, { unknown: "x" }, { utm_source: " " }, { utm_source: 1 }, { utm_source: ["x"] }])("rejects invalid config %j without writing", async (value) => {
    const response = await put(path, { [field]: value });
    expect(response.status).toBe(400);
    expect(response.body.error).toEqual(expect.any(String));
    expect(mockStore.setCustomerUtmDefault).not.toHaveBeenCalled();
    expect(mockStore.setLanderUtmOverride).not.toHaveBeenCalled();
  });
  it.each([{}, [], { unrelated: null }])("rejects missing field in body %j", async (body) => {
    expect((await put(path, body)).status).toBe(400);
    expect(mockStore.setCustomerUtmDefault).not.toHaveBeenCalled();
    expect(mockStore.setLanderUtmOverride).not.toHaveBeenCalled();
  });
  it("does not mislabel a storage failure as validation failure", async () => {
    mockStore.setCustomerUtmDefault.mockRejectedValue(new Error("storage unavailable"));
    mockStore.setLanderUtmOverride.mockRejectedValue(new Error("storage unavailable"));
    const response = await put(path, { [field]: override });
    expect(response.status).toBe(500);
    expect(response.body.error).not.toContain("storage unavailable");
  });
});
