import { createHash } from "crypto";

/**
 * Reads a Smartlead campaign's sequence (`GET /campaigns/{id}/sequences`) for the push (ENG-673). The customer writes the
 * email in Smartlead, so what AgentWeb needs from it is the merge tags it uses, whether it has any content, and a hash to
 * notice a change. Shape verified on a live account (2026-10-27): a bare array of steps; a step with A/B variants has an
 * EMPTY `subject` and `email_body` and its content is in `sequence_variants` (skip `is_deleted` ones); follow-up steps
 * carry `follow_up_subject`.
 */

export interface SequenceAnalysis {
  /** False when the reply is not a list of steps we recognise. The caller must not read that as "no content". */
  readable: boolean;
  stepCount: number;
  /** At least one step or live variant has a subject or a body. */
  hasContent: boolean;
  /** Distinct merge tags as written, first-seen order: `{{ first_name }}` gives `first_name`. */
  tags: string[];
  /** Single-brace spintax such as `{a|b}`. Smartlead's handling of it inside values is unverified. */
  usesSpintax: boolean;
  /** sha256 over the normalised steps and live variants: no ids, no timestamps, so a no-op save does not change it. */
  hash: string;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "");
const isRow = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

const TAG = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SPINTAX = /\{[^{}]*\|[^{}]*\}/;

/** A list reply is a bare array (seen live) or wrapped in `data` or `sequences` (the docs' variants). */
function rowsOf(reply: unknown): Row[] | undefined {
  const list = Array.isArray(reply) ? reply : isRow(reply) ? (Array.isArray(reply.data) ? reply.data : Array.isArray(reply.sequences) ? reply.sequences : undefined) : undefined;
  return list ? list.filter(isRow) : undefined;
}

export function analyseSequence(reply: unknown): SequenceAnalysis {
  const rows = rowsOf(reply);
  if (!rows) return { readable: false, stepCount: 0, hasContent: false, tags: [], usesSpintax: false, hash: "" };

  const steps = rows
    .map(row => ({
      seq: Number(row.seq_number),
      subject: text(row.subject),
      followUp: text(row.follow_up_subject),
      body: text(row.email_body),
      variants: (Array.isArray(row.sequence_variants) ? row.sequence_variants : [])
        .filter(isRow)
        .filter(v => v.is_deleted !== true)
        .map(v => ({ label: text(v.variant_label), subject: text(v.subject), body: text(v.email_body), optional: text(v.optional_email_body_1) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => (Number.isFinite(a.seq) ? a.seq : 0) - (Number.isFinite(b.seq) ? b.seq : 0));

  const texts: string[] = [];
  for (const step of steps) {
    texts.push(step.subject, step.followUp, step.body);
    for (const v of step.variants) texts.push(v.subject, v.body, v.optional);
  }

  const tags: string[] = [];
  let usesSpintax = false;
  for (const t of texts) {
    for (const match of t.matchAll(TAG)) {
      const tag = match[1];
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
    if (SPINTAX.test(t.replace(TAG, ""))) usesSpintax = true;
  }

  return {
    readable: true,
    stepCount: steps.length,
    hasContent: texts.some(t => t !== ""),
    tags,
    usesSpintax,
    hash: createHash("sha256").update(JSON.stringify(steps)).digest("hex"),
  };
}
