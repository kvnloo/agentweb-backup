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
    expect(new Set(addressesOf("o'brien@x.com"))).toEqual(new Set(["o'brien@x.com", "brien@x.com"])); // as written, and as a quoted address
    expect(new Set(addressesOf("Pat O'Brien <o'brien@x.com>"))).toEqual(new Set(["o'brien@x.com", "brien@x.com"]));
    expect(addressesOf("'a@x.com'")).toEqual(expect.arrayContaining(["a@x.com"]));
    // quoting that is not at the very start: the address is still found (the old parser found all of these)
    for (const wrapped of ["name='a@x.com'", "{'a@x.com'}", "*'a@x.com'", "<'a@x.com'>", "to=\"'a@x.com'\"", "x:'a@x.com'", "[''a@x.com'']", "list=['a@x.com', 'b@y.com']"]) {
      expect(addressesOf(wrapped)).toEqual(expect.arrayContaining(["a@x.com"]));
    }
    expect(addressesOf("list=['a@x.com', 'b@y.com']")).toEqual(expect.arrayContaining(["a@x.com", "b@y.com"]));
    expect(addressesOf("o'brien@x.com")).toEqual(expect.arrayContaining(["o'brien@x.com"])); // and a real apostrophe is still looked up as written
    expect(addressesOf("'".repeat(10) + "a@x.com").length).toBeLessThanOrEqual(6); // a hostile run of quotes cannot mean hundreds of lookups
    expect(new Set(addressesOf("x@y.com, o'neil@z.com"))).toEqual(new Set(["x@y.com", "o'neil@z.com", "neil@z.com"]));
    // `{` and `}` are legal in a local part and are not stripped
    expect(addressesOf("{a}@x.com")).toEqual(["{a}@x.com"]);
    expect(addressesOf(undefined)).toEqual([]);
    expect(addressesOf(42)).toEqual([]);
    expect(addressesOf("no address here")).toEqual([]);
  });
});

/**
 * The address parser as it was BEFORE the apostrophe handling was added (the main pass, unchanged). The new parser must find every clean address this one
 * finds, for any input: an apostrophe change once lost addresses this caught (`name='a@x.com'`, `'(a@x.com)'`, `'a@x.com'|'b@y.com'`), and a lost address is a
 * blocked contact that can be emailed. Found by differential testing against this baseline (2,895 hand-built inputs and 300,000 random strings, zero losses).
 */
function baselineAddressesOf(value: unknown): string[] {
  const clean = (raw: string) => {
    let t = raw.trim().toLowerCase();
    const at = t.indexOf("@");
    const q = at >= 0 ? t.indexOf("?", at) : -1;
    if (q >= 0) t = t.slice(0, q);
    let start = 0, end = t.length;
    while (start < end && "([".includes(t[start])) start++;
    while (end > start && ")].".includes(t[end - 1])) end--;
    return t.slice(start, end);
  };
  const out = new Set<string>();
  const parts = Array.isArray(value) ? value.flat(Infinity) : typeof value === "string" ? [value] : [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const piece of part.split(/[;,]/)) {
      if (piece.length > 600) continue;
      const bracketed = [...piece.matchAll(/<(?:mailto:)?([^<>\s]+@[^<>\s]+)>/gi)];
      const found = bracketed.length > 0 ? bracketed : [...piece.matchAll(/(?:mailto:)?([^\s<>";,:]+@[^\s<>"';,]+)/gi)];
      for (const m of found) { const c = clean(m[1]); if (c.includes("@")) out.add(c); }
    }
  }
  return [...out];
}

describe("the parser never loses an address the baseline parser found (ENG-673)", () => {
  it("forms that an earlier apostrophe change lost: quoted, joined by punctuation, wrapped in brackets after a quote, or behind many quotes", () => {
    const forms = [
      "name='a@x.com'", "{'a@x.com'}", "*'a@x.com'", "<'a@x.com'>", "x:'a@x.com'", "'(a@x.com)'", "['(a@x.com)']", "'[a@x.com]'", "name='(a@x.com)'", "x'(a@x.com)",
      "'a@x.com'|'b@y.com'", "'a@x.com''b@y.com'", "a@x.com'b@y.com", "'a@x.com'+'b@y.com'", "'a@x.com'/'b@y.com'", "'a@x.com'&'b@y.com'", "'a@x.com'='b@y.com'",
      "['a@x.com'|'b@y.com']", "a@x.com'&cc=b@y.com", "a@x.com'/b@y.com", "x:'a@x.com'|b@y.com", "a@x.com", "x'x'x'x'x'x'a@x.com", "'a'b'c'd'e'f'g'a@x.com",
      "a'b@o'brien@x.com",
    ];
    for (const f of forms) for (const addr of baselineAddressesOf(f).filter(a => !/['"]/.test(a))) expect({ f, found: addressesOf(f).includes(addr), addr }).toEqual({ f, found: true, addr });
  });

  it("for 20,000 random strings of quote, bracket, punctuation and address fragments, nothing clean from the baseline is missing", () => {
    const tokens = ["'", "'", "\"", "a@x.com", "b@y.com", "o'b@x.com", " ", ",", "<", ">", "(", ")", "[", "]", "{", "}", ":", "=", "mailto:", "?", "n", ".", " <", "> ", "*", "|", "&", "+", "/"];
    let seed = 4242;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const losses: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      let str = "";
      for (let j = 0, k = 1 + Math.floor(rnd() * 9); j < k; j++) str += tokens[Math.floor(rnd() * tokens.length)];
      const now = addressesOf(str);
      for (const addr of baselineAddressesOf(str)) if (!/['"]/.test(addr) && !now.includes(addr)) losses.push(`${JSON.stringify(str)} lost ${addr}`);
    }
    expect(losses.slice(0, 5)).toEqual([]);
  });

  it("a bounded number of readings of one address, and the bare address inside the quotes is always among them", () => {
    for (const n of [3, 6, 10, 40, 200]) {
      for (const input of ["'".repeat(n) + "a@x.com", "x'".repeat(n) + "a@x.com"]) {
        expect(addressesOf(input).length).toBeLessThanOrEqual(7); // the main pass's one plus at most 6 extra readings
        expect(addressesOf(input)).toContain("a@x.com");
      }
    }
    expect(addressesOf("x'".repeat(40) + "a@x.com").length).toBeGreaterThan(3); // and the readings are really produced (the cap is not hiding a broken pass)
    expect(addressesOf("'a'b'c'd'e'f'g'a@x.com")).toContain("a@x.com");
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
