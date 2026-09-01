import {
  describeImageReportsFabricatedMetrics,
  promptRisksFabricatedMetrics,
} from '../services/agentMode/dataFabricationGuard';

describe('promptRisksFabricatedMetrics (ENG-1027)', () => {
  it('flags a generic dashboard/metrics-preview prompt with no real values supplied', () => {
    // Live-reproduced case: the user never asked for real data at all, just a
    // "status tracker" — the image model still invented Reach/CTR/Spend figures.
    const prompt =
      'A sleek, modern SaaS status tracker dashboard graphic featuring 3 horizontal cards. ' +
      'Each card represents a campaign stage with a status badge, progress bar, and metrics preview.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(true);
  });

  it('flags an explicit data-table comparison prompt with no real values supplied', () => {
    const prompt = 'A high-contrast data comparison table with columns for Metric, Last Month, This Month.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(true);
  });

  it('does not flag a data-table prompt that already supplies concrete values', () => {
    const prompt = 'A data table showing Total Spend $12,450 and Conversion Rate 2.8% for this campaign.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(false);
  });

  it('does not flag a prompt with no dashboard/data shape at all', () => {
    const prompt = 'A candid phone snapshot of a laptop on a kitchen table at night, warm lamp light.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(false);
  });

  it('is not tripped by unrelated digits like image dimensions', () => {
    const prompt = 'A minimalist status tracker dashboard graphic with a metrics preview, 1080x1080 square format.';
    // "1080x1080" has no $ or % so it must not be mistaken for a supplied real value.
    expect(promptRisksFabricatedMetrics(prompt)).toBe(true);
  });

  it('handles empty/non-string input', () => {
    expect(promptRisksFabricatedMetrics('')).toBe(false);
    expect(promptRisksFabricatedMetrics(undefined as any)).toBe(false);
  });
});

describe('describeImageReportsFabricatedMetrics (ENG-1027)', () => {
  it('detects numeric metric content in a vision description', () => {
    const description =
      "Row 8 reads 'AI + marketing automation'. The Spend column shows $1,240 and the ROI column shows 30.00%.";
    expect(describeImageReportsFabricatedMetrics(description)).toBe(true);
  });

  it('does not flag a description that explicitly reports no numbers found', () => {
    const description = 'The image shows a clean data table with dashes ("--") in every cell. No numbers found.';
    expect(describeImageReportsFabricatedMetrics(description)).toBe(false);
  });

  it('handles empty/non-string input', () => {
    expect(describeImageReportsFabricatedMetrics('')).toBe(false);
    expect(describeImageReportsFabricatedMetrics(undefined as any)).toBe(false);
  });
});
