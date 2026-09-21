import { buildSmokeTestEmail, isSmokeTestEmail, buildSmokeTestPhone, isSmokeTestPhone, isSmokeTestLead } from "../utils/smokeTestLead";

describe("smokeTestLead", () => {
  it("SUCCESS: buildSmokeTestEmail's own output is recognized by isSmokeTestEmail", () => {
    const email = buildSmokeTestEmail();
    expect(isSmokeTestEmail(email)).toBe(true);
  });

  it("SUCCESS: recognizes a well-formed smoke-test email regardless of case/whitespace", () => {
    expect(isSmokeTestEmail("smoke-test+1721000000000@agentweb.pro")).toBe(true);
    expect(isSmokeTestEmail("  SMOKE-TEST+1721000000000@AGENTWEB.PRO  ")).toBe(true);
  });

  it("FAIL: a real customer email is never recognized as a smoke-test email", () => {
    expect(isSmokeTestEmail("real-customer@example.com")).toBe(false);
  });

  it("FAIL: a similar-looking but non-matching email is not recognized (regression guard for the '+' escaping bug)", () => {
    expect(isSmokeTestEmail("smoke-test-but-not-really@agentweb.pro")).toBe(false);
    expect(isSmokeTestEmail("smoke-testXX1721000000000@agentweb.pro")).toBe(false);
    expect(isSmokeTestEmail("smoke-test+abc@agentweb.pro")).toBe(false); // must be digits
    expect(isSmokeTestEmail("smoke-test+1721000000000@notagentweb.pro")).toBe(false);
  });

  it("FAIL: undefined/null/empty email never throws, returns false", () => {
    expect(isSmokeTestEmail(undefined)).toBe(false);
    expect(isSmokeTestEmail(null)).toBe(false);
    expect(isSmokeTestEmail("")).toBe(false);
  });

  it("PASS: the synthetic phone is recognised, in whatever shape the CRM stored it", () => {
    // This is the marker that covers a lander with NO email field: it substitutes its own
    // placeholder address (observed live: noemail+<ts>@waterheater.app), so the address
    // marker cannot match and every suppression would otherwise fire on a synthetic lead.
    expect(isSmokeTestPhone("4155550142")).toBe(true);
    expect(isSmokeTestPhone("(415) 555-0142")).toBe(true);
    expect(isSmokeTestPhone("+1 415-555-0100")).toBe(false); // country code is not stripped to our shape
    expect(isSmokeTestPhone("4155550199")).toBe(true);
  });

  it("FAIL: a real phone number is never recognised, including nearby non-reserved ones", () => {
    expect(isSmokeTestPhone("4155551234")).toBe(false); // same exchange, outside the 01xx block
    expect(isSmokeTestPhone("2025550142")).toBe(false); // reserved block, different area code
    expect(isSmokeTestPhone("4155550200")).toBe(false); // one past the reserved block
    expect(isSmokeTestPhone(undefined)).toBe(false);
    expect(isSmokeTestPhone(null)).toBe(false);
    expect(isSmokeTestPhone("")).toBe(false);
  });

  it("buildSmokeTestPhone always produces a value its own recogniser accepts", () => {
    // The fill site and the suppression site must never drift apart.
    for (let i = 0; i < 5; i++) {
      const phone = buildSmokeTestPhone();
      expect(phone).toMatch(/^41555501\d{2}$/);
      expect(isSmokeTestPhone(phone)).toBe(true);
    }
  });

  it("isSmokeTestLead matches on EITHER marker, and neither for a real lead", () => {
    expect(isSmokeTestLead({ email: "smoke-test+1721000000000@agentweb.pro" })).toBe(true);
    // the case the address marker cannot cover
    expect(isSmokeTestLead({ email: "noemail+1789767265236@waterheater.app", phone: "4155550142" })).toBe(true);
    expect(isSmokeTestLead({ email: "buyer@acme.com", phone: "4155551234" })).toBe(false);
    expect(isSmokeTestLead({ email: "buyer@acme.com" })).toBe(false);
    expect(isSmokeTestLead(null)).toBe(false);
    expect(isSmokeTestLead(undefined)).toBe(false);
  });
});
