// ENG-1552: the `multi_campaign_performance_report` HTML template. Both the
// published `Meta_Ads_Perf_Report` work plan and its private autonomous
// validation variant find this template by NAME via `list_html_templates` and
// then fill it via `create_html_from_template` — a mismatch between the
// declared variables and what the raw HTML actually contains reaches a real
// customer session as a literal unfilled "{{token}}" in their report, or a
// silently-dropped array row. These tests are the gate on that contract.

jest.mock('../services/htmlTemplateService', () => ({
  htmlTemplateService: {
    upsertPublicTemplate: jest.fn(),
  },
}));

import { htmlTemplateService } from '../services/htmlTemplateService';
import { extractVariables } from '../utils/templateParser';
import {
  MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID,
  MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_NAME,
  MULTI_CAMPAIGN_PERFORMANCE_REPORT_SUBJECT,
  MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML,
  MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES,
  MULTI_CAMPAIGN_PERFORMANCE_REPORT_ARRAY_VARIABLES,
  SYSTEM_TEMPLATE_CREATOR,
  buildMultiCampaignPerformanceReportTemplate,
} from '../scripts/seed-eng1552-multi-campaign-performance-report-template';

describe('template shape', () => {
  const template = buildMultiCampaignPerformanceReportTemplate('2026-09-09T00:00:00.000Z');

  it('is a landing_page template with a stable id and the exact literal name the work plan searches for', () => {
    // The work-plan step text finds this template by reading `template_name` off
    // list_html_templates, not by id — a "prettified" name would never match.
    expect(template.template_name).toBe('multi_campaign_performance_report');
    expect(template.type).toEqual(['landing_page']);
    expect(template.template_id).toBe(MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID);
    expect(buildMultiCampaignPerformanceReportTemplate().template_id).toBe(
      MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID
    );
  });

  it('carries a non-empty subject even though it is never displayed', () => {
    // createHtmlFromTemplate throws "Invalid template structure: missing
    // html_content or subject" if this is falsy, regardless of `type`.
    expect(template.subject.length).toBeGreaterThan(0);
    expect(template.html_content.length).toBeGreaterThan(0);
  });
});

describe('variable contract', () => {
  it('extractVariables(html_content, subject) produces exactly the declared variables — no more, no fewer', () => {
    const extracted = extractVariables(
      MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML,
      MULTI_CAMPAIGN_PERFORMANCE_REPORT_SUBJECT
    );
    expect(extracted.variables.slice().sort()).toEqual(
      MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES.slice().sort()
    );
    expect(extracted.arrayVariables.slice().sort()).toEqual(
      MULTI_CAMPAIGN_PERFORMANCE_REPORT_ARRAY_VARIABLES.slice().sort()
    );
  });

  it('the campaigns_n array family has real _1, _2, AND _n instances in the HTML for every field', () => {
    // create_html_from_template needs a real repeated block to clone per row —
    // a lone {{x_n}} placeholder with no {{x_1}}/{{x_2}} siblings has nothing to
    // repeat from, even though the parser alone would still classify it as an
    // array variable.
    MULTI_CAMPAIGN_PERFORMANCE_REPORT_ARRAY_VARIABLES.forEach((full) => {
      // e.g. "campaigns_n_name" -> base "campaigns", suffix "name"
      const m = full.match(/^(.+)_n_(.+)$/);
      expect(m).not.toBeNull();
      const [, base, suffix] = m as RegExpMatchArray;
      expect(MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML).toContain(`{{${base}_1_${suffix}}}`);
      expect(MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML).toContain(`{{${base}_2_${suffix}}}`);
      expect(MULTI_CAMPAIGN_PERFORMANCE_REPORT_HTML).toContain(`{{${base}_n_${suffix}}}`);
    });
  });

  it('is the exact scalar variable set the plan design specifies', () => {
    expect(MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES.slice().sort()).toEqual(
      [
        'report_title', 'client_name', 'date_range', 'timeframe_label', 'generated_date',
        'total_campaigns', 'total_spend', 'total_impressions', 'total_clicks',
        'total_ctr', 'total_cpc', 'total_leads', 'total_cost_per_lead',
        'ad_level_chart_url', 'ad_level_insights',
        'demographics_chart_url', 'demographics_insights',
        'placement_chart_url', 'placement_insights',
        'device_chart_url', 'device_insights',
      ].sort()
    );
  });

  it('maps one chart+insight scalar pair to each of the 4 real CSVs get_meta_ads_metrics produces', () => {
    // Ad-Level Data, Demographics Breakdown, Placement Breakdown, Device
    // Breakdown — verified live against agentModeService.ts's formatMetricsSummary,
    // not guessed. A 5th or missing pair here would silently orphan one of the
    // 4 perform_data_analysis calls the work-plan step makes.
    ['ad_level', 'demographics', 'placement', 'device'].forEach((prefix) => {
      expect(MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES).toContain(`${prefix}_chart_url`);
      expect(MULTI_CAMPAIGN_PERFORMANCE_REPORT_VARIABLES).toContain(`${prefix}_insights`);
    });
  });
});

describe('seed idempotency', () => {
  const mockService = htmlTemplateService as jest.Mocked<typeof htmlTemplateService>;
  // The script only self-invokes under `require.main === module`, so importing
  // it here is inert; `main` is reached through the module's own export surface.
  const runSeed = async () => {
    const mod = await import('../scripts/seed-eng1552-multi-campaign-performance-report-template');
    await (mod as any).main();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('creates exactly one public row, conditionally, on a clean table', async () => {
    mockService.upsertPublicTemplate.mockResolvedValue({
      template: buildMultiCampaignPerformanceReportTemplate(),
      created: true,
    });

    await runSeed();

    expect(mockService.upsertPublicTemplate).toHaveBeenCalledTimes(1);
    expect(mockService.upsertPublicTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template_id: MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_ID,
        template_name: MULTI_CAMPAIGN_PERFORMANCE_REPORT_TEMPLATE_NAME,
        type: ['landing_page'],
      }),
      SYSTEM_TEMPLATE_CREATOR,
      // The condition is what makes it safe against a concurrent second run.
      { onlyIfAbsent: true },
    );
  });

  it('running it twice leaves exactly one row (second call reports created:false, does not throw)', async () => {
    mockService.upsertPublicTemplate
      .mockResolvedValueOnce({ template: buildMultiCampaignPerformanceReportTemplate(), created: true })
      .mockResolvedValueOnce({ template: buildMultiCampaignPerformanceReportTemplate(), created: false });

    await runSeed();
    await runSeed();

    expect(mockService.upsertPublicTemplate).toHaveBeenCalledTimes(2);
  });

  it('a real database error is not swallowed', async () => {
    mockService.upsertPublicTemplate.mockRejectedValue(new Error('dynamo down'));
    await expect(runSeed()).rejects.toThrow('dynamo down');
  });
});
