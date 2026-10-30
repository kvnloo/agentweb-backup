import { signWebhookToken, verifyWebhookToken } from "../smartleadWebhookToken";

const SECRET = "test-secret";

describe("the Smartlead webhook URL token (ENG-673)", () => {
  it("verifies the exact token made for this account and campaign", () => {
    const t = signWebhookToken(SECRET, "smartlead-u1", 77);
    expect(verifyWebhookToken(SECRET, "smartlead-u1", 77, t)).toBe(true);
    expect(verifyWebhookToken(SECRET, "smartlead-u1", "77", t)).toBe(true); // the URL gives the campaign as text
  });

  it("is bound to the account, the campaign and the secret", () => {
    const t = signWebhookToken(SECRET, "smartlead-u1", 77);
    expect(verifyWebhookToken(SECRET, "smartlead-u2", 77, t)).toBe(false);
    expect(verifyWebhookToken(SECRET, "smartlead-u1", 78, t)).toBe(false);
    expect(verifyWebhookToken("other-secret", "smartlead-u1", 77, t)).toBe(false);
    // the separator cannot be used to shift a character between the account and the campaign
    expect(signWebhookToken(SECRET, "a", "1|2")).not.toBe(signWebhookToken(SECRET, "a|1", 2));
  });

  it("is stable, and never throws on odd input", () => {
    expect(signWebhookToken(SECRET, "a", 1)).toBe(signWebhookToken(SECRET, "a", 1));
    for (const bad of [undefined, null, "", 0, {}, [], "x", "a".repeat(5000)]) {
      expect(verifyWebhookToken(SECRET, "a", 1, bad)).toBe(false);
    }
    expect(verifyWebhookToken(SECRET, undefined, 1, "x")).toBe(false);
    expect(verifyWebhookToken(SECRET, "a", undefined, "x")).toBe(false);
    expect(verifyWebhookToken(SECRET, "", 1, signWebhookToken(SECRET, "", 1))).toBe(false);
  });
});
