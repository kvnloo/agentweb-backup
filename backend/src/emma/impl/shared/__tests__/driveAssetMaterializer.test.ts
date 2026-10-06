import {
  materializeResolvedDriveAsset,
  resolveNamedDriveFile,
  type DriveFileResolutionDeps,
} from '../driveAssetMaterializer';

const folder = { folderId: 'root', name: 'Root' };

function deps(overrides: Partial<DriveFileResolutionDeps> = {}): DriveFileResolutionDeps {
  return {
    getFolderTree: jest.fn().mockResolvedValue({
      folderIds: ['root'],
      restricted: [],
      rootRestricted: false,
      truncated: false,
      throttled: false,
      transientFailure: false,
      boundedStop: false,
      folderNames: new Map([['root', 'Root']]),
    }),
    queryFiles: jest.fn().mockResolvedValue({ files: new Map(), capped: false }),
    escapeQueryValue: (value) => value.replace(/'/g, "\\'"),
    incompleteMessage: (fileName, rootName) => `incomplete:${rootName}:${fileName}`,
    serviceAccountEmail: 'drive@example.com',
    ...overrides,
  };
}

describe('Drive named-file resolver', () => {
  it('fails closed before tree/query work for an unauthorized root', async () => {
    const d = deps();
    const result = await resolveNamedDriveFile({
      drive: {},
      folders: [],
      kbIdentifier: 'gdrive:root',
      fileName: 'asset.png',
      fields: 'files(id)',
      deps: d,
    });
    expect(result).toEqual({
      ok: false,
      result: { success: false, message: 'Not authorized to access this Google Drive folder' },
    });
    expect(d.getFolderTree).not.toHaveBeenCalled();
    expect(d.queryFiles).not.toHaveBeenCalled();
  });

  it('preserves incomplete-search truth instead of claiming absence', async () => {
    const d = deps({
      queryFiles: jest.fn().mockResolvedValue({ files: new Map(), capped: true }),
    });
    const result = await resolveNamedDriveFile({
      drive: {},
      folders: [folder],
      kbIdentifier: 'gdrive:root',
      fileName: 'asset.png',
      fields: 'files(id)',
      deps: d,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.message).toBe('incomplete:Root:asset.png');
  });

  it('rejects ambiguous names rather than choosing one', async () => {
    const d = deps({
      queryFiles: jest.fn().mockResolvedValue({
        files: new Map([
          ['a', { id: 'a', name: 'asset.png', parents: ['root'] }],
          ['b', { id: 'b', name: 'asset.png', parents: ['child'] }],
        ]),
        capped: false,
      }),
      getFolderTree: jest.fn().mockResolvedValue({
        folderIds: ['root', 'child'],
        restricted: [],
        rootRestricted: false,
        truncated: false,
        throttled: false,
        transientFailure: false,
        boundedStop: false,
        folderNames: new Map([['root', 'Root'], ['child', 'Child']]),
      }),
    });
    const result = await resolveNamedDriveFile({
      drive: {},
      folders: [folder],
      kbIdentifier: 'gdrive:root',
      fileName: 'asset.png',
      fields: 'files(id)',
      deps: d,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.message).toContain('Multiple files named');
  });
});

describe('Drive asset materializer', () => {
  it('checks downloaded bytes before upload', async () => {
    const uploadFile = jest.fn();
    const drive = {
      files: {
        get: jest.fn().mockResolvedValue({ data: Buffer.alloc(11) }),
      },
    };
    const result = await materializeResolvedDriveAsset({
      drive,
      file: { id: 'f1', name: 'asset.png', mimeType: 'image/png', size: '0' },
      fileName: 'asset.png',
      userId: 'u1',
      kbIdentifier: 'gdrive:root',
      maxBytes: 10,
      uploadFile,
    });
    expect(result.success).toBe(false);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
