/**
 * ENG-200: reportRevisionService obtained a METERED getAzureClient (auto-records
 * burn) AND called meterUsageFromResponse on the same response → double-record.
 * The fix requests the client UN-metered; this test locks that its client()
 * helper passes metered:false so the single meterUsageFromResponse meters once.
 */

jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../utils/llmClients', () => ({
  getAzureClient: jest.fn().mockReturnValue({ chat: { completions: { create: jest.fn() } } }),
  meterUsageFromResponse: jest.fn(),
}));

import { getAzureClient } from '../utils/llmClients';
import { ReportRevisionService } from '../services/reportRevisionService';

const mockGetAzure = getAzureClient as jest.Mock;

describe('reportRevisionService metering (ENG-200)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds an UN-metered client (metered:false) so it does not double-record', () => {
    const svc = new ReportRevisionService();
    // client() is the single place the Azure client is constructed for the revision LLM call.
    (svc as any).client('user-1');

    expect(mockGetAzure).toHaveBeenCalledTimes(1);
    expect(mockGetAzure.mock.calls[0][0]).toEqual(
      expect.objectContaining({ userId: 'user-1', feature: 'report_revision' })
    );
    // overrides (3rd arg) carries metered:false.
    expect(mockGetAzure.mock.calls[0][2]).toEqual(
      expect.objectContaining({ metered: false })
    );
  });
});
