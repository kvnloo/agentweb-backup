/**
 * Seed script (ENG-1552): the "Multi-Campaign Performance Report" HTML template.
 *
 * WHY THIS EXISTS. `Meta_Ads_Perf_Report` (the published work plan, and its
 * autonomous variant this ticket builds) both have a step whose description text
 * instructs the model to `list_html_templates` and find a template literally named
 * `multi_campaign_performance_report`, then fill it with campaign data and 4
 * chart+insight blocks. That template has never existed — confirmed live against
 * prod: zero source hits, zero `templates_public` row in `AW-Settings`, invisible
 * via `GET /api/html-templates`. Both the published plan and its private
 * validation variant have only ever "worked" by the model silently falling back to
 * a freeform `create_html_file` call instead. This script closes that gap.
 *
 * WHY A SCRIPT AND NOT AN API CALL. `htmlTemplateService`'s only write path
 * (`createTemplate`) is hardcoded to a per-user private row (`USER_KEY`) —
 * `templates_public` has never had a writer anywhere in this codebase, confirmed
 * by reading every call site of `writeRow` in that file. `upsertPublicTemplate`
 * (added alongside this script) is the first one, keyed on a fixed `template_id`
 * for the same idempotent-reseed reason ENG-1609's schedule-template seed used a
 * fixed id rather than a fresh uuid per run.
 *
 * WHY THESE VARIABLES, NOT INVENTED ONES. The CSV shape comes from
 * `formatMetricsSummary` (`agentModeService.ts`, `getMetaAdsMetrics`'s formatting
 * path) — verified live in source, not guessed: it already uploads exactly 4 CSVs
 * (Ad-Level Data, Demographics Breakdown, Placement Breakdown, Device Breakdown)
 * with real column headers, and embeds their S3 links directly in the tool's own
 * result. The work-plan step just needs to extract those links and run
 * `perform_data_analysis` once per file — this template's 4 analysis blocks
 * (`ad_level_*`, `demographics_*`, `placement_*`, `device_*`) map 1:1 onto them.
 * Each CSV is only produced when its source array is non-empty, so a run can
 * legitimately produce fewer than 4 — the work-plan step's instructions (not this
 * template) are responsible for telling the model to omit a block it has no data
 * for, since `create_html_from_template`'s built-in empty-handling only covers
 * array variables, not scalars like these chart/insight pairs.
 *
 * `subject` is required even though `type` is `landing_page`, not `email` —
 * `createHtmlFromTemplate` (`agentModeService.ts`) throws "Invalid template
 * structure: missing html_content or subject" otherwise. Its content is never
 * shown to anyone; it exists only to satisfy that check.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng1552-multi-campaign-performance-report-template.ts
 *   NODE_ENV=production  npx ts-node src/scripts/seed-eng1552-multi-campaign-performance-report-template.ts
 *
 * Idempotent: skips if a public template with this exact id already exists, so
 * running it twice leaves exactly one row.
 */

/**
 * STABLE identity, deliberately not a fresh uuid per run (same reasoning as
 * ENG-1609's `LINKEDIN_OUTREACH_TEMPLATE_ID`). Never change this value — a new id
 * would seed a SECOND public template rather than update the existing one, and
 * the work plan's own description text finds this template by NAME
 * (`template_name`), not by id, so a duplicate would be genuinely ambiguous to
 * the model reading `list_html_templates`.
 */
export const MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID = 'eng1552-multi-campaign-performance-report';

/**
 * Literal string the work-plan step text searches for via `list_html_templates`.
 * Must match exactly — this is read by an LLM off the template listing, not
 * looked up by id.
 */
export const MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_NAME = 'multi_campaign_performance_report';

export const SYSTEM_TEMPLATE_CREATOR = 'system';

/**
 * Never displayed — `type: ['landing_page']` means this report is shown as a
 * clickable link, not emailed. Exists only because `createHtmlFromTemplate`
 * requires a non-empty `subject` on every template regardless of type.
 */
export const MULTI_CAMPAIGN_PERFORMANCE_REPORT_SUBJECT =
  '{{client_name}} — Meta Ads Performance Report ({{date_range}})';

/**
 * THE TEMPLATE BODY.
 *
 * Section by section:
 *  1. Header — report title, client, timeframe, generation date (all scalar).
 *  2. Summary stat-tile grid — the 8 overall totals (all scalar).
 *  3. Per-campaign table — the `campaigns_n` array-variable family. Deliberately
 *     carries real `_1`, `_2`, AND `_n` placeholder instances for every field in
 *     the family (not just `_n`) — `templateParser.extractVariables` groups an
 *     array family from its literal numbered instances; a lone `_n` placeholder
 *     with no `_1`/`_2` siblings is still detected as an array variable by the
 *     parser, but `create_html_from_template`'s row-repetition logic needs a real
 *     repeated block in the source HTML to know what to clone per array entry.
 *  4. Four analysis blocks — Ad-Level, Demographics, Placement, Device. Each is
 *     one `perform_data_analysis` call's chart + insight text, mapped straight
 *     from the 4 CSVs `get_meta_ads_metrics` already produces.
 *
 * A pinned test (`seedEng1552Template.test.ts`) asserts
 * `extractVariables(html_content, subject)` produces exactly the `variables`/
 * `arrayVariables` lists declared below — catches a stray `_3` or a typo'd
 * placeholder before this ever ships.
 */
export const MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>{{report_title}}</title>
<style>
  :root {
    --color-primary: #2563EB;
    --color-accent: #10B981;
    --color-text: #1F2937;
    --color-muted: #6B7280;
    --color-border: #E5E7EB;
    --color-bg: #F9FAFB;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--color-text); background: var(--color-bg); margin: 0; padding: 32px; }
  .report { max-width: 960px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  header h1 { margin: 0 0 4px; font-size: 24px; }
  header p { margin: 0; color: var(--color-muted); }
  header .muted { font-size: 13px; margin-top: 4px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 28px 0; }
  .stat-tile { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 8px; padding: 16px; text-align: center; }
  .stat-tile span { display: block; font-size: 20px; font-weight: 700; color: var(--color-primary); }
  .stat-tile label { display: block; font-size: 12px; color: var(--color-muted); margin-top: 4px; }
  .campaign-table { margin: 28px 0; }
  .campaign-table h2 { font-size: 18px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--color-border); font-size: 13px; }
  th { color: var(--color-muted); font-weight: 600; }
  .analysis-block { margin: 28px 0; padding-top: 20px; border-top: 1px solid var(--color-border); }
  .analysis-block h2 { font-size: 18px; margin-bottom: 12px; }
  .analysis-block img { max-width: 100%; border-radius: 8px; border: 1px solid var(--color-border); }
  .analysis-block p { color: var(--color-text); line-height: 1.5; margin-top: 12px; }
</style>
</head>
<body>
<div class="report">

  <header>
    <h1>{{report_title}}</h1>
    <p>{{client_name}} &middot; {{timeframe_label}}</p>
    <p class="muted">Generated {{generated_date}} &middot; {{date_range}}</p>
  </header>

  <section class="summary-grid">
    <div class="stat-tile"><span>{{total_campaigns}}</span><label>Campaigns</label></div>
    <div class="stat-tile"><span>{{total_spend}}</span><label>Total Spend</label></div>
    <div class="stat-tile"><span>{{total_impressions}}</span><label>Impressions</label></div>
    <div class="stat-tile"><span>{{total_clicks}}</span><label>Clicks</label></div>
    <div class="stat-tile"><span>{{total_ctr}}</span><label>CTR</label></div>
    <div class="stat-tile"><span>{{total_cpc}}</span><label>CPC</label></div>
    <div class="stat-tile"><span>{{total_leads}}</span><label>CRM Leads</label></div>
    <div class="stat-tile"><span>{{total_cost_per_lead}}</span><label>Cost / Lead</label></div>
  </section>

  <section class="campaign-table">
    <h2>Campaign Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>Campaign</th><th>Spend</th><th>Impressions</th><th>Clicks</th>
          <th>CTR</th><th>CPC</th><th>Leads</th><th>Cost / Lead</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{{campaigns_1_name}}</td><td>{{campaigns_1_spend}}</td><td>{{campaigns_1_impressions}}</td>
          <td>{{campaigns_1_clicks}}</td><td>{{campaigns_1_ctr}}</td><td>{{campaigns_1_cpc}}</td>
          <td>{{campaigns_1_leads}}</td><td>{{campaigns_1_costperlead}}</td>
        </tr>
        <tr>
          <td>{{campaigns_2_name}}</td><td>{{campaigns_2_spend}}</td><td>{{campaigns_2_impressions}}</td>
          <td>{{campaigns_2_clicks}}</td><td>{{campaigns_2_ctr}}</td><td>{{campaigns_2_cpc}}</td>
          <td>{{campaigns_2_leads}}</td><td>{{campaigns_2_costperlead}}</td>
        </tr>
        <tr>
          <td>{{campaigns_n_name}}</td><td>{{campaigns_n_spend}}</td><td>{{campaigns_n_impressions}}</td>
          <td>{{campaigns_n_clicks}}</td><td>{{campaigns_n_ctr}}</td><td>{{campaigns_n_cpc}}</td>
          <td>{{campaigns_n_leads}}</td><td>{{campaigns_n_costperlead}}</td>
        </tr>
      </tbody>
    </table>
  </section>

  <section class="analysis-block">
    <h2>Top Performing Ads</h2>
    <img src="{{ad_level_chart_url}}" alt="Ad-level performance chart" />
    <p>{{ad_level_insights}}</p>
  </section>

  <section class="analysis-block">
    <h2>Demographics</h2>
    <img src="{{demographics_chart_url}}" alt="Demographics breakdown chart" />
    <p>{{demographics_insights}}</p>
  </section>

  <section class="analysis-block">
    <h2>Placement</h2>
    <img src="{{placement_chart_url}}" alt="Placement breakdown chart" />
    <p>{{placement_insights}}</p>
  </section>

  <section class="analysis-block">
    <h2>Device</h2>
    <img src="{{device_chart_url}}" alt="Device breakdown chart" />
    <p>{{device_insights}}</p>
  </section>

</div>
</body>
</html>`;

/** Scalar variables — everything NOT part of the `campaigns_n` array family. */
export const MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES: string[] = [
  'report_title',
  'client_name',
  'date_range',
  'timeframe_label',
  'generated_date',
  'total_campaigns',
  'total_spend',
  'total_impressions',
  'total_clicks',
  'total_ctr',
  'total_cpc',
  'total_leads',
  'total_cost_per_lead',
  'ad_level_chart_url',
  'ad_level_insights',
  'demographics_chart_url',
  'demographics_insights',
  'placement_chart_url',
  'placement_insights',
  'device_chart_url',
  'device_insights',
];

/** Array-variable family — one canonical entry per field, per `templateParser`'s grouping. */
export const MULTI_CAMPAIGN_PERFORMANCE_REPORT_ARRAY_VARIABLES: string[] = [
  'campaigns_n_name',
  'campaigns_n_spend',
  'campaigns_n_impressions',
  'campaigns_n_clicks',
  'campaigns_n_ctr',
  'campaigns_n_cpc',
  'campaigns_n_leads',
  'campaigns_n_costperlead',
];

export function buildMultiCampaignPerformanceReportTemplate(now: string = new Date().toISOString()) {
  return {
    template_id: MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID,
    template_name: MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_NAME,
    type: ['landing_page'] as ('email' | 'landing_page')[],
    subject: MULTI_CAMPAIGN_PERFORMANCE_REPORT_SUBJECT,
    html_content: MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML,
    variables: MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES,
    arrayVariables: MULTI_CAMPAIGN_PERFORMANCE_REPORT_ARRAY_VARIABLES,
    created_at: now,
    updated_at: now,
  };
}

export async function main() {
  const { htmlTemplateService } = await import('../services/htmlTemplateService');

  const template = buildMultiCampaignPerformanceReportTemplate();
  const { created } = await htmlTemplateService.upsertPublicTemplate(
    template,
    SYSTEM_TEMPLATE_CREATOR,
    { onlyIfAbsent: true },
  );

  if (!created) {
    console.log(
      `Public template "${MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_NAME}" already exists `
      + `(id: ${MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID}). Nothing to do.`
    );
    return;
  }
  console.log(`Seeded public HTML template "${template.template_name}" with id: ${template.template_id}`);
  console.log(`  variables:      ${template.variables.join(', ')}`);
  console.log(`  arrayVariables: ${template.arrayVariables.join(', ')}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
