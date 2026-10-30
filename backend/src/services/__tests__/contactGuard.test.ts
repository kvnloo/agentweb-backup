jest.mock("../db", () => ({
  crmDb: { findAllLeadsByEmail: jest.fn(), getLeadListById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgMembers: jest.fn() },
}));
import { addressesOf, blockedMessage, blockedRecipients, unverifiedContactError } from "../contactGuard";
import { crmDb, orgDb, userDb } from "../db";

const db = crmDb as unknown as { findAllLeadsByEmail: jest.Mock; getLeadListById: jest.Mock };
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
    expect(addressesOf("(a@x.com)")).toEqual(["a@x.com"]);
    expect(addressesOf("[a@x.com]")).toEqual(["a@x.com"]);
    expect(addressesOf("a@x.com.")).toEqual(["a@x.com"]);
    expect(addressesOf("a@x.com)")).toEqual(["a@x.com"]);
    expect(addressesOf("mailto:a@x.com?subject=hi")).toEqual(["a@x.com"]);
    expect(addressesOf([["a@x.com"], [["b@x.com"]]])).toEqual(["a@x.com", "b@x.com"]);
    // a `?` inside the local part is part of the address; only a query AFTER the domain is cut
    expect(addressesOf("what?@x.com")).toEqual(["what?@x.com"]);
    expect(addressesOf("a@x.com?subject=hi&body=b")).toEqual(["a@x.com"]);
    // an apostrophe is legal in a local part: o'brien@x.com is looked up as written, not as brien@x.com
    expect(addressesOf("o'brien@x.com")).toEqual(["o'brien@x.com", "brien@x.com"]); // as written, and as a quoted address
    expect(addressesOf("Pat O'Brien <o'brien@x.com>")).toEqual(["o'brien@x.com", "brien@x.com"]);
    expect(addressesOf("'a@x.com'")).toEqual(expect.arrayContaining(["a@x.com"]));
    // quoting that is not at the very start: the address is still found (the old parser found all of these)
    for (const wrapped of ["name='a@x.com'", "{'a@x.com'}", "*'a@x.com'", "<'a@x.com'>", "to=\"'a@x.com'\"", "x:'a@x.com'", "[''a@x.com'']", "list=['a@x.com', 'b@y.com']"]) {
      expect(addressesOf(wrapped)).toEqual(expect.arrayContaining(["a@x.com"]));
    }
    expect(addressesOf("list=['a@x.com', 'b@y.com']")).toEqual(expect.arrayContaining(["a@x.com", "b@y.com"]));
    expect(addressesOf("o'brien@x.com")).toEqual(expect.arrayContaining(["o'brien@x.com"])); // and a real apostrophe is still looked up as written
    expect(addressesOf("'".repeat(10) + "a@x.com").length).toBeLessThanOrEqual(6); // a hostile run of quotes cannot mean hundreds of lookups
    expect(addressesOf("x@y.com, o'neil@z.com")).toEqual(["x@y.com", "o'neil@z.com", "neil@z.com"]);
    // `{` and `}` are legal in a local part and are not stripped
    expect(addressesOf("{a}@x.com")).toEqual(["{a}@x.com"]);
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

  it("long hostile input is bounded: a piece over the length limit is skipped, and 100,000 characters take well under a second", () => {
    const started = Date.now();
    expect(addressesOf("a".repeat(100_000))).toEqual([]);
    expect(addressesOf(".".repeat(100_000) + "x")).toEqual([]);
    expect(addressesOf("(".repeat(50_000) + ")".repeat(50_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    // a normal address next to a hostile piece is still found
    expect(addressesOf(`${"a".repeat(5000)}, ok@x.com`)).toEqual(["ok@x.com"]);
  });

  it("a recipient too long to look at REFUSES the send instead of being skipped, even next to a fine address", async () => {
    db.findAllLeadsByEmail.mockResolvedValue([]);
    await expect(blockedRecipients(["u1"], `"${"N".repeat(700)}" <hidden@x.com>`)).rejects.toThrow("too long to check");
    await expect(blockedRecipients(["u1"], "ok@x.com", ["fine@x.com", "z".repeat(700)])).rejects.toThrow("too long to check");
    expect(await blockedRecipients(["u1"], "ok@x.com")).toEqual([]);
  });

  it("does no lookup at all for a send with no address", async () => {
    expect(await blockedRecipients(["u1"], undefined, "")).toEqual([]);
    expect(db.findAllLeadsByEmail).not.toHaveBeenCalled();
  });

  it("the messages name only the caller's own addresses, tell the agent not to route around, and carry no internal wording", () => {
    expect(blockedMessage(["a@x.com"])).toContain("a@x.com is marked do-not-contact");
    expect(blockedMessage(["a@x.com", "b@x.com"])).toContain("are marked");
    expect(blockedMessage(["a@x.com"]) + unverifiedContactError).not.toMatch(/ENG|Linear|ticket|slice/i);
    expect(unverifiedContactError).toContain("nothing was sent");
  });
});
