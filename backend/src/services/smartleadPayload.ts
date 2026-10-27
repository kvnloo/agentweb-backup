import { createHash } from "crypto";
import type { SmartleadLeadInput } from "./smartleadService";

/**
 * Builds what AgentWeb sends to Smartlead for one lead (ENG-673). The customer writes the email in Smartlead (Harsha,
 * 2026-10-27), so the payload is the lead's contact fields plus a custom field for every non-standard tag the customer's
 * own sequence uses. Pure: no network, no database.
 */

/** Smartlead's standard merge tags and the CRM lead fields they are read from; the first non-empty value wins. */
export const STANDARD_TAG_SOURCES: Record<string, string[]> = {
  email: ["email"],
  first_name: ["firstName"],
  last_name: ["lastName"],
  company_name: ["company"],
  phone_number: ["phone"],
  website: ["website"],
  linkedin_profile: ["linkedin"],
  location: ["location", "customFields.location"],
};

/** Tag name (as written in the customer's template) to the CRM lead field it is read from, e.g. `industry` to `customFields.industry`. */
export type TagMapping = Record<string, string>;

type Lead = Record<string, any>;

export function readLeadValue(lead: Lead, path: string): unknown {
  if (path.startsWith("customFields.")) return lead.customFields?.[path.slice("customFields.".length)];
  return lead[path];
}

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
/** Tag names that would hit the object prototype (`{{constructor}}`, `{{__proto__}}`): never standard, never mapped. */
const FORBIDDEN_TAGS = new Set(["__proto__", "constructor", "prototype"]);
const usable = (tag: string): boolean => !FORBIDDEN_TAGS.has(tag);

const norm = (tag: string): string => tag.toLowerCase().replace(/[\s-]+/g, "_");

export interface TagClassification {
  standard: string[];
  mapped: string[];
  /** Differs from a standard or mapped tag only by case, spaces or hyphens (`{{First_Name}}`): Smartlead would render it blank. */
  nearMiss: Array<{ tag: string; meant: string }>;
  /** Neither standard nor mapped: the user must map it to a CRM field or confirm Smartlead supplies it. */
  unknown: string[];
}

export function classifyTags(tags: string[], mapping: TagMapping, acknowledged: string[] = []): TagClassification {
  const out: TagClassification = { standard: [], mapped: [], nearMiss: [], unknown: [] };
  const known = [...Object.keys(STANDARD_TAG_SOURCES), ...Object.keys(mapping)];
  for (const tag of tags) {
    if (usable(tag) && own(STANDARD_TAG_SOURCES, tag)) out.standard.push(tag);
    else if (usable(tag) && own(mapping, tag)) out.mapped.push(tag);
    else if (acknowledged.includes(tag)) continue;
    else {
      const meant = known.find(k => norm(k) === norm(tag));
      if (meant) out.nearMiss.push({ tag, meant });
      else out.unknown.push(tag);
    }
  }
  return out;
}

export type SanitizeResult = { ok: true; value: string } | { ok: false; reason: "template_syntax" };

/**
 * A value goes to Smartlead as plain text: control characters and newlines become spaces (a subject cannot carry a newline, and
 * the customer's template owns the markup, so HTML-escaping would show `don&#39;t`). A value containing `{{`, `}}` or spintax
 * `{a|b}` is refused: whether Smartlead substitutes a tag inside a custom-field value is unverified, and a literal tag must never
 * reach a recipient.
 */
export function sanitizeValue(raw: unknown): SanitizeResult {
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return { ok: true, value: "" };
  const value = String(raw).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (value.includes("{{") || value.includes("}}") || /\{[^{}]*\|[^{}]*\}/.test(value)) return { ok: false, reason: "template_syntax" };
  return { ok: true, value };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type PayloadResult =
  | { ok: true; input: SmartleadLeadInput; payloadHash: string }
  | { ok: false; reason: "no_email" | "invalid_email" | "missing_tag" | "template_syntax"; tag?: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Lead).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Lead)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `tagsUsed` are the tags the customer's sequence uses. A lead is refused when a value is missing or unsafe for a tag the
 * sequence uses (Smartlead renders a missing variable blank, so the recipient would get "Hi ,"). Standard fields are always sent
 * when present and safe; an unsafe one is left out. Tags the user confirmed Smartlead supplies itself need no value.
 */
export function buildLeadPayload(lead: Lead, opts: { tagsUsed: string[]; mapping: TagMapping; acknowledgedTags?: string[] }): PayloadResult {
  const rawEmail = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
  if (!rawEmail) return { ok: false, reason: "no_email" };
  if (!EMAIL.test(rawEmail)) return { ok: false, reason: "invalid_email" };

  const values: Record<string, SanitizeResult> = {};
  for (const [tag, paths] of Object.entries(STANDARD_TAG_SOURCES)) {
    let result: SanitizeResult = { ok: true, value: "" };
    for (const path of paths) {
      const candidate = tag === "email" ? { ok: true as const, value: rawEmail } : sanitizeValue(readLeadValue(lead, path));
      if (candidate.ok && candidate.value !== "") { result = candidate; break; }
      if (!candidate.ok) result = candidate;
    }
    values[tag] = result;
  }

  const input: SmartleadLeadInput = { email: rawEmail };
  const set = (tag: string, key: keyof SmartleadLeadInput) => {
    const v = values[tag];
    if (v?.ok && v.value !== "") (input as unknown as Record<string, string>)[key] = v.value;
  };
  set("first_name", "first_name");
  set("last_name", "last_name");
  set("company_name", "company_name");
  set("phone_number", "phone_number");
  set("website", "website");
  set("location", "location");
  set("linkedin_profile", "linkedin_profile");

  const custom: Record<string, string> = {};
  for (const tag of opts.tagsUsed) {
    if (opts.acknowledgedTags?.includes(tag)) continue;
    let result: SanitizeResult | undefined;
    if (!usable(tag)) continue;
    if (own(STANDARD_TAG_SOURCES, tag)) result = values[tag];
    else if (own(opts.mapping, tag)) {
      result = sanitizeValue(readLeadValue(lead, opts.mapping[tag]));
      if (result.ok && result.value !== "") custom[tag] = result.value;
    } else continue; // unknown or near-miss tags are blocked once for the whole run, not per lead
    if (!result.ok) return { ok: false, reason: "template_syntax", tag };
    if (result.value === "") return { ok: false, reason: "missing_tag", tag };
  }
  if (Object.keys(custom).length > 0) input.custom_fields = custom;

  return { ok: true, input, payloadHash: createHash("sha256").update(canonical(input)).digest("hex") };
}
