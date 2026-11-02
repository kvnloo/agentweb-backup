import { createHash } from "crypto";
import type { SmartleadLeadInput } from "./smartleadService";
import { containsSpintax } from "./smartleadText";

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
  company_url: ["website"],
  linkedin_profile: ["linkedin"],
  location: ["location", "customFields.location"],
};

/** Tag name (as written in the customer's template) to the CRM lead field it is read from, e.g. `industry` to `customFields.industry`. */
export type TagMapping = Record<string, string>;

type Lead = Record<string, any>;

export function readLeadValue(lead: Lead, path: unknown): unknown {
  if (typeof path !== "string" || path === "" || FORBIDDEN_TAGS.has(path)) return undefined;
  if (path.startsWith("customFields.")) {
    const key = path.slice("customFields.".length);
    return FORBIDDEN_TAGS.has(key) ? undefined : lead.customFields?.[key];
  }
  return own(lead, path) ? lead[path] : undefined;
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
  // Normalised once per known name and once per tag (a lookup, not a scan), and the acknowledged list as a set: the work stays
  // linear in the total size of the tags however many a hostile sequence contains.
  const knownByNorm = new Map<string, string>();
  for (const k of [...Object.keys(STANDARD_TAG_SOURCES), ...Object.keys(mapping)]) if (!knownByNorm.has(norm(k))) knownByNorm.set(norm(k), k);
  const acknowledgedSet = new Set(acknowledged);
  for (const tag of tags) {
    if (usable(tag) && own(STANDARD_TAG_SOURCES, tag)) out.standard.push(tag);
    else if (usable(tag) && own(mapping, tag)) out.mapped.push(tag);
    else {
      // A near-miss is a typo of a tag we supply, so acknowledging it ("Smartlead supplies this") is never right: it still blocks.
      const meant = knownByNorm.get(norm(tag));
      if (meant) out.nearMiss.push({ tag, meant });
      else if (!acknowledgedSet.has(tag)) out.unknown.push(tag);
    }
  }
  return out;
}

/** Longest value we send for one field; real names, companies and locations are far shorter. Refused, never truncated. */
export const MAX_VALUE_CHARS = 500;
/** Checked on the RAW text before anything else runs on it, so one enormous scraped value costs nothing. */
const MAX_RAW_CHARS = MAX_VALUE_CHARS * 4;

export type SanitizeResult = { ok: true; value: string } | { ok: false; reason: "template_syntax" | "unsafe_text" };

/**
 * A value goes to Smartlead as plain text. Control characters, newlines, zero-width and bidirectional-override characters
 * become spaces or vanish (a subject cannot carry a newline). It is NOT HTML-escaped (that would show `don&#39;t` in a
 * subject), so a value containing `<` or `>` is refused instead: Smartlead puts values into the customer's HTML email, and a
 * scraped or enriched company name such as `<a href=...>` would otherwise become a link in mail sent from their domain.
 * A value containing `{{`, `}}` or spintax `{a|b}` is refused too (whether Smartlead substitutes a tag inside a value is
 * unverified, and a literal tag must never reach a recipient), as is one longer than MAX_VALUE_CHARS.
 */
export function sanitizeValue(raw: unknown): SanitizeResult {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  else return { ok: true, value: "" }; // null, undefined, NaN, booleans, objects and arrays carry no usable text
  if (text.length > MAX_RAW_CHARS) return { ok: false, reason: "unsafe_text" };
  const value = text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (value.includes("{{") || value.includes("}}") || containsSpintax(value)) return { ok: false, reason: "template_syntax" };
  if (/[<>]/.test(value) || value.length > MAX_VALUE_CHARS) return { ok: false, reason: "unsafe_text" };
  return { ok: true, value };
}

// No quotes, angle brackets, braces or backslashes: `{{email}}` is put into the customer's HTML email, and a value such as
// `a<b>@x.com` or `x{{y}}@z.com` must not reach it. Real addresses do not need them.
const EMAIL = /^[^\s@<>{}"'\\]+@[^\s@<>{}"'\\]+\.[^\s@<>{}"'\\]{2,}$/;
const MAX_EMAIL_CHARS = 254;
// What the pattern above lets through but a real address never contains: zero-width, bidi and control characters, list separators and pipes,
// a repeated dot, a leading or trailing dot in either part, and a top-level domain that is not letters.
const EMAIL_HIDDEN_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
const EMAIL_SEPARATORS = /[,;|`]/;
function emailShapeOk(email: string): boolean {
  if (EMAIL_HIDDEN_OR_CONTROL.test(email) || EMAIL_SEPARATORS.test(email) || email.includes("..")) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.startsWith(".") || local.endsWith(".") || domain.startsWith(".") || domain.endsWith(".") || domain.startsWith("-")) return false;
  // The top-level domain is letters in any script (internationalised domains such as .中国 or .рф), or punycode (xn--...); never digits.
  return /\.\p{L}{2,}$/u.test(domain) || /\.xn--[a-z0-9-]{2,}$/i.test(domain);
}

// URL-type fields end up in the customer's template, possibly inside href="...": no quotes, backticks or spaces, and no script-style scheme.
const URL_FIELDS = new Set(["website", "company_url", "linkedin_profile"]);
// An HTML character reference (&#106; or &colon;) can spell a script scheme once a browser decodes it inside href="...", so none is allowed.
const UNSAFE_URL = /["'`\s]|&#|&[a-z]+;|^\s*(javascript|data|vbscript):/i;

/** True when the address would be accepted for a push (the same checks buildLeadPayload applies). */
export function isAcceptableEmail(raw: unknown): boolean {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return !!email && email.length <= MAX_EMAIL_CHARS && EMAIL.test(email) && emailShapeOk(email);
}

export type PayloadResult =
  | { ok: true; input: SmartleadLeadInput; payloadHash: string }
  | { ok: false; reason: "no_email" | "invalid_email" | "missing_tag" | "template_syntax" | "unsafe_text"; tag?: string };

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
 * when present and safe; an unsafe one is left out. A tag that is neither standard nor mapped (unknown, or one the user confirmed
 * Smartlead supplies itself) needs no value from the lead: those are decided once for the run by the preflight, not per lead.
 */
export function buildLeadPayload(lead: Lead, opts: { tagsUsed: string[]; mapping: TagMapping }): PayloadResult {
  const rawEmail = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
  if (!rawEmail) return { ok: false, reason: "no_email" };
  if (rawEmail.length > MAX_EMAIL_CHARS || !EMAIL.test(rawEmail) || !emailShapeOk(rawEmail)) return { ok: false, reason: "invalid_email" };

  const values: Record<string, SanitizeResult> = {};
  for (const [tag, paths] of Object.entries(STANDARD_TAG_SOURCES)) {
    let result: SanitizeResult = { ok: true, value: "" };
    for (const path of paths) {
      let candidate: SanitizeResult = tag === "email" ? { ok: true as const, value: rawEmail } : sanitizeValue(readLeadValue(lead, path));
      if (candidate.ok && URL_FIELDS.has(tag) && UNSAFE_URL.test(candidate.value)) candidate = { ok: false, reason: "unsafe_text" };
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
  set("company_url", "company_url");
  set("location", "location");
  set("linkedin_profile", "linkedin_profile");

  const custom: Record<string, string> = {};
  for (const tag of opts.tagsUsed) {
    let result: SanitizeResult | undefined;
    if (!usable(tag)) continue;
    if (own(STANDARD_TAG_SOURCES, tag)) result = values[tag];
    else if (own(opts.mapping, tag)) {
      result = sanitizeValue(readLeadValue(lead, opts.mapping[tag]));
      if (result.ok && result.value !== "") custom[tag] = result.value;
    } else continue; // unknown, near-miss and acknowledged tags are handled once for the whole run, not per lead
    if (!result.ok) return { ok: false, reason: result.reason, tag };
    if (result.value === "") return { ok: false, reason: "missing_tag", tag };
  }
  if (Object.keys(custom).length > 0) input.custom_fields = custom;

  return { ok: true, input, payloadHash: createHash("sha256").update(canonical(input)).digest("hex") };
}
