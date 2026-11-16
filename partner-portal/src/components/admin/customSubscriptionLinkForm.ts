/**
 * ENG-2488 (slice of ENG-2266): pure validation + request builder for the
 * admin-only "Create custom subscription link" form. The backend route
 * (POST /api/admin/custom-subscription-links, ENG-2428) re-validates and owns
 * the Stripe Checkout param mapping (ENG-2304); this keeps the UI honest.
 */

export type CustomLinkFrequency = "one_time" | "week" | "month" | "quarter" | "year";

export const CUSTOM_LINK_FREQUENCIES: ReadonlyArray<{ value: CustomLinkFrequency; label: string }> = [
  { value: "one_time", label: "One-time" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
  { value: "year", label: "Yearly" },
];

export const CUSTOM_LINK_LABEL_MAX = 100;

export interface CustomLinkFormInput {
  orgId: string | null | undefined;
  label: string;
  amountUsd: string;
  frequency: string;
}

export interface CustomLinkRequestBody {
  orgId: string;
  label: string;
  amountUsd: number;
  frequency: CustomLinkFrequency;
}

export type CustomLinkFormResult =
  | { ok: true; body: CustomLinkRequestBody }
  | { ok: false; errors: Partial<Record<"orgId" | "label" | "amountUsd" | "frequency", string>> };

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export function buildCustomLinkRequest(input: CustomLinkFormInput): CustomLinkFormResult {
  const errors: Partial<Record<"orgId" | "label" | "amountUsd" | "frequency", string>> = {};
  const orgId = (input.orgId ?? "").trim();
  const label = (input.label ?? "").trim();
  const amountRaw = (input.amountUsd ?? "").trim();

  if (!orgId) errors.orgId = "Account has no organization";
  if (!label) errors.label = "Name is required";
  else if (label.length > CUSTOM_LINK_LABEL_MAX) errors.label = `Name must be ${CUSTOM_LINK_LABEL_MAX} characters or fewer`;

  let amountUsd = NaN;
  if (!AMOUNT_RE.test(amountRaw)) errors.amountUsd = "Enter a USD amount with at most 2 decimals";
  else {
    amountUsd = Number(amountRaw);
    if (!(amountUsd > 0)) errors.amountUsd = "Amount must be greater than 0";
  }

  if (!CUSTOM_LINK_FREQUENCIES.some((f) => f.value === input.frequency)) errors.frequency = "Choose a frequency";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { orgId, label, amountUsd, frequency: input.frequency as CustomLinkFrequency } };
}

/** Flag is OFF unless explicitly "true" (default off in every env). */
export function isCustomSubscriptionLinksEnabled(raw: unknown): boolean {
  return String(raw ?? "").trim().toLowerCase() === "true";
}
