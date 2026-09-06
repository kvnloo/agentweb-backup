/**
 * Client-side mirror of the backend's canonical customer projection
 * (`backend/src/services/workPlanCustomerProjection.ts`). This never talks to
 * the server — it lets the Partner Portal editor show the admin exactly what
 * a customer would see for the fields currently in the form, using the same
 * fallback rules, before anything is saved (ENG-1469).
 */

export type WorkPlanDisplayCategory = "strategy" | "paid-ads" | "founder-led-sales" | "event-led-sales" | "content";
export type WorkPlanDisplayChannel = "meta" | "google" | "linkedin" | "email" | "event" | "content" | "cross-channel";

export interface WorkPlanDisplaySuite {
  id: string;
  name: string;
  position: number;
}

export interface WorkPlanDisplayMetadata {
  version: 1;
  title?: string;
  summary?: string;
  categories?: WorkPlanDisplayCategory[];
  channel?: WorkPlanDisplayChannel;
  suite?: WorkPlanDisplaySuite;
  stepLabels?: string[];
  nextPlanIds?: string[];
}

export interface WorkPlanPreviewStep {
  position: number;
  label: string;
}

export interface WorkPlanPreview {
  id: string;
  title: string;
  summary: string;
  categories: WorkPlanDisplayCategory[];
  channel?: WorkPlanDisplayChannel;
  suite?: WorkPlanDisplaySuite;
  steps: WorkPlanPreviewStep[];
  nextPlans: Array<{ id: string; title: string; resolved: boolean }>;
  visibility: string;
}

/** Same legacy category mapping the backend projection uses. */
const LEGACY_CATEGORY: Record<string, WorkPlanDisplayCategory> = {
  Strategy: "strategy",
  "Paid Ads": "paid-ads",
  Content: "content",
};

/** Mirrors the backend's `text()` helper: strip tags, collapse whitespace, cap length. */
function collapseText(value: string | undefined, max: number): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface WorkPlanPreviewInput {
  planId?: string;
  title: string;
  description?: string;
  legacyCategory?: string;
  visibility: string;
  steps: Array<{ title: string }>;
  display: {
    title?: string;
    summary?: string;
    categories: WorkPlanDisplayCategory[];
    channel?: WorkPlanDisplayChannel;
    suite?: WorkPlanDisplaySuite;
    stepLabels: string[];
    nextPlanIds: string[];
  };
  /** Used only to resolve next-plan ids to a title for display; an id with no
   *  match here still renders (as its raw id) rather than being dropped —
   *  references may be temporarily unresolved during authoring. */
  knownPlansById: Map<string, { title: string }>;
}

export function computeWorkPlanPreview(input: WorkPlanPreviewInput): WorkPlanPreview {
  const categories = input.display.categories.length
    ? input.display.categories
    : LEGACY_CATEGORY[input.legacyCategory || ""]
      ? [LEGACY_CATEGORY[input.legacyCategory || ""]]
      : [];

  return {
    id: input.planId || "(unsaved)",
    title: collapseText(input.display.title, 80) || input.title,
    summary: collapseText(input.display.summary, 180) || collapseText(input.description, 180),
    categories,
    ...(input.display.channel && { channel: input.display.channel }),
    ...(input.display.suite && { suite: input.display.suite }),
    steps: input.steps.map((step, index) => ({
      position: index + 1,
      label: collapseText(input.display.stepLabels[index], 80) || step.title,
    })),
    nextPlans: input.display.nextPlanIds.map((id) => ({
      id,
      title: input.knownPlansById.get(id)?.title || id,
      resolved: input.knownPlansById.has(id),
    })),
    visibility: input.visibility,
  };
}
