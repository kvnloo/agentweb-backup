/**
 * Tests for landerUtm — the pure precedence resolver behind ENG-723 (slice A of
 * ENG-538 / ENG-327).
 *
 * Every `describe` below names the human-written acceptance criterion it proves.
 * The criteria come verbatim from Harsha's 2026-07-27 implementation contract and
 * are NOT modifiable by the implementation: the tests are written against the
 * contract, and the module is written to pass them.
 *
 * The resolver is deliberately the ONLY place precedence is computed. Later
 * slices (Meta `url_tags`, lander outbound decoration, the inherited-vs-overridden
 * UI) consume this one module rather than re-deriving the order — that
 * single-resolver requirement is explicit in the contract.
 */

import fs from "fs";
import path from "path";

import { UTM_KEYS } from "../adUtm";
import {
  CLICK_ID_KEYS,
  LANDER_PROVENANCE_KEY,
  LANDER_PROVENANCE_VALUE,
  resolveLanderParams,
  validateUtmConfig,
} from "../landerUtm";

describe("AC1 — precedence: visitor > per-lander override > customer default > absent", () => {
  it("prefers the visitor value when all three layers define the same key", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "facebook" },
      override: { utm_source: "lander-override" },
      customerDefault: { utm_source: "customer-default" },
    });

    expect(result.params.utm_source).toBe("facebook");
    expect(result.origins.utm_source).toBe("visitor");
  });

  it("prefers the per-lander override over the customer default", () => {
    const result = resolveLanderParams({
      override: { utm_source: "lander-override" },
      customerDefault: { utm_source: "customer-default" },
    });

    expect(result.params.utm_source).toBe("lander-override");
    expect(result.origins.utm_source).toBe("override");
  });

  it("uses the customer default when it is the only layer present", () => {
    const result = resolveLanderParams({
      customerDefault: { utm_source: "customer-default", utm_medium: "paid_social" },
    });

    expect(result.params.utm_source).toBe("customer-default");
    expect(result.params.utm_medium).toBe("paid_social");
    expect(result.origins.utm_source).toBe("default");
  });

  it("omits the parameter entirely when nothing supplies it — absent, not empty-string", () => {
    const result = resolveLanderParams();

    for (const key of UTM_KEYS) {
      expect(result.params).not.toHaveProperty(key);
      expect(result.origins).not.toHaveProperty(key);
    }
    // "" would be a silent downgrade of "absent"; assert the strict absence.
    expect(Object.values(result.params)).not.toContain("");
    expect(Object.keys(result.params)).toEqual([LANDER_PROVENANCE_KEY]);
  });

  it("resolves precedence per key, so a partial visitor does not erase configured keys", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "facebook" },
      override: { utm_campaign: "spring-launch" },
      customerDefault: { utm_source: "google", utm_medium: "cpc", utm_term: "seo audit" },
    });

    expect(result.params).toEqual({
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "spring-launch",
      utm_term: "seo audit",
      [LANDER_PROVENANCE_KEY]: LANDER_PROVENANCE_VALUE,
    });
    expect(result.origins).toEqual({
      utm_source: "visitor",
      utm_medium: "default",
      utm_campaign: "override",
      utm_term: "default",
      [LANDER_PROVENANCE_KEY]: "provenance",
    });
  });

  it("treats an empty or whitespace-only visitor value as not provided and falls through", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "", utm_medium: "   " },
      customerDefault: { utm_source: "customer-default", utm_medium: "email" },
    });

    expect(result.params.utm_source).toBe("customer-default");
    expect(result.params.utm_medium).toBe("email");
    expect(result.origins.utm_source).toBe("default");
  });

  it("leaves a key absent when the visitor sends it empty and no config supplies it", () => {
    const result = resolveLanderParams({ visitor: { utm_source: "" } });

    expect(result.params).not.toHaveProperty("utm_source");
  });

  it("ignores an undefined visitor value (an unset key on a parsed query object)", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: undefined },
      customerDefault: { utm_source: "customer-default" },
    });

    expect(result.params.utm_source).toBe("customer-default");
  });

  it("trims surrounding whitespace rather than emitting a padded value", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "  facebook  " },
      customerDefault: { utm_campaign: "  spring  " },
    });

    expect(result.params.utm_source).toBe("facebook");
    expect(result.params.utm_campaign).toBe("spring");
  });

  it("resolves every supported UTM key from each layer", () => {
    const visitorOnly = resolveLanderParams({
      visitor: Object.fromEntries(UTM_KEYS.map((key) => [key, `v-${key}`])),
    });
    const overrideOnly = resolveLanderParams({
      override: Object.fromEntries(UTM_KEYS.map((key) => [key, `o-${key}`])),
    });

    for (const key of UTM_KEYS) {
      expect(visitorOnly.params[key]).toBe(`v-${key}`);
      expect(overrideOnly.params[key]).toBe(`o-${key}`);
    }
  });
});

describe("AC2 — gclid and fbclid are preserved, never dropped, overwritten, or renamed", () => {
  it("passes both click IDs through untouched", () => {
    const result = resolveLanderParams({
      visitor: { gclid: "Cj0KCQ-abc123", fbclid: "IwAR0-xyz789" },
    });

    expect(result.params.gclid).toBe("Cj0KCQ-abc123");
    expect(result.params.fbclid).toBe("IwAR0-xyz789");
    expect(result.origins.gclid).toBe("visitor");
    expect(result.origins.fbclid).toBe("visitor");
  });

  it("preserves click IDs when every UTM layer is also populated", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "facebook", gclid: "g-1", fbclid: "f-1" },
      override: { utm_source: "o", utm_medium: "o" },
      customerDefault: { utm_source: "d", utm_campaign: "d" },
    });

    expect(result.params.gclid).toBe("g-1");
    expect(result.params.fbclid).toBe("f-1");
  });

  it("keeps the click ID keys under their exact names — never renamed", () => {
    const result = resolveLanderParams({ visitor: { gclid: "g-1", fbclid: "f-1" } });

    expect(Object.keys(result.params)).toEqual(expect.arrayContaining(["gclid", "fbclid"]));
    expect([...CLICK_ID_KEYS]).toEqual(["gclid", "fbclid"]);
  });

  it("omits a click ID that the visitor did not send, rather than emitting a blank", () => {
    const result = resolveLanderParams({ visitor: { gclid: "g-1" } });

    expect(result.params.gclid).toBe("g-1");
    expect(result.params).not.toHaveProperty("fbclid");
  });

  it("refuses to let a config layer overwrite a click ID", () => {
    expect(() =>
      resolveLanderParams({
        visitor: { gclid: "real-click-id" },
        customerDefault: { gclid: "configured" } as never,
      }),
    ).toThrow(/reserved parameter "gclid"/);
  });

  it("refuses a click ID configured on the per-lander override", () => {
    expect(() => resolveLanderParams({ override: { fbclid: "nope" } as never })).toThrow(
      /reserved parameter "fbclid"/,
    );
  });
});

describe("AC3 — provenance uses aw_lander, never a repurposed customer UTM", () => {
  it("always stamps aw_lander=1", () => {
    expect(resolveLanderParams().params[LANDER_PROVENANCE_KEY]).toBe(LANDER_PROVENANCE_VALUE);
    expect(LANDER_PROVENANCE_KEY).toBe("aw_lander");
    expect(LANDER_PROVENANCE_VALUE).toBe("1");
  });

  it("never writes provenance into a standard UTM key", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "facebook", utm_medium: "paid_social" },
    });

    // The customer's values survive verbatim; provenance lives in its own field.
    expect(result.params.utm_source).toBe("facebook");
    expect(result.params.utm_medium).toBe("paid_social");
    // Absent keys stay absent (AC1); the ones that are present carry the
    // customer's value and no trace of our provenance.
    for (const key of UTM_KEYS) {
      const value = result.params[key];
      if (value === undefined) {
        continue;
      }
      expect(value).not.toBe(LANDER_PROVENANCE_VALUE);
      expect(value).not.toContain("agentweb");
      expect(value).not.toContain(LANDER_PROVENANCE_KEY);
    }
  });

  it("does not let a config layer claim the provenance key", () => {
    expect(() =>
      resolveLanderParams({ customerDefault: { aw_lander: "0" } as never }),
    ).toThrow(/reserved parameter "aw_lander"/);
  });

  it("emits our own provenance value even if a visitor arrives carrying aw_lander", () => {
    const result = resolveLanderParams({ visitor: { aw_lander: "spoofed" } });

    expect(result.params[LANDER_PROVENANCE_KEY]).toBe(LANDER_PROVENANCE_VALUE);
    expect(result.origins[LANDER_PROVENANCE_KEY]).toBe("provenance");
  });
});

describe("AC4 — no duplicate utm_source, or any duplicated key, is ever emitted", () => {
  it("returns each key exactly once across every layer combination", () => {
    const result = resolveLanderParams({
      visitor: { utm_source: "facebook", gclid: "g-1", aw_lander: "spoofed" },
      override: { utm_source: "o", utm_medium: "o" },
      customerDefault: { utm_source: "d", utm_medium: "d", utm_campaign: "d" },
    });

    const keys = Object.keys(result.params);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((key) => key === "utm_source")).toHaveLength(1);
    expect(keys.filter((key) => key === LANDER_PROVENANCE_KEY)).toHaveLength(1);
  });

  it("emits keys in a deterministic order: UTMs, then click IDs, then provenance", () => {
    const result = resolveLanderParams({
      visitor: {
        fbclid: "f-1",
        utm_term: "t",
        gclid: "g-1",
        utm_source: "s",
        utm_content: "c",
        utm_medium: "m",
        utm_campaign: "ca",
      },
    });

    expect(Object.keys(result.params)).toEqual([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "gclid",
      "fbclid",
      LANDER_PROVENANCE_KEY,
    ]);
  });

  it("rejects a repeated inbound key rather than emitting a duplicate or silently picking one", () => {
    // Express/qs parses `?utm_source=a&utm_source=b` into an array. Choosing one
    // silently would be an invisible attribution decision; emitting both would be
    // the exact duplicate this criterion forbids.
    expect(() => resolveLanderParams({ visitor: { utm_source: ["a", "b"] as never } })).toThrow(
      /visitor parameter "utm_source" must be a string, got array/,
    );
  });
});

describe("AC5 — the resolver is pure", () => {
  it("returns deep-equal output for the same input across repeated calls", () => {
    const input = {
      visitor: { utm_source: "facebook", gclid: "g-1" },
      override: { utm_medium: "paid_social" },
      customerDefault: { utm_campaign: "always-on" },
    };

    expect(resolveLanderParams(input)).toEqual(resolveLanderParams(input));
  });

  it("does not mutate its inputs", () => {
    const visitor = { utm_source: "facebook" };
    const override = { utm_medium: "paid_social" };
    const customerDefault = { utm_campaign: "always-on" };

    resolveLanderParams({ visitor, override, customerDefault });

    expect(visitor).toEqual({ utm_source: "facebook" });
    expect(override).toEqual({ utm_medium: "paid_social" });
    expect(customerDefault).toEqual({ utm_campaign: "always-on" });
  });

  it("returns a fresh object each call, so a caller cannot poison the next resolution", () => {
    const first = resolveLanderParams({ visitor: { utm_source: "facebook" } });
    first.params.utm_source = "tampered";
    first.params.injected = "x";

    const second = resolveLanderParams({ visitor: { utm_source: "facebook" } });
    expect(second.params.utm_source).toBe("facebook");
    expect(second.params).not.toHaveProperty("injected");
  });

  it("reads no clock, environment, randomness, network, or storage", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "landerUtm.ts"), "utf8");
    const forbidden = [
      "process.env",
      "Date",
      "Math.random",
      "fetch(",
      "require(",
      "aws-sdk",
      "@aws-sdk",
      "localStorage",
    ];

    for (const token of forbidden) {
      expect(source).not.toContain(token);
    }
    // Its only import is the sibling UTM key contract, itself a pure constants module.
    expect(source.match(/^import .*/gm)).toEqual(['import { UTM_KEYS, type UtmKey } from "./adUtm";']);
  });
});

describe("AC6 — malformed input fails observably rather than silently dropping a parameter", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "utm_source=facebook"],
    ["a number", 42],
  ])("rejects a customer default that is %s", (_label, value) => {
    expect(() => resolveLanderParams({ customerDefault: value as never })).toThrow(
      /customer default must be an object/,
    );
  });

  it("rejects a per-lander override that is not an object", () => {
    expect(() => resolveLanderParams({ override: "utm_source=x" as never })).toThrow(
      /per-lander override must be an object/,
    );
  });

  it("rejects a visitor param bag that is not an object", () => {
    expect(() => resolveLanderParams({ visitor: "utm_source=x" as never })).toThrow(
      /visitor parameters must be an object/,
    );
  });

  it("rejects a non-object input envelope", () => {
    expect(() => resolveLanderParams("nope" as never)).toThrow(/input must be an object/);
  });

  it("rejects an unsupported config key instead of quietly ignoring it", () => {
    expect(() =>
      resolveLanderParams({ customerDefault: { utm_sauce: "typo" } as never }),
    ).toThrow(/unsupported parameter "utm_sauce"/);
  });

  it("rejects a prototype-polluting config key", () => {
    const polluted = JSON.parse('{"__proto__": {"utm_source": "evil"}}');
    expect(() => resolveLanderParams({ customerDefault: polluted })).toThrow(
      /unsupported parameter "__proto__"/,
    );
  });

  it("rejects a non-string config value", () => {
    expect(() =>
      resolveLanderParams({ customerDefault: { utm_source: 42 } as never }),
    ).toThrow(/customer default "utm_source" must be a string, got number/);
  });

  it("names null explicitly on a null config value", () => {
    expect(() =>
      resolveLanderParams({ override: { utm_source: null } as never }),
    ).toThrow(/per-lander override "utm_source" must be a string, got null/);
  });

  it("rejects a blank config value rather than storing a parameter that resolves to nothing", () => {
    expect(() =>
      resolveLanderParams({ customerDefault: { utm_source: "   " } as never }),
    ).toThrow(/customer default "utm_source" is empty/);
  });

  it("rejects a non-string visitor value", () => {
    expect(() =>
      resolveLanderParams({ visitor: { utm_source: { nested: true } as never } }),
    ).toThrow(/visitor parameter "utm_source" must be a string, got object/);
  });

  it("rejects a null visitor value", () => {
    expect(() => resolveLanderParams({ visitor: { gclid: null as never } })).toThrow(
      /visitor parameter "gclid" must be a string, got null/,
    );
  });

  it("ignores undeclared visitor params by design — the allowlist is the contract", () => {
    // Not a silent drop: outbound decoration reflects only declared keys, so an
    // arbitrary attacker-supplied query param can never ride onto a customer link.
    const result = resolveLanderParams({
      visitor: { utm_source: "facebook", evil: "<script>", ref: "partner" },
    });

    expect(result.params).not.toHaveProperty("evil");
    expect(result.params).not.toHaveProperty("ref");
    expect(result.params.utm_source).toBe("facebook");
  });
});

describe("validateUtmConfig — exported so later slices validate at write time", () => {
  it("returns a trimmed copy of a valid config", () => {
    expect(validateUtmConfig({ utm_source: "  facebook  " }, "customer default")).toEqual({
      utm_source: "facebook",
    });
  });

  it("treats an undefined config as empty", () => {
    expect(validateUtmConfig(undefined, "customer default")).toEqual({});
  });

  it("does not return the caller's object", () => {
    const config = { utm_source: "facebook" };
    expect(validateUtmConfig(config, "customer default")).not.toBe(config);
  });

  it("uses the caller's label in the error, so the failure names the offending layer", () => {
    expect(() => validateUtmConfig({ utm_source: "" }, "brand default")).toThrow(
      /brand default "utm_source" is empty/,
    );
  });
});
