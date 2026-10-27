import { buildLeadPayload, classifyTags, sanitizeValue } from "../smartleadPayload";

const lead = (over: Record<string, any> = {}) => ({
  leadId: "lead_1", email: "  Ann@Example.com ", firstName: "Ann", lastName: "Lee", company: "Acme", website: "acme.example",
  customFields: { industry: "SaaS" }, ...over,
});

describe("sanitizeValue (ENG-673)", () => {
  it("sends plain text: newlines and control characters become spaces, nothing is HTML-escaped", () => {
    expect(sanitizeValue("Line1\nLine2\t  x")).toEqual({ ok: true, value: "Line1 Line2 x" });
    expect(sanitizeValue("don't & Q&A <b>")).toEqual({ ok: true, value: "don't & Q&A <b>" });
  });
  it("refuses template syntax and spintax so a literal tag never reaches a recipient", () => {
    for (const v of ["Hi {{first_name}}", "a }} b", "{a|b}", "x {one|two} y"]) expect(sanitizeValue(v)).toEqual({ ok: false, reason: "template_syntax" });
  });
  it("treats null, objects and arrays as empty, and keeps numbers and booleans as text", () => {
    expect(sanitizeValue(null)).toEqual({ ok: true, value: "" });
    expect(sanitizeValue({ a: 1 })).toEqual({ ok: true, value: "" });
    expect(sanitizeValue(["a"])).toEqual({ ok: true, value: "" });
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

  it("needs no value for a tag the user confirmed Smartlead supplies", () => {
    expect(buildLeadPayload(lead(), { tagsUsed: ["sender_name"], mapping: {}, acknowledgedTags: ["sender_name"] }).ok).toBe(true);
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
