import { openSignInToken, sealSignInToken, type SignInTokenPayload } from "../hostedSignInToken";

const P: SignInTokenPayload = { userId: "u1", provider: "claude", connectionId: "c1", loginRef: "ref-1", reconnect: false, expiresAtMs: 2_000_000 };
const SECRET = "unit-test-secret";

describe("sign-in token", () => {
  it("round-trips and gives a fresh token each time", () => {
    const a = sealSignInToken(P, SECRET);
    expect(openSignInToken(a, 1_000_000, SECRET)).toEqual(P);
    expect(sealSignInToken(P, SECRET)).not.toBe(a);
  });
  it("is expired at and after its expiry", () => {
    const t = sealSignInToken(P, SECRET);
    expect(openSignInToken(t, 1_999_999, SECRET)).toBeDefined();
    expect(openSignInToken(t, 2_000_000, SECRET)).toBeUndefined();
  });
  it("is refused under another secret (rotation means start again)", () => {
    expect(openSignInToken(sealSignInToken(P, SECRET), 1, "other-secret")).toBeUndefined();
  });
  it("is refused when any byte is changed", () => {
    const raw = Buffer.from(sealSignInToken(P, SECRET), "base64url");
    for (const i of [0, 11, 12, Math.floor(raw.length / 2), raw.length - 1]) {
      const c = Buffer.from(raw);
      c[i] ^= 1;
      expect(openSignInToken(c.toString("base64url"), 1, SECRET)).toBeUndefined();
    }
  });
  it("hides its contents", () => {
    const text = Buffer.from(sealSignInToken(P, SECRET), "base64url").toString("latin1");
    expect(text).not.toContain("ref-1");
    expect(text).not.toContain("u1");
  });
  it("never throws on junk", () => {
    for (const j of [undefined, null, 7, {}, "", "!!", "A".repeat(5000), "AAAA"]) expect(openSignInToken(j, 1, SECRET)).toBeUndefined();
  });
  it("accepts only the spelling it issued (lenient base64url aliases are refused)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let checked = 0;
    // A token has an alias spelling only when its byte length is not a multiple of 3, so try payloads until one does.
    for (let n = 1; n <= 6; n++) {
      const t = sealSignInToken({ ...P, loginRef: "r".repeat(n) }, SECRET);
      const bytes = Buffer.from(t, "base64url");
      for (const ch of alphabet) {
        const alt = t.slice(0, -1) + ch;
        if (alt === t || !Buffer.from(alt, "base64url").equals(bytes)) continue;
        checked++;
        expect(openSignInToken(alt, 1, SECRET)).toBeUndefined();
        expect(openSignInToken(t, 1, SECRET)).toBeDefined();
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
