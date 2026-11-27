/**
 * ENG-2103 (F2) — shared Google Drive access helpers.
 *
 * Extracted verbatim from `AgentModeService.prototype.*`. Two distinct Drive
 * identities are involved, both needed by more than one not-yet-fully-migrated
 * consumer, which is why they live here rather than solely inside
 * `emma/impl/googleDrive.ts`:
 *
 * - `getGoogleDriveOAuthClient` (the END USER's own connected Google account,
 *   write-capable): used by all 4 methods in `emma/impl/googleDrive.ts`
 *   (readGoogleFileById, listGoogleDriveFolder, createGoogleDriveFolder,
 *   searchGoogleDrive) AND by createGoogleDoc/updateGoogleDoc/createGoogleSheet/
 *   updateGoogleSheet, which remain `AgentModeService` methods for now (a
 *   separate, not-yet-extracted "Google Docs/Sheets" cluster — deferred because
 *   it pulls in a large markdown-to-Google-Docs-API conversion pipeline that is
 *   itself shared with `createHtmlFromTemplate`; extracting it needed its own
 *   pass rather than growing this one further).
 * - `getGoogleDriveClient` / `getGoogleDriveServiceAccountEmail` (AgentWeb's OWN
 *   service-account Drive access, read-only, used to read files/folders an
 *   admin registered for the knowledge base): used by `readGoogleFileById`
 *   (its OAuth-failure fallback) AND by the knowledge-base cluster's
 *   searchKnowledgeBase/listKnowledgeBaseFiles/readKnowledgeBaseFiles/
 *   materializeKnowledgeBaseAsset, all of which remain `AgentModeService`
 *   methods (a different, not-yet-extracted cluster).
 * - `readGoogleDriveFileContent` / `fetchDriveFileComments`: pure content
 *   readers, shared the same way as `getGoogleDriveClient` above.
 *
 * `AgentModeService.prototype.*` now delegates to these rather than duplicating
 * them, so every one of the callers listed above — moved or not — shares one
 * implementation.
 */
import { pdfPageRender } from './pdfTextRender';

/**
 * ENG-1858: AgentWeb's own service-account email, once resolved by
 * `getGoogleDriveClient`. A pure, process-lifetime cache (no per-user or
 * per-request scoping needed — it's the same service account for the whole
 * process) — promoted to a module-level singleton per the F2 design draft's
 * §3.2 treatment for pure caches, the same shape as F1's `runFundingStore`.
 */
let driveServiceAccountEmail: string | null = null;

/**
 * AgentWeb's OWN Google Drive service-account client (read-only) — used to
 * read files/folders an admin registered as a knowledge-base source, as
 * opposed to `getGoogleDriveOAuthClient` below (the end user's own connected
 * account).
 */
export async function getGoogleDriveClient() {
  // ENG-1277: lazy load. `googleapis` pulls in ~990 transitive modules that
  // every jest worker paid on `require()` of this file (1,023 of 1,388 test
  // files statically import agentModeService.ts) even when a test never
  // touches Drive/Sheets.
  const { google } = await import('googleapis');
  const { getSecret } = await import('../../../utils/secretsManager');
  const environment = process.env.NODE_ENV || 'development';
  const secretName = environment === 'production' ? 'prod/AgentWeb/Google/Share' : 'dev/AgentWeb/Google/Share';
  const credentials = JSON.parse(await getSecret(secretName));
  driveServiceAccountEmail = credentials.client_email || null;
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

export function getGoogleDriveServiceAccountEmail(): string {
  return driveServiceAccountEmail || 'the AgentWeb Google Drive service account';
}

/** Test hook: reset the resolved service-account email between test cases. */
export function __resetDriveServiceAccountEmailForTests(): void {
  driveServiceAccountEmail = null;
}

// ── Google Drive OAuth helpers (user-authenticated, write-capable) ──────────

export async function getGoogleDriveOAuthClient(userId: string) {
  const { getAccountByPlatform } = await import('../../../services/connectedAccountsDb');
  const account = await getAccountByPlatform(userId, 'google_drive');
  if (!account) {
    throw new Error('Google Drive not connected. Connect Google Drive in Settings → Connected Accounts.');
  }
  const cfg = account.config as any;
  const { getGoogleDriveConfig } = await import('../../../config/integrations');
  const driveConfig = await getGoogleDriveConfig();
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client(driveConfig.clientId, driveConfig.clientSecret);
  client.setCredentials({
    access_token: cfg.access_token,
    refresh_token: cfg.refresh_token,
    expiry_date: cfg.token_expires_at,
  });
  // Persist refreshed tokens back to DB — use updateAccountTokens to preserve all other account fields
  client.on('tokens', async (tokens) => {
    try {
      const { updateAccountTokens } = await import('../../../services/connectedAccountsDb');
      await updateAccountTokens(userId, 'google_drive', {
        access_token: tokens.access_token ?? cfg.access_token,
        refresh_token: tokens.refresh_token ?? cfg.refresh_token,
        token_expires_at: tokens.expiry_date ?? cfg.token_expires_at,
      }, cfg.email);
    } catch { /* best effort */ }
  });
  return client;
}

export async function fetchDriveFileComments(drive: any, fileId: string): Promise<string> {
  try {
    const resp = await drive.comments.list({
      fileId,
      fields: 'comments(content,quotedFileContent,author,replies,resolved,createdTime)',
      includeDeleted: false,
      pageSize: 100,
    });
    const comments: any[] = resp.data.comments || [];
    if (comments.length === 0) return '';
    const lines: string[] = ['\n\n--- COMMENTS & FEEDBACK ---'];
    for (const c of comments) {
      const author = c.author?.displayName || 'Unknown';
      const quote = c.quotedFileContent?.value ? ` [on: "${c.quotedFileContent.value}"]` : '';
      const resolved = c.resolved ? ' [resolved]' : '';
      lines.push(`\n[${author}]${quote}${resolved}: ${c.content}`);
      for (const reply of (c.replies || [])) {
        const rAuthor = reply.author?.displayName || 'Unknown';
        lines.push(`  ↳ [${rAuthor}]: ${reply.content}`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** ENG-2840: the largest Drive file read for its text (Emma keeps at most 1,000,000 characters of it). */
export const DRIVE_TEXT_READ_MAX_BYTES = 50 * 1024 * 1024;

export async function readGoogleDriveFileContent(drive: any, fileId: string, fileName: string, mimeType: string): Promise<string> {
  // ENG-2840: every download is a stream read with a byte ceiling (DRIVE_TEXT_READ_MAX_BYTES). Before, the whole file was buffered (and
  // a binary one then converted to base64) whatever its size, so naming a large video in a registered folder could exhaust the
  // process's memory. Drive's reported size can be missing, so it is not trusted.
  const { readWithByteCap } = await import('../../../utils/readWithByteCap');
  const { normalizeStreamedDriveError } = await import('./googleDriveErrors');
  const tooLarge = () => new Error(`"${fileName}" is larger than ${DRIVE_TEXT_READ_MAX_BYTES / (1024 * 1024)} MB, the most that can be read here`);
  const abort = new AbortController();
  const options = { responseType: 'stream', signal: abort.signal };
  const exportAs = (exportMime: string) => drive.files.export({ fileId, mimeType: exportMime }, options);

  // Google Workspace files need to be exported
  let res: any;
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      res = await exportAs('text/plain');
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      res = await exportAs('text/csv');
    } else if (mimeType === 'application/vnd.google-apps.presentation') {
      res = await exportAs('text/plain');
    } else {
      // Binary files — download directly
      res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, options);
    }
  } catch (err) {
    throw normalizeStreamedDriveError(err);
  }
  const read = await readWithByteCap(res?.data, DRIVE_TEXT_READ_MAX_BYTES, () => abort.abort());
  if (!read) throw tooLarge();
  const content: Buffer = read;

  const extension = (fileName.split('.').pop() || '').toLowerCase();

  if (extension === 'pdf' || mimeType === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const pdfData = await pdfParse(content, { pagerender: pdfPageRender });
    return pdfData.text || '';
  } else if (['xlsx', 'xls', 'xlsm', 'xlsb'].includes(extension) ||
    mimeType.includes('spreadsheetml') || mimeType.includes('ms-excel')) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(content, { type: 'buffer' });
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) {
        lines.push(`Sheet: ${sheetName}`);
        lines.push(csv);
      }
    }
    return lines.join('\n\n');
  } else if (['docx', 'doc'].includes(extension) ||
    mimeType.includes('wordprocessingml') || mimeType.includes('msword')) {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: content });
      return result.value || '';
    } catch {
      return content.toString('utf-8');
    }
  } else if (['txt', 'md', 'html', 'htm', 'csv', 'json', 'xml', 'log'].includes(extension) ||
    mimeType.startsWith('text/') ||
    mimeType.startsWith('application/vnd.google-apps.')) {
    return content.toString('utf-8');
  } else {
    return content.toString('base64');
  }
}
