/**
 * ENG-2103 F2 — proves emma/tools.ts's convert_to_pdf/read_page_source
 * (extractDesignTokens branch)/list_html_templates execute() bodies call
 * emma/impl/htmlTools.ts directly (not agentModeService.<method>) and
 * forward the result unchanged. Same pattern as emmaTools.googleDrive.test.ts.
 */

jest.mock('../emma/impl/htmlTools', () => ({
  convertToPdf: jest.fn(),
  extractCSSFromURL: jest.fn(),
  listHtmlTemplates: jest.fn(),
}));

// ENG-2103 (F2), cluster 22: read_page_source's non-extraction branch now
// calls emma/impl/misc.ts's readFileContent directly (moved off
// agentModeService in this cluster) — mocked here so the
// "does not call extractCSSFromURL" case below doesn't fall through to a
// REAL axios fetch of https://example.com. Mirrors the { success: true }
// default the old agentModeService Proxy mock returned for any unlisted prop.
jest.mock('../emma/impl/misc', () => ({
  readFileContent: jest.fn().mockResolvedValue({ success: true }),
}));

// agentModeService.<htmlToolsMethod> must NOT be called by these tools
// anymore for the three moved methods.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        if (['convertToPdf', 'extractCSSFromURL', 'listHtmlTemplates'].includes(String(prop))) {
          return () => {
            throw new Error(`agentModeService.${String(prop)} should not be called by the htmlTools cluster after ENG-2103 F2`);
          };
        }
        return jest.fn().mockResolvedValue({ success: true });
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as htmlToolsImpl from '../emma/impl/htmlTools';
import '../emma/tools';

const mockHtmlTools = htmlToolsImpl as jest.Mocked<typeof htmlToolsImpl>;

describe('htmlTools cluster delegates to emma/impl/htmlTools.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('list_html_templates forwards userId/type and returns the result unchanged', async () => {
    const expected = { success: true, email_templates: [] };
    mockHtmlTools.listHtmlTemplates.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('list_html_templates')!;
    const result = await tool.execute({ type: 'email' }, { userId: 'u1' });

    expect(mockHtmlTools.listHtmlTemplates).toHaveBeenCalledWith('u1', 'email');
    expect(result).toBe(expected);
  });

  it('read_page_source with extractDesignTokens forwards args and returns the result unchanged', async () => {
    const expected = { success: true, detailedTokens: {} };
    mockHtmlTools.extractCSSFromURL.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('read_page_source')!;
    const result = await tool.execute({ url: 'https://example.com', extractDesignTokens: true }, { userId: 'u1' });

    expect(mockHtmlTools.extractCSSFromURL).toHaveBeenCalledWith({ url: 'https://example.com', extractDesignTokens: true }, 'u1');
    expect(result).toBe(expected);
  });

  it('read_page_source without extractDesignTokens does not call extractCSSFromURL', async () => {
    const tool = emmaToolRegistry.getTool('read_page_source')!;
    await tool.execute({ url: 'https://example.com' }, { userId: 'u1' });

    expect(mockHtmlTools.extractCSSFromURL).not.toHaveBeenCalled();
  });

  it('convert_to_pdf forwards args (including orientation/format) and returns the result unchanged', async () => {
    const expected = { success: true, pdf_url: 'https://s3/x.pdf' };
    mockHtmlTools.convertToPdf.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('convert_to_pdf')!;
    const result = await tool.execute(
      { source_url: 'https://s3/x.html', output_filename: 'report', orientation: 'landscape', format: 'A4' },
      { userId: 'u1' }
    );

    expect(mockHtmlTools.convertToPdf).toHaveBeenCalledWith('https://s3/x.html', 'report', 'u1', {
      orientation: 'landscape', format: 'A4',
    });
    expect(result).toBe(expected);
  });
});
