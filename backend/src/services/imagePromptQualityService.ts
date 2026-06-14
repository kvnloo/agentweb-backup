/**
 * Image-prompt quality analyzer (WS1c).
 *
 * Closes the human-in-the-loop self-improvement cycle for onboarding ad
 * images. WS1b now captures per-archetype like/skip signals; WS1a made the
 * prompt runtime-editable. This service reads those signals, computes the
 * like-rate per archetype (at its current prompt version), and ranks the
 * archetypes whose like-rate is below threshold — with enough sample to be
 * meaningful — as "underperformers" the taste team should edit.
 *
 * It does NOT auto-edit prompts. Auto-application of a proposed edit depends
 * on the Slack-reaction approval gate (the loops framework's ApprovalGate is
 * still a no-op CaptureGate today), so this stage surfaces recommendations;
 * a human applies them via PUT /api/admin/prompt-templates/:id (or the global
 * directives route). When the approval gate lands, this analyzer is the
 * natural source of the `prompt_edit` proposals.
 *
 * Pure logic with injected fetchers — unit-tested without DynamoDB.
 */

import {
  computeLikeRate,
  type PromptSignalSummary,
} from "./promptSignalsService";

export type ArchetypeQualityStatus =
  | "ok"
  | "underperforming"
  | "insufficient_data";

export interface ArchetypeQuality {
  archetype: string;
  /** Full prompt version (builder/template) the signals are attributed to. */
  version: string;
  likeRate: number | null;
  sampleSize: number;
  status: ArchetypeQualityStatus;
  recommendation: string;
}

export interface ImagePromptQualityReport {
  thresholds: { likeRateThreshold: number; minSample: number };
  archetypes: ArchetypeQuality[];
  /** Underperformers only, worst like-rate first. */
  underperformers: ArchetypeQuality[];
}

const DEFAULT_LIKE_RATE_THRESHOLD = 0.5;
const DEFAULT_MIN_SAMPLE = 20;

export interface AnalyzeDeps {
  /** List the current template rows (id + version). Defaults to the store. */
  listTemplates?: () => Promise<Array<{ templateId: string; version: string }>>;
  /** Fetch the signal summary for a full prompt version. Defaults to the store. */
  getSummary?: (fullVersion: string) => Promise<PromptSignalSummary>;
  /** Builder version prefix combined with each template version. */
  builderVersion?: string;
  likeRateThreshold?: number;
  minSample?: number;
}

function archetypeIdFrom(templateId: string): string {
  const m = /^archetype-([A-L])$/.exec(templateId);
  return m ? m[1] : templateId;
}

/**
 * Analyze image-prompt quality across all archetypes. Returns each archetype's
 * like-rate + status and the ranked list of underperformers.
 */
export async function analyzeImagePromptQuality(
  deps: AnalyzeDeps = {},
): Promise<ImagePromptQualityReport> {
  const likeRateThreshold = deps.likeRateThreshold ?? DEFAULT_LIKE_RATE_THRESHOLD;
  const minSample = deps.minSample ?? DEFAULT_MIN_SAMPLE;

  const listTemplates =
    deps.listTemplates ??
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { listAllTemplates } = require("./promptTemplatesService");
      const rows = await listAllTemplates();
      return rows.map((r: any) => ({ templateId: r.templateId, version: r.version }));
    });
  const getSummary =
    deps.getSummary ??
    ((fullVersion: string) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getPromptSignalSummary } = require("./promptSignalsService");
      return getPromptSignalSummary(fullVersion, 1000);
    });
  const builderVersion =
    deps.builderVersion ??
    (() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PROMPT_BUILDER_VERSION } = require("./onboardingAdImageService");
      return PROMPT_BUILDER_VERSION;
    })();

  const templates = await listTemplates();

  const archetypes: ArchetypeQuality[] = await Promise.all(
    templates.map(async (t: { templateId: string; version: string }) => {
      const arch = archetypeIdFrom(t.templateId);
      const fullVersion = `${builderVersion}/${t.version}`;
      let summary: PromptSignalSummary;
      try {
        summary = await getSummary(fullVersion);
      } catch {
        summary = {
          promptVersion: fullVersion,
          totals: { like: 0, skip: 0, continue_set: 0, regenerate_set: 0 },
          byArchetype: {},
          sampleSize: 0,
        };
      }
      const totals = summary.byArchetype[arch] ?? {
        like: 0,
        skip: 0,
        continue_set: 0,
        regenerate_set: 0,
      };
      const sampleSize = totals.like + totals.skip;
      const likeRate = computeLikeRate(totals);

      let status: ArchetypeQualityStatus;
      let recommendation: string;
      if (sampleSize < minSample || likeRate === null) {
        status = "insufficient_data";
        recommendation = `Only ${sampleSize} rating(s) — need ≥${minSample} before judging archetype ${arch}.`;
      } else if (likeRate < likeRateThreshold) {
        status = "underperforming";
        recommendation =
          `Archetype ${arch} like-rate ${(likeRate * 100).toFixed(0)}% (n=${sampleSize}) is below ` +
          `${(likeRateThreshold * 100).toFixed(0)}%. Edit its layout/text-budget (PUT ` +
          `/api/admin/prompt-templates/archetype-${arch}) or the global directives, then re-measure.`;
      } else {
        status = "ok";
        recommendation = `Archetype ${arch} like-rate ${(likeRate * 100).toFixed(0)}% (n=${sampleSize}) is healthy.`;
      }

      return { archetype: arch, version: fullVersion, likeRate, sampleSize, status, recommendation };
    }),
  );

  const underperformers = archetypes
    .filter((a) => a.status === "underperforming")
    .sort((a, b) => (a.likeRate ?? 1) - (b.likeRate ?? 1));

  return {
    thresholds: { likeRateThreshold, minSample },
    archetypes,
    underperformers,
  };
}
