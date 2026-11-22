import { requiredToolsBudgetNote, uncalledRequiredTools } from '../stepBudgetRequiredTools';

describe('ENG-3147 step-budget required-tool reminder', () => {
  it('names the required deliverable tools a report run has not called yet', () => {
    const toolCalls = [
      { name: 'list_meta_ads_campaigns' },
      { name: 'get_meta_ads_metrics' },
      { name: 'monitor_lead_volume' },
      { name: 'perform_data_analysis' },
    ];
    const uncalled = uncalledRequiredTools(
      ['list_meta_ads_campaigns', 'get_meta_ads_metrics', 'list_html_templates', 'create_html_from_template'],
      toolCalls,
    );
    expect(uncalled).toEqual(['list_html_templates', 'create_html_from_template']);
    const note = requiredToolsBudgetNote(uncalled);
    expect(note).toContain('list_html_templates, create_html_from_template');
    expect(note).toContain('Stop gathering');
  });

  it('adds nothing when all required tools ran or none are required', () => {
    expect(uncalledRequiredTools(['a'], [{ name: 'a' }])).toEqual([]);
    expect(uncalledRequiredTools([], [{ name: 'a' }])).toEqual([]);
    expect(uncalledRequiredTools(undefined, undefined)).toEqual([]);
    expect(requiredToolsBudgetNote([])).toBe('');
  });

  it('dedupes and ignores malformed entries', () => {
    expect(uncalledRequiredTools(['x', 'x', '' as string, 5 as unknown as string], [{ name: 7 }, {}])).toEqual(['x']);
  });
});
