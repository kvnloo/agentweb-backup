/**
 * ENG-200: report revisions must use the one shared gateway/metering path.
 */

jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
const mockCallLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { callLLM: (...a: any[]) => mockCallLLM(...a) },
}));

import { ReportRevisionService } from '../services/reportRevisionService';

describe('reportRevisionService metering (ENG-200)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes once with attributable usage context (no double-record)', async () => {
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { tool_calls: [{ function: {
        name: 'write_revised_report',
        arguments: JSON.stringify({ revised_content: '<p>new</p>', filename: 'new.html' }),
      } }] } }],
    });
    const svc = new ReportRevisionService();
    (svc as any).handleWriteRevisedReport = jest.fn().mockResolvedValue({ url: 'https://example.com/new.html' });
    await (svc as any).generateRevisedReport('<p>old</p>', 'improve it', 'task-1', 'exec-1', 'user-1');

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        usageContext: { userId: 'user-1', feature: 'report_revision' },
        taskClass: 'content_generation',
      }),
    );
  });
});
