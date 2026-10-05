/**
 * ENG-2103 F2 — proves emma/tools.ts's update_html_file tool execute() body
 * calls emma/impl/htmlUpdate.ts directly (not agentModeService.updateHtmlFile)
 * and forwards the parsed operations JSON unchanged. Same pattern as
 * emmaTools.leads.test.ts / emmaTools.htmlCreation.test.ts.
 */

jest.mock('../emma/impl/htmlUpdate', () => ({
  updateHtmlFile: jest.fn(),
}));

// agentModeService.updateHtmlFile must NOT be called by this tool anymore.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'updateHtmlFile') {
          return () => {
            throw new Error('agentModeService.updateHtmlFile should not be called by the update_html_file tool after ENG-2103 F2');
          };
        }
        return jest.fn().mockResolvedValue({ success: true });
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as htmlUpdateImpl from '../emma/impl/htmlUpdate';
import '../emma/tools';

const mockHtmlUpdate = htmlUpdateImpl as jest.Mocked<typeof htmlUpdateImpl>;

describe('updateHtmlFile cluster delegates to emma/impl/htmlUpdate.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('update_html_file parses operations_json and forwards args to updateHtmlFile', async () => {
    const expected = { success: true, s3_url: 'https://s3/updated.html' };
    mockHtmlUpdate.updateHtmlFile.mockResolvedValue(expected);
    const operations = [{ action: 'replaceInner', selector: 'h1', html: 'New title' }];

    const result = await emmaToolRegistry.getTool('update_html_file')!.execute(
      { file_url: 'https://s3/source.html', update_type: 'css', operations_json: JSON.stringify(operations) },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockHtmlUpdate.updateHtmlFile).toHaveBeenCalledWith('https://s3/source.html', 'css', operations, 'u1', 's1');
    expect(result).toBe(expected);
  });

  it('returns a clean error and does not call updateHtmlFile when operations_json is invalid', async () => {
    const result = await emmaToolRegistry.getTool('update_html_file')!.execute(
      { file_url: 'https://s3/source.html', update_type: 'css', operations_json: 'not json' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockHtmlUpdate.updateHtmlFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, message: 'Invalid JSON in operations_json' });
  });
});
