/**
 * Meta reports ONE conversion under SEVERAL action_type names, and the set of names varies by
 * objective and by how the conversion was captured. Anything that reads `insights.actions` and
 * treats those names as separate events over-counts.
 *
 * Measured, not assumed. Across four production ad accounts on 180-day windows, the bare `lead`
 * rollup and `offsite_conversion.fb_pixel_lead` carried IDENTICAL values in every account —
 * one conversion reported twice, never two conversions. `metaTrackingMonitor`'s own 50-day study
 * found the same: the bare rollup equalled the MAXIMUM of its aliases in every row, zero
 * exceptions. Hence: count each family ONCE, by its maximum.
 *
 * (Per-account figures are deliberately not recorded here. The property is what this code needs;
 * the customer identities and their conversion volumes are not, and committing them would leak
 * customer performance data through the repo and every review surface.)
 *
 * Why maximum rather than "read the bare rollup": whether Meta emits the bare rollup at all
 * depends on the capture surface, and we have never had an Instant Form account to observe.
 * `max` is correct under BOTH answers — with the rollup present it equals the rollup, without it
 * it equals the aliases, which carry the same value. That is what lets this ship without first
 * finding a lead-ads customer to measure.
 */

/** Meta's deduplicated conversion rollups. Mirrors metaTrackingMonitor's list deliberately. */
export const CONVERSION_FAMILIES = [
  'lead',
  'complete_registration',
  'purchase',
  'schedule',
  'submit_application',
  'start_trial',
  'subscribe',
  'contact',
  'initiate_checkout',
  'add_to_cart',
  'donate',
  'find_location',
] as const;

export type ConversionFamily = (typeof CONVERSION_FAMILIES)[number];

/**
 * Where a conversion was captured.
 *
 * `instant_form` — Meta's native in-platform lead form (Lead Ads). No pixel involved.
 * `website`      — the advertiser's own site, via pixel or CAPI.
 * `unknown`      — the bare family rollup, which spans both and names neither.
 *
 * This exists because the previous implementation inferred surface from two OVERLAPPING sets:
 * `offsite_conversion.fb_pixel_lead` (a PIXEL event, so unambiguously website) sat in the set
 * named FORM_ACTIONS. The same conversion therefore landed in both buckets, and the workaround
 * — zeroing form leads whenever any website lead existed — could not tell a duplicated alias
 * from a genuine Instant Form lead. It reported every Instant Form lead as a website lead.
 */
export type ConversionSurface = 'instant_form' | 'website' | 'unknown';

/** Instant Form (Lead Ads) spellings. NOT pixel events — no website involved. */
const INSTANT_FORM_EXACT = new Set<string>([
  'leadgen',
  'on_facebook_lead',
  'onsite_conversion.lead_form',
]);

/**
 * Returns the conversion family an action_type belongs to, or null if it is not a conversion.
 *
 * Extends metaTrackingMonitor's `familyOf` with the Instant Form spellings above, which that
 * implementation does not recognise — it checks `onsite_conversion.${family}` (i.e.
 * `onsite_conversion.lead`), never `onsite_conversion.lead_form`. Harmless there, because an
 * unrecognised type surfaces as a signal rather than being miscounted; not harmless here, where
 * an unrecognised type would silently drop the lead.
 */
export function familyOf(actionType: string): ConversionFamily | null {
  if (INSTANT_FORM_EXACT.has(actionType)) return 'lead';

  for (const family of CONVERSION_FAMILIES) {
    if (
      actionType === family ||
      actionType === `omni_${family}` ||
      actionType === `onsite_web_${family}` ||
      // CodeRabbit (ENG-1575): omitting this dropped `website_lead` from the totals entirely —
      // `surfaceOf` and WEBSITE_COST_PRECEDENCE both recognise it, and the sets this replaces
      // counted it, so leaving it unclassified was a regression. Not observed on any production
      // account (8 accounts, 180 days) but Meta documents it and the old code handled it.
      actionType === `website_${family}` ||
      actionType === `offsite_conversion.fb_pixel_${family}` ||
      actionType === `onsite_conversion.${family}` ||
      actionType === `offsite_${family}` ||
      // `offsite_lead_add_20_s_calls` and `offsite_complete_registration_add_meta_leads` are both
      // real spellings observed in production; the suffix names the ad-set rule that produced them.
      actionType.startsWith(`offsite_${family}_add_`)
    ) {
      return family;
    }
  }
  return null;
}

/**
 * Where the conversion was captured. Only meaningful for action types that ARE conversions —
 * callers should establish `familyOf(actionType) !== null` first.
 *
 * ⚠ `offsite_conversion.fb_pixel_custom` is deliberately NOT a lead. It is a CUSTOM conversion
 * and can be defined as anything the advertiser likes. One production account carried ~1.5x as
 * many of these as it had real leads — counting them would materially overstate it.
 * `familyOf` already excludes it (there is no `custom` family); this note exists so it is not
 * "helpfully" added back. One production account carried ~1.5x as many custom conversions as real
 * leads, so counting them would materially overstate that account.
 */
export function surfaceOf(actionType: string): ConversionSurface {
  if (INSTANT_FORM_EXACT.has(actionType)) return 'instant_form';
  // Pixel and CAPI events are website conversions by definition.
  if (actionType.startsWith('offsite_conversion.fb_pixel_')) return 'website';
  if (actionType.startsWith('onsite_web_')) return 'website';
  if (actionType.startsWith('offsite_')) return 'website';
  if (actionType === 'website_lead') return 'website';
  // Bare `lead`, `omni_lead` etc. are rollups spanning both surfaces and naming neither.
  return 'unknown';
}

export interface MetaAction {
  action_type: string;
  value: string | number;
}

export interface FamilyTotals {
  /** The family counted ONCE, by the maximum across its aliases. */
  total: number;
  /** Conversions attributable to the advertiser's own site (pixel / CAPI). */
  website: number;
  /** Conversions captured by Meta's native Instant Form. */
  instantForm: number;
}

const toCount = (value: string | number): number => {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Collapse an insights `actions` array into per-family totals with a surface split.
 *
 * `total` is the family maximum — never a sum, which is the whole point.
 *
 * The surface split is derived from surface-SPECIFIC spellings only; the bare rollup never
 * contributes to either side, because it names no surface. When only the rollup is present
 * (the common pixel-account shape carries both, but a rollup-only account is possible) the
 * split is attributed to `website`, since a conversion with no Instant Form spelling anywhere
 * in the payload did not come from an Instant Form.
 *
 * Consequence worth stating: `website + instantForm` always equals `total`. Callers may rely
 * on that; a test enforces it.
 */
export function collapseActions(actions: MetaAction[] | undefined | null): Map<ConversionFamily, FamilyTotals> {
  const out = new Map<ConversionFamily, FamilyTotals>();
  if (!Array.isArray(actions)) return out;

  // Per family: the running max, plus the max seen for each surface.
  const bySurface = new Map<ConversionFamily, { max: number; website: number; instantForm: number }>();

  for (const action of actions) {
    if (!action || typeof action.action_type !== 'string') continue;
    const family = familyOf(action.action_type);
    if (!family) continue;

    const value = toCount(action.value);
    const entry = bySurface.get(family) ?? { max: 0, website: 0, instantForm: 0 };
    entry.max = Math.max(entry.max, value);

    // Surface-specific spellings are themselves aliased (a website lead can appear as both
    // `onsite_web_lead` and `offsite_conversion.fb_pixel_lead`), so take the max per surface too.
    const surface = surfaceOf(action.action_type);
    if (surface === 'website') entry.website = Math.max(entry.website, value);
    else if (surface === 'instant_form') entry.instantForm = Math.max(entry.instantForm, value);

    bySurface.set(family, entry);
  }

  for (const [family, entry] of bySurface) {
    let { website, instantForm } = entry;
    let total = entry.max;

    if (website === 0 && instantForm === 0) {
      // Rollup only — no surface-specific spelling anywhere. See the note above.
      website = total;
    } else if (website + instantForm < total) {
      // The rollup counts more than the surfaces we could name. Never drop the difference:
      // keep the rollup authoritative and attribute the remainder to the dominant surface,
      // so `website + instantForm === total` still holds.
      //
      // ⚠ This split is a HEURISTIC — the total is right, the attribution is a guess. No
      // production account produces this shape today, so it is untested against real data.
      // Logged rather than left silent: if it ever fires we find out from a log line instead
      // of from a number nobody can explain.
      const remainder = total - website - instantForm;
      console.warn(
        `[metaActionFamilies] rollup exceeds named surfaces for family=${family}: ` +
        `total=${total} website=${website} instantForm=${instantForm} remainder=${remainder}. ` +
        `Total is authoritative; the surface split is heuristic.`
      );
      if (instantForm > website) instantForm += remainder;
      else website += remainder;
    } else if (website + instantForm > total) {
      // Surfaces sum ABOVE the rollup. This is the MIXED-ACCOUNT-WITHOUT-ROLLUP case: an
      // account running both Instant Forms and website conversions where Meta emits no bare
      // `lead`, so `max` only ever saw one surface. The two surfaces are genuinely distinct
      // conversions here, so the sum is the truth and the max was an undercount.
      //
      // Also unobserved in production (it needs an account running both surfaces with no bare
      // rollup), so it is logged for the same reason as the branch above.
      console.warn(
        `[metaActionFamilies] surfaces exceed rollup for family=${family}: ` +
        `rollupMax=${total} website=${website} instantForm=${instantForm}. ` +
        `Treating the surfaces as distinct conversions.`
      );
      total = website + instantForm;
    }

    out.set(family, { total, website, instantForm });
  }

  return out;
}

/** Convenience for the common case: total leads for a row, counted once. */
export function leadTotals(actions: MetaAction[] | undefined | null): FamilyTotals {
  return collapseActions(actions).get('lead') ?? { total: 0, website: 0, instantForm: 0 };
}

/**
 * Apply one insights row's lead metrics to a campaign / ad set / ad / breakdown accumulator.
 *
 * Lives here rather than in each caller: `agentModeService` and `routes/meta.ts` had identical
 * copies, and one-implementation-for-both is the entire point of this change. Counters are
 * initialised defensively (`|| 0`) so both an accumulator that pre-seeds them to 0 and one that
 * leaves them undefined behave the same.
 *
 * ROW SEMANTICS — counts ADD across rows, aliases take the MAX within a row.
 *
 * `action_breakdowns=action_type` does NOT split an entity into several rows; it structures the
 * `actions` array INSIDE one row. Measured against a live account at all three levels: campaign
 * 2 rows / 2 campaigns, adset 4/4, ad 10/10 — never more than one row per entity, each carrying
 * ~26 action entries. So the two operations never collide today.
 *
 * Adding across rows is also the CORRECT behaviour for the query shapes that do produce several
 * rows per entity — `time_increment` (one row per day) and `breakdowns` (one row per segment).
 * Taking a max across rows instead would silently collapse a 30-day series into its largest
 * single day, so it must not be "fixed" that way.
 *
 * Cost cannot be taken from an arbitrary row when several contribute: first-wins and last-wins
 * are both order-dependent. So a row's reported cost is used only while it is the ONLY opinion;
 * as soon as a second row disagrees the value is cleared, which hands the decision to the
 * caller's `cost || spend / leads` fallback — the correct figure for an aggregate anyway. That
 * is order-independent: any disagreement produces the same result whichever row arrives first.
 */
export function applyLeadMetrics(target: any, row: any): void {
  const totals = leadTotals(row?.actions);
  target.websiteLeads = (target.websiteLeads || 0) + totals.website;
  target.formLeads = (target.formLeads || 0) + totals.instantForm;

  const cost = selectLeadCost(row?.cost_per_action_type);
  applyCost(target, 'costPerWebsiteLead', cost.website);
  applyCost(target, 'costPerFormLead', cost.instantForm);
}

/**
 * Conflict state, kept OUT of `target` so nothing extra reaches a serialised API response.
 *
 * A conflict cannot be recorded by writing a sentinel into the field itself: the cleared value
 * has to be falsy for the caller's `cost || spend / leads` fallback to fire, and a falsy value
 * is indistinguishable from "not yet set" on the next row. Costs 40, 90, 60 would then end at
 * 60 — and 60, 90, 40 at 0 — which is the order dependence this exists to remove. (NaN would be
 * falsy AND distinguishable, but it serialises to null if no fallback runs.) WeakMap so entries
 * disappear with the accumulator.
 */
const disputedCosts = new WeakMap<object, Set<string>>();

/** See the ROW SEMANTICS note above: unanimous rows keep the value, disagreement clears it. */
function applyCost(target: any, field: string, proposed: number | null): void {
  if (proposed === null) return;
  // Once disputed, always disputed — later rows must not resurrect a value.
  if (disputedCosts.get(target)?.has(field)) return;

  const current = target[field];
  if (!current) {
    target[field] = proposed;
  } else if (current !== proposed) {
    // Unobserved today: `action_breakdowns=action_type` returns one row per entity, so nothing
    // can disagree. Reachable via `time_increment` / `breakdowns`. Logged so a first occurrence
    // is visible rather than silently changing a reported cost.
    console.warn(
      `[metaActionFamilies] conflicting ${field} across insight rows (${current} vs ${proposed}); ` +
      `clearing so the caller derives it from spend / leads.`
    );
    target[field] = 0; // disagreement -> let the caller derive it from spend / leads
    const fields = disputedCosts.get(target) ?? new Set<string>();
    fields.add(field);
    disputedCosts.set(target, fields);
  }
}

/**
 * Derive `totalLeads` and the per-surface costs once both surfaces are fully accumulated.
 *
 * ⚠ The spend fallback must stay BOUNDED. Before this change `formLeads` was zeroed whenever
 * `websiteLeads > 0`, so the two fallbacks were mutually exclusive. Removing that suppression
 * makes both reachable, and dividing the FULL spend by each surface independently attributes
 * more money than was spent: 100 website + 50 Instant Form on $3,000 would report $30 and $60,
 * i.e. $6,000 against $3,000.
 *
 * So: a surface that is the only one with leads carries all the spend, exactly as before. When
 * BOTH have leads, spend cannot be split per surface — Meta does not tell us — and both take the
 * blended rate, which keeps `website * cpwl + form * cpfl === spend`. A per-family figure Meta
 * actually reported always wins over either derivation.
 */
export function finalizeLeadCosts(target: any): void {
  const website = target.websiteLeads || 0;
  const form = target.formLeads || 0;
  const spend = target.spend || 0;
  const total = website + form;

  target.totalLeads = total;
  if (total > 0) target.costPerLead = spend / total;

  const blended = total > 0 ? spend / total : 0;
  if (website > 0 && !target.costPerWebsiteLead) {
    target.costPerWebsiteLead = form > 0 ? blended : spend / website;
  }
  if (form > 0 && !target.costPerFormLead) {
    target.costPerFormLead = website > 0 ? blended : spend / form;
  }
}

/**
 * Meta reports a cost per action_type, and the same conversion appears under several of them.
 * The previous implementation assigned on every match, so the surviving value was whichever
 * alias Meta happened to return LAST — array order, which Meta does not guarantee. Two runs
 * over identical data could report different costs.
 *
 * Fixed precedence instead, most specific first. The bare rollup is a last resort for the
 * website side only: it spans both surfaces, so using it as an Instant Form cost would be a
 * different number wearing the right label.
 */
const WEBSITE_COST_PRECEDENCE = [
  'offsite_conversion.fb_pixel_lead',
  'onsite_web_lead',
  'website_lead',
  'lead',
];

const INSTANT_FORM_COST_PRECEDENCE = [
  'onsite_conversion.lead_form',
  'leadgen',
  'on_facebook_lead',
];

export function selectLeadCost(
  costActions: MetaAction[] | undefined | null
): { website: number | null; instantForm: number | null } {
  if (!Array.isArray(costActions)) return { website: null, instantForm: null };

  const byType = new Map<string, number>();
  for (const entry of costActions) {
    if (!entry || typeof entry.action_type !== 'string') continue;
    const value = typeof entry.value === 'number' ? entry.value : parseFloat(entry.value);
    // First spelling wins so the result cannot depend on a duplicate later in the array.
    if (Number.isFinite(value) && value > 0 && !byType.has(entry.action_type)) {
      byType.set(entry.action_type, value);
    }
  }

  const pick = (order: string[]): number | null => {
    for (const type of order) {
      const value = byType.get(type);
      if (value !== undefined) return value;
    }
    return null;
  };

  return { website: pick(WEBSITE_COST_PRECEDENCE), instantForm: pick(INSTANT_FORM_COST_PRECEDENCE) };
}
