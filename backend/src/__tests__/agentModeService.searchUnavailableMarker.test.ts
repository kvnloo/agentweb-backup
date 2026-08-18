// ENG-1131: `linkedin_outreach` and `find_leads` have no branch in
// extractMinimalToolResult, so their stored tool-ledger result is the `{}` default.
// That erased the ENG-975 `searchUnavailable` marker — the only machine-readable
// evidence that a prospecting run sourced zero leads because LinkedIn people-search
// was DOWN for the account rather than because nobody matched. Without it the
// scheduled-run recorder cannot tell the two apart and files a clean success.

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService.extractMinimalToolResult — LinkedIn search-outage marker (ENG-1131)', () => {
  let service: AgentModeService;

  const minimal = (result: any, toolName: string) =>
    (service as any).extractMinimalToolResult(result, toolName);

  beforeEach(() => {
    service = new AgentModeService();
  });

  it('preserves the marker from a linkedin_outreach search-people outage response', () => {
    // Shape returned by linkedInSearchUnavailableResponse(). `success: false` means
    // the dispatcher downgrades the call to an error, but it still stores the
    // minimal result — which is where the marker has to survive.
    const result = {
      success: false,
      message: 'LinkedIn people search is unavailable',
      error: 'LinkedIn returned zero results for a maximally broad control query ...',
      searchUnavailable: true,
    };
    expect(minimal(result, 'linkedin_outreach')).toMatchObject({ searchUnavailable: true });
  });

  it('preserves the marker from the find_leads top-up loop', () => {
    const result = {
      success: true,
      imported: 0,
      total: 0,
      searchError: 'LinkedIn returned zero results for a maximally broad control query ...',
      searchUnavailable: true,
    };
    expect(minimal(result, 'find_leads')).toMatchObject({ searchUnavailable: true });
  });

  it('does NOT invent the marker for an honest empty search', () => {
    // The ENG-975 control probe answered `ok`, so no marker: nobody matched. This
    // must stay unmarked or every genuine zero is reported as an outage.
    expect(minimal({ success: true, imported: 0, total: 0 }, 'find_leads')).not.toHaveProperty(
      'searchUnavailable',
    );
    expect(minimal({ success: true, data: { items: [] } }, 'linkedin_outreach')).not.toHaveProperty(
      'searchUnavailable',
    );
  });

  it('leaves unrelated tools untouched', () => {
    expect(minimal({ success: true, s3_url: 'https://x/y.html', message: 'ok', versioned_filename: 'y.html' }, 'update_html_file')).toEqual({
      success: true,
      message: 'ok',
      s3_url: 'https://x/y.html',
      versioned_filename: 'y.html',
    });
  });

  it('is null-safe', () => {
    expect(() => minimal(null, 'linkedin_outreach')).not.toThrow();
    expect(() => minimal(undefined, 'find_leads')).not.toThrow();
  });
});
