/**
 * ENG-2103 F2 — proves emma/tools.ts's knowledge-base tool execute() bodies
 * call emma/impl/knowledgeBase.ts directly (not agentModeService.<method>)
 * and forward the result unchanged. Same pattern as
 * emmaTools.googleDrive.test.ts / emmaTools.leads.test.ts.
 */

jest.mock('../emma/impl/knowledgeBase', () => ({
  createKnowledgeBase: jest.fn(),
  updateKnowledgeBaseFile: jest.fn(),
  attachKnowledgeBaseFiles: jest.fn(),
  searchKnowledgeBase: jest.fn(),
  searchForeplayAds: jest.fn(),
  searchForeplayDiscovery: jest.fn(),
  listKnowledgeBaseFiles: jest.fn(),
  readKnowledgeBaseFiles: jest.fn(),
  materializeKnowledgeBaseAsset: jest.fn(),
  writeClickUpDoc: jest.fn(),
}));

// agentModeService.<kbMethod> must NOT be called by these tools anymore —
// mock the whole module so a regression (a call site accidentally left
// pointed at the class) would throw instead of silently succeeding against
// the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the knowledge-base tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as knowledgeBaseImpl from '../emma/impl/knowledgeBase';
import '../emma/tools';

const mockKb = knowledgeBaseImpl as jest.Mocked<typeof knowledgeBaseImpl>;

describe('Knowledge base tool cluster delegates to emma/impl/knowledgeBase.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('search_knowledge_base forwards query/max_results/userId and returns the result unchanged', async () => {
    const expected = { success: true, results: [] };
    mockKb.searchKnowledgeBase.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('search_knowledge_base')!;
    const result = await tool.execute({ query: 'pricing', max_results: 7 }, { userId: 'u1' });

    expect(mockKb.searchKnowledgeBase).toHaveBeenCalledWith('pricing', 7, 'u1');
    expect(result).toBe(expected);
  });

  it('search_ads_knowledge_base (default/swipefile source) forwards to searchForeplayAds', async () => {
    const expected = { success: true, results: [], totalResults: 0 };
    mockKb.searchForeplayAds.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('search_ads_knowledge_base')!;
    const result = await tool.execute({ query: 'checkout', max_results: 3 }, { userId: 'u1' });

    expect(mockKb.searchForeplayAds).toHaveBeenCalledWith('checkout', 3, 'u1');
    expect(mockKb.searchForeplayDiscovery).not.toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it('search_ads_knowledge_base (source=discovery) forwards to searchForeplayDiscovery with options', async () => {
    const expected = { success: true, results: [], totalResults: 0, cursor: 'next' };
    mockKb.searchForeplayDiscovery.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('search_ads_knowledge_base')!;
    const result = await tool.execute(
      {
        source: 'discovery',
        query: 'skincare',
        company_name: 'Acme',
        max_results: 15,
        cursor: 'abc',
        format: ['video'],
        platform: ['facebook'],
        niche: ['beauty'],
        live: true,
        sort: 'newest',
      },
      { userId: 'u1' }
    );

    expect(mockKb.searchForeplayDiscovery).toHaveBeenCalledWith(
      'skincare',
      {
        maxResults: 15,
        companyName: 'Acme',
        cursor: 'abc',
        format: ['video'],
        platform: ['facebook'],
        niche: ['beauty'],
        live: true,
        sort: 'newest',
      },
      'u1'
    );
    expect(mockKb.searchForeplayAds).not.toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  it('list_knowledge_base_files forwards userId and options and returns the result unchanged', async () => {
    const expected = { success: true, knowledge_bases: [] };
    mockKb.listKnowledgeBaseFiles.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('list_knowledge_base_files')!;
    const result = await tool.execute(
      { modified_after: '2026-01-01', modified_before: '2026-02-01', limit: 10, offset: 0, kb_type: 'google-drive' },
      { userId: 'u1' }
    );

    expect(mockKb.listKnowledgeBaseFiles).toHaveBeenCalledWith('u1', {
      modified_after: '2026-01-01',
      modified_before: '2026-02-01',
      limit: 10,
      offset: 0,
      kb_type: 'google-drive',
    });
    expect(result).toBe(expected);
  });

  it('read_knowledge_base_files forwards files/userId and returns the result unchanged', async () => {
    const expected = { success: true, files: [] };
    mockKb.readKnowledgeBaseFiles.mockResolvedValue(expected);

    const files = [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }];
    const tool = emmaToolRegistry.getTool('read_knowledge_base_files')!;
    const result = await tool.execute({ files }, { userId: 'u1' });

    expect(mockKb.readKnowledgeBaseFiles).toHaveBeenCalledWith(files, 'u1');
    expect(result).toBe(expected);
  });

  it('materialize_knowledge_base_asset forwards kb_identifier/file_name/userId and returns the result unchanged', async () => {
    const expected = { success: true, url: 'https://s3/asset.png' };
    mockKb.materializeKnowledgeBaseAsset.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('materialize_knowledge_base_asset')!;
    const result = await tool.execute({ kb_identifier: 'gdrive:folder-1', file_name: 'ad.png' }, { userId: 'u1' });

    expect(mockKb.materializeKnowledgeBaseAsset).toHaveBeenCalledWith('gdrive:folder-1', 'ad.png', 'u1');
    expect(result).toBe(expected);
  });

  it('create_knowledge_base requires user/session context and forwards args otherwise', async () => {
    const tool = emmaToolRegistry.getTool('create_knowledge_base')!;

    await expect(tool.execute({ name: 'KB', content: 'hi' }, { userId: 'u1' })).rejects.toThrow(
      'Missing user or session context'
    );
    expect(mockKb.createKnowledgeBase).not.toHaveBeenCalled();

    const expected = { success: true, taskId: 't1' };
    mockKb.createKnowledgeBase.mockResolvedValue(expected);
    const result = await tool.execute(
      { name: 'KB', content: 'hi', knowledgeBaseType: 'public' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockKb.createKnowledgeBase).toHaveBeenCalledWith('KB', 'hi', 'public', 'u1', 's1');
    expect(result).toBe(expected);
  });

  it('update_knowledge_base_file requires user/session context and forwards args otherwise', async () => {
    const tool = emmaToolRegistry.getTool('update_knowledge_base_file')!;

    await expect(
      tool.execute({ taskId: 't1', fileName: 'knowledge-base.txt', content: 'hi' }, { userId: 'u1' })
    ).rejects.toThrow('Missing user or session context');
    expect(mockKb.updateKnowledgeBaseFile).not.toHaveBeenCalled();

    const expected = { success: true };
    mockKb.updateKnowledgeBaseFile.mockResolvedValue(expected);
    const result = await tool.execute(
      { taskId: 't1', fileName: 'knowledge-base.txt', content: 'hi', mode: 'replace' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockKb.updateKnowledgeBaseFile).toHaveBeenCalledWith('t1', 'knowledge-base.txt', 'hi', 'replace', 'u1', 's1');
    expect(result).toBe(expected);
  });

  it('attach_knowledge_base_files requires user/session context and forwards args otherwise', async () => {
    const tool = emmaToolRegistry.getTool('attach_knowledge_base_files')!;
    const files = [{ name: 'notes.txt', content: 'hi' }];

    await expect(tool.execute({ taskId: 't1', files }, { userId: 'u1' })).rejects.toThrow(
      'Missing user or session context'
    );
    expect(mockKb.attachKnowledgeBaseFiles).not.toHaveBeenCalled();

    const expected = { success: true, files: [] };
    mockKb.attachKnowledgeBaseFiles.mockResolvedValue(expected);
    const result = await tool.execute({ taskId: 't1', files }, { userId: 'u1', sessionId: 's1' });

    expect(mockKb.attachKnowledgeBaseFiles).toHaveBeenCalledWith('t1', files, 'u1', 's1');
    expect(result).toBe(expected);
  });

  it('write_clickup_doc requires user context and forwards args otherwise', async () => {
    const tool = emmaToolRegistry.getTool('write_clickup_doc')!;

    await expect(
      tool.execute({ workspace_id: 'ws-1', name: 'Doc', content: 'body' }, {})
    ).rejects.toThrow('Missing user context');
    expect(mockKb.writeClickUpDoc).not.toHaveBeenCalled();

    const expected = { success: true, message: 'ok', docId: 'doc-1' };
    mockKb.writeClickUpDoc.mockResolvedValue(expected);
    const result = await tool.execute(
      { workspace_id: 'ws-1', name: 'Doc', content: 'body', parent_doc_id: 'parent-1' },
      { userId: 'u1' }
    );

    expect(mockKb.writeClickUpDoc).toHaveBeenCalledWith('ws-1', 'Doc', 'body', 'u1', 'parent-1');
    expect(result).toBe(expected);
  });
});
