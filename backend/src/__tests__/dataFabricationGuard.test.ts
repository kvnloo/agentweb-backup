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

  // ENG-1027 (round 2): live re-verification found the fix ITSELF fabricating a
  // number — Emma wrote "progress bar indicator at 75%" straight into a
  // generate_image prompt with no sourced progress data behind it, and it rendered
  // exactly as asked. An earlier version of this heuristic skipped the check
  // whenever a $/% value was already present, reasoning that meant real data had
  // been supplied — that suppression is precisely what let this slip past
  // undetected. The check must still fire here: a concrete-looking value already
  // in the prompt is not proof it's real.
  it('still flags a dashboard prompt that already contains a self-invented percentage (the "75%" regression)', () => {
    const prompt =
      'Card 2 (Center): Active highlighted card labeled "STAGE 2", with a glowing status pill "IN PROGRESS" ' +
      'and progress bar indicator at 75%.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(true);
  });

  it('flags a data-table prompt even when it already contains concrete-looking values', () => {
    const prompt = 'A data table showing Total Spend $12,450 and Conversion Rate 2.8% for this campaign.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(true);
  });

  it('does not flag a prompt with no dashboard/data shape at all', () => {
    const prompt = 'A candid phone snapshot of a laptop on a kitchen table at night, warm lamp light.';
    expect(promptRisksFabricatedMetrics(prompt)).toBe(false);
  });

  it('handles empty/non-string input', () => {
    expect(promptRisksFabricatedMetrics('')).toBe(false);
    expect(promptRisksFabricatedMetrics(undefined as any)).toBe(false);
  });

  // A false positive here means Emma tells a customer their real, tool-sourced
  // numbers "were never verified as real" — a trust-eroding, confusing thing to say
  // about accurate data. metrics_verified is the explicit escape hatch: Emma has to
  // actively assert it, unlike a text heuristic the system infers on its own.
  it('skips the check when Emma explicitly declares the values are verified real data', () => {
    const prompt = 'A data table showing Total Spend $12,450 and Conversion Rate 2.8% for this campaign.';
    expect(promptRisksFabricatedMetrics(prompt, true)).toBe(false);
  });

  it('still checks a dashboard-shaped prompt when metricsVerified is false/omitted', () => {
    const prompt = 'A high-contrast data comparison table with columns for Metric, Last Month, This Month.';
    expect(promptRisksFabricatedMetrics(prompt, false)).toBe(true);
    expect(promptRisksFabricatedMetrics(prompt)).toBe(true);
  });
});

describe('describeImageReportsFabricatedMetrics (ENG-1027)', () => {
  // Preferred path: the vision check now asks for a single structured line, which
  // is far more reliable to parse than free-form prose phrasing that varies across
  // vision-model responses.
  it('detects numeric content via the structured NUMBERS_FOUND line', () => {
    expect(describeImageReportsFabricatedMetrics('NUMBERS_FOUND: 75%, $1,240, 30.00%')).toBe(true);
  });

  it('does not flag NUMBERS_FOUND: NONE', () => {
    expect(describeImageReportsFabricatedMetrics('NUMBERS_FOUND: NONE')).toBe(false);
  });

  it('parses NUMBERS_FOUND even with surrounding text', () => {
    const description = "Sure, here's what I see.\nNUMBERS_FOUND: 68%, 92%\nThat's my full answer.";
    expect(describeImageReportsFabricatedMetrics(description)).toBe(true);
  });

  // Fallback path: if the vision model ignores the structured-format instruction
  // and answers in prose, fall back to the prose heuristic rather than silently
  // treating an unparseable response as "no numbers found" — the fallback fails
  // toward flagging (an extra disregardable warning) rather than toward missing
  // real fabrication.
  it('falls back to prose parsing when the model does not use the structured format', () => {
    const description =
      "Row 8 reads 'AI + marketing automation'. The Spend column shows $1,240 and the ROI column shows 30.00%.";
    expect(describeImageReportsFabricatedMetrics(description)).toBe(true);
  });

  it('falls back to prose "no numbers found" phrasing when unstructured', () => {
    const description = 'The image shows a clean data table with dashes ("--") in every cell. No numbers found.';
    expect(describeImageReportsFabricatedMetrics(description)).toBe(false);
  });

  it('handles empty/non-string input', () => {
    expect(describeImageReportsFabricatedMetrics('')).toBe(false);
    expect(describeImageReportsFabricatedMetrics(undefined as any)).toBe(false);
  });
});
