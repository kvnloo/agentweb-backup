/**
 * ENG-2103 F2 — proves emma/tools.ts's Google Drive tool execute() bodies call
 * emma/impl/googleDrive.ts directly (not agentModeService.<method>) and
 * forward the result unchanged. Same pattern as emmaTools.books.test.ts /
 * emmaTools.gtmPlans.test.ts.
 */

jest.mock('../emma/impl/googleDrive', () => ({
  readGoogleFileById: jest.fn(),
  listGoogleDriveFolder: jest.fn(),
  createGoogleDriveFolder: jest.fn(),
  searchGoogleDrive: jest.fn(),
}));

// agentModeService.<driveMethod> must NOT be called by these tools anymore —
// mock the whole module so a regression (a call site accidentally left
// pointed at the class) would throw instead of silently succeeding against
// the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the Google Drive tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as googleDriveImpl from '../emma/impl/googleDrive';
import '../emma/tools';

const mockGDrive = googleDriveImpl as jest.Mocked<typeof googleDriveImpl>;

describe('Google Drive tool cluster delegates to emma/impl/googleDrive.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('read_google_doc extracts the file id from a URL and forwards it', async () => {
    const expected = { success: true, content: 'hello' };
    mockGDrive.readGoogleFileById.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('read_google_doc')!;
    const result = await tool.execute(
      { url_or_id: 'https://docs.google.com/document/d/ABC123/edit' },
      { userId: 'u1' }
    );

    expect(mockGDrive.readGoogleFileById).toHaveBeenCalledWith('ABC123', 'u1');
    expect(result).toBe(expected);
  });

  it('read_google_doc accepts a raw file id and requires auth', async () => {
    mockGDrive.readGoogleFileById.mockResolvedValue({ success: true });

    const tool = emmaToolRegistry.getTool('read_google_doc')!;
    const unauth = await tool.execute({ url_or_id: 'RAWID' }, {});
    expect(unauth).toEqual({ success: false, message: 'Authentication required' });
    expect(mockGDrive.readGoogleFileById).not.toHaveBeenCalled();

    await tool.execute({ url_or_id: 'RAWID' }, { userId: 'u1' });
    expect(mockGDrive.readGoogleFileById).toHaveBeenCalledWith('RAWID', 'u1');
  });

  it('google_drive action=search forwards query/type and returns the result unchanged', async () => {
    const expected = { success: true, results: [] };
    mockGDrive.searchGoogleDrive.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('google_drive')!;
    const result = await tool.execute({ action: 'search', query: 'report', type: 'file' }, { userId: 'u1' });

    expect(mockGDrive.searchGoogleDrive).toHaveBeenCalledWith('report', 'u1', 'file');
    expect(result).toBe(expected);
  });

  it('google_drive action=list forwards folder_url_or_id and returns the result unchanged', async () => {
    const expected = { success: true, files: [] };
    mockGDrive.listGoogleDriveFolder.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('google_drive')!;
    const result = await tool.execute({ action: 'list', folder_url_or_id: 'root' }, { userId: 'u1' });

    expect(mockGDrive.listGoogleDriveFolder).toHaveBeenCalledWith('root', 'u1');
    expect(result).toBe(expected);
  });

  it('google_drive action=create_folder forwards name/parent_folder_id and returns the result unchanged', async () => {
    const expected = { success: true, folder_id: 'f1' };
    mockGDrive.createGoogleDriveFolder.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('google_drive')!;
    const result = await tool.execute({ action: 'create_folder', name: 'New Folder', parent_folder_id: 'p1' }, { userId: 'u1' });

    expect(mockGDrive.createGoogleDriveFolder).toHaveBeenCalledWith('New Folder', 'u1', 'p1');
    expect(result).toBe(expected);
  });

  it('google_drive rejects an unknown action without calling any impl function', async () => {
    const tool = emmaToolRegistry.getTool('google_drive')!;
    const result = await tool.execute({ action: 'bogus' }, { userId: 'u1' });

    expect(result).toEqual({ success: false, message: 'Unknown action: bogus' });
    expect(mockGDrive.searchGoogleDrive).not.toHaveBeenCalled();
    expect(mockGDrive.listGoogleDriveFolder).not.toHaveBeenCalled();
    expect(mockGDrive.createGoogleDriveFolder).not.toHaveBeenCalled();
  });

  it('google_drive requires auth before dispatching to any action', async () => {
    const tool = emmaToolRegistry.getTool('google_drive')!;
    const result = await tool.execute({ action: 'search', query: 'x' }, {});

    expect(result).toEqual({ success: false, message: 'Authentication required' });
    expect(mockGDrive.searchGoogleDrive).not.toHaveBeenCalled();
  });
});
