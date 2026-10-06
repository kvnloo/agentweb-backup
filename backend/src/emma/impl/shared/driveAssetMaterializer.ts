export interface AuthorizedDriveFolder {
  folderId: string;
  name?: string;
}

export interface DriveFolderTreeResult {
  folderIds: string[];
  restricted: Array<{ id: string; name: string }>;
  rootRestricted: boolean;
  truncated: boolean;
  throttled: boolean;
  transientFailure: boolean;
  boundedStop: boolean;
  folderNames: Map<string, string>;
}

export interface DriveQueryResult {
  files: Map<string, any>;
  capped: boolean;
  failed?: any;
}

export interface DriveFileResolutionDeps {
  getFolderTree(drive: any, rootFolderId: string): Promise<DriveFolderTreeResult>;
  queryFiles(
    drive: any,
    folderIds: string[],
    extraQuery: string,
    fields: string,
    perBatchTarget: number,
  ): Promise<DriveQueryResult>;
  escapeQueryValue(value: string): string;
  incompleteMessage(fileName: string, rootName: string, failed?: any): string;
  serviceAccountEmail: string;
}

export type NamedDriveFileResolution =
  | { ok: true; file: any; folderId: string; folderMeta: AuthorizedDriveFolder; rootName: string }
  | { ok: false; result: { success: false; message: string } };

export async function resolveNamedDriveFile(params: {
  drive: any;
  folders: AuthorizedDriveFolder[];
  kbIdentifier: string;
  fileName: string;
  fields: string;
  deps: DriveFileResolutionDeps;
}): Promise<NamedDriveFileResolution> {
  const { drive, folders, kbIdentifier, fileName, fields, deps } = params;
  const folderId = kbIdentifier.replace('gdrive:', '');
  const folderMeta = folders.find((folder) => folder.folderId === folderId);
  if (!folderMeta) {
    return { ok: false, result: { success: false, message: 'Not authorized to access this Google Drive folder' } };
  }

  const rootName = folderMeta.name || folderId;
  const tree = await deps.getFolderTree(drive, folderId);
  const query = await deps.queryFiles(
    drive,
    tree.folderIds,
    `name = '${deps.escapeQueryValue(fileName)}' and trashed = false`,
    fields,
    2,
  );
  const files = Array.from(query.files.values());

  if (files.length === 0) {
    if (tree.throttled) {
      return {
        ok: false,
        result: {
          success: false,
          message: `File "${fileName}" was not found, but Google Drive rate-limited the scan of folder "${rootName}", so the search did not finish. This is a temporary quota answer, NOT a permissions or size problem — nothing needs to be shared and narrowing will not help. Wait a minute and try again. Do NOT report the file as absent.`,
        },
      };
    }
    if (tree.rootRestricted) {
      return {
        ok: false,
        result: {
          success: false,
          message: `File "${fileName}" not found — the Google Drive folder "${rootName}" itself could not be accessed. Share it with ${deps.serviceAccountEmail} to allow access.`
            + (query.failed || query.capped ? ' The file search did not complete either, so this is not a confirmed absence.' : ''),
        },
      };
    }
    if (query.failed || query.capped) {
      return {
        ok: false,
        result: { success: false, message: deps.incompleteMessage(fileName, rootName, query.failed) },
      };
    }
    if (tree.restricted.length > 0) {
      const names = tree.restricted.map((entry) => `"${entry.name}"`).join(', ');
      return {
        ok: false,
        result: {
          success: false,
          message: `File "${fileName}" not found in Google Drive folder "${rootName}". Sub-folder(s) ${names} could not be accessed — share them with ${deps.serviceAccountEmail} to allow access.`,
        },
      };
    }
    if (tree.truncated) {
      return {
        ok: false,
        result: {
          success: false,
          message: `File "${fileName}" not found in Google Drive folder "${rootName}" — but the folder scan did not cover the whole tree, so this is not a confirmed absence. `
            + (tree.transientFailure && !tree.boundedStop
              ? 'A sub-folder read failed part-way, so retrying may well complete the scan.'
              : 'It stopped at a fixed folder-count or time bound, so a tree this size will stop in the same place every time. Do NOT retry this same call — narrow to a specific sub-folder, or ask the user for a direct Google Drive link.'),
        },
      };
    }
    return {
      ok: false,
      result: { success: false, message: `File "${fileName}" not found in Google Drive folder "${rootName}"` },
    };
  }

  if (files.length > 1) {
    const folderIdSet = new Set(tree.folderIds);
    const candidates = files.map((file) => {
      const parents = Array.isArray(file?.parents)
        ? file.parents.filter((parent: unknown): parent is string => typeof parent === 'string')
        : [];
      const parentId = parents.find((parent) => folderIdSet.has(parent)) ?? parents[0];
      const location = parentId === folderId
        ? rootName
        : (tree.folderNames.get(parentId) || parentId || 'an unresolved sub-folder');
      return `"${file?.name ?? fileName}" in "${location}"`;
    }).join(', ');
    return {
      ok: false,
      result: {
        success: false,
        message: `Multiple files named "${fileName}" found in Google Drive folder "${rootName}": ${candidates}. Use a more specific file name, or move the duplicates so names are unique.`,
      },
    };
  }

  return { ok: true, file: files[0], folderId, folderMeta, rootName };
}

export async function materializeResolvedDriveAsset(params: {
  drive: any;
  file: any;
  fileName: string;
  userId: string;
  kbIdentifier: string;
  maxBytes: number;
  uploadFile: (
    buffer: Buffer,
    fileName: string,
    userId: string,
    mimeType: string,
  ) => Promise<{ success: boolean; url?: string; error?: string }>;
}): Promise<any> {
  const { drive, file, fileName, userId, kbIdentifier, maxBytes, uploadFile } = params;
  const mimeType = typeof file?.mimeType === 'string' ? file.mimeType : '';
  if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
    return {
      success: false,
      message: `"${fileName}" is a ${mimeType || 'unknown type'} file. materialize_knowledge_base_asset only handles images/videos — use read_knowledge_base_files for text/document content.`,
    };
  }

  const metadataSize = typeof file?.size === 'string' ? Number.parseInt(file.size, 10) : 0;
  const size = Number.isFinite(metadataSize) ? metadataSize : 0;
  if (size > maxBytes) {
    return {
      success: false,
      message: `"${fileName}" is ${Math.round(size / (1024 * 1024))}MB, over the ${maxBytes / (1024 * 1024)}MB limit for asset materialization`,
    };
  }
  if (typeof file?.id !== 'string' || !file.id) {
    return { success: false, message: `Google Drive returned an invalid record for "${fileName}"` };
  }

  const mediaResponse = await drive.files.get(
    { fileId: file.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(mediaResponse.data as any);
  if (buffer.length > maxBytes) {
    return {
      success: false,
      message: `"${fileName}" is ${Math.round(buffer.length / (1024 * 1024))}MB, over the ${maxBytes / (1024 * 1024)}MB limit for asset materialization`,
    };
  }

  const hostedName = typeof file?.name === 'string' && file.name ? file.name : fileName;
  const upload = await uploadFile(buffer, hostedName, userId, mimeType);
  if (!upload.success || !upload.url) {
    return {
      success: false,
      message: upload.error || 'Failed to upload asset to S3',
      error: upload.error || 's3_upload_failed',
    };
  }
  return {
    success: true,
    message: `Materialized "${fileName}" from Google Drive as a hosted asset.`,
    url: upload.url,
    file_name: hostedName,
    mime_type: mimeType,
    size,
    kb_identifier: kbIdentifier,
  };
}
