import { buildLeadPayload, classifyTags, sanitizeValue } from "../smartleadPayload";

const lead = (over: Record<string, any> = {}) => ({
  leadId: "lead_1", email: "  Ann@Example.com ", firstName: "Ann", lastName: "Lee", company: "Acme", website: "acme.example",
  customFields: { industry: "SaaS" }, ...over,
});

describe("sanitizeValue (ENG-673)", () => {
  it("sends plain text: newlines and control characters become spaces, nothing is HTML-escaped", () => {
    expect(sanitizeValue("Line1\nLine2\t  x")).toEqual({ ok: true, value: "Line1 Line2 x" });
    expect(sanitizeValue("don't & Q&A")).toEqual({ ok: true, value: "don't & Q&A" });
  });
  it("refuses angle brackets, so a scraped value cannot become a link or tag in the customer's HTML email", () => {
    for (const v of ["<a href=\"https://evil.example\">x</a>", "A<B Inc", "x > y", "<img src=x>"]) expect(sanitizeValue(v)).toEqual({ ok: false, reason: "unsafe_text" });
  });
  it("removes zero-width and bidirectional-override characters and unicode line separators", () => {
    expect(sanitizeValue("Ann\u202e\u200bLee\u2028x\ufeff")).toEqual({ ok: true, value: "AnnLee x" });
  });
  it("does not run any pattern on an enormous raw value: it is refused first, in milliseconds", () => {
    const started = Date.now();
    expect(sanitizeValue("{" + "|".repeat(1_000_000))).toEqual({ ok: false, reason: "unsafe_text" });
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("refuses a value longer than the cap rather than truncating it", () => {
    expect(sanitizeValue("x".repeat(500))).toMatchObject({ ok: true });
    expect(sanitizeValue("x".repeat(501))).toEqual({ ok: false, reason: "unsafe_text" });
  });
  it("refuses template syntax and spintax so a literal tag never reaches a recipient", () => {
    for (const v of ["Hi {{first_name}}", "a }} b", "{a|b}", "x {one|two} y"]) expect(sanitizeValue(v)).toEqual({ ok: false, reason: "template_syntax" });
  });
  it("treats null, objects, arrays, booleans, NaN and Infinity as empty, and keeps finite numbers as text", () => {
    for (const v of [null, undefined, { a: 1 }, ["a"], false, true, NaN, Infinity]) expect(sanitizeValue(v)).toEqual({ ok: true, value: "" });
    expect(sanitizeValue(42)).toEqual({ ok: true, value: "42" });
  });
});

describe("classifyTags", () => {
  it("separates standard, mapped, near-miss and unknown tags, and honours acknowledged tags", () => {
    const c = classifyTags(["first_name", "industry", "First_Name", "company name", "signature", "sender"], { industry: "customFields.industry" }, ["sender"]);
    expect(c.standard).toEqual(["first_name"]);
    expect(c.mapped).toEqual(["industry"]);
    expect(c.nearMiss).toEqual([{ tag: "First_Name", meant: "first_name" }, { tag: "company name", meant: "company_name" }]);
    expect(c.unknown).toEqual(["signature"]);
  });
});

describe("classifyTags and acknowledgement", () => {
  it("acknowledging a near-miss tag does not clear it: it is a typo of a tag we supply, so it still blocks", () => {
    const c = classifyTags(["First_Name", "signature"], {}, ["First_Name", "signature"]);
    expect(c.nearMiss).toEqual([{ tag: "First_Name", meant: "first_name" }]);
    expect(c.unknown).toEqual([]);
  });
});

describe("classifyTags on a hostile list of tags", () => {
  it("stays fast for tens of thousands of long tags, with a large mapping and a large acknowledged list", () => {
    const tags = Array.from({ length: 20_000 }, (_, i) => `tag_${i}_${"x".repeat(80)}`);
    const mapping = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`m${i}`, "customFields.a"]));
    const acknowledged = Array.from({ length: 5_000 }, (_, i) => `ack${i}`);
    const started = Date.now();
    const c = classifyTags(tags, mapping, acknowledged);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(c.unknown).toHaveLength(20_000);
  });
});

describe("tags that name object internals", () => {
  it("never treats {{constructor}}, {{toString}} or {{__proto__}} as standard or mapped", () => {
    const c = classifyTags(["constructor", "__proto__", "toString", "hasOwnProperty"], {});
    expect(c.standard).toEqual([]);
    expect(c.mapped).toEqual([]);
    expect(c.unknown).toEqual(["constructor", "__proto__", "toString", "hasOwnProperty"]);
  });

  it("does not let a mapping key like __proto__ pollute the custom fields", () => {
    const mapping = JSON.parse('{"__proto__": "customFields.industry", "industry": "customFields.industry"}');
    const r = buildLeadPayload(lead(), { tagsUsed: ["__proto__", "industry"], mapping });
    expect(r.ok && Object.keys(r.input.custom_fields ?? {})).toEqual(["industry"]);
    expect(({} as any).industry).toBeUndefined();
  });
});

describe("buildLeadPayload", () => {
  it("builds the standard fields from the CRM names, lower-cases the email, and adds a custom field for a mapped tag", () => {
    const r = buildLeadPayload(lead(), { tagsUsed: ["first_name", "industry"], mapping: { industry: "customFields.industry" } });
    expect(r).toMatchObject({ ok: true, input: { email: "ann@example.com", first_name: "Ann", last_name: "Lee", company_name: "Acme", website: "acme.example", custom_fields: { industry: "SaaS" } } });
  });

  it("sends no custom field for a mapped tag the sequence does not use", () => {
    const r = buildLeadPayload(lead(), { tagsUsed: ["first_name"], mapping: { industry: "customFields.industry" } });
    expect(r.ok && r.input.custom_fields).toBeUndefined();
  });

  it("refuses a lead with no value for a tag the sequence uses (Smartlead would render it blank)", () => {
    expect(buildLeadPayload(lead({ firstName: "  " }), { tagsUsed: ["first_name"], mapping: {} })).toEqual({ ok: false, reason: "missing_tag", tag: "first_name" });
    expect(buildLeadPayload(lead({ customFields: {} }), { tagsUsed: ["industry"], mapping: { industry: "customFields.industry" } })).toEqual({ ok: false, reason: "missing_tag", tag: "industry" });
  });

  it("does not need a value the sequence does not use", () => {
    expect(buildLeadPayload(lead({ company: undefined }), { tagsUsed: ["first_name"], mapping: {} }).ok).toBe(true);
  });

  it("refuses unsafe text in a used tag, and leaves an unsafe unused field out", () => {
    expect(buildLeadPayload(lead({ firstName: "{{x}}" }), { tagsUsed: ["first_name"], mapping: {} })).toEqual({ ok: false, reason: "template_syntax", tag: "first_name" });
    const r = buildLeadPayload(lead({ firstName: "{{x}}" }), { tagsUsed: ["company_name"], mapping: {} });
    expect(r.ok && r.input.first_name).toBeUndefined();
  });

  it("needs no value from the lead for a tag that is neither standard nor mapped (unknown, or one Smartlead supplies)", () => {
    expect(buildLeadPayload(lead(), { tagsUsed: ["sender_name"], mapping: {} }).ok).toBe(true);
  });

  it("still needs a value for a STANDARD or MAPPED tag even if the user acknowledged it (acknowledging never switches the guard off)", () => {
    // the acknowledgement lives in classifyTags / the preflight; the payload guard has no acknowledgement input at all
    expect(buildLeadPayload(lead({ firstName: "" }), { tagsUsed: ["first_name"], mapping: {} })).toEqual({ ok: false, reason: "missing_tag", tag: "first_name" });
    expect(classifyTags(["first_name", "industry"], { industry: "customFields.industry" }, ["first_name", "industry"])).toMatchObject({ standard: ["first_name"], mapped: ["industry"], unknown: [] });
  });

  it("sends company_url from the CRM website, and a standard tag {{company_url}} is supplied", () => {
    const r = buildLeadPayload(lead(), { tagsUsed: ["company_url"], mapping: {} });
    expect(r).toMatchObject({ ok: true, input: { company_url: "acme.example", website: "acme.example" } });
    expect(classifyTags(["company_url"], {}).standard).toEqual(["company_url"]);
  });

  it("refuses markup and over-long values in a used tag, with the reason", () => {
    expect(buildLeadPayload(lead({ company: "<a href=x>Acme</a>" }), { tagsUsed: ["company_name"], mapping: {} })).toEqual({ ok: false, reason: "unsafe_text", tag: "company_name" });
  });

  it("does not throw on a mapping whose value is not a string, and reads such a tag as blank", () => {
    const r = buildLeadPayload(lead(), { tagsUsed: ["industry"], mapping: { industry: undefined as any } });
    expect(r).toEqual({ ok: false, reason: "missing_tag", tag: "industry" });
    expect(buildLeadPayload(lead(), { tagsUsed: ["x"], mapping: { x: 5 as any } })).toEqual({ ok: false, reason: "missing_tag", tag: "x" });
  });

  it("reads nothing through a __proto__ or constructor path in a mapping", () => {
    expect(buildLeadPayload(lead(), { tagsUsed: ["x"], mapping: { x: "__proto__" } })).toEqual({ ok: false, reason: "missing_tag", tag: "x" });
    expect(buildLeadPayload(lead(), { tagsUsed: ["x"], mapping: { x: "customFields.constructor" } })).toEqual({ ok: false, reason: "missing_tag", tag: "x" });
    expect(buildLeadPayload(lead(), { tagsUsed: ["x"], mapping: { x: "toString" } })).toEqual({ ok: false, reason: "missing_tag", tag: "x" });
  });

  it("refuses addresses a real person never has: hidden or control characters, list separators, a pipe, a repeated or edge dot, a non-letter top-level domain", () => {
    for (const email of ["a\u200b@x.com", "a@x.com,b", "a@x..com", "a\u0001@x.com", "a|b@x.com", "a;b@x.com", ".a@x.com", "a.@x.com", "a@.x.com", "a@x.com.", "a@x.123", "a@-x.com", "a`b@x.com", "a\u202e@x.com"]) {
      expect(buildLeadPayload(lead({ email }), { tagsUsed: [], mapping: {} })).toEqual({ ok: false, reason: "invalid_email" });
    }
    for (const email of ["first.last+tag@sub.example.co.uk", "a_b-c@x.io", "A@X.COM", "o@xn--bcher-kva.example", "n@müller.de".replace("ü", "u"), "a@例え.日本", "a@x.中国", "用户@例子.广告", "a@пример.рф", "a@bücher.de"]) {
      expect(buildLeadPayload(lead({ email }), { tagsUsed: [], mapping: {} }).ok).toBe(true);
    }
  });

  it("leaves out a URL-type field with quotes, backticks, spaces or a script scheme (it may land inside href=\"...\" in the customer's template), but keeps an ordinary one", () => {
    for (const website of ['https://x.com" onmouseover="alert(1)', "&#106;avascript:alert(1)", "&#x6A;avascript:alert(1)", "java&Tab;script:alert(1)", "https://x.com/?a=1&amp;b=2", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "https://x.com/a b", "https://x.com/`x`", "https://x.com/'x"]) {
      const r = buildLeadPayload(lead({ website }), { tagsUsed: [], mapping: {} });
      expect(r.ok && (r as any).input.website).toBeFalsy();
      expect(r.ok && (r as any).input.company_url).toBeFalsy();
    }
    const unsafeAndUsed = buildLeadPayload(lead({ website: "javascript:alert(1)" }), { tagsUsed: ["website"], mapping: {} });
    expect(unsafeAndUsed).toEqual({ ok: false, reason: "unsafe_text", tag: "website" });
    for (const website of ["https://acme.com/path?x=1&y=2", "acme.com", "http://sub.acme.co.uk", "https://acme.com/a?x=1&y=2&z=3"]) {
      expect((buildLeadPayload(lead({ website }), { tagsUsed: [], mapping: {} }) as any).input.website).toBe(website);
    }
    expect((buildLeadPayload(lead({ linkedin: 'https://linkedin.com/in/a"b' }), { tagsUsed: [], mapping: {} }) as any).input.linkedin_profile).toBeUndefined();
    expect((buildLeadPayload(lead({ company: "Domino's Pizza" }), { tagsUsed: ["company_name"], mapping: {} }) as any).input.company_name).toBe("Domino's Pizza"); // quotes are fine in a company NAME
  });

  it("refuses an email carrying markup, braces, quotes or a backslash, which would reach the customer's HTML as {{email}}", () => {
    for (const email of ["a<b>@x.com", "x{{y}}@z.com", 'a"b@x.com', "a'b@x.com", "a\\b@x.com", "a@x>.com"]) {
      expect(buildLeadPayload(lead({ email }), { tagsUsed: [], mapping: {} })).toEqual({ ok: false, reason: "invalid_email" });
    }
    expect(buildLeadPayload(lead({ email: "a".repeat(250) + "@x.com" }), { tagsUsed: [], mapping: {} })).toEqual({ ok: false, reason: "invalid_email" });
    expect(buildLeadPayload(lead({ email: "first.last+tag@sub.example.co.uk" }), { tagsUsed: [], mapping: {} }).ok).toBe(true);
  });

  it("refuses a missing or malformed email", () => {
    expect(buildLeadPayload(lead({ email: "" }), { tagsUsed: [], mapping: {} })).toEqual({ ok: false, reason: "no_email" });
    expect(buildLeadPayload(lead({ email: "not-an-email" }), { tagsUsed: [], mapping: {} })).toEqual({ ok: false, reason: "invalid_email" });
  });

  it("reads location from the lead or from a custom field", () => {
    const r = buildLeadPayload(lead({ customFields: { location: "Austin" } }), { tagsUsed: ["location"], mapping: {} });
    expect(r.ok && r.input.location).toBe("Austin");
  });

  it("gives the same hash for the same payload whatever the key order, and a different one when a value changes", () => {
    const a = buildLeadPayload(lead(), { tagsUsed: ["first_name"], mapping: {} });
    const b = buildLeadPayload({ company: "Acme", website: "acme.example", lastName: "Lee", firstName: "Ann", email: "ann@example.com", customFields: {} }, { tagsUsed: ["first_name"], mapping: {} });
    const c = buildLeadPayload(lead({ firstName: "Anne" }), { tagsUsed: ["first_name"], mapping: {} });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) { expect(a.payloadHash).toBe(b.payloadHash); expect(a.payloadHash).not.toBe(c.payloadHash); }
  });
});
