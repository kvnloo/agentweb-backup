/**
 * ENG-2103 F2 — proves emma/tools.ts's Google Docs/Sheets tool execute()
 * bodies call emma/impl/googleDocsSheets.ts directly (not
 * agentModeService.<method>) and forward the result unchanged. Same pattern
 * as emmaTools.googleDrive.test.ts.
 */

jest.mock('../emma/impl/googleDocsSheets', () => ({
  createGoogleDoc: jest.fn(),
  updateGoogleDoc: jest.fn(),
  createGoogleSheet: jest.fn(),
  updateGoogleSheet: jest.fn(),
}));

// agentModeService.<docsSheetsMethod> must NOT be called by these tools
// anymore — mock the whole module so a regression (a call site accidentally
// left pointed at the class) would throw instead of silently succeeding
// against the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the Google Docs/Sheets tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as googleDocsSheetsImpl from '../emma/impl/googleDocsSheets';
import '../emma/tools';

const mockGDocs = googleDocsSheetsImpl as jest.Mocked<typeof googleDocsSheetsImpl>;

describe('Google Docs/Sheets tool cluster delegates to emma/impl/googleDocsSheets.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create_google_doc defaults to styled and forwards args', async () => {
    const expected = { success: true, doc_id: 'd1', url: 'https://docs.google.com/document/d/d1/edit' };
    mockGDocs.createGoogleDoc.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_google_doc')!;
    const result = await tool.execute({ title: 'Plan', content: '# Hi' }, { userId: 'u1' });

    expect(mockGDocs.createGoogleDoc).toHaveBeenCalledWith('Plan', '# Hi', 'u1', undefined, undefined, 'styled', undefined);
    expect(result).toBe(expected);
  });

  it('create_google_doc respects plain=true and maps style_options', async () => {
    mockGDocs.createGoogleDoc.mockResolvedValue({ success: true });

    const tool = emmaToolRegistry.getTool('create_google_doc')!;
    await tool.execute({
      title: 'Plan', content: 'Body', plain: true,
      style_options: { primary_color: '#fff', font_family: 'Georgia', font_size: 16, line_height: 1.4, compact: true },
    }, { userId: 'u1' });

    expect(mockGDocs.createGoogleDoc).toHaveBeenCalledWith('Plan', 'Body', 'u1', undefined, undefined, 'plain', {
      primaryColor: '#fff', fontFamily: 'Georgia', fontSize: 16, lineHeight: 1.4, compact: true,
    });
  });

  it('create_google_doc requires auth', async () => {
    const tool = emmaToolRegistry.getTool('create_google_doc')!;
    const result = await tool.execute({ title: 'Plan', content: 'Body' }, {});
    expect(result).toEqual({ success: false, message: 'Authentication required' });
    expect(mockGDocs.createGoogleDoc).not.toHaveBeenCalled();
  });

  it('update_google_doc defaults to plain (leaves existing styling alone)', async () => {
    const expected = { success: true, doc_id: 'd1' };
    mockGDocs.updateGoogleDoc.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('update_google_doc')!;
    const result = await tool.execute({ url_or_id: 'd1', content: 'New body' }, { userId: 'u1' });

    expect(mockGDocs.updateGoogleDoc).toHaveBeenCalledWith('d1', 'New body', 'u1', 'plain', undefined);
    expect(result).toBe(expected);
  });

  it('update_google_doc styles when style_options is given even without plain', async () => {
    mockGDocs.updateGoogleDoc.mockResolvedValue({ success: true });

    const tool = emmaToolRegistry.getTool('update_google_doc')!;
    await tool.execute({ url_or_id: 'd1', content: 'New body', style_options: { primary_color: '#000' } }, { userId: 'u1' });

    expect(mockGDocs.updateGoogleDoc).toHaveBeenCalledWith('d1', 'New body', 'u1', 'styled', {
      primaryColor: '#000', fontFamily: undefined, fontSize: undefined, lineHeight: undefined, compact: undefined,
    });
  });

  it('create_google_sheet forwards args and returns the result unchanged', async () => {
    const expected = { success: true, sheet_id: 's1' };
    mockGDocs.createGoogleSheet.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_google_sheet')!;
    const result = await tool.execute({ title: 'Data', data: [['a', 'b']] }, { userId: 'u1' });

    expect(mockGDocs.createGoogleSheet).toHaveBeenCalledWith('Data', [['a', 'b']], 'u1', undefined, undefined);
    expect(result).toBe(expected);
  });

  it('update_google_sheet forwards args and returns the result unchanged', async () => {
    const expected = { success: true, sheet_id: 's1' };
    mockGDocs.updateGoogleSheet.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('update_google_sheet')!;
    const result = await tool.execute({ url_or_id: 's1', range: 'Sheet1!A1', data: [['1']] }, { userId: 'u1' });

    expect(mockGDocs.updateGoogleSheet).toHaveBeenCalledWith('s1', 'Sheet1!A1', [['1']], 'u1');
    expect(result).toBe(expected);
  });

  it('update_google_sheet requires auth', async () => {
    const tool = emmaToolRegistry.getTool('update_google_sheet')!;
    const result = await tool.execute({ url_or_id: 's1', range: 'A1', data: [] }, undefined);
    expect(result).toEqual({ success: false, message: 'Authentication required' });
    expect(mockGDocs.updateGoogleSheet).not.toHaveBeenCalled();
  });
});
