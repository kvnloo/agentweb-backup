jest.mock("../db", () => ({
  crmDb: { findAllLeadsByEmail: jest.fn(), getLeadById: jest.fn(), findLeadsByLinkedin: jest.fn(), getLeadListById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgMembers: jest.fn() },
}));
import { addressesOf, blockedContactError, blockedMessage, blockedRecipients, leadIsBlocked, linkedinProfileIsBlocked, unverifiedContactError } from "../contactGuard";
import { crmDb, orgDb, userDb } from "../db";

const db = crmDb as unknown as { findAllLeadsByEmail: jest.Mock; getLeadById: jest.Mock; findLeadsByLinkedin: jest.Mock; getLeadListById: jest.Mock };
const users = userDb as unknown as { getUserById: jest.Mock };
const orgs = orgDb as unknown as { getOrgMembers: jest.Mock };
beforeEach(() => {
  jest.resetAllMocks();
  users.getUserById.mockResolvedValue({ userId: "u1" }); // no org by default
  orgs.getOrgMembers.mockResolvedValue([]);
});

describe("addresses in a to/cc/bcc value", () => {
  it("handles strings, lists, display names, separators, mailto: and case", () => {
    expect(addressesOf("a@x.com")).toEqual(["a@x.com"]);
    expect(addressesOf("Ann <A@X.com>, b@y.com; \"C, D\" <c@z.com>")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(addressesOf(["a@x.com", "A@X.COM", "b@y.com"])).toEqual(["a@x.com", "b@y.com"]);
    expect(addressesOf("mailto:a@x.com")).toEqual(["a@x.com"]);
    expect(addressesOf("Ann <mailto:a@x.com>")).toEqual(["a@x.com"]);
    expect(addressesOf("a@x.com c@y.com")).toEqual(["a@x.com", "c@y.com"]);
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

  it("a block set by a teammate in the same org holds for the whole team, whether or not CRM sharing is on", async () => {
    users.getUserById.mockResolvedValue({ userId: "u1", orgId: "org1" });
    orgs.getOrgMembers.mockResolvedValue([{ userId: "u1" }, { userId: "teammate" }]);
    db.findAllLeadsByEmail.mockResolvedValue([{ userId: "teammate", contactStatus: "do-not-contact" }]);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual(["a@x.com"]);
    db.findAllLeadsByEmail.mockResolvedValue([{ userId: "other-org-user", contactStatus: "do-not-contact" }]);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual([]);
  });

  it("a lead with no owner recorded is resolved through its list, and blocked when the list is ours (never silently allowed)", async () => {
    db.findAllLeadsByEmail.mockResolvedValue([{ listId: "L1", contactStatus: "unsubscribed" }]);
    db.getLeadListById.mockResolvedValue({ userId: "u1" });
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual(["a@x.com"]);
    db.getLeadListById.mockResolvedValue({ userId: "someone-else" });
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual([]);
    db.getLeadListById.mockResolvedValue(null);
    expect(await blockedRecipients(["u1"], "a@x.com")).toEqual([]);
  });

  it("refuses (throws) when the lookup failed or hit its row cap, instead of sending unverified", async () => {
    db.findAllLeadsByEmail.mockRejectedValue(new Error("dynamo down"));
    await expect(blockedRecipients(["u1"], "a@x.com")).rejects.toThrow("dynamo down");
    db.findAllLeadsByEmail.mockResolvedValue(Array.from({ length: 200 }, () => ({ userId: "other", contactStatus: "active" })));
    await expect(blockedRecipients(["u1"], "info@x.com")).rejects.toThrow("too many contacts share this address");
  });

  it("does no lookup at all for a send with no address", async () => {
    expect(await blockedRecipients(["u1"], undefined, "")).toEqual([]);
    expect(db.findAllLeadsByEmail).not.toHaveBeenCalled();
  });

  it("the messages name only the caller's own addresses, tell the agent not to route around, and carry no internal wording", () => {
    expect(blockedMessage(["a@x.com"])).toContain("a@x.com is marked do-not-contact");
    expect(blockedMessage(["a@x.com", "b@x.com"])).toContain("are marked");
    expect(blockedMessage(["a@x.com"]) + blockedContactError + unverifiedContactError).not.toMatch(/ENG|Linear|ticket|slice/i);
    expect(unverifiedContactError).toContain("nothing was sent");
  });
});

describe("blocking by lead or LinkedIn profile (agent LinkedIn and X tools)", () => {
  it("leadIsBlocked: only our blocked lead, and nothing without both ids", async () => {
    db.getLeadById.mockResolvedValue({ userId: "u1", contactStatus: "do-not-contact" });
    expect(await leadIsBlocked(["u1"], "l1", "d1")).toBe(true);
    expect(await leadIsBlocked(["other"], "l1", "d1")).toBe(false);
    expect(await leadIsBlocked(["u1"], undefined, "d1")).toBe(false);
    expect(await leadIsBlocked(["u1"], "l1", undefined)).toBe(false);
    db.getLeadById.mockResolvedValue(null);
    expect(await leadIsBlocked(["u1"], "l1", "d1")).toBe(false);
  });
  it("leadIsBlocked: a lead with no owner recorded is resolved through the named list", async () => {
    db.getLeadById.mockResolvedValue({ contactStatus: "do-not-contact" });
    db.getLeadListById.mockResolvedValue({ userId: "u1" });
    expect(await leadIsBlocked(["u1"], "l1", "d1")).toBe(true);
    expect(db.getLeadListById).toHaveBeenCalledWith("l1");
  });
  it("linkedinProfileIsBlocked: finds the profile with or without a trailing slash, only among our leads", async () => {
    db.findLeadsByLinkedin.mockImplementation(async (v: string) => (v.endsWith("/") ? [{ userId: "u1", contactStatus: "unsubscribed" }] : []));
    expect(await linkedinProfileIsBlocked(["u1"], "https://www.linkedin.com/in/x")).toBe(true);
    expect(await linkedinProfileIsBlocked(["other"], "https://www.linkedin.com/in/x")).toBe(false);
    expect(await linkedinProfileIsBlocked(["u1"], undefined)).toBe(false);
    expect(await linkedinProfileIsBlocked(["u1"], "  ")).toBe(false);
  });
  it("linkedinProfileIsBlocked: throws at the row cap", async () => {
    db.findLeadsByLinkedin.mockResolvedValue(Array.from({ length: 10 }, () => ({ userId: "other", contactStatus: "active" })));
    await expect(linkedinProfileIsBlocked(["u1"], "https://www.linkedin.com/in/popular")).rejects.toThrow("too many contacts");
  });
});
