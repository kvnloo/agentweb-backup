jest.mock("../db", () => ({ crmDb: { findAllLeadsByEmail: jest.fn(), getLeadById: jest.fn(), findLeadsByLinkedin: jest.fn() } }));
import { addressesOf, blockedContactError, blockedMessage, blockedRecipients, leadIsBlocked, linkedinProfileIsBlocked } from "../contactGuard";
import { crmDb } from "../db";

const db = crmDb as unknown as { findAllLeadsByEmail: jest.Mock; getLeadById: jest.Mock; findLeadsByLinkedin: jest.Mock };
beforeEach(() => jest.resetAllMocks());

describe("addresses in a to/cc/bcc value", () => {
  it("handles strings, lists, display names, separators and case", () => {
    expect(addressesOf("a@x.com")).toEqual(["a@x.com"]);
    expect(addressesOf("Ann <A@X.com>, b@y.com; \"C, D\" <c@z.com>")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(addressesOf(["a@x.com", "A@X.COM", "b@y.com"])).toEqual(["a@x.com", "b@y.com"]);
    expect(addressesOf(undefined)).toEqual([]);
    expect(addressesOf(42)).toEqual([]);
    expect(addressesOf("no address here")).toEqual([]);
  });
});

describe("blocking by address (agent email tools, the Emma API) (ENG-673)", () => {
  it("blocks an address that belongs to a do-not-contact lead of the sender, in any of the three statuses", async () => {
    for (const status of [{ contactStatus: "do-not-contact" }, { contactStatus: "unsubscribed" }, { unsubscribedFromGroupEmail: true }]) {
      db.findAllLeadsByEmail.mockResolvedValue([{ userId: "u1", ...status }]);
      expect(await blockedRecipients(["u1"], "a@x.com")).toEqual(["a@x.com"]);
    }
  });
  it("also checks cc and bcc, and the mailbox owner as well as the caller", async () => {
    db.findAllLeadsByEmail.mockImplementation(async (a: string) => (a === "bcc@x.com" ? [{ userId: "owner", contactStatus: "do-not-contact" }] : []));
    expect(await blockedRecipients(["caller", "owner"], "a@x.com", "b@x.com", "bcc@x.com")).toEqual(["bcc@x.com"]);
  });
  it("ignores another customer's block, an active lead, and an unknown address", async () => {
    db.findAllLeadsByEmail.mockResolvedValue([{ userId: "someone-else", contactStatus: "do-not-contact" }]);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual([]);
    db.findAllLeadsByEmail.mockResolvedValue([{ userId: "u1", contactStatus: "active" }, { userId: "u1" }]);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual([]);
    db.findAllLeadsByEmail.mockResolvedValue([]);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual([]);
  });
  it("blocks when ANY copy of the contact (several lists) is blocked", async () => {
    db.findAllLeadsByEmail.mockResolvedValue([{ userId: "u1", contactStatus: "active" }, { userId: "u1", contactStatus: "unsubscribed" }]);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual(["a@x.com"]);
  });
  it("a failed lookup is thrown, so an unverified send does not go out", async () => {
    db.findAllLeadsByEmail.mockRejectedValue(new Error("dynamo down"));
    await expect(blockedRecipients(["u1"], "a@x.com")).rejects.toThrow("dynamo down");
  });
  it("the message names the people and tells the agent not to route around it, with no internal wording", () => {
    expect(blockedMessage(["a@x.com"])).toContain("a@x.com is marked do-not-contact");
    expect(blockedMessage(["a@x.com", "b@x.com"])).toContain("are marked");
    expect(blockedMessage(["a@x.com"]) + blockedContactError).not.toMatch(/ENG|Linear|ticket|slice/i);
  });
});

describe("blocking by lead or LinkedIn profile (agent LinkedIn and X tools)", () => {
  it("leadIsBlocked: only the caller's own blocked lead, and nothing without both ids", async () => {
    db.getLeadById.mockResolvedValue({ userId: "u1", contactStatus: "do-not-contact" });
    expect(await leadIsBlocked(["u1"], "l1", "d1")).toBe(true);
    expect(await leadIsBlocked(["other"], "l1", "d1")).toBe(false);
    expect(await leadIsBlocked(["u1"], undefined, "d1")).toBe(false);
    expect(await leadIsBlocked(["u1"], "l1", undefined)).toBe(false);
    db.getLeadById.mockResolvedValue(null);
    expect(await leadIsBlocked(["u1"], "l1", "d1")).toBe(false);
  });
  it("linkedinProfileIsBlocked: finds the profile with or without a trailing slash, only among the caller's leads", async () => {
    db.findLeadsByLinkedin.mockImplementation(async (v: string) => (v.endsWith("/") ? [{ userId: "u1", contactStatus: "unsubscribed" }] : []));
    expect(await linkedinProfileIsBlocked(["u1"], "https://www.linkedin.com/in/x")).toBe(true);
    expect(await linkedinProfileIsBlocked(["other"], "https://www.linkedin.com/in/x")).toBe(false);
    expect(await linkedinProfileIsBlocked(["u1"], undefined)).toBe(false);
    expect(await linkedinProfileIsBlocked(["u1"], "  ")).toBe(false);
  });
});
