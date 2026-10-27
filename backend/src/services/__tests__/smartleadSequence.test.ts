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

    it("does not change when only a deleted variant changes", () => {
      const withDeleted = clone(realSequencesWithVariants); withDeleted[0].sequence_variants.push({ variant_label: "Z", subject: "old", email_body: "old", is_deleted: true });
      expect(analyseSequence(withDeleted).hash).toBe(base);
    });
  });
});
