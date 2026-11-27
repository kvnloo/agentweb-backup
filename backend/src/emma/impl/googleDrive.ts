/**
 * ENG-2103 (F2) — Google Drive tool cluster, extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * readGoogleFileById, listGoogleDriveFolder, createGoogleDriveFolder,
 * searchGoogleDrive. Third domain cluster after books/whitepapers and GTM
 * plans — the third of the 134 `agentModeService.<method>()` names
 * `emma/tools.ts` calls into (ENG-1816 F1's design draft, §2).
 *
 * Deliberately narrower than the "Google Workspace" candidate surveyed
 * (readGoogleFileById + these 3, but NOT createGoogleDoc/updateGoogleDoc/
 * createGoogleSheet/updateGoogleSheet): those four pull in a large
 * markdown-to-Google-Docs-API conversion pipeline (~600 lines of static
 * helpers: markdownToHtml, markdownToDocsRequests, lexMarkdown, buildDocBlocks,
 * parseInlineRuns, inlineToHtml) that is ALSO shared with
 * `createHtmlFromTemplate` (a different, not-yet-extracted cluster) — extracting
 * that pipeline deserves its own pass rather than growing this one further.
 * "Google Drive" (this file) still has real shared-helper coupling of its own
 * (see below), just less than the full 8-method candidate would have.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions.
 * `__tests__/agentModeService.googleDrive.test.ts` (3413 lines) calls
 * `service.<method>(...)` directly on a real instance (a real second caller
 * beyond `emma/tools.ts`, same discipline that found `routes/emmaApi.ts`'s
 * `/books*` endpoints for the books cluster and the direct-call test suite for
 * GTM plans), so the 4 class methods could not simply be deleted.
 *
 * Instance-state/shared-helper findings, all handled the same way — promoted to
 * `emma/impl/shared/*`, with `AgentModeService`'s own copies turned into thin
 * delegating methods rather than touched-and-rewritten call sites in the
 * KB/Docs-Sheets clusters that also use them (lower risk: zero other methods'
 * bodies needed to change):
 *  - `getGoogleDriveOAuthClient` (the end user's own connected Google account):
 *    shared with the not-yet-extracted Google Docs/Sheets cluster.
 *  - `getGoogleDriveClient` / `getGoogleDriveServiceAccountEmail` (AgentWeb's
 *    OWN service-account Drive access) and `readGoogleDriveFileContent` /
 *    `fetchDriveFileComments`: shared with the not-yet-extracted
 *    knowledge-base cluster. `getGoogleDriveClient` also held real mutable
 *    instance state (`this.driveServiceAccountEmail`, set as a side effect,
 *    read by the KB cluster's error messages) — promoted to a module-level
 *    singleton in `emma/impl/shared/googleDriveAccess.ts`, the same "pure
 *    cache" treatment F1's design draft §3.2 prescribes.
 *  - `escapeDriveQueryValue`, `driveErrorCode`, `driveThrottleRefusal` (module-
 *    level function and static helpers respectively): shared with the KB
 *    cluster (via `classifyDriveError`) AND the Docs/Sheets cluster.
 *
 * No metering/LLM calls exist anywhere in this cluster (grepped for
 * llmService, generateJSONContent, callLLM, meterUserUsage, currentRunFunding,
 * usageContext — zero matches), so there is nothing for the RunFunding/
 * billingUserId audit (F1 rounds 3-5's bug class) to find here.
 */
import {
  getGoogleDriveOAuthClient,
  getGoogleDriveClient,
  readGoogleDriveFileContent,
  fetchDriveFileComments,
} from './shared/googleDriveAccess';
import {
  escapeDriveQueryValue,
  driveErrorCode,
  driveThrottleRefusal,
} from './shared/googleDriveErrors';
import { auditSharedGoogleRead } from '../../services/sharedGoogleAudit';

export async function readGoogleFileById(fileId: string, userId: string): Promise<any> {
  // ENG-1277: lazy load — see getGoogleDriveClient() for why.
  const { google } = await import('googleapis');
  let drive: any;
  let usingOAuth = false;
  // Log-only (sharedGoogleAudit.ts): a read through the platform's shared service account for a file id nothing proves this caller owns.
  const auditSharedAccount = (reason: 'no_oauth' | 'oauth_denied', outcome: 'ok' | 'failed') =>
    auditSharedGoogleRead({ kind: 'drive-file', userId, ids: [fileId], source: 'readGoogleFileById', reason, outcome });
  try {
    const oauthClient = await getGoogleDriveOAuthClient(userId);
    drive = google.drive({ version: 'v3', auth: oauthClient });
    usingOAuth = true;
  } catch (e) {
    console.error('[AgentMode] getGoogleDriveOAuthClient failed, falling back to SA:', e);
    drive = await getGoogleDriveClient();
  }

  const readWithDrive = async (driveClient: any) => {
    const meta = await driveClient.files.get({ fileId, fields: 'id,name,mimeType,modifiedTime', supportsAllDrives: true });
    const { name, mimeType, modifiedTime } = meta.data;
    const isGoogleNative =
      mimeType === 'application/vnd.google-apps.document' ||
      mimeType === 'application/vnd.google-apps.spreadsheet';
    const [contentStr, commentsStr] = await Promise.all([
      readGoogleDriveFileContent(driveClient, fileId, name || fileId, mimeType || ''),
      isGoogleNative ? fetchDriveFileComments(driveClient, fileId) : Promise.resolve(''),
    ]);
    const combined = contentStr + commentsStr;
    const maxLen = 1_000_000;
    return {
      success: true,
      message: `Successfully read Google file "${name}"`,
      file_id: fileId,
      file_name: name,
      content: combined.length > maxLen ? combined.substring(0, maxLen) + '\n\n[Content truncated]' : combined,
      size: contentStr.length,
      type: mimeType,
      modifiedTime,
    };
  };

  try {
    const result = await readWithDrive(drive);
    if (!usingOAuth) auditSharedAccount('no_oauth', 'ok');
    return result;
  } catch (oauthErr: any) {
    if (!usingOAuth) auditSharedAccount('no_oauth', 'failed');
    // OAuth drive.file scope can't access files it didn't create — retry with SA
    if (usingOAuth && (oauthErr?.code === 403 || oauthErr?.status === 403 || oauthErr?.code === 401 || oauthErr?.status === 401)) {
      try {
        const saDrive = await getGoogleDriveClient();
        const saResult = await readWithDrive(saDrive);
        auditSharedAccount('oauth_denied', 'ok');
        return saResult;
      } catch (saErr: any) {
        auditSharedAccount('oauth_denied', 'failed');
        // ENG-1300: carry the real numeric HTTP status through so a clean
        // 401/403/404 classifies as auth/not_found instead of the generic
        // Error/bug fallback once toolResultError rebuilds an Error from the
        // message alone.
        const code = saErr?.code || saErr?.status;
        const is404 = code === 404;
        const msg = is404
          ? `File not found or not accessible. Share the file with the service account, or connect Google Drive in Settings for files you own.`
          : `Failed to read file: ${saErr instanceof Error ? saErr.message : 'Unknown error'}`;
        return { success: false, message: msg, code };
      }
    }
    const code = oauthErr?.code || oauthErr?.status;
    const is404 = code === 404;
    const msg = is404
      ? `File not found or you don't have access (fileId: ${fileId}).`
      : `Failed to read file: ${oauthErr instanceof Error ? oauthErr.message : 'Unknown error'}`;
    return { success: false, message: msg, code };
  }
}

export async function listGoogleDriveFolder(folderIdOrUrl: string, userId: string): Promise<any> {
  // ENG-1277: lazy load — see getGoogleDriveClient() for why.
  const { google } = await import('googleapis');
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    const drive = google.drive({ version: 'v3', auth });

    const folderIdFromUrl = folderIdOrUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
    const rawId = folderIdOrUrl.trim();
    const folderId = folderIdFromUrl ?? (/^[a-zA-Z0-9_-]+$/.test(rawId) ? rawId : null);
    if (!folderId) {
      return { success: false, message: 'Invalid folder ID or URL. Please provide a valid Google Drive folder URL or folder ID.' };
    }

    const resp = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken',
      orderBy: 'name',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = resp.data.files || [];
    const hasMore = !!resp.data.nextPageToken;

    if (files.length === 0) {
      return { success: true, message: 'Folder is empty.', files: [] };
    }

    const formatted = files.map(f => ({
      id: f.id,
      name: f.name,
      type: f.mimeType,
      url: f.webViewLink,
      modified: f.modifiedTime,
    }));

    return {
      success: true,
      message: `Found ${files.length} item(s) in folder.${hasMore ? ' (Showing first 100 — folder has more items.)' : ''}`,
      folder_id: folderId,
      files: formatted,
    };
  } catch (err: any) {
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(err);
    const throttled = driveThrottleRefusal(err);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Google Drive access denied. Your Google Drive connection may have expired — reconnect in Settings → Connected Accounts.', code };
    }
    if (code === 404) {
      return { success: false, message: 'Folder not found. Check the URL or ID and try again.', code };
    }
    return { success: false, message: err?.message || 'Failed to list folder contents', code };
  }
}

export async function createGoogleDriveFolder(name: string, userId: string, parentFolderId?: string): Promise<any> {
  // ENG-1277: lazy load — see getGoogleDriveClient() for why.
  const { google } = await import('googleapis');
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    const drive = google.drive({ version: 'v3', auth });

    const requestBody: any = { name, mimeType: 'application/vnd.google-apps.folder' };
    if (parentFolderId) requestBody.parents = [parentFolderId];

    const resp = await drive.files.create({ requestBody, fields: 'id,name,webViewLink' });
    const folderId = resp.data.id!;
    const folderUrl = resp.data.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;

    return { success: true, folder_id: folderId, folder_url: folderUrl, name: resp.data.name };
  } catch (err: any) {
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(err);
    const throttled = driveThrottleRefusal(err);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Cannot create folder in that location — Emma does not have access to the specified parent folder.', code };
    }
    if (code === 404) {
      return { success: false, message: 'Parent folder not found. Check the folder ID and try again.', code };
    }
    return { success: false, message: err?.message || 'Failed to create Google Drive folder', code };
  }
}

export async function searchGoogleDrive(query: string, userId: string, type?: string): Promise<any> {
  // ENG-1277: lazy load — see getGoogleDriveClient() for why.
  const { google } = await import('googleapis');
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    const drive = google.drive({ version: 'v3', auth });

    const namePart = `name contains '${escapeDriveQueryValue(query)}'`;
    const typePart = type === 'folder'
      ? ` and mimeType = 'application/vnd.google-apps.folder'`
      : type === 'file'
      ? ` and mimeType != 'application/vnd.google-apps.folder'`
      : '';
    const q = `${namePart}${typePart} and trashed = false`;

    const resp = await drive.files.list({
      q,
      // `nextPageToken` is requested so this read can tell a complete result from a capped
      // one. Without it the 20-row cap below was invisible and unknowable.
      fields: 'nextPageToken, files(id,name,mimeType,webViewLink,parents)',
      orderBy: 'modifiedTime desc',
      pageSize: 20,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = resp.data.files || [];
    /*
     * ENG-1584, same sentence, different edge.
     *
     * `Found ${n} item(s) matching "x"` off a hard `pageSize: 20` with no `nextPageToken`
     * requested reads as "these are all the matches" and means "these are the first 20". A
     * model that searches for a file, sees it missing, and reports it absent is the exact
     * failure that told a customer a protected ad did not exist. The sibling
     * `listGoogleDriveFolder` already reports `hasMore`; this read did not.
     *
     * Deliberately NOT drained into full pagination: a name-substring search is an
     * interactive lookup, not an inventory, and 20 newest-first matches is the right size.
     * The bound is fine — going UNANNOUNCED was the defect.
     */
    const hasMore = !!resp.data.nextPageToken;
    if (files.length === 0) {
      return {
        success: true,
        complete: !hasMore,
        message: hasMore
          ? `No items found in the first page of matches for "${query}", but MORE PAGES EXIST — this is not evidence that nothing matches. Narrow the query and search again.`
          : `No items found matching "${query}" (complete search).`,
        results: [],
      };
    }

    const results = files.map(f => ({
      id: f.id,
      name: f.name,
      type: f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : f.mimeType,
      url: f.webViewLink,
      parent_folder_ids: f.parents,
    }));

    // Completeness ahead of the payload — anything after `results` can fall outside the
    // sealed prefix the model reads once this result is offloaded.
    return {
      success: true,
      complete: !hasMore,
      ...(hasMore && { hasMore: true }),
      totalCount: results.length,
      message: hasMore
        ? `Found ${results.length} item(s) matching "${query}", but THIS LIST IS INCOMPLETE — Drive had more matches and the search stopped at its 20-item bound. Do NOT conclude a file is absent from Drive because it is not here. Narrow the query and search again.`
        : `Found ${results.length} item(s) matching "${query}" (complete list).`,
      results,
    };
  } catch (err: any) {
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(err);
    const throttled = driveThrottleRefusal(err);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Google Drive access denied. Ensure Drive is connected in Settings → Connected Accounts.', code };
    }
    return { success: false, message: err?.message || 'Failed to search Google Drive', code };
  }
}
