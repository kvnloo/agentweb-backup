import { PUSH_TOKEN_TTL_MS, signPushToken, verifyPushToken, type PushTokenPayload } from "../smartleadPushToken";

const NOW = Date.parse("2026-10-28T10:00:00Z");
const payload = (over: Partial<PushTokenPayload> = {}): PushTokenPayload => ({
  v: 1, jti: "jti-1", userId: "u1", accountId: "smartlead-u1", acknowledgeUnreadable: false, listId: "L1", campaignId: 77, includeUnverified: false, mapping: { industry: "customFields.industry" }, acknowledgedTags: [], startStatus: "DRAFTED",
  sequenceHash: "abc", eligible: 50, warnings: ["w"], iat: NOW, exp: NOW + PUSH_TOKEN_TTL_MS, ...over,
});

describe("push approval token (ENG-673)", () => {
  it("round-trips what was signed", () => {
    expect(verifyPushToken("s3cret", signPushToken("s3cret", payload()), NOW)).toEqual(payload());
  });

  it("gives the same token however the mapping and tags are ordered", () => {
    const a = signPushToken("s", payload({ mapping: { a: "x", b: "y" }, acknowledgedTags: ["q", "p"] }));
    const b = signPushToken("s", payload({ mapping: { b: "y", a: "x" }, acknowledgedTags: ["p", "q"] }));
    expect(a).toBe(b);
  });

  it("rejects a token signed with another secret", () => {
    expect(verifyPushToken("other", signPushToken("s", payload()), NOW)).toBeNull();
  });

  it("rejects a token whose body was changed (a wider count, another list, another campaign)", () => {
    const token = signPushToken("s", payload());
    const [body, sig] = token.split(".");
    for (const change of [{ eligible: 5000 }, { listId: "L2" }, { campaignId: 78 }, { userId: "u2" }, { sequenceHash: "zzz" }, { accountId: "smartlead-other" }, { jti: "another" }, { acknowledgeUnreadable: true }, { iat: 1 }]) {
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), ...change })).toString("base64url");
      expect(verifyPushToken("s", `${forged}.${sig}`, NOW)).toBeNull();
    }
  });

  it("rejects an expired token, and accepts one up to its expiry", () => {
    const token = signPushToken("s", payload());
    expect(verifyPushToken("s", token, NOW + PUSH_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyPushToken("s", token, NOW + PUSH_TOKEN_TTL_MS)).toBeNull();
  });

  it.each([undefined, null, 5, {}, "", ".", "a.b.c", "x".repeat(30_000), "abc.def", `${Buffer.from("{}").toString("base64url")}.`])("rejects a malformed token (%#) without throwing", bad => {
    expect(verifyPushToken("s", bad, NOW)).toBeNull();
  });

  it("rejects a correctly signed payload that is not a valid payload (a bad count or campaign id)", () => {
    for (const bad of [{ eligible: -1 }, { eligible: 1.5 }, { campaignId: 0 }, { campaignId: "7" as any }, { v: 2 as any }, { jti: "" }, { jti: 5 as any }, { accountId: 5 as any }, { acknowledgeUnreadable: "yes" as any }, { iat: "now" as any }, { warnings: "x" as any }]) {
      expect(verifyPushToken("s", signPushToken("s", payload(bad)), NOW)).toBeNull();
    }
  });
});
