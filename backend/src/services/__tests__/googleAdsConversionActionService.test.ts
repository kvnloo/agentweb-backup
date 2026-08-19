/**
 * ENG-1322 — service-boundary behaviour for CONVERSION_ACTION.
 *
 * The pure rules are covered in utils/__tests__/googleAdsConversionActions.test.ts.
 * What matters here is what the service does AROUND them: that it refuses before it
 * writes, that a create hands back the tag pair rather than just a resource name,
 * and that it reads the action back instead of trusting the create.
 *
 * The Google boundary is mocked. These are the failure paths first, per Rule 2.
 */
import { googleAdsService } from '../googleAdsService';

const CUSTOMER = '2883029950';
const RESOURCE = `customers/${CUSTOMER}/conversionActions/7724987234`;

const storedRow = (over: Record<string, any> = {}) => ({
  conversionAction: {
    resourceName: RESOURCE,
    id: '7724987234',
    name: 'Submit lead form',
    status: 'ENABLED',
    type: 'WEBPAGE',
    category: 'SUBMIT_LEAD_FORM',
    countingType: 'ONE_PER_CLICK',
    primaryForGoal: true,
    tagSnippets: [{
      type: 'WEBPAGE',
      pageFormat: 'HTML',
      eventSnippet: `<script>gtag('event','conversion',{'send_to':'AW-18192751758/qAnwCOLmx-McEI65_eJD'});</script>`,
    }],
    ...over,
  },
});

let mutateSpy: jest.SpyInstance;
let searchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(googleAdsService as any, 'getAccountCredentials').mockResolvedValue({
    accessToken: 'tok', customerId: CUSTOMER, currency: 'INR', loginCustomerId: '5331614095',
  });
  mutateSpy = jest.spyOn(googleAdsService, 'mutate').mockResolvedValue({ results: [{ resourceName: RESOURCE }] });
  searchSpy = jest.spyOn(googleAdsService, 'search').mockResolvedValue([storedRow()]);
});

describe('createConversionAction — refuses before it writes (ENG-1322 AC3)', () => {
  const valid = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK' };

  it('refuses a missing counting_type and sends nothing to Google', async () => {
    await expect(googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, countingType: undefined as any }))
      .rejects.toThrow(/counting_type/i);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('refuses an unrecognised counting_type and sends nothing', async () => {
    await expect(googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, countingType: 'ONCE' }))
      .rejects.toThrow(/ONCE/);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('refuses a missing category, naming it as never inferred', async () => {
    await expect(googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, category: '' }))
      .rejects.toThrow(/category is required/i);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('refuses a blank name', async () => {
    await expect(googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, name: '   ' }))
      .rejects.toThrow(/name is required/i);
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});

describe('createConversionAction — hands back the tag pair (ENG-1322 AC2)', () => {
  const valid = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK' };

  it('returns the AW id and label, not merely a resource name', async () => {
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    expect(out.resourceName).toBe(RESOURCE);
    expect(out.tag).toEqual({
      conversionId: 'AW-18192751758',
      conversionLabel: 'qAnwCOLmx-McEI65_eJD',
      sendTo: 'AW-18192751758/qAnwCOLmx-McEI65_eJD',
    });
  });

  it('reads the action back rather than trusting the create', async () => {
    await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    // One mutate to write, one search to verify. Skipping the read is how ENG-1293
    // shipped an ENABLED object off a non-default status request.
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0][2]).toContain('conversion_action.tag_snippets');
  });

  it('reports tag as null when Google has not generated snippets yet', async () => {
    searchSpy.mockResolvedValue([storedRow({ tagSnippets: [] })]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    expect(out.tag).toBeNull();
    // The action still exists — a missing tag is "not available yet", not a failure.
    expect(out.resourceName).toBe(RESOURCE);
  });

  it('survives a read-back that returns no row at all', async () => {
    searchSpy.mockResolvedValue([]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    expect(out.tag).toBeNull();
    expect(out.stored).toBeNull();
    // Every requested field is unverifiable, so all of them read as drift.
    expect(out.drift.map((d) => d.field).sort()).toEqual(['category', 'countingType', 'name', 'status']);
  });
});

describe('createConversionAction — surfaces drift (ENG-1322 AC4)', () => {
  const valid = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK' };

  it('reports nothing when Google stored what was asked', async () => {
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    expect(out.drift).toEqual([]);
  });

  it('catches the ENG-1293 shape — a status stored as something else', async () => {
    searchSpy.mockResolvedValue([storedRow({ status: 'ENABLED' })]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, status: 'HIDDEN' });
    expect(out.drift).toEqual([{ field: 'status', requested: 'HIDDEN', stored: 'ENABLED' }]);
  });

  it('catches a counting_type Google did not honour', async () => {
    searchSpy.mockResolvedValue([storedRow({ countingType: 'MANY_PER_CLICK' })]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    expect(out.drift).toEqual([{ field: 'countingType', requested: 'ONE_PER_CLICK', stored: 'MANY_PER_CLICK' }]);
  });
});

describe('optional fields are sent only when supplied', () => {
  const valid = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK' };

  it('sends primary_for_goal and the lookback window on create when given', async () => {
    await googleAdsService.createConversionAction('u', CUSTOMER, {
      ...valid, primaryForGoal: true, clickThroughLookbackWindowDays: 90,
    });
    const created = mutateSpy.mock.calls[0][3][0].create;
    expect(created.primaryForGoal).toBe(true);
    expect(created.clickThroughLookbackWindowDays).toBe(90);
  });

  it('omits them entirely when not given, rather than sending defaults', async () => {
    await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    const created = mutateSpy.mock.calls[0][3][0].create;
    expect('primaryForGoal' in created).toBe(false);
    expect('clickThroughLookbackWindowDays' in created).toBe(false);
  });

  it('updates every supported field, building the mask from what was supplied', async () => {
    searchSpy.mockResolvedValue([storedRow({
      name: 'Renamed', category: 'SIGNUP', countingType: 'MANY_PER_CLICK', primaryForGoal: false, status: 'HIDDEN',
    })]);
    await googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, {
      name: 'Renamed', category: 'SIGNUP', countingType: 'MANY_PER_CLICK',
      primaryForGoal: false, clickThroughLookbackWindowDays: 30, status: 'HIDDEN',
    });
    const op = mutateSpy.mock.calls[0][3][0];
    expect(op.updateMask.split(',').sort()).toEqual(
      ['category', 'click_through_lookback_window_days', 'counting_type', 'name', 'primary_for_goal', 'status'],
    );
    expect(op.update.countingType).toBe('MANY_PER_CLICK');
    expect(op.update.clickThroughLookbackWindowDays).toBe(30);
    expect(op.update.primaryForGoal).toBe(false);
  });

  it('normalises a lowercase counting_type rather than rejecting it', async () => {
    await googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, countingType: 'one_per_click' });
    expect(mutateSpy.mock.calls[0][3][0].create.countingType).toBe('ONE_PER_CLICK');
  });
});

describe('every field sent is a field checked (Greptile, ENG-1322)', () => {
  const valid = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK' };

  // These fixtures quote the lookback window on purpose. It is an INT64, and the
  // REST transport hands INT64 back as a JSON string — the same reason createBudget
  // sends `amountMicros: String(...)` and listBudgets types its read-back as string.
  // Mocking it as a bare number tested a response shape production never returns.

  it('reports drift on a lookback window Google did not honour', async () => {
    // The field was being SENT but not CHECKED, so a create that silently widened
    // the attribution window came back with an empty drift report. A wrong window
    // misattributes conversions for weeks and nothing errors.
    searchSpy.mockResolvedValue([storedRow({ clickThroughLookbackWindowDays: '30' })]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, {
      ...valid, clickThroughLookbackWindowDays: 90,
    });
    expect(out.drift).toEqual([
      { field: 'clickThroughLookbackWindowDays', requested: 90, stored: '30' },
    ]);
  });

  it('reports no drift when the window was stored as asked', async () => {
    // The regression Greptile caught: stored exactly as requested, but "90" !== 90
    // raised drift on a write that was perfectly honoured.
    searchSpy.mockResolvedValue([storedRow({ clickThroughLookbackWindowDays: '90' })]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, {
      ...valid, clickThroughLookbackWindowDays: 90,
    });
    expect(out.drift).toEqual([]);
  });

  it('reports no drift on an UPDATE whose window read back as a string', async () => {
    searchSpy.mockResolvedValue([storedRow({ clickThroughLookbackWindowDays: '60' })]);
    const out = await googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, {
      clickThroughLookbackWindowDays: 60,
    });
    expect(out.drift).toEqual([]);
  });

  it('does not check a window the caller never set', async () => {
    searchSpy.mockResolvedValue([storedRow({ clickThroughLookbackWindowDays: '30' })]);
    const out = await googleAdsService.createConversionAction('u', CUSTOMER, valid);
    expect(out.drift).toEqual([]);
  });
});

describe('listConversionActions', () => {
  it('returns an empty list for an account with none, rather than throwing', async () => {
    searchSpy.mockResolvedValue([]);
    await expect(googleAdsService.listConversionActions('u', CUSTOMER)).resolves.toEqual([]);
  });

  it('parses the tag pair onto each row so the caller never re-derives it', async () => {
    const rows = await googleAdsService.listConversionActions('u', CUSTOMER);
    expect(rows[0].tag.sendTo).toBe('AW-18192751758/qAnwCOLmx-McEI65_eJD');
    expect(rows[0].countingType).toBe('ONE_PER_CLICK');
  });
});

describe('updateConversionAction', () => {
  it('refuses an update that changes nothing', async () => {
    await expect(googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, {}))
      .rejects.toThrow(/at least one field/i);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('refuses a missing resource name', async () => {
    await expect(googleAdsService.updateConversionAction('u', CUSTOMER, '', { status: 'HIDDEN' }))
      .rejects.toThrow(/resource_name is required/i);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('still refuses a bad counting_type on update, and writes nothing', async () => {
    await expect(googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, { countingType: 'ONCE' }))
      .rejects.toThrow(/ONCE/);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('sends only the fields supplied, so an omitted field is left alone', async () => {
    searchSpy.mockResolvedValue([storedRow({ status: 'HIDDEN' })]);
    await googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, { status: 'HIDDEN' });
    const op = mutateSpy.mock.calls[0][3][0];
    expect(op.updateMask).toBe('status');
    expect(op.update).toEqual({ resourceName: RESOURCE, status: 'HIDDEN' });
    expect(op.update.name).toBeUndefined();
  });

  it('HIDDEN is the supported alternative to removal, and reads back clean', async () => {
    searchSpy.mockResolvedValue([storedRow({ status: 'HIDDEN' })]);
    const out = await googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, { status: 'HIDDEN' });
    expect(out.drift).toEqual([]);
    expect(out.stored.status).toBe('HIDDEN');
  });
});

describe('status is validated before it reaches Google (ENG-1329 e2e)', () => {
  // The end-to-end run found this, not review. CREATE with PAUSED returned a bare 400 and
  // Google's body named the field. These pin that the refusal now happens locally, with
  // an explanation, and that nothing is sent.
  const valid = { name: 'Submit lead form', category: 'SUBMIT_LEAD_FORM', countingType: 'ONE_PER_CLICK' };

  it('refuses PAUSED on create without issuing a mutate', async () => {
    await expect(googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, status: 'PAUSED' }))
      .rejects.toThrow(/cannot be PAUSED/);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('refuses PAUSED on update without issuing a mutate', async () => {
    await expect(googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, { status: 'PAUSED' }))
      .rejects.toThrow(/cannot be PAUSED/);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('points the caller at HIDDEN rather than just refusing', async () => {
    await expect(googleAdsService.createConversionAction('u', CUSTOMER, { ...valid, status: 'PAUSED' }))
      .rejects.toThrow(/HIDDEN/);
  });

  it('accepts the three real values and normalises case', async () => {
    searchSpy.mockResolvedValue([storedRow({ status: 'HIDDEN' })]);
    await googleAdsService.updateConversionAction('u', CUSTOMER, RESOURCE, { status: 'hidden' });
    const op = mutateSpy.mock.calls[0][3][0];
    expect(op.update.status).toBe('HIDDEN');
  });
});
