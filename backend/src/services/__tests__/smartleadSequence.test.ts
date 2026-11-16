import { analyseSequence } from "../smartleadSequence";
import { realSequencesWithVariants } from "./fixtures/smartleadRealReplies";

const clone = (v: unknown): any => JSON.parse(JSON.stringify(v));

describe("analyseSequence (ENG-673)", () => {
  it("reads the content of A/B variants when the step's own subject and body are empty (the live shape)", () => {
    const a = analyseSequence(realSequencesWithVariants);
    expect(a).toMatchObject({ readable: true, stepCount: 2, hasContent: true, usesSpintax: false });
    expect([...a.tags].sort()).toEqual(["company_name", "first_name"]);
  });

  it("ignores variants marked is_deleted", () => {
    const seq = clone(realSequencesWithVariants);
    seq[0].sequence_variants[0].is_deleted = true; // the only variant that used {{company_name}} in step 1
    seq[1].email_body = "<p>Following up</p>";
    seq[1].subject = "Quick follow-up";
    const a = analyseSequence(seq);
    expect(a.tags).toEqual(["first_name"]);
  });

  it("reads follow_up_subject and the optional body", () => {
    const a = analyseSequence([{ seq_number: 2, subject: "", follow_up_subject: "Re {{company_name}}", email_body: "x", sequence_variants: [{ variant_label: "A", subject: "", email_body: "", optional_email_body_1: "{{industry}}" }] }]);
    expect(a.tags).toEqual(["company_name", "industry"]);
  });

  it("accepts the wrapped shapes the docs show", () => {
    expect(analyseSequence({ ok: true, data: realSequencesWithVariants }).readable).toBe(true);
    expect(analyseSequence({ sequences: realSequencesWithVariants }).readable).toBe(true);
  });

  it("says unreadable, not empty, for a reply that is not a list of steps", () => {
    for (const reply of [null, undefined, "oops", 5, { message: "Invalid API Key" }, { data: "x" }]) {
      expect(analyseSequence(reply)).toMatchObject({ readable: false, hasContent: false, tags: [] });
    }
  });

  it("an empty list is readable and has no content (a draft campaign still being built)", () => {
    expect(analyseSequence([])).toMatchObject({ readable: true, stepCount: 0, hasContent: false, tags: [] });
  });

  it("trims spaces inside a tag, ignores unbalanced braces, and lists each tag once", () => {
    const a = analyseSequence([{ seq_number: 1, subject: "Hi {{ first_name }} {{first_name}}", email_body: "{{broken and {{company_name}}", sequence_variants: [] }]);
    expect(a.tags).toEqual(["first_name", "company_name"]);
  });

  it("does not freeze on a stray {{ followed by a lot of whitespace (the old pattern took 23 s at 6,000 spaces)", () => {
    for (const body of ["{{" + " ".repeat(100_000) + "x", "{{ \n".repeat(20_000), ("{{ " + " ".repeat(100)).repeat(1500)]) {
      const started = Date.now();
      const a = analyseSequence([{ seq_number: 1, subject: "s", email_body: body, sequence_variants: [] }]);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(a.readable).toBe(true);
      expect(a.tags).toEqual([]);
    }
  });

  it("does not freeze on a brace followed by a hundred thousand pipes (the spintax pattern was quadratic)", () => {
    const started = Date.now();
    const a = analyseSequence([{ seq_number: 1, subject: "s", email_body: "{" + "|".repeat(150_000), sequence_variants: [] }]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(a).toMatchObject({ readable: true, usesSpintax: false });
  });

  it("treats a sequence with an absurd number of steps as unreadable, and handles fifteen thousand distinct tags quickly", () => {
    const steps = Array.from({ length: 201 }, (_, i) => ({ seq_number: i + 1, subject: "s", email_body: "b", sequence_variants: [] }));
    expect(analyseSequence(steps).readable).toBe(false);
    const started = Date.now();
    const many = analyseSequence([{ seq_number: 1, subject: "s", email_body: Array.from({ length: 15_000 }, (_, i) => `{{t${i}}}`).join(" "), sequence_variants: [] }]);
    expect(many.tags).toHaveLength(15_000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("treats a 'tag' longer than any real tag name as an unreadable sequence", () => {
    expect(analyseSequence([{ seq_number: 1, subject: "s", email_body: `{{${"a".repeat(101)}}}`, sequence_variants: [] }]).readable).toBe(false);
    expect(analyseSequence([{ seq_number: 1, subject: "s", email_body: `{{${"a".repeat(100)}}}`, sequence_variants: [] }]).readable).toBe(true);
  });

  it("treats a sequence whose total text is absurd as unreadable, however it is split across steps and variants", () => {
    const variants = Array.from({ length: 12 }, (_, i) => ({ variant_label: `V${i}`, subject: "s", email_body: "x".repeat(190_000), is_deleted: false }));
    expect(analyseSequence([{ seq_number: 1, subject: "s", email_body: "b", sequence_variants: variants }]).readable).toBe(false);
  });

  it("extracts tags correctly from triple braces and from HTML attributes", () => {
    const a = analyseSequence([{ seq_number: 1, subject: "{{{x}}}", email_body: '<a href="{{website}}">{{ Company Name }}</a>', sequence_variants: [] }]);
    expect(a.tags).toEqual(["x", "website", "Company Name"]);
  });

  it("treats a text longer than any real email as unreadable instead of scanning it", () => {
    expect(analyseSequence([{ seq_number: 1, subject: "s", email_body: "x".repeat(200_001), sequence_variants: [] }])).toMatchObject({ readable: false, tags: [] });
  });

  it("treats a list with no step objects as unreadable, but an empty list as readable", () => {
    for (const reply of [[null], [5], ["x"]]) expect(analyseSequence(reply).readable).toBe(false);
    expect(analyseSequence([]).readable).toBe(true);
  });

  it("detects single-brace spintax but not a merge tag", () => {
    expect(analyseSequence([{ seq_number: 1, subject: "{Hi|Hello} {{first_name}}", email_body: "x", sequence_variants: [] }]).usesSpintax).toBe(true);
    expect(analyseSequence([{ seq_number: 1, subject: "Hi {{first_name}}", email_body: "x", sequence_variants: [] }]).usesSpintax).toBe(false);
  });

  describe("hash", () => {
    const base = analyseSequence(realSequencesWithVariants).hash;

    it("does not change for ids, timestamps, step order in the reply, CRLF or surrounding whitespace", () => {
      const seq = clone(realSequencesWithVariants).reverse();
      seq.forEach((s: any) => { s.id += 100; s.updated_at = "2030-01-01"; s.sequence_variants.forEach((v: any) => { v.id += 7; v.email_body = ` ${v.email_body.replace(/\n/g, "\r\n")} `; }); });
      expect(analyseSequence(seq).hash).toBe(base);
    });

    it("changes when any subject or body changes, or a live variant is added", () => {
      const edited = clone(realSequencesWithVariants); edited[1].subject = "A different follow-up";
      expect(analyseSequence(edited).hash).not.toBe(base);
      const added = clone(realSequencesWithVariants); added[0].sequence_variants.push({ variant_label: "C", subject: "s", email_body: "b", is_deleted: false });
      expect(analyseSequence(added).hash).not.toBe(base);
    });

    it("changes when a follow-up delay changes", () => {
      const slower = clone(realSequencesWithVariants); slower[1].seq_delay_details.delayInDays = 9;
      expect(analyseSequence(slower).hash).not.toBe(base);
    });

    it("does not change when only a deleted variant changes", () => {
      const withDeleted = clone(realSequencesWithVariants); withDeleted[0].sequence_variants.push({ variant_label: "Z", subject: "old", email_body: "old", is_deleted: true });
      expect(analyseSequence(withDeleted).hash).toBe(base);
    });
  });
});
