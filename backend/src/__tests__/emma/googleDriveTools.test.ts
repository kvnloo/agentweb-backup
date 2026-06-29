/**
 * Tests for Emma Google Drive tools (defined in emma/tools.ts).
 * Tools: read_google_doc, list_google_drive_folder, create_google_drive_folder,
 *        create_google_doc, update_google_doc, create_google_sheet, update_google_sheet
 */

// ── Mocks BEFORE imports ─────────────────────────────────────────────────────

jest.mock('../../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/askCrmService', () => ({ askCrm: jest.fn(), AskCrmLead: {} }));
jest.mock('../../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../../routes/tasks', () => ({ getExecutionsWithAssets: jest.fn() }));
jest.mock('../../config', () => ({
  RESEND_SYSTEM_EMAIL: 'system@test.com',
  RESEND_SYSTEM_NAME: 'Test',
}));
jest.mock('../../services/dealDb', () => ({
  DEAL_STAGES: ['Lead'],
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  dealDb: {},
}));
jest.mock('../../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn() },
  normalizeContactId: (raw: string) => String(raw || '').trim().toLowerCase(),
  KNOWN_CONTACT_EVENT_TYPES: new Set(['manual.note']),
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(['form.submitted']),
}));
jest.mock('../../services/contactCaptureHooks', () => ({
  logManualEvent: jest.fn(),
  isKnownContactEventType: jest.fn(),
  onUserRegistered: jest.fn(),
  onOnboardingStageChanged: jest.fn(),
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));

const mockReadGoogleFileById = jest.fn();
const mockListGoogleDriveFolder = jest.fn();
const mockCreateGoogleDriveFolder = jest.fn();
const mockCreateGoogleDoc = jest.fn();
const mockUpdateGoogleDoc = jest.fn();
const mockCreateGoogleSheet = jest.fn();
const mockUpdateGoogleSheet = jest.fn();

jest.mock('../../services/agentModeService', () => ({
  agentModeService: {
    readGoogleFileById: (...a: any[]) => mockReadGoogleFileById(...a),
    listGoogleDriveFolder: (...a: any[]) => mockListGoogleDriveFolder(...a),
    createGoogleDriveFolder: (...a: any[]) => mockCreateGoogleDriveFolder(...a),
    createGoogleDoc: (...a: any[]) => mockCreateGoogleDoc(...a),
    updateGoogleDoc: (...a: any[]) => mockUpdateGoogleDoc(...a),
    createGoogleSheet: (...a: any[]) => mockCreateGoogleSheet(...a),
    updateGoogleSheet: (...a: any[]) => mockUpdateGoogleSheet(...a),
  },
}));

jest.mock('../../services/db', () => ({
  crmDb: { getLeadListsByUserId: jest.fn() },
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: {
    getMemories: jest.fn().mockResolvedValue([]),
    putMemory: jest.fn().mockResolvedValue(undefined),
    deleteMemory: jest.fn().mockResolvedValue(undefined),
  },
  orgMemoryDb: { getMemories: jest.fn().mockResolvedValue([]) },
}));

const toolMap = new Map<string, any>();
const mockRegistryInstance = {
  register: jest.fn((handler: any) => toolMap.set(handler.name, handler)),
  getTool: jest.fn((name: string) => toolMap.get(name)),
  getToolNames: jest.fn(() => Array.from(toolMap.keys())),
  getToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllToolDefinitions: jest.fn(() => Array.from(toolMap.values()).map((t: any) => t.definition)),
  getAllTools: jest.fn(() => Array.from(toolMap.values())),
};
jest.mock('../../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => mockRegistryInstance),
  mcpToolRegistry: mockRegistryInstance,
}));
jest.mock('../../mcp/server/apiTools', () => ({ adminToolNames: [] }));

import { emmaToolRegistry } from '../../emma/registry';

// ── Helpers ───────────────────────────────────────────────────────────────────

const USER = 'user-gdrive-test-1';

async function getTool(name: string) {
  await import('../../emma/tools');
  const tool = emmaToolRegistry.getTool(name);
  expect(tool).toBeDefined();
  return tool!;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── read_google_doc ──────────────────────────────────────────────────────────

describe('read_google_doc — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('read_google_doc');
    expect(tool.definition.name).toBe('read_google_doc');
  });

  it('schema requires url_or_id', async () => {
    const tool = await getTool('read_google_doc');
    expect(tool.definition.inputSchema.required).toContain('url_or_id');
  });
});

describe('read_google_doc — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('read_google_doc');
    const result = await tool.execute({ url_or_id: 'some-file-id' }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockReadGoogleFileById).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('read_google_doc');
    const result = await tool.execute({ url_or_id: 'some-file-id' }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockReadGoogleFileById).not.toHaveBeenCalled();
  });
});

describe('read_google_doc — URL parsing', () => {
  it('extracts fileId from full Google Docs URL', async () => {
    mockReadGoogleFileById.mockResolvedValue({ success: true, content: 'Doc content' });
    const tool = await getTool('read_google_doc');
    await tool.execute(
      { url_or_id: 'https://docs.google.com/document/d/abc123XYZ_-/edit' },
      { userId: USER },
    );
    expect(mockReadGoogleFileById).toHaveBeenCalledWith('abc123XYZ_-', USER);
  });

  it('uses the raw value as-is when no /d/<id> pattern is present', async () => {
    mockReadGoogleFileById.mockResolvedValue({ success: true, content: 'Doc content' });
    const tool = await getTool('read_google_doc');
    await tool.execute({ url_or_id: '  raw-file-id-42  ' }, { userId: USER });
    expect(mockReadGoogleFileById).toHaveBeenCalledWith('raw-file-id-42', USER);
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, content: 'Hello World', mimeType: 'application/vnd.google-apps.document' };
    mockReadGoogleFileById.mockResolvedValue(serviceResult);
    const tool = await getTool('read_google_doc');
    const result = await tool.execute(
      { url_or_id: 'https://docs.google.com/document/d/fileId99/view' },
      { userId: USER },
    );
    expect(result).toEqual(serviceResult);
  });

  it('extracts fileId from Google Sheets URL', async () => {
    mockReadGoogleFileById.mockResolvedValue({ success: true, content: '' });
    const tool = await getTool('read_google_doc');
    await tool.execute(
      { url_or_id: 'https://docs.google.com/spreadsheets/d/sheetId777/edit#gid=0' },
      { userId: USER },
    );
    expect(mockReadGoogleFileById).toHaveBeenCalledWith('sheetId777', USER);
  });
});

// ─── list_google_drive_folder ────────────────────────────────────────────────

describe('list_google_drive_folder — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('list_google_drive_folder');
    expect(tool.definition.name).toBe('list_google_drive_folder');
  });

  it('schema requires folder_url_or_id', async () => {
    const tool = await getTool('list_google_drive_folder');
    expect(tool.definition.inputSchema.required).toContain('folder_url_or_id');
  });
});

describe('list_google_drive_folder — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('list_google_drive_folder');
    const result = await tool.execute({ folder_url_or_id: 'folder-id-1' }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockListGoogleDriveFolder).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('list_google_drive_folder');
    const result = await tool.execute({ folder_url_or_id: 'folder-id-1' }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
  });
});

describe('list_google_drive_folder — delegation', () => {
  it('calls agentModeService.listGoogleDriveFolder with correct args', async () => {
    mockListGoogleDriveFolder.mockResolvedValue({ success: true, files: [] });
    const tool = await getTool('list_google_drive_folder');
    await tool.execute({ folder_url_or_id: 'folder-abc' }, { userId: USER });
    expect(mockListGoogleDriveFolder).toHaveBeenCalledWith('folder-abc', USER);
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, files: [{ id: 'f1', name: 'Report.docx' }] };
    mockListGoogleDriveFolder.mockResolvedValue(serviceResult);
    const tool = await getTool('list_google_drive_folder');
    const result = await tool.execute({ folder_url_or_id: 'folder-abc' }, { userId: USER });
    expect(result).toEqual(serviceResult);
  });

  it('passes a folder URL through to the service unchanged', async () => {
    mockListGoogleDriveFolder.mockResolvedValue({ success: true, files: [] });
    const tool = await getTool('list_google_drive_folder');
    const folderUrl = 'https://drive.google.com/drive/folders/FOLDER_ID_99';
    await tool.execute({ folder_url_or_id: folderUrl }, { userId: USER });
    expect(mockListGoogleDriveFolder).toHaveBeenCalledWith(folderUrl, USER);
  });

  it('passes service error through to caller', async () => {
    mockListGoogleDriveFolder.mockResolvedValue({ success: false, error: 'Folder not found' });
    const tool = await getTool('list_google_drive_folder');
    const result = await tool.execute({ folder_url_or_id: 'bad-folder' }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/folder not found/i);
  });
});

// ─── create_google_drive_folder ──────────────────────────────────────────────

describe('create_google_drive_folder — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('create_google_drive_folder');
    expect(tool.definition.name).toBe('create_google_drive_folder');
  });

  it('schema requires name', async () => {
    const tool = await getTool('create_google_drive_folder');
    expect(tool.definition.inputSchema.required).toContain('name');
  });
});

describe('create_google_drive_folder — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('create_google_drive_folder');
    const result = await tool.execute({ name: 'My Folder' }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockCreateGoogleDriveFolder).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('create_google_drive_folder');
    const result = await tool.execute({ name: 'My Folder' }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
  });
});

describe('create_google_drive_folder — delegation', () => {
  it('calls agentModeService.createGoogleDriveFolder with name, userId, and undefined parent', async () => {
    mockCreateGoogleDriveFolder.mockResolvedValue({ success: true, folderId: 'new-folder-1', url: 'https://drive.google.com/...' });
    const tool = await getTool('create_google_drive_folder');
    await tool.execute({ name: 'Campaigns 2026' }, { userId: USER });
    expect(mockCreateGoogleDriveFolder).toHaveBeenCalledWith('Campaigns 2026', USER, undefined);
  });

  it('passes parent_folder_id to the service when provided', async () => {
    mockCreateGoogleDriveFolder.mockResolvedValue({ success: true, folderId: 'child-folder', url: 'https://drive.google.com/...' });
    const tool = await getTool('create_google_drive_folder');
    await tool.execute({ name: 'Sub Folder', parent_folder_id: 'parent-99' }, { userId: USER });
    expect(mockCreateGoogleDriveFolder).toHaveBeenCalledWith('Sub Folder', USER, 'parent-99');
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, folderId: 'folder-xyz', url: 'https://drive.google.com/drive/folders/folder-xyz' };
    mockCreateGoogleDriveFolder.mockResolvedValue(serviceResult);
    const tool = await getTool('create_google_drive_folder');
    const result = await tool.execute({ name: 'Q1 Assets' }, { userId: USER });
    expect(result).toEqual(serviceResult);
  });

  it('passes service error through to caller', async () => {
    mockCreateGoogleDriveFolder.mockResolvedValue({ success: false, error: 'Drive not connected' });
    const tool = await getTool('create_google_drive_folder');
    const result = await tool.execute({ name: 'Fail Folder' }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/drive not connected/i);
  });
});

// ─── create_google_doc ────────────────────────────────────────────────────────

describe('create_google_doc — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('create_google_doc');
    expect(tool.definition.name).toBe('create_google_doc');
  });

  it('schema requires title and content', async () => {
    const tool = await getTool('create_google_doc');
    expect(tool.definition.inputSchema.required).toEqual(expect.arrayContaining(['title', 'content']));
  });
});

describe('create_google_doc — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('create_google_doc');
    const result = await tool.execute({ title: 'My Doc', content: 'Hello' }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockCreateGoogleDoc).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('create_google_doc');
    const result = await tool.execute({ title: 'My Doc', content: 'Hello' }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
  });
});

describe('create_google_doc — delegation', () => {
  it('calls agentModeService.createGoogleDoc with correct args (no optional params)', async () => {
    mockCreateGoogleDoc.mockResolvedValue({ success: true, url: 'https://docs.google.com/document/d/doc1/edit' });
    const tool = await getTool('create_google_doc');
    await tool.execute({ title: 'GTM Plan', content: 'Strategy content here' }, { userId: USER });
    expect(mockCreateGoogleDoc).toHaveBeenCalledWith('GTM Plan', 'Strategy content here', USER, undefined, undefined);
  });

  it('passes folder_id and share_with_emails to the service when provided', async () => {
    mockCreateGoogleDoc.mockResolvedValue({ success: true, url: 'https://docs.google.com/document/d/doc2/edit' });
    const tool = await getTool('create_google_doc');
    await tool.execute(
      {
        title: 'Team Brief',
        content: 'Content here',
        folder_id: 'folder-abc',
        share_with_emails: ['alice@co.com', 'bob@co.com'],
      },
      { userId: USER },
    );
    expect(mockCreateGoogleDoc).toHaveBeenCalledWith(
      'Team Brief',
      'Content here',
      USER,
      'folder-abc',
      ['alice@co.com', 'bob@co.com'],
    );
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, url: 'https://docs.google.com/document/d/doc3/edit', docId: 'doc3' };
    mockCreateGoogleDoc.mockResolvedValue(serviceResult);
    const tool = await getTool('create_google_doc');
    const result = await tool.execute({ title: 'Report', content: 'Data' }, { userId: USER });
    expect(result).toEqual(serviceResult);
  });

  it('passes service error through to caller', async () => {
    mockCreateGoogleDoc.mockResolvedValue({ success: false, error: 'Drive not connected' });
    const tool = await getTool('create_google_doc');
    const result = await tool.execute({ title: 'Fail Doc', content: 'x' }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/drive not connected/i);
  });
});

// ─── update_google_doc ────────────────────────────────────────────────────────

describe('update_google_doc — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('update_google_doc');
    expect(tool.definition.name).toBe('update_google_doc');
  });

  it('schema requires url_or_id and content', async () => {
    const tool = await getTool('update_google_doc');
    expect(tool.definition.inputSchema.required).toEqual(expect.arrayContaining(['url_or_id', 'content']));
  });
});

describe('update_google_doc — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('update_google_doc');
    const result = await tool.execute({ url_or_id: 'doc1', content: 'New content' }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockUpdateGoogleDoc).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('update_google_doc');
    const result = await tool.execute({ url_or_id: 'doc1', content: 'New content' }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
  });
});

describe('update_google_doc — delegation', () => {
  it('calls agentModeService.updateGoogleDoc with url_or_id, content, and userId', async () => {
    mockUpdateGoogleDoc.mockResolvedValue({ success: true });
    const tool = await getTool('update_google_doc');
    await tool.execute(
      { url_or_id: 'https://docs.google.com/document/d/docABC/edit', content: 'Updated content' },
      { userId: USER },
    );
    expect(mockUpdateGoogleDoc).toHaveBeenCalledWith(
      'https://docs.google.com/document/d/docABC/edit',
      'Updated content',
      USER,
    );
  });

  it('works with a raw file ID as url_or_id', async () => {
    mockUpdateGoogleDoc.mockResolvedValue({ success: true });
    const tool = await getTool('update_google_doc');
    await tool.execute({ url_or_id: 'raw-doc-id-555', content: 'Replaced content' }, { userId: USER });
    expect(mockUpdateGoogleDoc).toHaveBeenCalledWith('raw-doc-id-555', 'Replaced content', USER);
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, updatedAt: '2026-06-29T00:00:00Z' };
    mockUpdateGoogleDoc.mockResolvedValue(serviceResult);
    const tool = await getTool('update_google_doc');
    const result = await tool.execute({ url_or_id: 'doc1', content: 'x' }, { userId: USER });
    expect(result).toEqual(serviceResult);
  });

  it('passes service error through to caller', async () => {
    mockUpdateGoogleDoc.mockResolvedValue({ success: false, error: 'File not found' });
    const tool = await getTool('update_google_doc');
    const result = await tool.execute({ url_or_id: 'bad-id', content: 'x' }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file not found/i);
  });
});

// ─── create_google_sheet ─────────────────────────────────────────────────────

describe('create_google_sheet — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('create_google_sheet');
    expect(tool.definition.name).toBe('create_google_sheet');
  });

  it('schema requires title and data', async () => {
    const tool = await getTool('create_google_sheet');
    expect(tool.definition.inputSchema.required).toEqual(expect.arrayContaining(['title', 'data']));
  });
});

describe('create_google_sheet — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('create_google_sheet');
    const result = await tool.execute({ title: 'My Sheet', data: [['A', 'B']] }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockCreateGoogleSheet).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('create_google_sheet');
    const result = await tool.execute({ title: 'My Sheet', data: [] }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
  });
});

describe('create_google_sheet — delegation', () => {
  const SHEET_DATA = [['Name', 'Email', 'Score'], ['Alice', 'alice@co.com', '90']];

  it('calls agentModeService.createGoogleSheet with correct args (no optional params)', async () => {
    mockCreateGoogleSheet.mockResolvedValue({ success: true, url: 'https://docs.google.com/spreadsheets/d/sheet1/edit' });
    const tool = await getTool('create_google_sheet');
    await tool.execute({ title: 'Lead Scores', data: SHEET_DATA }, { userId: USER });
    expect(mockCreateGoogleSheet).toHaveBeenCalledWith('Lead Scores', SHEET_DATA, USER, undefined, undefined);
  });

  it('passes folder_id and share_with_emails to the service when provided', async () => {
    mockCreateGoogleSheet.mockResolvedValue({ success: true, url: 'https://docs.google.com/spreadsheets/d/sheet2/edit' });
    const tool = await getTool('create_google_sheet');
    await tool.execute(
      {
        title: 'Team Data',
        data: SHEET_DATA,
        folder_id: 'folder-xyz',
        share_with_emails: ['carol@co.com'],
      },
      { userId: USER },
    );
    expect(mockCreateGoogleSheet).toHaveBeenCalledWith(
      'Team Data',
      SHEET_DATA,
      USER,
      'folder-xyz',
      ['carol@co.com'],
    );
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, url: 'https://docs.google.com/spreadsheets/d/sheet3/edit', sheetId: 'sheet3' };
    mockCreateGoogleSheet.mockResolvedValue(serviceResult);
    const tool = await getTool('create_google_sheet');
    const result = await tool.execute({ title: 'Metrics', data: SHEET_DATA }, { userId: USER });
    expect(result).toEqual(serviceResult);
  });

  it('passes service error through to caller', async () => {
    mockCreateGoogleSheet.mockResolvedValue({ success: false, error: 'Quota exceeded' });
    const tool = await getTool('create_google_sheet');
    const result = await tool.execute({ title: 'Fail Sheet', data: [] }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/quota exceeded/i);
  });
});

// ─── update_google_sheet ─────────────────────────────────────────────────────

describe('update_google_sheet — registration', () => {
  it('is registered with correct name', async () => {
    const tool = await getTool('update_google_sheet');
    expect(tool.definition.name).toBe('update_google_sheet');
  });

  it('schema requires url_or_id, range, and data', async () => {
    const tool = await getTool('update_google_sheet');
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['url_or_id', 'range', 'data']),
    );
  });
});

describe('update_google_sheet — auth guard', () => {
  it('returns auth error when userId is missing', async () => {
    const tool = await getTool('update_google_sheet');
    const result = await tool.execute({ url_or_id: 'sheet1', range: 'Sheet1!A1', data: [['x']] }, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
    expect(mockUpdateGoogleSheet).not.toHaveBeenCalled();
  });

  it('returns auth error when context is undefined', async () => {
    const tool = await getTool('update_google_sheet');
    const result = await tool.execute({ url_or_id: 'sheet1', range: 'Sheet1!A1', data: [] }, undefined);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/authentication required/i);
  });
});

describe('update_google_sheet — delegation', () => {
  const RANGE = 'Sheet1!A1:C2';
  const DATA = [['Name', 'Email', 'Score'], ['Bob', 'bob@co.com', '85']];

  it('calls agentModeService.updateGoogleSheet with url_or_id, range, data, and userId', async () => {
    mockUpdateGoogleSheet.mockResolvedValue({ success: true, updatedCells: 6 });
    const tool = await getTool('update_google_sheet');
    await tool.execute(
      { url_or_id: 'https://docs.google.com/spreadsheets/d/sheetABC/edit', range: RANGE, data: DATA },
      { userId: USER },
    );
    expect(mockUpdateGoogleSheet).toHaveBeenCalledWith(
      'https://docs.google.com/spreadsheets/d/sheetABC/edit',
      RANGE,
      DATA,
      USER,
    );
  });

  it('works with a raw sheet ID as url_or_id', async () => {
    mockUpdateGoogleSheet.mockResolvedValue({ success: true, updatedCells: 3 });
    const tool = await getTool('update_google_sheet');
    await tool.execute({ url_or_id: 'raw-sheet-id-42', range: 'Sheet1!B2', data: [['v']] }, { userId: USER });
    expect(mockUpdateGoogleSheet).toHaveBeenCalledWith('raw-sheet-id-42', 'Sheet1!B2', [['v']], USER);
  });

  it('returns the service result to the caller', async () => {
    const serviceResult = { success: true, updatedCells: 12, updatedRange: RANGE };
    mockUpdateGoogleSheet.mockResolvedValue(serviceResult);
    const tool = await getTool('update_google_sheet');
    const result = await tool.execute({ url_or_id: 'sheet1', range: RANGE, data: DATA }, { userId: USER });
    expect(result).toEqual(serviceResult);
  });

  it('passes service error through to caller', async () => {
    mockUpdateGoogleSheet.mockResolvedValue({ success: false, error: 'Range out of bounds' });
    const tool = await getTool('update_google_sheet');
    const result = await tool.execute({ url_or_id: 'sheet1', range: 'ZZ9999', data: [] }, { userId: USER });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/range out of bounds/i);
  });
});
