import path from "path";

export interface TemplateEntry {
  label: string;
  description: string;
  filename: string;
}

/**
 * Canonical registry of preset landing page templates.
 * Add or remove entries here — both the template list API and the
 * generation route read from this single source of truth.
 */
export const TEMPLATE_REGISTRY: Record<string, TemplateEntry> = {
  "event-marketing": {
    label: "Event Marketing",
    description: "Webinars, conferences, and live events",
    filename: "event-marketing.html",
  },
  "case-study": {
    label: "Case Study / Lead Magnet",
    description: "Gated PDFs, guides, and research reports",
    filename: "case-study-lead-magnet.html",
  },
  "b2b-ad": {
    label: "B2B Ad Campaign",
    description: "Meta and LinkedIn ad landing pages",
    filename: "ad-campaign-optimized.html",
  },
  "advertorial": {
    label: "Advertorial",
    description: "Sponsored editorial — video, article, and CTA",
    filename: "advertorial.html",
  },
};

/** Absolute path to the templates directory on disk. */
export const TEMPLATES_DIR = path.join(__dirname, "..", "templates");
