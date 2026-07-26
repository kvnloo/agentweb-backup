import { buildSmokeTestEmail, isSmokeTestEmail } from "../utils/smokeTestLead";

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
});
