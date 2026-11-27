/**
 * ENG-2103 (F2) — knowledge base tool cluster, extracted from `AgentModeService`.
 * The eleventh and largest domain-cluster extraction in this series, and the
 * last non-trivial one (what remains after this is `createHtmlFromTemplate`,
 * already flagged/excluded across rounds 5 and 9 for its own `this.callLLM`
 * coupling — a design decision, not a mechanical move).
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * createKnowledgeBase, updateKnowledgeBaseFile, attachKnowledgeBaseFiles (a
 * non-contiguous trio living ~8,500 lines away from the rest of the cluster —
 * confirmed real Emma tools via `emma/tools.ts`, not moved with the others
 * originally only because of where they happened to sit in the file),
 * searchKnowledgeBase, searchForeplayAds, searchForeplayDiscovery,
 * listKnowledgeBaseFiles, readKnowledgeBaseFiles, readSingleKnowledgeBaseFile
 * (the kb_identifier-prefix dispatcher), materializeKnowledgeBaseAsset,
 * writeClickUpDoc, plus the private Drive-folder-walk/ClickUp/Foreplay readers
 * those public methods call: classifyDriveError, the retry/timeout/throttle
 * helpers (DRIVE_LIST_WALK_MAX_MS, DRIVE_REQUEST_TIMEOUT_FLOOR_MS,
 * driveRequestTimeout, isTransientDriveError, withDriveRetry,
 * driveRequestOptions), getGoogleDriveFolderTreeIds, DRIVE_FOLDER_QUERY_BATCH_SIZE,
 * queryDriveFilesAcrossFolders, getUserGoogleDriveFolders,
 * driveNameSearchIncompleteMessage, readGoogleDriveSharedFile,
 * MATERIALIZE_ASSET_MAX_BYTES, readClickUpSharedDoc, readClickUpTask, and
 * readForeplayAd (itself a second non-contiguous piece — physically sitting
 * right after the not-yet-... now already-extracted Google Docs/Sheets
 * delegates, confirmed to have exactly one caller,
 * readSingleKnowledgeBaseFile's dispatch, before moving it). Also moved:
 * `validateDriveDateFilter`, a module-scope (not class) function defined near
 * the top of agentModeService.ts with `listKnowledgeBaseFiles` as its only
 * caller anywhere in the backend.
 *
 * `readKnowledgeBaseFile` (singular, the flexible `"kb::file"` /
 * `{kb_identifier,file_name}` identifier parser) was in the candidate list but
 * is DELETED outright, not moved: a whole-backend grep found it has zero
 * callers anywhere — not `emma/tools.ts`, not `routes/emmaApi.ts`, not a
 * single test file. Same treatment round 4 gave ~600 lines of confirmed-dead
 * markdown-pipeline code — deleted rather than relocated as an unreachable
 * stub.
 *
 * Three Meta-ads helpers happen to sit inside this cluster's contiguous line
 * range purely by file layout accident and are functionally unrelated —
 * confirmed by grep and deliberately left untouched on the class:
 * `remedyFromScopeRefusal` and `maskMetaIds` (ad-account scope-refusal /
 * Graph-error-id masking, called only from Meta ad-listing code) and
 * `optionalScopeId` (a model-supplied-scope-id sanitizer whose only two real
 * callers are `listMetaAdsCampaignsNew`/`listMetaAdsAdSets`, nowhere in this
 * cluster's own Drive/ClickUp/Foreplay code despite its doc comment sitting
 * beside the Drive walk helpers).
 *
 * The four `private static driveErrorReasons/isDriveThrottle/driveErrorCode/
 * driveThrottleRefusal` delegates immediately above `classifyDriveError` in
 * the source are NOT moved: their own doc comment says they're shared with
 * `emma/impl/googleDrive.ts` (already extracted) AND
 * createGoogleDoc/updateGoogleDoc/createGoogleSheet/updateGoogleSheet (now
 * also already extracted, to `emma/impl/googleDocsSheets.ts`, which still
 * references them as `AgentModeService.driveErrorCode(...)` etc.) — kept as
 * class statics so that cluster's call sites keep working. This cluster's own
 * `classifyDriveError` imports the underlying `shared/googleDriveErrors.ts`
 * functions directly instead of going through those class statics.
 *
 * All 10 public methods keep a one-line delegating wrapper on
 * `AgentModeService.prototype` rather than being deleted — every one of them
 * has a real caller beyond `emma/tools.ts`:
 *   - createKnowledgeBase / updateKnowledgeBaseFile / attachKnowledgeBaseFiles:
 *     routes/emmaApi.ts (POST /create-knowledge-base, /update-knowledge-base-file,
 *     /attach-knowledge-base-files) AND direct-instance test files.
 *     updateKnowledgeBaseFile has a THIRD real caller:
 *     services/onboardingDesignSystemService.ts calls
 *     `agentModeService.updateKnowledgeBaseFile(...args)` directly.
 *   - searchKnowledgeBase / searchForeplayAds / searchForeplayDiscovery /
 *     listKnowledgeBaseFiles / readKnowledgeBaseFiles: routes/emmaApi.ts AND
 *     direct-instance test files (`agentModeService.googleDrive.test.ts`,
 *     `agentModeService.searchKnowledgeBase.test.ts`,
 *     `agentModeService.knowledgeBaseFiles.test.ts`, etc.). (The apparent
 *     `this.searchKnowledgeBase(...)` hits in `services/growthGeniusService.ts`
 *     and `controllers/growthGeniusController.ts` are a DIFFERENT class's own
 *     same-named method — verified by reading both files, not real callers of
 *     this one.)
 *   - materializeKnowledgeBaseAsset / writeClickUpDoc: no route exists for
 *     either, but both have dozens of direct-instance calls in
 *     `agentModeService.googleDrive.test.ts` /
 *     `agentModeService.clickupKnowledgeBase.test.ts`.
 *   - readSingleKnowledgeBaseFile / readClickUpSharedDoc / readClickUpTask /
 *     readForeplayAd (all private/dispatcher-only, no `emma/tools.ts` entry at
 *     all): kept delegating solely because
 *     `agentModeService.readKBOrgAware.test.ts`,
 *     `agentModeService.clickupKnowledgeBase.test.ts`,
 *     `agentModeService.googleDrive.test.ts`, and
 *     `agentModeService.foreplay.test.ts` call them directly on a real
 *     instance via `(agentModeService as any).<method>(...)`.
 *
 * Transitive-import handling:
 *   - `searchPlatformKnowledgeBase` is the KNOWN trap named in this round's
 *     brief: `chatbotService.ts` constructs a real AWS DynamoDB client at
 *     module scope and has a circular import back to `agentModeService.ts`.
 *     Lazily `await import('../../services/chatbotService')`'d inside
 *     `searchKnowledgeBase` only, matching `shared/toolUsageMetering.ts`'s
 *     worked example.
 *   - `taskDb` (from `services/db.ts`) and `getGCSPPrivateKey` (from
 *     `utils/secretsManager.ts`) both construct real AWS clients at module
 *     scope the same way `chatbotService.ts` does (confirmed by reading both
 *     files: `db.ts` line ~56 is `const dynamodb = new AWS.DynamoDB.DocumentClient()`;
 *     `secretsManager.ts` is `const secretsManager = new AWS.SecretsManager(...)`).
 *     Every prior cluster in this series avoids a static top-level import of
 *     `services/db.ts` (confirmed: zero matches across all of `emma/impl/*.ts`),
 *     so both are lazily `await import()`'d inside each function that needs
 *     them, matching that established convention rather than this cluster's
 *     own class code (which imported both eagerly at the top of the 470KB
 *     class file — a cost already paid there regardless of this extraction).
 *     `userDb`/`orgDb` (also from `db.ts`) and `isFeatureEffectivelyEnabled`/
 *     `canViewItem` (from `orgShareService.ts`) were ALREADY lazily
 *     `await import()`'d in the original class code; kept exactly as-is, only
 *     the relative path changed (`./db` → `../../services/db`,
 *     `./orgShareService` → `../../services/orgShareService`) because the
 *     code now lives one directory deeper.
 *   - `clickupService.ts` and `foreplayService.ts` (used by the ClickUp/
 *     Foreplay readers) are statically imported at the top of this module.
 *     Both transitively import `services/db.ts` themselves already (for
 *     `userDb`/`orgDb`), so importing them here carries no NEW transitive
 *     exposure beyond what they already carry on their own — confirmed by
 *     `npm run typecheck` passing clean with the static imports in place.
 *   - `Storage` (`@google-cloud/storage`) is statically imported, matching the
 *     original class's own top-level import — instantiating it is deferred to
 *     call time (`new Storage({...})` inside each function, exactly as
 *     before), and the class already paid this import's cost eagerly, so
 *     there is no marginal cost to also declaring it here.
 *
 * No `this.callLLM` (or the generateImage→describeImage→callVisionLLM→callLLM
 * chain) coupling anywhere in this cluster — grepped for llmService,
 * generateJSONContent, callLLM, meterUserUsage, currentRunFunding, and
 * billingUserId and found zero matches, confirming Manan's own pre-check
 * before this round started.
 */
import { truncateToolContent } from '../../utils/surrogateSafeCut';
import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import {
  getAccessToken as getClickUpAccessToken,
  getWorkspaces as getClickUpWorkspaces,
  listDocs as listClickUpDocs,
  readDocContent as readClickUpDocContent,
  listTasks as listClickUpTasks,
  readTaskContent as readClickUpTaskContent,
  createDoc as createClickUpDoc,
  createPageInDoc as createClickUpPageInDoc,
  listSpaces as listClickUpSpaces,
  listFolders as listClickUpFolders,
} from '../../services/clickupService';
import {
  getAccessToken as getForeplayAccessToken,
  listBoards as listForeplayBoards,
  getAllBoardAds as getAllForeplayBoardAds,
  getSwipefileAds as getForeplaySwipefileAds,
  searchDiscoveryAds as searchForeplayDiscoveryAds,
  formatAdAsMarkdown as formatForeplayAdAsMarkdown,
  ForeplayAd,
} from '../../services/foreplayService';
import {
  getGoogleDriveClient,
  getGoogleDriveServiceAccountEmail,
  readGoogleDriveFileContent,
  fetchDriveFileComments,
} from './shared/googleDriveAccess';
import {
  escapeDriveQueryValue,
  driveErrorCode,
  isDriveThrottle,
  driveThrottleRefusal,
} from './shared/googleDriveErrors';
import { pdfPageRender } from './shared/pdfTextRender';
import * as googleDriveImpl from './googleDrive';

/**
 * Validate a model-supplied Drive date filter, returning the `YYYY-MM-DD` day it names.
 *
 * `modified_after`/`modified_before` reach `list_knowledge_base_files` as a bare
 * `type: "string"` with no schema constraint and no validation anywhere, and were interpolated
 * UNESCAPED into the same `q` as the parent-folder clause. Drive's `or` binds looser than `and`,
 * so `modified_after = "2020-01-01' or name != 'x"` ORs the parent scoping away and matches
 * everything the query can see — and the Drive client is a SHARED service account holding
 * `drive.readonly`, so that is other tenants' file names, ids, sizes and modifiedTimes.
 *
 * Escaping alone would fix the injection. Validating as well is what stops the OTHER failure:
 * a value that is merely malformed (a full ISO datetime, say) produced
 * `'2026-04-15T10:00:00ZT00:00:00'` and an opaque Drive 400 rather than a usable error.
 *
 * Deliberately strict — a calendar day, which is the only shape the caller then wraps in
 * `T00:00:00`/`T23:59:59`. Anything else is refused with the expected format named, rather than
 * guessed at.
 */
function validateDriveDateFilter(value: string, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(
      `${label} must be a calendar date in YYYY-MM-DD form (e.g. "2026-04-15"); received ${JSON.stringify(value)}.`,
    );
  }
  // Rejects 2026-02-31 and friends: Date normalises them, so round-tripping is the check.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real calendar date: ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Create a new knowledge base (task) with initial content
 * Used by create_knowledge_base tool
 */
export async function createKnowledgeBase(
  name: string,
  content: string,
  knowledgeBaseType: 'public' | 'private',
  userId: string,
  sessionId: string
): Promise<any> {
  try {
    console.log(`[createKnowledgeBase] name=${name}, type=${knowledgeBaseType}, userId=${userId}`);

    // 1. Input validation
    if (!name || name.trim().length === 0) {
      return {
        success: false,
        message: 'Knowledge base name cannot be empty',
        error: 'Invalid input: empty name'
      };
    }

    if (!content || content.trim().length === 0) {
      return {
        success: false,
        message: 'Content cannot be empty',
        error: 'Invalid input: empty content'
      };
    }

    const MAX_KB_SIZE = 10 * 1024 * 1024; // 10MB
    const contentSize = Buffer.byteLength(content, 'utf8');
    if (contentSize > MAX_KB_SIZE) {
      return {
        success: false,
        message: `Content too large (${Math.round(contentSize / 1024 / 1024)}MB). Maximum size is 10MB.`,
        error: 'Content exceeds size limit'
      };
    }

    // 2. Create the task
    const { taskDb } = await import('../../services/db');
    const taskId = uuidv4();
    const now = new Date().toISOString();
    await taskDb.createTask({
      taskId,
      userId,
      name: name.trim(),
      prompt: '',
      status: 'active',
      createdAt: now,
      useKnowledgeBase: true,
      updateKnowledgeBase: true,
      knowledgeBaseType,
    });

    // 3. Initialize GCS and upload content
    const { getGCSPPrivateKey } = await import('../../utils/secretsManager');
    const privateKey = await getGCSPPrivateKey();
    const storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey
      }
    });

    const bucketName = knowledgeBaseType === 'public'
      ? (process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev')
      : (process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev');

    const bucket = storage.bucket(bucketName);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);

    await file.save(content, {
      contentType: 'text/plain',
      metadata: {
        taskId,
        userId,
        sessionId,
        updatedAt: now
      }
    });

    // 4. Get signed URL
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500'
    });

    // 5. Update task with KB metadata
    // Use max(contentSize, 1) so that size=0 never silently excludes this KB from search results.
    // The actual content is in GCS; size=0 is a stale-metadata bug, not an empty file.
    const sizeToStore = Math.max(contentSize, 1);
    await taskDb.updateTask(taskId, {
      knowledgeBaseSize: sizeToStore,
      knowledgeBase: url,
      knowledgeBaseUpdatedAt: now
    });

    return {
      success: true,
      taskId,
      name: name.trim(),
      message: `Knowledge base "${name.trim()}" created successfully`
    };

  } catch (error) {
    console.error('[createKnowledgeBase] Error:', error);
    return {
      success: false,
      message: 'Failed to create knowledge base',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Update a specific file in a task's knowledge base
 * Used by update_knowledge_base_file tool
 */
export async function updateKnowledgeBaseFile(
  taskId: string,
  fileName: string,
  content: string,
  mode: 'replace' | 'append',
  userId: string,
  sessionId: string
): Promise<any> {
  try {
    console.log(`[updateKnowledgeBaseFile] taskId=${taskId}, fileName=${fileName}, mode=${mode}, userId=${userId}`);

    // 1. Input validation
    if (!content || content.trim().length === 0) {
      return {
        success: false,
        message: 'Content cannot be empty',
        error: 'Invalid input: empty content'
      };
    }

    const MAX_KB_SIZE = 10 * 1024 * 1024; // 10MB
    const contentSize = Buffer.byteLength(content, 'utf8');
    if (contentSize > MAX_KB_SIZE) {
      return {
        success: false,
        message: `Content too large (${Math.round(contentSize / 1024 / 1024)}MB). Maximum size is 10MB.`,
        error: 'Content exceeds size limit'
      };
    }

    if (!taskId || taskId.trim().length === 0) {
      return {
        success: false,
        message: 'Task ID is required',
        error: 'Invalid input: missing taskId'
      };
    }

    if (!fileName || fileName.trim().length === 0) {
      return {
        success: false,
        message: 'File name is required',
        error: 'Invalid input: missing fileName'
      };
    }

    // 2. Get task and check authorization
    const { taskDb } = await import('../../services/db');
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return {
        success: false,
        message: 'Task not found',
        error: 'Task not found'
      };
    }

    if (task.userId !== userId) {
      return {
        success: false,
        message: 'Not authorized to modify this task',
        error: 'Unauthorized'
      };
    }

    // 3. Initialize GCS
    const { getGCSPPrivateKey } = await import('../../utils/secretsManager');
    const privateKey = await getGCSPPrivateKey();
    const storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey
      }
    });

    // 4. Determine bucket based on knowledgeBaseType
    const knowledgeBaseType = task.knowledgeBaseType || 'private';
    const bucketName = knowledgeBaseType === 'public'
      ? (process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev')
      : (process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev');

    const bucket = storage.bucket(bucketName);

    // 5. Determine file path based on fileName
    let filePath: string;
    let isMainKB = false;

    if (fileName === 'knowledge-base.txt') {
      // Main knowledge base file
      filePath = `tasks/${taskId}/knowledge-base.txt`;
      isMainKB = true;
    } else {
      // Look up in knowledgeBaseFiles array
      const kbFiles = task.knowledgeBaseFiles || [];
      const existingFile = kbFiles.find((f: any) => f.filename === fileName);
      if (existingFile) {
        filePath = existingFile.key;
      } else {
        // Create new file under knowledge-base-files/
        const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        filePath = `tasks/${taskId}/knowledge-base-files/${Date.now()}_${sanitizedName}`;
      }
    }

    const file = bucket.file(filePath);

    // 6. Handle append mode - read existing content
    let finalContent = content;
    if (mode === 'append') {
      try {
        const [existingContent] = await file.download();
        finalContent = existingContent.toString() + '\n\n' + content;
      } catch (error: any) {
        const errorMessage = error.message?.toLowerCase() || '';
        const isNotFound = error.code === 404 ||
          errorMessage.includes('no such object') ||
          errorMessage.includes('not found') ||
          errorMessage.includes('does not exist');

        if (isNotFound) {
          console.log(`[updateKnowledgeBaseFile] No existing file ${fileName} for task ${taskId}, creating new`);
        } else {
          console.error(`[updateKnowledgeBaseFile] Error downloading existing file:`, error);
          throw error;
        }
      }
    }

    // 7. Save content to GCS
    await file.save(finalContent, {
      contentType: 'text/plain',
      metadata: {
        taskId,
        userId,
        sessionId,
        fileName,
        updatedAt: new Date().toISOString()
      }
    });

    // 8. Get signed URL
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500'
    });

    // 9. Update DynamoDB
    const finalSize = Buffer.byteLength(finalContent, 'utf8');
    const now = new Date().toISOString();

    if (isMainKB) {
      await taskDb.updateTask(taskId, {
        knowledgeBaseSize: Math.max(finalSize, 1),
        knowledgeBase: url,
        knowledgeBaseUpdatedAt: now
      });
    } else {
      // Update or add entry in knowledgeBaseFiles array
      const kbFiles = task.knowledgeBaseFiles || [];
      const existingIdx = kbFiles.findIndex((f: any) => f.filename === fileName);
      const fileEntry = {
        filename: fileName,
        size: finalSize,
        url,
        key: filePath,
        uploadedAt: now,
      };
      if (existingIdx >= 0) {
        kbFiles[existingIdx] = fileEntry;
      } else {
        kbFiles.push(fileEntry);
      }
      // Calculate total size from all files
      const totalSize = kbFiles.reduce((sum: number, f: any) => sum + (f.size || 0), 0);
      await taskDb.updateTask(taskId, {
        knowledgeBaseFiles: kbFiles,
        knowledgeBaseSize: Math.max(totalSize, 1),
        knowledgeBaseUpdatedAt: now
      });
    }

    return {
      success: true,
      message: `File "${fileName}" ${mode === 'append' ? 'updated' : 'replaced'} successfully`,
      fileName,
      updatedSize: finalSize,
      updatedAt: now
    };

  } catch (error) {
    console.error('[updateKnowledgeBaseFile] Error:', error);
    return {
      success: false,
      message: 'Failed to update knowledge base file',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

const ATTACH_FILE_SHAPE = '{"name": "design.md", "content": "..."}';

type AttachFile = { name: string; content: string };

/**
 * Validates the model-supplied `files` argument. Only top-level `required` is enforced by the tool
 * schema, so per-file shape must be checked here. `error` (not `message`) is what the model sees on a
 * failed result, so it must name the fix.
 */
function normalizeAttachFiles(
  raw: unknown
): { files: AttachFile[] } | { message: string; error: string } {
  let files = raw;
  // Models sometimes serialize the array as a JSON string.
  if (typeof files === 'string') {
    try { files = JSON.parse(files); } catch { /* reported by the array check below */ }
  }
  if (files != null && !Array.isArray(files)) {
    return {
      message: 'files must be an array',
      error: `Invalid input: files must be an array of ${ATTACH_FILE_SHAPE} objects`
    };
  }
  if (!files || files.length === 0) {
    return { message: 'At least one file is required', error: 'Invalid input: empty files array' };
  }

  const result: AttachFile[] = [];
  for (const [i, entry] of files.entries()) {
    const f = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    // Models often reuse update_knowledge_base_file's `fileName` key; accept the aliases.
    const name = f.name || f.fileName || f.file_name || f.filename;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        message: `File #${i + 1} has no name`,
        error: `Invalid input: file #${i + 1} is missing "name" - each file must be ${ATTACH_FILE_SHAPE}`
      };
    }
    if (typeof f.content !== 'string' || f.content.trim().length === 0) {
      return {
        message: `File "${name}" has empty content`,
        error: `Invalid input: empty file content for "${name}" - put the text in a non-empty string "content" field`
      };
    }
    result.push({ name, content: f.content });
  }
  return { files: result };
}

/**
 * Attach multiple files to a task's knowledge base
 * Used by attach_knowledge_base_files tool
 */
export async function attachKnowledgeBaseFiles(
  taskId: string,
  files: unknown,
  userId: string,
  sessionId: string
): Promise<any> {
  try {
    // 1. Input validation
    if (!taskId || taskId.trim().length === 0) {
      return {
        success: false,
        message: 'Task ID is required',
        error: 'Invalid input: missing taskId'
      };
    }

    const normalized = normalizeAttachFiles(files);
    if ('error' in normalized) {
      return { success: false, message: normalized.message, error: normalized.error };
    }
    const attachFiles = normalized.files;
    console.log(`[attachKnowledgeBaseFiles] taskId=${taskId}, filesCount=${attachFiles.length}, userId=${userId}`);

    // 2. Get task and check authorization
    const { taskDb } = await import('../../services/db');
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return {
        success: false,
        message: 'Task not found',
        error: 'Task not found'
      };
    }

    if (task.userId !== userId) {
      return {
        success: false,
        message: 'Not authorized to modify this task',
        error: 'Unauthorized'
      };
    }

    // 3. Initialize GCS
    const { getGCSPPrivateKey } = await import('../../utils/secretsManager');
    const privateKey = await getGCSPPrivateKey();
    const storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey
      }
    });

    const knowledgeBaseType = task.knowledgeBaseType || 'private';
    const bucketName = knowledgeBaseType === 'public'
      ? (process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev')
      : (process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev');

    const bucket = storage.bucket(bucketName);
    const kbFiles = task.knowledgeBaseFiles || [];
    const uploadedFiles: Array<{ name: string; size: number; url: string }> = [];

    // 4. Upload each file
    for (const f of attachFiles) {
      const sanitizedName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `tasks/${taskId}/knowledge-base-files/${Date.now()}_${sanitizedName}`;
      const file = bucket.file(filePath);
      const now = new Date().toISOString();
      const size = Buffer.byteLength(f.content, 'utf8');

      await file.save(f.content, {
        contentType: 'text/plain',
        metadata: {
          taskId,
          userId,
          sessionId,
          fileName: f.name,
          updatedAt: now
        }
      });

      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-01-2500'
      });

      kbFiles.push({
        filename: f.name,
        size,
        url,
        key: filePath,
        uploadedAt: now,
      });

      uploadedFiles.push({ name: f.name, size, url });
    }

    // 5. Calculate total size and update DynamoDB
    const totalSize = kbFiles.reduce((sum: number, f: any) => sum + (f.size || 0), 0);
    await taskDb.updateTask(taskId, {
      knowledgeBaseFiles: kbFiles,
      knowledgeBaseSize: Math.max(totalSize, 1),
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });

    return {
      success: true,
      message: `${uploadedFiles.length} file(s) attached successfully`,
      files: uploadedFiles
    };

  } catch (error) {
    console.error('[attachKnowledgeBaseFiles] Error:', error);
    return {
      success: false,
      message: 'Failed to attach knowledge base files',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * ENG-1624: classify a Drive failure into a short, safe reason for a
 * model-visible payload. Never put the raw error object (or its message)
 * there — mirrors metaService.ts's drainCursor, which deliberately doesn't
 * log/surface FacebookRequestError objects because a paged Graph URL carries
 * the access token in its query string; a Drive error can carry similarly
 * sensitive request context. The full error is still logged server-side by
 * the caller, same as before — only this classified string reaches the model.
 */
function classifyDriveError(err: any): string {
  const code = driveErrorCode(err);
  if ((code === 403 || code === 401) && isDriveThrottle(err)) return 'rate limited';
  if (code === 403 || code === 401) return 'permission denied';
  if (code === 429) return 'rate limited';
  if (code === 400) return 'invalid request';
  /*
   * Both timeout shapes. `did not respond within` is `metaService.withReadDeadline`'s wording
   * and no Drive call can produce it — a Drive request timeout comes from node-fetch as
   * `network timeout at: <url>`, so this branch was dead for the very calls it was added for
   * and every one of them fell through to the generic "temporary Drive error".
   */
  if (typeof err?.message === 'string' && /did not respond within|network timeout at/i.test(err.message)) {
    return 'temporary Drive error (timed out)';
  }
  return 'temporary Drive error';
}

/**
 * ENG-1624: getGoogleDriveFolderTreeIds bounds folder COUNT (maxFolders) and
 * queryDriveFilesAcrossFolders bounds per-batch file COUNT (perBatchTarget),
 * but neither bounded elapsed TIME — both await Drive list calls sequentially,
 * so a large or slow-to-respond tree/query was many serial round-trips with no
 * deadline. Same shape as metaService.ts's META_LIST_MAX_MS / drainCursor: a
 * count bound limits WORK, not TIME, when calls are awaited one at a time.
 *
 * A Drive list call here fetches only id+name (folder discovery) or a handful
 * of scalar fields (file listing) with no nested expansions, so it's a much
 * lighter call than a Meta ad-list page with `creative{...}` expansion —
 * intentionally far short of Meta's 45s: long enough that an ordinary
 * customer's tree (tens of folders) finishes in a fraction of it, short
 * enough that a pathological or throttled tree can't visibly stall a turn.
 * Crossing it sets `truncated`/`capped` — the same "incomplete, do not
 * conclude absence" signal the count bounds already use, not a new failure
 * mode.
 *
 * ⚠ Raised from 15s. The reasoning above is sound about the SHAPE of the calls and wrong about
 * the consequence of stopping: an incomplete read is not a free outcome. It is what makes the
 * agent say "that file is not in your Drive" about a folder it only partly looked at — the
 * ENG-1584 sentence, on the Drive side. The tree is not too large to read; we were not giving
 * it long enough, exactly as the launch pre-flight was not.
 *
 * 15s bought a snappier turn at the cost of a wrong answer. 90s reads an ordinary customer's
 * tree comfortably and a large one completely, still finishes far inside nginx/ALB's 600s, and
 * costs nothing at all in the common case — it is a deadline, not a delay, so a tree that
 * takes two seconds still takes two seconds.
 */
export const DRIVE_LIST_WALK_MAX_MS = 90_000;

/**
 * ENG-1476 follow-up: per-REQUEST deadline, derived from the walk-wide one rather than fixed.
 *
 * `DRIVE_LIST_WALK_MAX_MS` is checked BETWEEN requests, so it bounds how many calls the walk
 * makes but cannot interrupt one already issued that never answers — Node's fetch applies no
 * default deadline. Same reasoning as `metaService`'s `withReadDeadline` sitting alongside
 * `META_LIST_MAX_MS`: an elapsed bound limits the WORK, a per-call timeout is what stops a
 * single stalled read from holding the turn.
 *
 * Deliberately the REMAINING walk budget, not a fixed ceiling. A fixed value (10s was the
 * first attempt) is arbitrary in both directions: too low fails a legitimately slow call that
 * the walk still had time for — a read that used to succeed now errors — and too high is
 * meaningless, since the walk stops at its own deadline anyway. Deriving it means a request
 * can use exactly the time the walk still has and no more, so this can never fail a call the
 * walk would not have abandoned regardless.
 *
 * googleapis' `MethodOptions` extends gaxios' `GaxiosOptions`, so `timeout` is accepted as the
 * SECOND argument to a method. The floor keeps a near-expired budget from sending `timeout: 0`,
 * which gaxios reads as "no timeout".
 */
const DRIVE_REQUEST_TIMEOUT_FLOOR_MS = 1_000;

function driveRequestTimeout(deadline: number): number {
  return Math.max(DRIVE_REQUEST_TIMEOUT_FLOOR_MS, deadline - Date.now());
}

/**
 * Per-request options for a Drive call inside a walk: the remaining budget as a timeout, AND
 * the retries turned off.
 *
 * `timeout` alone bounds nothing here. `googleapis-common/apirequest.js:263` sets
 * `options.retry = true` by default, and gaxios only skips retrying an `AbortError` — a
 * node-fetch request timeout raises a `FetchError`, so `noResponseRetries: 2` applies and one
 * logical request is issued THREE times, each with the full timeout. Measured: 1 attempt /
 * ~1.0s with retry off, 3 attempts / ~3.6s with googleapis' default against a server that
 * accepts and never responds. A 15s walk budget became ~45s, and `readGoogleDriveSharedFile`
 * does this twice in sequence.
 *
 * (Bare gaxios and google-auth-library's DefaultTransporter do NOT retry, so probing those
 * says the timeout is fine. It is the googleapis layer that turns retries on.)
 *
 * Retrying is also wrong on its own terms: the budget is what is running out, so a second and
 * third attempt spend time the walk does not have and triple Drive quota use on exactly the
 * calls most likely to be near a limit.
 */
/** A Drive failure worth one more attempt: transport-level, not an answer from Drive. */
function isTransientDriveError(err: any): boolean {
  const code = driveErrorCode(err);
  if (code !== undefined && code < 500) return false;           // 4xx is an answer, not a blip
  if (code !== undefined && code >= 500) return true;           // 5xx
  const msg = typeof err?.message === 'string' ? err.message : '';
  return /network timeout at|econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed/i.test(msg);
}

/**
 * One retry for a transient Drive failure — but only if a full second attempt still fits
 * inside the walk's remaining budget.
 *
 * Turning googleapis' retries off was necessary (it reused the SAME timeout on each of three
 * attempts, so one hung request cost 3× the budget) but it also removed the cheap win: a
 * single dropped connection used to be absorbed and now surfaces as an incomplete read. This
 * restores that without the overrun, because the decision is made against `deadline` and the
 * second attempt's timeout is recomputed from what is actually left.
 *
 * Deliberately not retrying 4xx: a 403, 404 or a throttle is Drive ANSWERING, and repeating
 * the question does not change the answer — it just spends budget the walk needs.
 */
async function withDriveRetry<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    if (!isTransientDriveError(err)) throw err;
    // A second attempt must fit whole; a sliver of budget buys nothing but another timeout.
    if (Date.now() + DRIVE_REQUEST_TIMEOUT_FLOOR_MS >= deadline) throw err;
    console.log('AgentMode: retrying a transient Drive failure once within the walk budget:', err?.message);
    return await run();
  }
}

function driveRequestOptions(deadline: number): { timeout: number; retryConfig: { noResponseRetries: number } } {
  return {
    timeout: driveRequestTimeout(deadline),
    retryConfig: { noResponseRetries: 0 },
  };
}

// ENG-1624: a registered gdrive: KB folder is authorized by its root ID only, but
// every Drive query in this file was scoped to `'<folderId>' in parents` — direct
// children only. A file living in a sub-folder (any depth) of a registered root
// resolved as not-found, and the sub-folder itself as "Not authorized" (our own
// flat allowlist check, not a real Google permission failure). This walks the
// folder tree from a registered root so callers can search/list across the whole
// tree instead of just its direct children. `restricted` surfaces sub-folders that
// couldn't be listed (e.g. an unshared shortcut target) so callers can give an
// actionable error instead of a bare "not found". `rootRestricted` is the same
// signal for the registered root itself — kept separate from `restricted` so it
// isn't reported to the caller as if it were a sub-folder found underneath itself.
// `truncated` is set when the `maxFolders` bound stops the walk before the whole
// tree was covered, so a caller can say "incomplete" instead of asserting absence.
async function getGoogleDriveFolderTreeIds(
  drive: any,
  rootFolderId: string,
  maxFolders: number = 500
): Promise<{
  folderIds: string[];
  restricted: Array<{ id: string; name: string }>;
  rootRestricted: boolean;
  /**
   * The walk stopped because Drive THROTTLED it, not because the tree was too large.
   *
   * Kept distinct from `truncated` because the two need opposite sentences: a large tree tells
   * the user to narrow the search, a quota answer tells them to wait. Folding a throttle into
   * `truncated` is what made a rate-limited read report "the folder tree is large enough that
   * the scan stopped" about a folder with four files in it.
   */
  throttled: boolean;
  /**
   * The walk stopped short because a sub-folder read FAILED transiently, as opposed to hitting
   * the folder-count bound or the wall clock.
   *
   * `truncated` alone cannot carry this: two of its three causes are deterministic — the same
   * tree stops in the same place every time — so a message telling the model to "retry, a
   * sub-folder may have failed transiently" was advice that could not work for two of them,
   * and the retryable classification meant each futile attempt re-walked the whole budget.
   */
  transientFailure: boolean;
  /**
   * The walk hit a deterministic bound — the folder-count ceiling or the wall clock.
   *
   * Not exclusive with `transientFailure`, and correlated with it: `withDriveRetry` spends
   * budget on a transient failure, which makes the clock more likely to run out in the same
   * walk. A walk with both must NOT advise a retry, because the bound will stop it in the same
   * place next time — verified by probe: a transport failure on one child followed by the
   * folder-count ceiling sets both flags.
   */
  boundedStop: boolean;
  truncated: boolean;
  folderNames: Map<string, string>;
}> {
  const folderIdSet = new Set<string>([rootFolderId]);
  const folderIds: string[] = [rootFolderId];
  const folderNames = new Map<string, string>();
  const queue: string[] = [rootFolderId];
  const restricted: Array<{ id: string; name: string }> = [];
  let rootRestricted = false;
  let throttled = false;
  let transientFailure = false;
  let boundedStop = false;
  let truncated = false;
  /*
   * "The walk is incomplete" and "stop walking" are DIFFERENT facts, and conflating them cost
   * the whole tree.
   *
   * `truncated` is what the caller is told; `stopWalk` is what ends the loop. Only two things
   * genuinely mean there is no point continuing: the wall-clock deadline, and the maxFolders
   * bound (both apply to the walk as a whole). A transient failure on ONE sub-folder applies
   * to that sub-folder alone — the 403/401 branch below has always taken that view, skipping
   * the folder and walking on. Setting `truncated` from the error branch made the loop
   * condition `!truncated` abandon the entire BFS, so a single 502 on sub-folder 3 of 40 left
   * the remaining 37 unvisited, with the same "incomplete" signal a much smaller gap produces.
   */
  let stopWalk = false;
  const deadline = Date.now() + DRIVE_LIST_WALK_MAX_MS;

  while (queue.length > 0 && !stopWalk) {
    if (Date.now() >= deadline) {
      truncated = true;
      boundedStop = true;
      stopWalk = true;
      break;
    }
    const current = queue.shift()!;
    let pageToken: string | undefined;
    do {
      if (Date.now() >= deadline) {
        truncated = true;
        boundedStop = true;
        stopWalk = true;
        break;
      }
      let resp: any;
      try {
        // Each request carries its own deadline (see driveRequestTimeout): the loop-level
        // check above only runs BEFORE a request starts, so it cannot interrupt one already
        // in flight. A failure here is caught below and reported as an incomplete walk.
        // Options built INSIDE the closure so a retry recomputes its timeout from the budget
        // actually remaining, rather than reusing the first attempt's.
        resp = await withDriveRetry(deadline, () => drive.files.list({
          q: `'${current}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 1000,
          ...(pageToken && { pageToken }),
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }, driveRequestOptions(deadline)));
      } catch (err: any) {
        const code = driveErrorCode(err);
        /*
         * A THROTTLED 403 is not an access decision, so it must not land in the permission
         * buckets: `rootRestricted`/`restricted` are what produce "share it with the service
         * account", and telling a rate-limited user to share an already-shared folder is a
         * remedy that cannot work. Falls through to the incomplete-walk branch below, whose
         * "the walk did not finish, retry" is the correct answer for a quota answer.
         */
        if (isDriveThrottle(err)) throttled = true;
        if ((code === 403 || code === 401) && !isDriveThrottle(err)) {
          if (current === rootFolderId) {
            rootRestricted = true;
          } else {
            restricted.push({ id: current, name: folderNames.get(current) || current });
          }
        } else {
          /*
           * Not a permission answer — a timeout or transport failure. The walk did not finish,
           * so the tree is partial and every conclusion drawn from it is provisional. Without
           * this, a fired per-request timeout left `truncated` false and a caller reported a
           * definitive "file not found" from a search that never completed.
           *
           * Records the incompleteness WITHOUT ending the walk (see `stopWalk` above): the
           * other 39 sub-folders can still be listed, and a partial tree covering 39 of 40 is
           * worth far more than one covering 2.
           */
          truncated = true;
          transientFailure = true;
        }
        console.log(`AgentMode: Could not list subfolders of Drive folder ${current}:`, err);
        break;
      }

      for (const f of resp.data.files || []) {
        if (!f.id || folderIdSet.has(f.id)) continue;
        if (folderIds.length >= maxFolders) {
          truncated = true;
          boundedStop = true;
          stopWalk = true;
          break;
        }
        folderIdSet.add(f.id);
        folderIds.push(f.id);
        if (f.name) folderNames.set(f.id, f.name);
        queue.push(f.id);
      }

      pageToken = stopWalk ? undefined : (resp.data.nextPageToken || undefined);
    } while (pageToken);
  }

  return { folderIds, restricted, rootRestricted, truncated, throttled, transientFailure, boundedStop, folderNames };
}

// ENG-1624: `'<id>' in parents` clauses joined with OR grow ~52 chars per Drive
// id (33-char id + boilerplate). `q` travels as a URL query parameter, so a
// 500-folder tree building one query risks a 400/414 from Drive rather than
// degrading gracefully. Chunk into batches and merge results de-duplicated by
// file id — a file with multiple parents can legitimately appear in more than
// one batch.
const DRIVE_FOLDER_QUERY_BATCH_SIZE = 50;

// ENG-1624 rework: this used to fetch a single page per batch (pageSize
// pageSizePerBatch, no nextPageToken follow-through), so a batch holding more
// matches than that one page silently dropped the rest. `perBatchTarget` is now
// pursued via in-batch pagination — following nextPageToken — until either the
// batch is genuinely exhausted or `perBatchTarget` items have been accumulated
// FOR THAT BATCH. The target is deliberately per-batch, not a budget shared
// across batches: each batch is fetched with the same `orderBy`, so the
// per-batch top-K is a superset of what the true global top-K could need from
// that batch — a shared budget would let one batch starve another and return
// the wrong page contents, not just a wrong total. `capped` reports whether any
// batch stopped at its target with more available, i.e. whether the merged
// result can be trusted as exhaustive.
async function queryDriveFilesAcrossFolders(
  drive: any,
  folderIds: string[],
  extraClause: string,
  fields: string,
  perBatchTarget: number,
  orderBy?: string,
  /**
   * A budget SHARED with the caller, when the caller makes several of these calls in sequence.
   *
   * Without it each call opens its own `DRIVE_LIST_WALK_MAX_MS`, which composes badly: the
   * knowledge-base listing runs one query per registered Drive source in a sequential loop, so
   * six sources meant six full budgets — 6 x 90s = 540s on top of the tree walk, past the 600s
   * nginx/ALB ceiling the budget was chosen to sit inside. At the old 15s that overrun was
   * invisible (6 x 15s); raising the budget is what made it reachable.
   */
  sharedDeadlineAt?: number,
): Promise<{ files: Map<string, any>; capped: boolean; incomplete: boolean; failed?: any }> {
  const merged = new Map<string, any>();
  let capped = false;
  /*
   * `capped` covers three stops and only two of them mean the read is INCOMPLETE.
   *
   * The third — "this batch hit offset+limit+1 and there is more" — is ordinary pagination,
   * already reported exactly by `totalFilesIsLowerBound`, with `files` correct and `hasMore`
   * exact. Folding it into the incompleteness signal made every routine paginated listing
   * announce "some folders were too large to fully scan or could not be accessed": the
   * wrong-cause sentence, on healthy reads, which is the failure this PR exists to remove.
   */
  let incomplete = false;
  // Distinguished from `capped`: "we stopped at a bound" and "a request errored" are different
  // facts and their callers need different things. The listing path reports a failed source as
  // failed rather than merely short; the search path treats either as incomplete.
  let failed: any;
  // ENG-1624: same time bound as getGoogleDriveFolderTreeIds, and for the same
  // reason — batches and pages here are walked sequentially with no overall
  // bound otherwise. Crossing it sets `capped`, which the listing maps into
  // `folderScanIncomplete` — it did NOT until a starved source was found being
  // reported as an empty folder; it was mapped only to a counting-precision
  // flag. Reusing the existing
  // "incomplete, do not conclude absence" signal.
  const deadline = sharedDeadlineAt ?? (Date.now() + DRIVE_LIST_WALK_MAX_MS);
  for (let i = 0; i < folderIds.length; i += DRIVE_FOLDER_QUERY_BATCH_SIZE) {
    if (Date.now() >= deadline) {
      capped = true;
      incomplete = true;
      break;
    }
    const batch = folderIds.slice(i, i + DRIVE_FOLDER_QUERY_BATCH_SIZE);
    const parentClause = `(${batch.map(id => `'${id}' in parents`).join(' or ')})`;
    let batchCount = 0;
    let pageToken: string | undefined;
    do {
      if (Date.now() >= deadline) {
        capped = true;
        incomplete = true;
        pageToken = undefined;
        break;
      }
      let resp: any;
      try {
        // Same budgeted single retry as the folder walk — see withDriveRetry.
        resp = await withDriveRetry(deadline, () => drive.files.list({
        q: `${parentClause} and ${extraClause}`,
        // nextPageToken must be requested explicitly — it isn't returned by
        // default, which is exactly why the old single-page fetch had no way
        // to know it was truncating.
        fields: `nextPageToken, ${fields}`,
        pageSize: Math.min(perBatchTarget - batchCount, 1000),
        ...(pageToken && { pageToken }),
        ...(orderBy && { orderBy }),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        }, driveRequestOptions(deadline)));
      } catch (err) {
        /*
         * A failed request — most likely the per-request timeout firing near the end of the
         * budget — must degrade this read to INCOMPLETE, never discard it. Throwing here
         * reaches callers that swallow it (searchKnowledgeBase logs and continues), so every
         * row already merged would be dropped and the answer would present an empty result as
         * a complete search: the exact defect this file is being changed to prevent, caused by
         * the guard against it. `capped` is the signal the callers already surface.
         */
        console.log('AgentMode: Drive file query batch failed; reporting the read as incomplete:', err);
        capped = true;
        incomplete = true;
        failed = err;
        break;
      }
      const files = resp.data.files || [];
      for (const f of files) {
        if (f.id) merged.set(f.id, f);
      }
      batchCount += files.length;
      pageToken = resp.data.nextPageToken || undefined;
      if (batchCount >= perBatchTarget && pageToken) {
        // Hit this batch's target with more still available — stop here
        // rather than draining a huge folder, but the caller needs to know
        // this batch's contribution isn't necessarily complete.
        capped = true;
        pageToken = undefined;
      }
    } while (pageToken);
  }
  return { files: merged, capped, incomplete, failed };
}

// Helper: get Google Drive shared folders for a caller.
// Returns the union of org-level and user-level folders so that folders added before the
// org feature existed (stored on the user record) continue to work without data migration.
async function getUserGoogleDriveFolders(userId: string): Promise<Array<{ folderId: string; name: string }>> {
  const { userDb, orgDb } = await import('../../services/db');
  const user = await userDb.getUserById(userId);
  const userFolders: Array<{ folderId: string; name: string }> =
    Array.isArray(user?.googleDriveFolders) ? user!.googleDriveFolders : [];
  if (user?.orgId) {
    const org = await orgDb.getOrgById(user.orgId);
    const orgFolders: Array<{ folderId: string; name: string }> =
      Array.isArray(org?.googleDriveFolders) ? org!.googleDriveFolders : [];
    // Merge: org folders first, then user folders not already in org list
    const orgFolderIds = new Set(orgFolders.map(f => f.folderId));
    return [...orgFolders, ...userFolders.filter(f => !orgFolderIds.has(f.folderId))];
  }
  return userFolders;
}

export async function searchKnowledgeBase(query: string, maxResults: number = 5, userId?: string): Promise<any> {
  try {
    console.log('AgentMode: Searching knowledge base for query:', query, 'maxResults:', maxResults);

    // Guard: an empty/whitespace query matches everything in Vertex (returned the whole
    // KB). Skip the search entirely and return nothing.
    if (!query || !query.trim()) {
      return {
        success: true,
        message: 'No search query provided.',
        query: query || '',
        results: [],
        returnedResults: 0,
        hasMore: false,
      };
    }

    // Limit max results to 10
    const limitedMaxResults = Math.min(maxResults, 10);

    // ENG-1624: set when a registered root's folder tree couldn't be fully
    // walked/read (truncated by maxFolders, or a root/sub-folder 403'd) — the
    // Drive portion of these results is then not exhaustive, and the final
    // message must say so rather than reading as a complete search.
    let driveScanIncomplete = false;

    // Search platform knowledge base (both public and private)
    // ENG-2103 (F2) / ENG-1816 F1 lesson-lazy-require-aws-sdk-modules:
    // chatbotService.ts constructs a real AWS DynamoDB client at module scope
    // and has a circular import back to agentModeService.ts — lazy `await
    // import()`'d here rather than a static top-level import.
    const { searchPlatformKnowledgeBase } = await import('../../services/chatbotService');
    const searchResults = await searchPlatformKnowledgeBase(query, limitedMaxResults, userId);

    const results: Array<{ content: string; source: string; fileName?: string }> = (searchResults || []).map(result => ({
      // ENG-1057: unlike the Drive/ClickUp sources below, Vertex results were
      // never capped, so a single oversized entry could exceed Node's max
      // string length once merged/serialized downstream and crash the process.
      content: result.content && result.content.length > 5000
        ? truncateToolContent(result.content)
        : result.content,
      source: result.metadata?.source || 'unknown',
      ...(result.metadata?.fileName && { fileName: result.metadata.fileName })
    }));

    // Search Google Drive shared folders
    if (userId) {
      try {
        const folders = await getUserGoogleDriveFolders(userId);
        if (folders.length > 0) {
          const drive = await getGoogleDriveClient();
          // Walk each registered root's whole folder tree (ENG-1624) so search
          // covers files nested in sub-folders too, not just direct children.
          const folderTrees = await Promise.all(
            folders.map(f => getGoogleDriveFolderTreeIds(drive, f.folderId))
          );
          if (folderTrees.some(t => t.truncated || t.rootRestricted || t.restricted.length > 0)) {
            driveScanIncomplete = true;
          }
          // De-dupe across roots: a file with multiple parents (or two registered
          // roots sharing a sub-tree) can otherwise appear twice.
          const allFolderIds = [...new Set(folderTrees.flatMap(t => t.folderIds))];
          const { files: driveFilesMap, capped: driveQueryCapped } = await queryDriveFilesAcrossFolders(
            drive,
            allFolderIds,
            `fullText contains '${escapeDriveQueryValue(query)}' and trashed = false`,
            'files(id, name, mimeType, parents)',
            limitedMaxResults
          );
          // A per-batch cap on the file query itself is a different reason the
          // Drive portion isn't exhaustive than an unreadable folder — fold it
          // into the same signal so a capped search result set isn't presented
          // as exhaustive either.
          if (driveQueryCapped) {
            driveScanIncomplete = true;
          }

          const driveFiles = Array.from(driveFilesMap.values()).slice(0, limitedMaxResults);
          for (const file of driveFiles) {
            // Read file content for text-based files
            if (file.id && file.mimeType && !file.mimeType.startsWith('application/vnd.google-apps.folder')) {
              try {
                const content = await readGoogleDriveFileContent(drive, file.id, file.name || '', file.mimeType);
                if (content) {
                  const parentFolder = folders.find(f => file.parents?.includes(f.folderId));
                  results.push({
                    content: truncateToolContent(content),
                    source: `google-drive/${parentFolder?.name || 'shared'}/${file.name}`
                  });
                }
              } catch (readErr) {
                console.log(`AgentMode: Could not read Drive file ${file.name} for search:`, readErr);
              }
            }
          }
        }
      } catch (driveError) {
        /*
         * The whole Drive source dropped out of this search, so the result set is missing an
         * entire source — the strongest form of incomplete there is here.
         *
         * Logging and continuing on its own let that be reported as a successful search that
         * simply found nothing in Drive. The escaper's own refusal (escapeDriveQueryValue
         * throws on a non-string) lands right here, so the guard added to stop a confidently
         * wrong query could itself produce a confidently wrong ANSWER. `driveScanIncomplete`
         * is the existing signal for "do not read absence into this result"; it belongs on
         * this branch more than on any of the narrower ones that already set it.
         */
        console.log('AgentMode: Error searching Google Drive shared folders:', driveError);
        driveScanIncomplete = true;
        // Don't fail the whole search if Drive search fails — but never report it as complete.
      }
    }

    // Search ClickUp docs (name match + content match)
    if (userId) {
      try {
        const clickUpToken = await getClickUpAccessToken(userId);
        if (clickUpToken) {
          const workspaces = await getClickUpWorkspaces(clickUpToken);
          const queryLower = query.toLowerCase();
          for (const workspace of workspaces) {
            try {
              const docs = await listClickUpDocs(clickUpToken, workspace.id);
              let clickUpResultCount = 0;
              for (const doc of docs) {
                if (clickUpResultCount >= limitedMaxResults) break;
                try {
                  const nameMatch = doc.name.toLowerCase().includes(queryLower);
                  const content = await readClickUpDocContent(clickUpToken, workspace.id, doc.id);
                  if (!content) continue;
                  const contentMatch = content.toLowerCase().includes(queryLower);
                  if (nameMatch || contentMatch) {
                    results.push({
                      content: truncateToolContent(content),
                      source: `clickup/${workspace.name}/${doc.name}`
                    });
                    clickUpResultCount++;
                  }
                } catch (readErr) {
                  console.log(`AgentMode: Could not read ClickUp doc ${doc.name} for search:`, readErr);
                }
              }
            } catch (wsErr) {
              console.log(`AgentMode: Error searching ClickUp docs in workspace ${workspace.name}:`, wsErr);
            }
          }
        }
      } catch (clickUpError) {
        console.log('AgentMode: Error searching ClickUp docs:', clickUpError);
        // Don't fail the whole search if ClickUp search fails
      }
    }

    // Search ClickUp tasks (name match + description match — no full content fetch needed)
    if (userId) {
      try {
        const clickUpToken = await getClickUpAccessToken(userId);
        if (clickUpToken) {
          const workspaces = await getClickUpWorkspaces(clickUpToken);
          const queryLower = query.toLowerCase();
          for (const workspace of workspaces) {
            try {
              const tasks = await listClickUpTasks(clickUpToken, workspace.id);
              let clickUpTaskResultCount = 0;
              for (const task of tasks) {
                if (clickUpTaskResultCount >= limitedMaxResults) break;
                const nameMatch = task.name.toLowerCase().includes(queryLower);
                const descMatch = (task.description || '').toLowerCase().includes(queryLower);
                if (nameMatch || descMatch) {
                  const summary = `# ${task.name}\n\n**Status:** ${task.status}${task.priority ? `\n**Priority:** ${task.priority}` : ''}${task.assignees.length > 0 ? `\n**Assignees:** ${task.assignees.join(', ')}` : ''}${task.description ? `\n\n${task.description}` : ''}`;
                  results.push({
                    content: truncateToolContent(summary),
                    source: `clickup-tasks/${workspace.name}/${task.name}`
                  });
                  clickUpTaskResultCount++;
                }
              }
            } catch (wsErr) {
              console.log(`AgentMode: Error searching ClickUp tasks in workspace ${workspace.name}:`, wsErr);
            }
          }
        }
      } catch (clickUpError) {
        console.log('AgentMode: Error searching ClickUp tasks:', clickUpError);
        // Don't fail the whole search if ClickUp tasks search fails
      }
    }

    if (results.length === 0) {
      return {
        success: true,
        message: driveScanIncomplete
          ? `No knowledge base results found for "${query}" — note: some Google Drive folders could not be fully scanned, so this is not confirmed exhaustive.`
          : `No knowledge base results found for "${query}"`,
        query,
        results: [],
        returnedResults: 0,
        hasMore: false,
        ...(driveScanIncomplete && { scanIncomplete: true })
      };
    }

    // Bound the merged results to what the caller asked for. Each source (Vertex, Drive,
    // ClickUp docs/tasks) is collected up to limitedMaxResults independently, so the merged
    // list can be several times larger than requested — cap it to avoid context bloat.
    const boundedResults = results.slice(0, limitedMaxResults);

    // ENG-1207: never present a page as a total. `totalResults` was the worst
    // instance of this in the file — a structured field NAMED "total" carrying a
    // page count reads as authoritative in a way prose does not, so a model has
    // no reason to doubt it. Renamed to `returnedResults`, which is what it
    // always actually held, plus an explicit `hasMore`.
    //
    // Unlike `get_lead_engagements`, no honest total is available here and none
    // is invented. Each source (Vertex, Drive, ClickUp docs/tasks) is collected
    // up to `limitedMaxResults` INDEPENDENTLY before merging, so `results.length`
    // is a floor rather than a count of what matched — a source that returned
    // exactly its own cap may well have had more. `hasMore` therefore reports
    // only what is certain: that the merge itself was cut. It can be false while
    // more exists upstream, which is why the message says "raise max_results"
    // rather than promising a specific remainder.
    const hasMore = results.length > boundedResults.length;
    const scanIncompleteNote = driveScanIncomplete
      ? ' Some Google Drive folders could not be fully scanned, so this is not confirmed exhaustive.'
      : '';
    return {
      success: true,
      message: (hasMore
        ? `Showing the first ${boundedResults.length} knowledge base results for "${query}" — raise max_results to see more.`
        : `Found ${boundedResults.length} knowledge base results for "${query}"`) + scanIncompleteNote,
      query,
      // Completeness AHEAD of the payload, the same rule listKnowledgeBaseFiles and
      // searchGoogleDrive follow. Ten results at ~5KB each clears the 8,000-char offload
      // threshold comfortably, after which the model reads a sealed 20,000-char prefix and
      // anything serialized after `results` is simply not there. The prose in `message` says
      // the same thing and is first, so this was mitigated rather than broken — but the
      // structured flags are what a future consumer will key on.
      returnedResults: boundedResults.length,
      hasMore,
      ...(driveScanIncomplete && { scanIncomplete: true }),
      results: boundedResults,
    };
  } catch (error) {
    console.error('AgentMode: Error searching knowledge base:', error);
    return {
      success: false,
      message: 'Failed to search the knowledge base. Please try again.',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Search Foreplay ads only (swipefile + boards). Use this tool when the query is ads-related.
export async function searchForeplayAds(query: string, maxResults: number = 5, userId?: string): Promise<any> {
  try {
    if (!userId) {
      return { success: false, message: 'User ID required to search Foreplay ads.', results: [], totalResults: 0 };
    }

    const foreplayToken = await getForeplayAccessToken(userId);
    if (!foreplayToken) {
      return {
        success: false,
        message: 'Foreplay is not configured. The platform-wide Foreplay API key is missing from AWS Secrets Manager — an admin needs to add it. Users can also connect their own Foreplay account in Knowledge Base settings.',
        results: [],
        totalResults: 0
      };
    }

    const limitedMaxResults = Math.min(maxResults, 10);
    const queryLower = query.toLowerCase();
    const results: Array<{ content: string; source: string }> = [];
    let foreplayResultCount = 0;
    // ENG-1300: swipefile/board-list failures below are caught and swallowed
    // so a bad Foreplay board never sinks the whole search — but that meant an
    // outright auth/rate-limit failure on EVERY source silently reported as
    // "no ads found" (success:true), exactly the "run looks successful while
    // operating on partial input" pattern ENG-1300 exists to catch. Track the
    // top-level failures (not the deliberately-tolerated per-board ones) and
    // only surface them as a real failure when there are zero results to show
    // for it — a genuine empty match must still report success.
    let topLevelError: any = null;

    // Search swipefile ads
    try {
      const swipeResult = await getForeplaySwipefileAds(foreplayToken, { limit: 250 });
      for (const ad of swipeResult.ads) {
        if (foreplayResultCount >= limitedMaxResults) break;
        const nameMatch = (ad.name || '').toLowerCase().includes(queryLower);
        const descMatch = (ad.description || '').toLowerCase().includes(queryLower);
        const headlineMatch = (ad.headline || '').toLowerCase().includes(queryLower);
        const brandMatch = (ad.brandName || '').toLowerCase().includes(queryLower);
        if (nameMatch || descMatch || headlineMatch || brandMatch) {
          const content = formatForeplayAdAsMarkdown(ad);
          results.push({
            content: truncateToolContent(content),
            source: `foreplay-swipefile/${ad.brandName || 'Unknown'}/${ad.name || ad.headline || ad.id}`
          });
          foreplayResultCount++;
        }
      }
    } catch (swipeErr) {
      console.log('AgentMode: Error searching Foreplay swipefile:', swipeErr);
      topLevelError = swipeErr;
    }

    // Search board ads
    try {
      const boards = await listForeplayBoards(foreplayToken);
      for (const board of boards) {
        if (foreplayResultCount >= limitedMaxResults) break;
        try {
          const boardAds = await getAllForeplayBoardAds(foreplayToken, board.id);
          for (const ad of boardAds) {
            if (foreplayResultCount >= limitedMaxResults) break;
            const nameMatch = (ad.name || '').toLowerCase().includes(queryLower);
            const descMatch = (ad.description || '').toLowerCase().includes(queryLower);
            const headlineMatch = (ad.headline || '').toLowerCase().includes(queryLower);
            const brandMatch = (ad.brandName || '').toLowerCase().includes(queryLower);
            if (nameMatch || descMatch || headlineMatch || brandMatch) {
              const content = formatForeplayAdAsMarkdown(ad);
              results.push({
                content: truncateToolContent(content),
                source: `foreplay-board/${board.name}/${ad.brandName || 'Unknown'}/${ad.name || ad.headline || ad.id}`
              });
              foreplayResultCount++;
            }
          }
        } catch (boardErr) {
          // Deliberately tolerated — one bad board must not sink every other
          // board's results, so this one is never promoted to topLevelError.
          console.log(`AgentMode: Error searching Foreplay board ${board.name}:`, boardErr);
        }
      }
    } catch (boardsErr) {
      console.log('AgentMode: Error listing Foreplay boards for search:', boardsErr);
      topLevelError = topLevelError || boardsErr;
    }

    if (results.length === 0 && topLevelError) {
      return {
        success: false,
        message: `Failed to search Foreplay ads: ${topLevelError?.message || 'Unknown error'}`,
        error: topLevelError?.message || 'Unknown error',
        code: topLevelError?.response?.status,
        results: [],
        totalResults: 0
      };
    }

    if (results.length === 0) {
      return {
        success: true,
        message: `No Foreplay ads found matching "${query}"`,
        query,
        results: [],
        totalResults: 0
      };
    }

    return {
      success: true,
      message: `Found ${results.length} Foreplay ads matching "${query}"`,
      query,
      results,
      totalResults: results.length
    };
  } catch (error) {
    console.error('AgentMode: Error searching Foreplay ads:', error);
    return {
      success: false,
      message: 'Failed to search Foreplay ads. Please try again.',
      error: error instanceof Error ? error.message : 'Unknown error',
      // ENG-1300: plain axios error — Foreplay has no known business-code field.
      code: (error as any)?.response?.status
    };
  }
}

// Search Foreplay discovery database (millions of ads, costs credits per result).
export async function searchForeplayDiscovery(
  query: string | undefined,
  options: {
    maxResults?: number;
    companyName?: string;
    cursor?: string;
    format?: string[];
    platform?: string[];
    niche?: string[];
    live?: boolean;
    sort?: string;
  } = {},
  userId?: string
): Promise<any> {
  try {
    if (!userId) {
      return { success: false, message: 'User ID required to search Foreplay discovery.', results: [], totalResults: 0 };
    }

    // Build the effective query: combine company_name + query if both provided
    const effectiveQuery = [options.companyName, query].filter(Boolean).join(' ') || undefined;
    if (!effectiveQuery) {
      return { success: false, message: 'Provide a company_name or query to search Foreplay discovery.', results: [], totalResults: 0 };
    }

    const foreplayToken = await getForeplayAccessToken(userId);
    if (!foreplayToken) {
      return {
        success: false,
        message: 'Foreplay is not configured. The platform-wide Foreplay API key is missing from AWS Secrets Manager — an admin needs to add it. Users can also connect their own Foreplay account in Knowledge Base settings.',
        results: [],
        totalResults: 0
      };
    }

    const limit = Math.min(options.maxResults || 10, 20);
    const result = await searchForeplayDiscoveryAds(foreplayToken, {
      query: effectiveQuery,
      limit,
      cursor: options.cursor,
      format: options.format,
      platform: options.platform,
      niche: options.niche,
      live: options.live,
      sort: options.sort,
    });

    // When a company_name is specified, filter results to only that brand
    const ads = options.companyName
      ? result.ads.filter(ad => (ad.brandName || '').toLowerCase().includes(options.companyName!.toLowerCase()))
      : result.ads;

    const results = ads.map(ad => ({
      content: (() => {
        const c = formatForeplayAdAsMarkdown(ad);
        return truncateToolContent(c);
      })(),
      source: `foreplay-discovery/${ad.brandName || 'Unknown'}/${ad.name || ad.headline || ad.id}`
    }));

    const searchLabel = options.companyName
      ? (query ? `"${options.companyName}" + "${query}"` : `"${options.companyName}"`)
      : `"${query}"`;

    return {
      success: true,
      message: results.length > 0
        ? `Found ${results.length} ads in Foreplay discovery database for ${searchLabel}${result.cursor ? ' (more available)' : ''}`
        : `No ads found in Foreplay discovery database for ${searchLabel}`,
      query: effectiveQuery,
      companyName: options.companyName,
      results,
      totalResults: results.length,
      hasMore: !!result.cursor,
      cursor: result.cursor,
      note: 'Each result costs 1 Foreplay credit. Discovery searches Foreplay\'s full database of millions of ads, not just your saved swipefile.' + (result.cursor ? ' More results are available — call this tool again with the returned cursor to fetch the next page.' : '')
    };
  } catch (error) {
    console.error('AgentMode: Error searching Foreplay discovery:', error);
    return {
      success: false,
      message: 'Failed to search Foreplay discovery. Please try again.',
      error: error instanceof Error ? error.message : 'Unknown error',
      code: (error as any)?.response?.status
    };
  }
}

// List all knowledge base files for a user
export async function listKnowledgeBaseFiles(userId: string, options?: {
  modified_after?: string;  // ISO 8601 date string, e.g. "2026-04-15"
  modified_before?: string; // ISO 8601 date string, e.g. "2026-04-22"
  limit?: number;           // max files per Drive KB (default 100)
  offset?: number;          // file offset within Drive KB for pagination (default 0)
  kb_type?: string;         // filter to specific KB type: "google-drive", "private", "public", "clickup", "clickup-tasks", "foreplay-swipefile", "foreplay-board"
}): Promise<any> {
  try {
    console.log('AgentMode: Listing knowledge base files for user:', userId, 'options:', options);

    // Refuse a malformed date filter here, before any source is read, so the caller gets the
    // expected format back instead of a per-folder Drive 400 buried in `listingFailed`.
    try {
      if (options?.modified_after) validateDriveDateFilter(options.modified_after, 'modified_after');
      if (options?.modified_before) validateDriveDateFilter(options.modified_before, 'modified_before');
    } catch (dateError: any) {
      return { success: false, message: dateError?.message || 'Invalid date filter' };
    }

    // Get user's private knowledge bases
    const { taskDb } = await import('../../services/db');
    const userKnowledgeBaseTasks = await taskDb.getTasksWithKnowledgeBase(userId);

    // Get all public knowledge bases from all users
    const publicKnowledgeBaseTasks = await taskDb.getAllPublicKnowledgeBaseTasks();

    // Fan out to same-org members' KBs when shareSettings.knowledgeBase is
    // effectively enabled for the caller (editors and the org owner always
    // see fanout; plain members only when the toggle is on).
    let orgKnowledgeBaseTasks: any[] = [];
    try {
      const { userDb, orgDb } = await import('../../services/db');
      const { isFeatureEffectivelyEnabled } = await import('../../services/orgShareService');
      const caller = await userDb.getUserById(userId);
      if (caller?.orgId) {
        const org = await orgDb.getOrgById(caller.orgId);
        const enabled = isFeatureEffectivelyEnabled(
          { userId, orgId: caller.orgId, orgRole: caller.orgRole as 'owner' | 'member' | undefined },
          org,
          'knowledgeBase',
        );
        if (enabled) {
          const members = await orgDb.getOrgMembers(caller.orgId);
          const otherMembers = members.filter((m: any) => m.userId !== userId);
          const perMember = await Promise.all(
            otherMembers.map((m: any) => taskDb.getTasksWithKnowledgeBase(m.userId).catch(() => [])),
          );
          orgKnowledgeBaseTasks = perMember.flat();
        }
      }
    } catch (e) {
      console.error('[agentModeService] org KB fanout failed:', e);
    }

    // Combine all lists, removing duplicates by taskId
    const taskIdSet = new Set<string>();
    const allKnowledgeBaseTasks: any[] = [];
    for (const task of [
      ...(userKnowledgeBaseTasks || []),
      ...orgKnowledgeBaseTasks,
      ...(publicKnowledgeBaseTasks || []),
    ]) {
      if (taskIdSet.has(task.taskId)) continue;
      taskIdSet.add(task.taskId);
      allKnowledgeBaseTasks.push(task);
    }

    // If kb_type filter is set and doesn't include platform KBs, skip them entirely
    const skipPlatformKBs = options?.kb_type && !['private', 'public'].includes(options.kb_type);

    const knowledgeBases: any[] = skipPlatformKBs ? [] : (allKnowledgeBaseTasks || []).map((task: any) => {
      const taskId = task.taskId;
      const taskName = task.name;
      const kbType = task.knowledgeBaseType || 'private';
      const kbUpdatedAt = task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt;
      // Default file + uploaded files
      const files = [
        {
          fileName: 'knowledge-base.txt',
          fileSize: task.knowledgeBaseSize || 0,
          url: task.knowledgeBase || null
        },
        ...(task.knowledgeBaseFiles || []).map((f: any) => ({
          fileName: f.filename,
          fileSize: f.size || 0,
          url: f.url || null
        }))
      ];

      return {
        identifier: taskId,
        name: taskName,
        type: kbType,
        updatedAt: kbUpdatedAt,
        files
      };
    });

    // Include Google Drive shared folders
    // ENG-1624: set when Drive enumeration failed entirely (outer catch below)
    // — a listing that's missing every Drive source must say so, not read as
    // "this account has no Drive folders."
    let driveEnumerationFailed = false;
    if (!options?.kb_type || options.kb_type === 'google-drive') try {
      const folders = await getUserGoogleDriveFolders(userId);
      if (folders.length > 0) {
        const drive = await getGoogleDriveClient();
        const driveLimit = options?.limit ?? 100;
        const driveOffset = options?.offset ?? 0;

        // ENG-1624: walk every registered root's tree up front. Two
        // registered roots can be in an ancestor/descendant relationship —
        // a customer registers both a parent folder and one of its own
        // sub-folders (e.g. Harsha's mitigation for Phoenix, which added
        // the ratio sub-folders directly alongside the already-registered
        // parent). Now that this PR walks the whole tree instead of direct
        // children only, the parent's listing legitimately includes the
        // child's files too, so the same file can appear under two
        // entries. Walking every tree first lets nesting be detected
        // STRUCTURALLY (one root's resolved folderIds actually containing
        // another registered root's own id) before any file query runs.
        // getGoogleDriveFolderTreeIds never rejects — its own Drive errors
        // are caught internally as restricted/rootRestricted — so this
        // can't silently drop a root the way a failing Promise.all
        // normally would.
        const treeResults = await Promise.all(
          folders.map(folder =>
            getGoogleDriveFolderTreeIds(drive, folder.folderId).then(tree => ({ folder, ...tree }))
          )
        );

        /*
         * ONE budget for the whole listing, not one per source.
         *
         * The file queries below run sequentially, one per registered Drive source, and each
         * used to open a fresh DRIVE_LIST_WALK_MAX_MS. Six registered sources therefore meant
         * six full budgets end to end — 540s at the current 90s — which blows past the 600s
         * nginx/ALB ceiling that budget was picked to sit inside. Sharing a deadline keeps the
         * whole listing inside one budget: sources still get read in order, and a listing that
         * runs out reports the remaining sources as incomplete rather than silently costing
         * the user a dropped request.
         */
        const listingDeadlineAt = Date.now() + DRIVE_LIST_WALK_MAX_MS;
        for (const { folder, folderIds, restricted, rootRestricted, truncated, throttled } of treeResults) {
          try {
            // Structural, not name-based: a root only counts as nested
            // when its OWN id was actually discovered inside another
            // root's resolved tree. This can't false-positive from a
            // truncated ancestor scan — truncation just means some
            // folders were never visited, so an undiscovered descendant
            // simply isn't found here either, and no relationship is
            // claimed (falls back to the plain file-id dedup in the
            // top-level totalFiles below).
            const ancestor = treeResults.find(other =>
              other.folder.folderId !== folder.folderId &&
              other.folderIds.includes(folder.folderId)
            );

            // Exclude folder entries themselves — previously these showed up as
            // 0-byte files instead of being descended into.
            let extraClause = `mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
            /*
             * Escaped exactly like the `name`/`fullText` literals beside it. These two were
             * missed when escapeDriveQueryValue was introduced, and they sit in the same `q`
             * as the parent-folder clause that scopes this read to the caller's own folders —
             * so an unescaped quote here reached past that scoping on a SHARED, read-all
             * service account. Already validated to YYYY-MM-DD at the top of this method, so
             * this is the second lock rather than the first.
             */
            if (options?.modified_after) {
              extraClause += ` and modifiedTime >= '${escapeDriveQueryValue(options.modified_after)}T00:00:00'`;
            }
            if (options?.modified_before) {
              extraClause += ` and modifiedTime <= '${escapeDriveQueryValue(options.modified_before)}T23:59:59'`;
            }

            // ENG-1624: the tree can span more folders than fit in one `q` string
            // (see queryDriveFilesAcrossFolders), so this is queried in batches and
            // merged/de-duplicated by file id — NOT per batch, or offset/limit
            // pagination below would silently skip and repeat files across batch
            // boundaries.
            //
            // Per-batch target is offset+limit+1, not offset+limit: each batch is
            // fetched at the same `orderBy`, so the global top-K of the union is
            // always a subset of the union of each batch's own top-K — the `files`
            // returned are correct regardless of the target. The `+1` is what makes
            // `hasMore` exact: the merged set then holds at least
            // min(trueTotal, K+1) files, so `allFiles.length > offset+limit` is
            // true exactly when more files really exist beyond this page.
            const perBatchTarget = driveOffset + driveLimit + 1;
            const { files: filesMap, capped, incomplete: queryIncomplete, failed: queryFailed } = await queryDriveFilesAcrossFolders(
              drive,
              folderIds,
              extraClause,
              'files(id, name, mimeType, size, modifiedTime)',
              perBatchTarget,
              'modifiedTime desc',
              listingDeadlineAt,
            );

            // Per-batch `orderBy` only sorts within its own batch; re-sort the
            // merged set so global ordering (and therefore offset/limit slicing)
            // is correct.
            const allFiles = Array.from(filesMap.values())
              .map((f) => ({
                fileName: f.name || 'unknown',
                fileSize: f.size ? parseInt(f.size, 10) : 0,
                mimeType: f.mimeType || 'unknown',
                driveFileId: f.id,
                modifiedTime: f.modifiedTime,
              }))
              .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));

            const totalMatchingFiles = allFiles.length;
            const driveFiles = allFiles.slice(driveOffset, driveOffset + driveLimit);
            // ENG-1624: a scan that stopped early (folder-count bound or the root
            // itself being unreadable) must not present its partial file list as
            // complete.
            /*
             * `capped` belongs here too.
             *
             * It means the file query stopped at a bound — including the shared listing
             * deadline, which a slow FIRST source can exhaust before a later source is queried
             * at all. Mapping it only to `totalFilesIsLowerBound` (a counting-precision flag)
             * presented a source that was never read as an EMPTY FOLDER: totalFiles 0,
             * hasMore false, no incompleteness, no "do not conclude absence". That is ENG-1584
             * on the Drive side, and it was created by the fix that gave the listing one shared
             * budget — the remedy for one composition bug producing a false absence instead.
             */
            // `queryIncomplete`, not `capped`: the latter also fires on ordinary pagination.
            const folderScanIncomplete = truncated || rootRestricted || queryIncomplete;
            // Same distinction the readers draw: a throttled scan is incomplete for a reason
            // the user acts on differently (wait) than a large one (narrow).
            const folderScanThrottled = throttled;
            // A batch that hit its per-batch target means `totalMatchingFiles`
            // wasn't fully counted — it's a floor, not an exact total. Getting an
            // exact total would mean fully paginating every batch, which isn't
            // worth the API cost just to render one page.
            const totalFilesIsLowerBound = capped;

            /*
             * ⚠ Field order is load-bearing: every completeness signal goes BEFORE `files`.
             *
             * A knowledge-base listing routinely clears the S3 offload threshold, after which
             * the model is handed a SEALED fixed-length PREFIX of this JSON — anything
             * serialized after the file array is simply not there. Measured at the default
             * limit of 100 files, one Drive source alone reached ~20.5k chars with
             * `listingFailed` landing past the 20k cut: the flag existed, was correct, and
             * was unreadable on exactly the listings that need it. Same failure the
             * `buildListResult` helper exists to prevent on the Meta side.
             *
             * `files` LAST, always. Anything appended after it is invisible.
             */
            knowledgeBases.push({
              identifier: `gdrive:${folder.folderId}`,
              name: folder.name,
              type: 'google-drive',
              updatedAt: allFiles.length > 0 ? allFiles[0].modifiedTime : undefined,
              totalFiles: totalMatchingFiles,
              hasMore: allFiles.length > driveOffset + driveLimit,
              offset: driveOffset,
              limit: driveLimit,
              ...(totalFilesIsLowerBound && { totalFilesIsLowerBound: true }),
              // A request that errored means this source is not merely short, it is unreliable
              // — reported as failed even when some rows were already merged, so an empty or
              // partial list is never mistaken for the folder's true contents.
              ...(queryFailed ? { listingFailed: true, listingFailedReason: classifyDriveError(queryFailed) } : {}),
              // ENG-1624: a sub-folder that couldn't be listed (e.g. an unshared
              // shortcut target) previously shrank the listing with no signal to
              // the caller. Name it so the caller can request access instead of
              // silently seeing an incomplete file list.
              ...(restricted.length > 0 && { inaccessibleFolders: restricted.map(r => r.name) }),
              ...(rootRestricted && { inaccessibleRoot: true }),
              ...(folderScanIncomplete && { folderScanIncomplete: true }),
              ...(folderScanThrottled && { folderScanThrottled: true }),
              // ENG-1624: this root's own id was found inside another
              // registered root's resolved tree — its files are already
              // counted there too. Kept as its own entry (never silently
              // dropped), just labeled, so a saved gdrive:<this-id>
              // reference still resolves exactly as it does today.
              ...(ancestor && { nestedUnder: `gdrive:${ancestor.folder.folderId}` }),
              files: driveFiles,
            });
          } catch (folderErr: any) {
            // ENG-1624: this used to just log and move on, which silently
            // dropped the whole KB from the response — indistinguishable from
            // "this folder has no files." Round 2 (the BFS walk + batched,
            // paginated file query) turned a single files.list call into many,
            // multiplying how often a Drive error lands here. A failure for
            // one folder must not abort the others (kept below, same as
            // before) — but the caller now still sees this source, marked as
            // failed rather than absent.
            console.log(`AgentMode: Error listing files in Drive folder ${folder.name}:`, folderErr);
            knowledgeBases.push({
              identifier: `gdrive:${folder.folderId}`,
              name: folder.name,
              type: 'google-drive',
              listingFailed: true,
              listingFailedReason: classifyDriveError(folderErr),
              // Same ordering rule as the success path above — `files` last.
              files: [],
            });
          }
        }
      }
    } catch (driveError) {
      console.error('AgentMode: Error listing Google Drive shared folders:', driveError);
      driveEnumerationFailed = true;
    }

    // Include ClickUp docs
    if (!options?.kb_type || options.kb_type === 'clickup') try {
      const clickUpToken = await getClickUpAccessToken(userId);
      if (clickUpToken) {
        const workspaces = await getClickUpWorkspaces(clickUpToken);
        for (const workspace of workspaces) {
          try {
            const docs = await listClickUpDocs(clickUpToken, workspace.id);
            const clickUpFiles = docs.map(doc => ({
              fileName: doc.name,
              fileSize: 0,
              docId: doc.id,
              dateCreated: doc.dateCreated,
              dateUpdated: doc.dateUpdated,
            }));

            knowledgeBases.push({
              identifier: `clickup:${workspace.id}`,
              name: `ClickUp - ${workspace.name}`,
              type: 'clickup',
              updatedAt: clickUpFiles.length > 0 ? clickUpFiles[0].dateUpdated : undefined,
              files: clickUpFiles,
            });
          } catch (wsErr) {
            console.log(`AgentMode: Error listing ClickUp docs in workspace ${workspace.name}:`, wsErr);
          }
        }
      }
    } catch (clickUpError) {
      console.error('AgentMode: Error listing ClickUp docs:', clickUpError);
    }

    // Include ClickUp folders (spaces → folders hierarchy, for use as doc write targets)
    try {
      const clickUpToken = await getClickUpAccessToken(userId);
      if (clickUpToken) {
        const workspaces = await getClickUpWorkspaces(clickUpToken);
        for (const workspace of workspaces) {
          try {
            const spaces = await listClickUpSpaces(clickUpToken, workspace.id);
            for (const space of spaces) {
              try {
                const folders = await listClickUpFolders(clickUpToken, space.id);
                for (const folder of folders) {
                  knowledgeBases.push({
                    identifier: `clickup-folder:${folder.id}`,
                    name: `ClickUp Folder - ${workspace.name} / ${space.name} / ${folder.name}`,
                    type: 'clickup-folder',
                    updatedAt: undefined,
                    files: [],
                  });
                }
              } catch (spaceErr) {
                console.log(`AgentMode: Error listing ClickUp folders in space ${space.name}:`, spaceErr);
              }
            }
          } catch (wsErr) {
            console.log(`AgentMode: Error listing ClickUp spaces in workspace ${workspace.name}:`, wsErr);
          }
        }
      }
    } catch (clickUpError) {
      console.error('AgentMode: Error listing ClickUp folders:', clickUpError);
    }

    // Include ClickUp tasks
    if (!options?.kb_type || options.kb_type === 'clickup-tasks') try {
      const clickUpToken = await getClickUpAccessToken(userId);
      if (clickUpToken) {
        const workspaces = await getClickUpWorkspaces(clickUpToken);
        for (const workspace of workspaces) {
          try {
            const tasks = await listClickUpTasks(clickUpToken, workspace.id);
            const clickUpTaskFiles = tasks.map(task => ({
              fileName: task.name,
              fileSize: 0,
              taskId: task.id,
              status: task.status,
              priority: task.priority,
              dueDate: task.dueDate,
              assignees: task.assignees,
              attachmentCount: task.attachments.length,
              dateCreated: task.dateCreated,
              dateUpdated: task.dateUpdated,
            }));

            knowledgeBases.push({
              identifier: `clickup-tasks:${workspace.id}`,
              name: `ClickUp Tasks - ${workspace.name}`,
              type: 'clickup-tasks',
              updatedAt: clickUpTaskFiles.length > 0 ? clickUpTaskFiles[0].dateUpdated : undefined,
              files: clickUpTaskFiles,
            });
          } catch (wsErr) {
            console.log(`AgentMode: Error listing ClickUp tasks in workspace ${workspace.name}:`, wsErr);
          }
        }
      }
    } catch (clickUpError) {
      console.error('AgentMode: Error listing ClickUp tasks:', clickUpError);
    }

    // Include Foreplay boards and swipefile
    if (!options?.kb_type || options.kb_type === 'foreplay-swipefile' || options.kb_type === 'foreplay-board') try {
      const foreplayToken = await getForeplayAccessToken(userId);
      if (foreplayToken) {
        // Add swipefile
        try {
          const swipeResult = await getForeplaySwipefileAds(foreplayToken, { limit: 250 });
          if (swipeResult.ads.length > 0) {
            const swipeFiles = swipeResult.ads.map(ad => ({
              fileName: ad.name || ad.headline || ad.id,
              fileSize: 0,
              adId: ad.id,
              brandName: ad.brandName,
              displayFormat: ad.displayFormat,
              publisherPlatform: ad.publisherPlatform,
              live: ad.live,
              savedAt: ad.savedAt,
            }));

            knowledgeBases.push({
              identifier: 'foreplay-swipefile',
              name: 'Foreplay - Swipe File',
              type: 'foreplay-swipefile',
              updatedAt: undefined,
              files: swipeFiles,
            });
          }
        } catch (swipeErr) {
          console.log('AgentMode: Error listing Foreplay swipefile:', swipeErr);
        }

        // Add boards
        try {
          const boards = await listForeplayBoards(foreplayToken);
          for (const board of boards) {
            try {
              const boardAds = await getAllForeplayBoardAds(foreplayToken, board.id);
              const boardFiles = boardAds.map(ad => ({
                fileName: ad.name || ad.headline || ad.id,
                fileSize: 0,
                adId: ad.id,
                brandName: ad.brandName,
                displayFormat: ad.displayFormat,
                publisherPlatform: ad.publisherPlatform,
                live: ad.live,
              }));

              knowledgeBases.push({
                identifier: `foreplay-board:${board.id}`,
                name: `Foreplay Board - ${board.name}`,
                type: 'foreplay-board',
                updatedAt: undefined,
                files: boardFiles,
              });
            } catch (boardErr) {
              console.log(`AgentMode: Error listing Foreplay board ${board.name}:`, boardErr);
            }
          }
        } catch (boardsErr) {
          console.log('AgentMode: Error listing Foreplay boards:', boardsErr);
        }
      }
    } catch (foreplayError) {
      console.error('AgentMode: Error listing Foreplay ads:', foreplayError);
    }

    // ENG-1624: a plain per-KB sum double-counts once nesting/multi-parent
    // overlap between registered Drive roots is possible (see the
    // treeResults/nestedUnder logic above) — the same underlying Drive file
    // can legitimately appear in more than one root's `files` array. De-dupe
    // by driveFileId for google-drive entries specifically; other KB types
    // (private/public/ClickUp/Foreplay) have no equivalent shared identity
    // and are summed as before.
    const seenDriveFileIds = new Set<string>();
    const totalFiles = knowledgeBases.reduce((sum: number, kb: any) => {
      if (kb.type !== 'google-drive') return sum + (kb.files?.length || 0);
      let kbCount = 0;
      for (const f of kb.files || []) {
        if (!f.driveFileId || !seenDriveFileIds.has(f.driveFileId)) {
          if (f.driveFileId) seenDriveFileIds.add(f.driveFileId);
          kbCount++;
        }
      }
      return sum + kbCount;
    }, 0);

    const appliedFiltersEarly = [
      options?.modified_after ? `modified_after=${options.modified_after}` : null,
      options?.modified_before ? `modified_before=${options.modified_before}` : null,
      options?.kb_type ? `kb_type=${options.kb_type}` : null,
      options?.limit != null ? `limit=${options.limit}` : null,
      options?.offset != null ? `offset=${options.offset}` : null,
    ].filter(Boolean) as string[];

    if (knowledgeBases.length === 0) {
      // ENG-173: an explicit Google Drive query (kb_type=google-drive) that returns
      // empty reflects only the READ-ONLY shared-folder path (service account) — it
      // says nothing about Docs/Sheets CREATE/EDIT, a separate OAuth-backed skill.
      // Point the model to the catalog so empty doesn't read as "Docs unavailable".
      // Scoped to the explicit drive query: an unfiltered/other empty gets the plain
      // message (this path lists all sources, and nudging Docs there is off-topic).
      //
      // ENG-1624: an empty result caused by driveEnumerationFailed is a DIFFERENT
      // claim than a genuinely empty account — the former means "we don't know",
      // the latter means "there is nothing." Collapsing them into the same plain
      // message would tell a caller no Drive folders are registered when the
      // truth is the enumeration call itself failed.
      let message: string;
      if (driveEnumerationFailed) {
        message = options?.kb_type === 'google-drive'
          ? 'Google Drive sources could not be enumerated — this does not mean no folders are registered, only that the enumeration attempt itself failed. Try again.'
          : 'No knowledge bases found in other sources, and Google Drive sources could not be enumerated — this does not mean no Drive folders exist, only that the enumeration attempt itself failed. Try again.';
      } else {
        message = options?.kb_type === 'google-drive'
          ? 'No Google Drive shared folders found here — this lists only READ-ONLY shared folders (surfaced via the service account). Creating and editing Google Docs & Sheets is a SEPARATE capability — call list_available_skills to find and install the skill that provides Google Docs / Sheets create/edit tools.'
          : 'No knowledge bases found';
      }
      return {
        success: true,
        message,
        knowledge_bases: [],
        totalKnowledgeBases: 0,
        totalFiles: 0,
        ...(driveEnumerationFailed && { driveEnumerationFailed: true }),
        ...(appliedFiltersEarly.length > 0 && { appliedFilters: appliedFiltersEarly }),
      };
    }

    const hasMorePages = knowledgeBases.some((kb: any) => kb.hasMore);
    // ENG-1624: a folder-scan cutoff (folder-count bound, or the root/a
    // sub-folder being unreadable) is a different signal than "more files exist
    // to paginate" — it means the listing itself may be incomplete, not just
    // capped.
    const hasIncompleteFolderScan = knowledgeBases.some((kb: any) => kb.folderScanIncomplete);
    /*
     * The third consumer of the throttle split, which was missed when the other two got it.
     * A throttled walk sets `truncated` as well, so this listing said "too large to fully scan
     * or could not be accessed" about a rate-limited read — the wrong-cause sentence, telling
     * the user to narrow a search that will throttle identically.
     */
    /*
     * Both sentences, when both are true.
     *
     * These are `.some()` over DIFFERENT sources, so suppressing the size/permission sentence
     * whenever any source was throttled hid a real incompleteness on every other source. The
     * two facts are independent and the model needs both: wait for the throttled one, narrow
     * or share the others.
     */
    const hasThrottledFolderScan = knowledgeBases.some((kb: any) => kb.folderScanThrottled);
    /*
     * Only claim "too large or inaccessible" about a source that is NOT merely throttled.
     *
     * A throttled walk sets `throttled` AND `truncated` in the same branch, so for a single
     * source both flags describe the same stop — and the two sentences then contradict each
     * other outright: "a temporary quota answer, not a size or permissions problem" followed
     * immediately by "too large to fully scan or could not be accessed". Suppressing the size
     * sentence whenever ANY source was throttled was also wrong, because it hid a real
     * incompleteness on the other sources. Per-source is the only reading that is right in
     * both shapes.
     */
    const hasIncompleteFolderScanBeyondThrottle = knowledgeBases.some(
      (kb: any) => kb.folderScanIncomplete && !kb.folderScanThrottled,
    );
    // A Drive KB's file query hit its per-batch target — its `totalFiles` is a
    // floor, not an exact count, even though `files`/`hasMore` are still correct.
    const hasLowerBoundTotals = knowledgeBases.some((kb: any) => kb.totalFilesIsLowerBound);
    // A Drive KB whose listing errored — shown rather than dropped, but its `files` must not
    // be read as the folder's true contents. NOT necessarily empty: `queryDriveFilesAcrossFolders`
    // sets `failed` after merging whatever batches did succeed, so a failed source can carry a
    // PARTIAL list. Saying "shown as empty" there described a state that does not exist and
    // invited the model to trust a short list as complete.
    const failedDriveCount = knowledgeBases.filter((kb: any) => kb.listingFailed).length;
    // A Drive KB nested inside another registered Drive KB's tree — its files
    // are already reflected in the parent's own listing (and in the
    // de-duplicated totalFiles above), not additional ones.
    const hasNestedRoots = knowledgeBases.some((kb: any) => kb.nestedUnder);
    const appliedFilters = appliedFiltersEarly;

    return {
      success: true,
      message: `Found ${knowledgeBases.length} knowledge base(s) with ${totalFiles} file(s)${appliedFilters.length ? ` (filters: ${appliedFilters.join(', ')})` : ''}${hasMorePages ? '. Some sources have more files — use limit/offset to paginate.' : ''}${hasThrottledFolderScan ? ' Google Drive rate-limited the scan of some folders — a temporary quota answer, not a size or permissions problem; wait a minute and retry rather than narrowing.' : ''}${hasIncompleteFolderScanBeyondThrottle ? ' Some Google Drive folders were too large to fully scan or could not be accessed — their file listings may be incomplete.' : ''}${hasLowerBoundTotals ? ' Some Google Drive totalFiles counts are a lower bound, not exact — the query hit its per-page cap before counting everything.' : ''}${failedDriveCount > 0 ? ` ${failedDriveCount} Google Drive source(s) could not be fully listed (see listingFailed) — their file lists may be empty OR partial, so treat any file missing from them as unknown, not absent.` : ''}${driveEnumerationFailed ? ' Google Drive sources could not be fully enumerated — some may be missing from this listing entirely.' : ''}${hasNestedRoots ? ' Some Google Drive sources are nested inside another registered source (see nestedUnder) — their files are the same files already counted under the parent, not additional ones.' : ''}. For Google Drive files, use kb_identifier starting with "gdrive:" and the file name to read them. For ClickUp docs, use kb_identifier starting with "clickup:" and the doc name to read them — each doc file entry has a docId you can pass as parent_doc_id to write_clickup_doc to create content inside that doc. For ClickUp tasks, use kb_identifier starting with "clickup-tasks:" and the task name to read them. For ClickUp task-hierarchy folders (clickup-folder:), these are for reference only and cannot be used as doc write targets. For Foreplay ads, use kb_identifier "foreplay-swipefile" or "foreplay-board:BOARD_ID" and the ad name to read them.`,
      // Same rule as the per-source objects: every completeness flag ahead of the payload,
      // because `knowledge_bases` is what pushes this result past the offload threshold and
      // anything after it falls outside the sealed prefix the model actually reads.
      totalKnowledgeBases: knowledgeBases.length,
      totalFiles,
      ...(appliedFilters.length > 0 && { appliedFilters }),
      ...(hasMorePages && { hasMore: true }),
      ...(hasIncompleteFolderScan && { folderScanIncomplete: true }),
      ...(hasThrottledFolderScan && { folderScanThrottled: true }),
      ...(hasLowerBoundTotals && { totalFilesIsLowerBound: true }),
      ...(failedDriveCount > 0 && { driveListingFailures: failedDriveCount }),
      ...(driveEnumerationFailed && { driveEnumerationFailed: true }),
      knowledge_bases: knowledgeBases,
    };
  } catch (error) {
    console.error('AgentMode: Error listing knowledge base files:', error);
    return {
      success: false,
      message: 'Failed to list knowledge base files. Please try again.',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Read multiple knowledge base files; each entry must include kb_identifier (taskId) and file_name
export async function readKnowledgeBaseFiles(files: Array<{ kb_identifier: string; file_name: string }>, userId: string): Promise<any> {
  try {
    if (!Array.isArray(files) || files.length === 0) {
      return {
        success: false,
        message: 'files array is required'
      };
    }

    const results: any[] = [];

    for (const entry of files) {
      const kbIdentifier = entry?.kb_identifier;
      const fileName = entry?.file_name;

      if (!kbIdentifier || !fileName) {
        results.push({
          success: false,
          message: 'kb_identifier and file_name are required'
        });
        continue;
      }

      try {
        const result = await readSingleKnowledgeBaseFile(kbIdentifier, fileName, userId);
        results.push(result);
      } catch (err: any) {
        results.push({
          success: false,
          message: `Failed to read knowledge base file: ${err?.message || 'Unknown error'}`
        });
      }
    }

    return {
      success: true,
      message: `Read ${results.filter(r => r.success).length} of ${results.length} file(s)`,
      files: results
    };
  } catch (error) {
    console.error('AgentMode: Error reading knowledge base file:', error);
    return {
      success: false,
      message: 'Failed to read knowledge base file. Please try again.',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Helper: read a single knowledge base file
export async function readSingleKnowledgeBaseFile(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
  // Handle Google Drive shared folder files (identifier starts with "gdrive:")
  if (kbIdentifier.startsWith('gdrive:')) {
    return await readGoogleDriveSharedFile(kbIdentifier, fileName, userId);
  }

  // Handle direct Google Doc/Sheet by ID
  if (kbIdentifier.startsWith('gdoc:') || kbIdentifier.startsWith('gsheet:')) {
    const fileId = kbIdentifier.replace(/^g(doc|sheet):/, '');
    return await googleDriveImpl.readGoogleFileById(fileId, userId);
  }

  // Handle ClickUp tasks (identifier starts with "clickup-tasks:")
  if (kbIdentifier.startsWith('clickup-tasks:')) {
    return await readClickUpTask(kbIdentifier, fileName, userId);
  }

  // Handle ClickUp docs (identifier starts with "clickup:")
  if (kbIdentifier.startsWith('clickup:')) {
    return await readClickUpSharedDoc(kbIdentifier, fileName, userId);
  }

  // Handle Foreplay ads (identifier starts with "foreplay-board:" or "foreplay-swipefile")
  if (kbIdentifier.startsWith('foreplay-board:') || kbIdentifier === 'foreplay-swipefile') {
    return await readForeplayAd(kbIdentifier, fileName, userId);
  }

  // Get the task
  const { taskDb } = await import('../../services/db');
  const task = await taskDb.getTaskById(kbIdentifier);
  if (!task) {
    return { success: false, message: `Knowledge base "${kbIdentifier}" not found` };
  }

  // Auth check: allow public KBs, otherwise owner or any same-org member when
  // shareSettings.knowledgeBase is effectively enabled (editors + owners always
  // pass; plain members only when toggle is on). Mirrors the GET /knowledge-base
  // route so Emma can read the same items the UI shows.
  const isPublic = task.knowledgeBaseType === 'public';
  if (!isPublic && task.userId !== userId) {
    let kbAuthorized = false;
    try {
      const { userDb, orgDb } = await import('../../services/db');
      const { canViewItem } = await import('../../services/orgShareService');
      const [caller, owner] = await Promise.all([
        userDb.getUserById(userId),
        userDb.getUserById(task.userId),
      ]);
      const ownerOrgId = owner?.orgId;
      const callerOrgId = caller?.orgId;
      if (callerOrgId && ownerOrgId && callerOrgId === ownerOrgId) {
        const org = await orgDb.getOrgById(callerOrgId);
        kbAuthorized = canViewItem(
          { userId: task.userId },
          { userId, orgId: callerOrgId, orgRole: caller?.orgRole as 'owner' | 'member' | undefined },
          org,
          ownerOrgId,
          'knowledgeBase',
        );
      }
    } catch (e) {
      console.error('[agentModeService] org KB authorization check failed:', e);
    }
    if (!kbAuthorized) {
      return { success: false, message: 'Not authorized to access this knowledge base file' };
    }
  }

  // Default file size check — skip if the KB has a URL set (size=0 can be stale metadata)
  const size = typeof task.knowledgeBaseSize === 'string'
    ? parseInt(task.knowledgeBaseSize)
    : task.knowledgeBaseSize || 0;
  if (fileName === 'knowledge-base.txt' && size === 0 && !task.knowledgeBase) {
    return { success: false, message: `Knowledge base file "${fileName}" is empty or does not exist` };
  }

  // Storage setup
  const { getGCSPPrivateKey } = await import('../../utils/secretsManager');
  const privateKey = await getGCSPPrivateKey();
  const storage = new Storage({
    projectId: process.env.GCS_PROJECT_ID,
    credentials: { client_email: process.env.GCS_CLIENT_EMAIL, private_key: privateKey }
  });
  const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev';
  const PRIVATE_BUCKET_NAME = process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev';
  const bucketType = task.knowledgeBaseType || 'private';
  const bucket = storage.bucket(bucketType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);

  // Resolve path (use stored key for uploads)
  let filePath: string;
  if (fileName === 'knowledge-base.txt') {
    filePath = `tasks/${kbIdentifier}/knowledge-base.txt`;
  } else {
    const kbFiles = (task as any).knowledgeBaseFiles || [];
    const matched = kbFiles.find((f: any) => f.filename === fileName || f.key?.endsWith(fileName));
    if (!matched) {
      return { success: false, message: `Knowledge base file "${fileName}" not found in metadata` };
    }
    filePath = matched.key || `tasks/${kbIdentifier}/knowledge-base-files/${fileName}`;
  }

  const file = bucket.file(filePath);
  const [exists] = await file.exists();
  if (!exists) {
    return { success: false, message: `Knowledge base file "${fileName}" not found in storage` };
  }

  // Download content
  const [content] = await file.download();
  const [metadata] = await file.getMetadata();
  const contentType = metadata.contentType || '';
  const extension = (fileName.split('.').pop() || '').toLowerCase();

  let contentStr = '';
  try {
    if (extension === 'pdf' || contentType.includes('application/pdf')) {
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(content, { pagerender: pdfPageRender });
      contentStr = pdfData.text || '';
    } else if (['xlsx', 'xls', 'xlsm', 'xlsb'].includes(extension) ||
      contentType.includes('spreadsheetml') || contentType.includes('ms-excel')) {
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
      contentStr = lines.join('\n\n');
    } else if (['txt', 'md', 'html', 'htm', 'csv', 'json', 'xml', 'log'].includes(extension) || contentType.startsWith('text/')) {
      contentStr = content.toString('utf-8');
    } else {
      contentStr = content.toString('base64');
    }
  } catch (parseError: any) {
    console.error('AgentMode: Error parsing file content:', parseError);
    contentStr = content.toString('utf-8');
  }

  const maxContentLength = 1_000_000;
  if (contentStr.length > maxContentLength) {
    contentStr = contentStr.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]';
    console.log(`AgentMode: Knowledge base content truncated to ${maxContentLength} characters`);
  }

  return {
    success: true,
    message: `Successfully read knowledge base file "${fileName}"`,
    kb_identifier: kbIdentifier,
    file_name: fileName,
    name: task.name,
    content: contentStr,
    size: content.length,
    type: bucketType,
    updatedAt: task.knowledgeBaseUpdatedAt || task.updatedAt || task.createdAt
  };
}

/**
 * The two "the name search did not finish" refusals, kept in one place because they are one
 * decision: whether the thing that stopped the read is worth trying again.
 *
 * `failed` — a request errored (5xx, a transport blip, the per-request timeout firing on one
 * unlucky call). That is transient by nature, so "retry" is a remedy that can actually work.
 *
 * `capped` with no failure — the ONLY way to reach that here is
 * `queryDriveFilesAcrossFolders` crossing DRIVE_LIST_WALK_MAX_MS. (Its other capping path,
 * `batchCount >= perBatchTarget`, cannot fire on a zero-result search.) That bound is
 * wall-clock, spent walking a folder tree whose size does not change between attempts, and it
 * is a SECOND such budget after `getGoogleDriveFolderTreeIds` already spent up to the same
 * amount enumerating the sub-folders. A tree big enough to exhaust it therefore exhausts it
 * again, in the same place, on every retry.
 *
 * So the two branches must not share a remedy. Telling the model to "retry the read" on the
 * capped branch is the ENG-1636 failure in miniature — naming a remedy that cannot work — and
 * worse than useless here, because the retry is not free: each attempt burns up to two full
 * DRIVE_LIST_WALK_MAX_MS budgets and the turn's own time, and a deterministic non-answer
 * repeated is a loop. The
 * capped branch is given remedies that change the SCOPE of the search, which is the only
 * variable that can move the outcome.
 */
function driveNameSearchIncompleteMessage(fileName: string, rootName: string, failed?: any): string {
  const preamble =
    `Could not determine whether "${fileName}" is in Google Drive folder "${rootName}" — `;
  if (failed) {
    return preamble
      + `the file search itself failed (${classifyDriveError(failed)}). This is a FAILED read, not a `
      + `confirmed absence: do not report the file as missing. Retry the read.`;
  }
  return preamble
    + `the file search ran out of its time budget before it had covered the whole folder tree. `
    + `This is an INCOMPLETE read, not a confirmed absence: do not report the file as missing. `
    + `Do NOT retry this same call — the budget is a fixed wall-clock bound spent walking this `
    + `folder's sub-folders, so a tree this large will stop in the same place every time. `
    + `The only thing that changes the outcome is a SMALLER search scope: ask the user for the `
    + `file's direct Google Drive link, or for the specific sub-folder it lives in so that `
    + `sub-folder can be registered as its own knowledge base source. If neither is available, `
    + `tell the user plainly that this folder exceeded the read budget for a single search — `
    + `do not describe it as a temporary glitch and do not try again.`;
}

// Helper: read a file from a Google Drive shared folder
async function readGoogleDriveSharedFile(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
  const folderId = kbIdentifier.replace('gdrive:', '');

  // Verify the folder belongs to this user
  const folders = await getUserGoogleDriveFolders(userId);
  if (!folders.some(f => f.folderId === folderId)) {
    return { success: false, message: 'Not authorized to access this Google Drive folder' };
  }

  const folderMeta = folders.find(f => f.folderId === folderId);
  const rootName = folderMeta?.name || folderId;

  try {
    const drive = await getGoogleDriveClient();

    // Find the file by name anywhere in the registered folder's tree (ENG-1624:
    // not just its direct children).
    const { folderIds, restricted, rootRestricted, truncated: folderScanTruncated, throttled: folderScanThrottled, transientFailure: folderScanTransient, boundedStop: folderScanBounded, folderNames } = await getGoogleDriveFolderTreeIds(drive, folderId);
    // pageSizePerBatch of 2 (not 1): a single match is the common case, but this
    // lets an ambiguous name (same filename in two sub-folders) be detected and
    // reported instead of one candidate being picked arbitrarily.
    const { files: filesMap, capped: nameQueryCapped, failed: nameQueryFailed } =
      await queryDriveFilesAcrossFolders(
        drive,
        folderIds,
        `name = '${escapeDriveQueryValue(fileName)}' and trashed = false`,
        'files(id, name, mimeType, size, modifiedTime, parents, shortcutDetails)',
        2
      );
    const files = Array.from(filesMap.values());

    if (files.length === 0) {
      /*
       * "Searched and absent" versus "could not search" — the whole point of this branch.
       *
       * queryDriveFilesAcrossFolders swallows a request failure and reports it as
       * `failed`/`capped` rather than throwing (throwing would discard rows it had already
       * merged). Destructuring only `files` therefore turned a timeout or 5xx on the name
       * query into a confident `File "X" not found in Google Drive folder "Y"` — a definitive
       * absence claim from a read that errored. Before the helper caught the error the
       * rejection reached the outer try and said the read failed, which was correct.
       *
       * Checked before the folder-scan signals below because it is the stronger fact: the
       * name query is what would have found the file, so if IT did not complete, nothing here
       * knows whether the file is there.
       */
      /*
       * `rootRestricted` is checked BEFORE the incomplete-search branch, and the order is the
       * point.
       *
       * Drive answers 403 for a permission denial AND for `userRateLimitExceeded`. The walk
       * now separates the two (`isDriveThrottle`), so `rootRestricted` means a real access
       * decision — but an unreadable root still very often makes the name query fail too, so
       * both flags are set at once. Ranking the search failure first replaced the one remedy the user can act on —
       * share the folder with the service account — with "retry the read", which cannot work
       * while the folder stays unshared. Same "remedy that cannot work" shape as ENG-1636.
       *
       * The incomplete-search caveat is not lost: it is appended, so the message carries the
       * actionable cause AND the fact that absence was never confirmed.
       */
      /*
       * A quota answer is not a shape answer, and it outranks everything below.
       *
       * A throttled walk sets `truncated`, and the only branch that consumed it said "the
       * folder tree is large enough that the scan stopped" — so a rate-limited user was told
       * their folder was too big and invited to narrow a search that would throttle just the
       * same. Every other branch here describes the folder; this one describes Drive.
       */
      if (folderScanThrottled) {
        return {
          success: false,
          message: `File "${fileName}" was not found, but Google Drive rate-limited the scan of `
            + `folder "${rootName}", so the search did not finish. This is a temporary quota answer, `
            + `NOT a permissions or size problem — nothing needs to be shared and narrowing will not `
            + `help. Wait a minute and try again. Do NOT report the file as absent.`,
        };
      }
      if (rootRestricted) {
        return {
          success: false,
          message: `File "${fileName}" not found — the Google Drive folder "${rootName}" itself could not be accessed. Share it with ${getGoogleDriveServiceAccountEmail()} to allow access.`
            + (nameQueryFailed || nameQueryCapped ? ' The file search did not complete either, so this is not a confirmed absence.' : '')
        };
      }
      if (nameQueryFailed || nameQueryCapped) {
        return {
          success: false,
          message: driveNameSearchIncompleteMessage(fileName, rootName, nameQueryFailed)
        };
      }
      if (restricted.length > 0) {
        const names = restricted.map(r => `"${r.name}"`).join(', ');
        return {
          success: false,
          message: `File "${fileName}" not found in Google Drive folder "${rootName}". Sub-folder(s) ${names} could not be accessed — share them with ${getGoogleDriveServiceAccountEmail()} to allow access.`
        };
      }
      if (folderScanTruncated) {
        return {
          success: false,
          message: `File "${fileName}" not found in Google Drive folder "${rootName}" — but the folder scan did not cover the whole tree, so this is not a confirmed absence. `
            // Deterministic bound checked FIRST: the causes are not exclusive, and a walk that
            // hit both will hit the bound again next time, so a retry cannot help.
            + (folderScanTransient && !folderScanBounded
              ? `A sub-folder read failed part-way, so retrying may well complete the scan.`
              : `It stopped at a fixed folder-count or time bound, so a tree this size will stop in the same place every time. Do NOT retry this same call — narrow to a specific sub-folder, or ask the user for a direct Google Drive link.`)
        };
      }
      return { success: false, message: `File "${fileName}" not found in Google Drive folder "${rootName}"` };
    }

    if (files.length > 1) {
      // A Drive file can have more than one parent — index [0] may be a
      // folder outside the tree that was actually searched, which would
      // point someone at the wrong place. Prefer whichever parent is
      // actually in `folderIds`; only fall back to [0] when none of the
      // file's parents resolve within the searched tree (shouldn't happen
      // in practice, since the file matched a query scoped to folderIds).
      const folderIdSet = new Set(folderIds);
      const candidates = files.map(f => {
        const parentId = (f.parents || []).find((p: string) => folderIdSet.has(p)) ?? (f.parents || [])[0];
        const location = parentId === folderId ? rootName : (folderNames.get(parentId) || parentId || 'an unresolved sub-folder');
        return `"${f.name}" in "${location}"`;
      }).join(', ');
      return {
        success: false,
        message: `Multiple files named "${fileName}" found in Google Drive folder "${rootName}": ${candidates}. Use a more specific file name, or move the duplicates so names are unique.`
      };
    }

    const matchedFile = files[0];
    let file = matchedFile;
    if (matchedFile.mimeType === 'application/vnd.google-apps.shortcut') {
      const targetId = matchedFile.shortcutDetails?.targetId;
      if (!targetId) {
        throw new Error(`Google Drive shortcut "${fileName}" has no target`);
      }
      const targetMeta = await drive.files.get({
        fileId: targetId,
        fields: 'id,name,mimeType,size,modifiedTime',
        supportsAllDrives: true,
      });
      file = targetMeta.data;
    }

    const isGoogleDoc =
      file.mimeType === 'application/vnd.google-apps.document' ||
      file.mimeType === 'application/vnd.google-apps.spreadsheet' ||
      file.mimeType === 'application/vnd.google-apps.presentation';
    const [contentStr, commentsStr] = await Promise.all([
      readGoogleDriveFileContent(drive, file.id!, file.name || fileName, file.mimeType || ''),
      isGoogleDoc ? fetchDriveFileComments(drive, file.id!) : Promise.resolve(''),
    ]);

    const maxContentLength = 1_000_000;
    const combined = contentStr + commentsStr;
    const truncated = combined.length > maxContentLength
      ? combined.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
      : combined;

    return {
      success: true,
      message: `Successfully read Google Drive file "${fileName}"`,
      kb_identifier: kbIdentifier,
      file_name: fileName,
      name: folderMeta?.name || folderId,
      content: truncated,
      size: file.size ? parseInt(file.size, 10) : contentStr.length,
      type: 'google-drive',
      modifiedTime: file.modifiedTime,
    };
  } catch (error) {
    console.error('AgentMode: Error reading Google Drive file:', error);
    // ENG-1300: carry the real numeric HTTP status through so a clean
    // 401/403/404 classifies as auth/not_found instead of the generic
    // Error/bug fallback once toolResultError rebuilds an Error from the
    // message alone.
    const code = (error as any)?.code || (error as any)?.status;
    return {
      success: false,
      message: `Failed to read Google Drive file "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      code,
    };
  }
}

// Maximum bytes materialize_knowledge_base_asset will download/upload for one file.
const MATERIALIZE_ASSET_MAX_BYTES = 200 * 1024 * 1024;

/**
 * ENG-2840: the body of a download, read up to `maxBytes`. Returns null (and stops the download) as soon as more than `maxBytes` arrive.
 * A body that is already a buffer (some transports, and tests) is measured as is.
 */
async function readWithByteCap(body: unknown, maxBytes: number): Promise<Buffer | null> {
  if (Buffer.isBuffer(body)) return body.length > maxBytes ? null : body;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const buffer = Buffer.from(body as any);
    return buffer.length > maxBytes ? null : buffer;
  }
  const stream = body as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
  if (!stream || typeof (stream as any).on !== 'function') return Buffer.alloc(0);
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    stream.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > maxBytes) {
        done = true;
        chunks.length = 0;
        stream.destroy?.();
        resolve(null);
        return;
      }
      chunks.push(piece);
    });
    stream.on('end', () => {
      if (!done) { done = true; resolve(Buffer.concat(chunks)); }
    });
    stream.on('error', (error: Error) => {
      if (!done) { done = true; reject(error); }
    });
  });
}

/**
 * Turn an image/video file from a connected Google Drive knowledge base
 * folder into a real, hosted S3 asset with a usable URL.
 *
 * readGoogleDriveSharedFile / readGoogleDriveFileContent are text-oriented:
 * a binary file falls through to `content.toString('base64')` inside a
 * knowledge-base tool response capped at 1,000,000 characters, which
 * silently truncates (and corrupts) anything but a tiny file, and nothing
 * downstream consumes that base64 blob anyway (ad-creative tools need a
 * real image_url/image_hash/video_id). This bypasses that path entirely:
 * download raw bytes -> upload to S3 -> return a URL other tools can use
 * directly, mirroring the existing removeC2PAFromImage upload pattern.
 */
export async function materializeKnowledgeBaseAsset(
  kbIdentifier: string,
  fileName: string,
  userId: string
): Promise<any> {
  if (!kbIdentifier || !fileName) {
    return { success: false, message: 'kb_identifier and file_name are required' };
  }

  if (!kbIdentifier.startsWith('gdrive:')) {
    return {
      success: false,
      message: 'materialize_knowledge_base_asset currently only supports Google Drive knowledge base sources (kb_identifier starting with "gdrive:")'
    };
  }

  const folderId = kbIdentifier.replace('gdrive:', '');
  const folders = await getUserGoogleDriveFolders(userId);
  if (!folders.some(f => f.folderId === folderId)) {
    return { success: false, message: 'Not authorized to access this Google Drive folder' };
  }
  const rootName = folders.find(f => f.folderId === folderId)?.name || folderId;

  try {
    const drive = await getGoogleDriveClient();

    // Search the whole folder tree rooted at the registered folder (ENG-1624),
    // not just its direct children.
    const { folderIds, restricted, rootRestricted, truncated, throttled: folderScanThrottled, transientFailure: folderScanTransient, boundedStop: folderScanBounded, folderNames } = await getGoogleDriveFolderTreeIds(drive, folderId);
    // pageSizePerBatch of 2 (not 1): a single match is the common case, but this
    // lets an ambiguous name (same filename in two sub-folders) be detected and
    // reported instead of one candidate being materialized arbitrarily.
    const { files: filesMap, capped: nameQueryCapped, failed: nameQueryFailed } =
      await queryDriveFilesAcrossFolders(
        drive,
        folderIds,
        `name = '${escapeDriveQueryValue(fileName)}' and trashed = false`,
        'files(id, name, mimeType, size, parents)',
        2
      );
    const files = Array.from(filesMap.values());

    if (files.length === 0) {
      // Same distinction readGoogleDriveSharedFile draws, for the same reason: the helper
      // reports a failed request as `failed`/`capped` instead of throwing, so ignoring both
      // flags turned an errored search into a definitive "not found". Shared wording too, so
      // the transient/deterministic split cannot drift between the two call sites.
      /*
       * `rootRestricted` is checked BEFORE the incomplete-search branch, and the order is the
       * point.
       *
       * Drive answers 403 for a permission denial AND for `userRateLimitExceeded`. The walk
       * now separates the two (`isDriveThrottle`), so `rootRestricted` means a real access
       * decision — but an unreadable root still very often makes the name query fail too, so
       * both flags are set at once. Ranking the search failure first replaced the one remedy the user can act on —
       * share the folder with the service account — with "retry the read", which cannot work
       * while the folder stays unshared. Same "remedy that cannot work" shape as ENG-1636.
       *
       * The incomplete-search caveat is not lost: it is appended, so the message carries the
       * actionable cause AND the fact that absence was never confirmed.
       */
      /*
       * A quota answer is not a shape answer, and it outranks everything below.
       *
       * A throttled walk sets `truncated`, and the only branch that consumed it said "the
       * folder tree is large enough that the scan stopped" — so a rate-limited user was told
       * their folder was too big and invited to narrow a search that would throttle just the
       * same. Every other branch here describes the folder; this one describes Drive.
       */
      if (folderScanThrottled) {
        return {
          success: false,
          message: `File "${fileName}" was not found, but Google Drive rate-limited the scan of `
            + `folder "${rootName}", so the search did not finish. This is a temporary quota answer, `
            + `NOT a permissions or size problem — nothing needs to be shared and narrowing will not `
            + `help. Wait a minute and try again. Do NOT report the file as absent.`,
        };
      }
      if (rootRestricted) {
        return {
          success: false,
          message: `File "${fileName}" not found — the Google Drive folder "${rootName}" itself could not be accessed. Share it with ${getGoogleDriveServiceAccountEmail()} to allow access.`
            + (nameQueryFailed || nameQueryCapped ? ' The file search did not complete either, so this is not a confirmed absence.' : '')
        };
      }
      if (nameQueryFailed || nameQueryCapped) {
        return {
          success: false,
          message: driveNameSearchIncompleteMessage(fileName, rootName, nameQueryFailed)
        };
      }
      if (restricted.length > 0) {
        const names = restricted.map(r => `"${r.name}"`).join(', ');
        return {
          success: false,
          message: `File "${fileName}" not found in Google Drive folder. Sub-folder(s) ${names} could not be accessed — share them with ${getGoogleDriveServiceAccountEmail()} to allow access.`
        };
      }
      if (truncated) {
        return {
          success: false,
          message: `File "${fileName}" not found in Google Drive folder "${rootName}" — but the folder scan did not cover the whole tree, so this is not a confirmed absence. `
            // Deterministic bound checked FIRST: the causes are not exclusive, and a walk that
            // hit both will hit the bound again next time, so a retry cannot help.
            + (folderScanTransient && !folderScanBounded
              ? `A sub-folder read failed part-way, so retrying may well complete the scan.`
              : `It stopped at a fixed folder-count or time bound, so a tree this size will stop in the same place every time. Do NOT retry this same call — narrow to a specific sub-folder, or ask the user for a direct Google Drive link.`)
        };
      }
      return { success: false, message: `File "${fileName}" not found in Google Drive folder` };
    }

    if (files.length > 1) {
      // A Drive file can have more than one parent — index [0] may be a
      // folder outside the tree that was actually searched, which would
      // point someone at the wrong place. Prefer whichever parent is
      // actually in `folderIds`; only fall back to [0] when none of the
      // file's parents resolve within the searched tree (shouldn't happen
      // in practice, since the file matched a query scoped to folderIds).
      const folderIdSet = new Set(folderIds);
      const candidates = files.map(f => {
        const parentId = (f.parents || []).find((p: string) => folderIdSet.has(p)) ?? (f.parents || [])[0];
        const location = parentId === folderId ? rootName : (folderNames.get(parentId) || parentId || 'an unresolved sub-folder');
        return `"${f.name}" in "${location}"`;
      }).join(', ');
      return {
        success: false,
        message: `Multiple files named "${fileName}" found in Google Drive folder "${rootName}": ${candidates}. Use a more specific file name, or move the duplicates so names are unique.`
      };
    }

    const file = files[0];
    const mimeType = file.mimeType || '';
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
      return {
        success: false,
        message: `"${fileName}" is a ${mimeType || 'unknown type'} file. materialize_knowledge_base_asset only handles images/videos — use read_knowledge_base_files for text/document content.`
      };
    }

    const size = file.size ? parseInt(file.size, 10) : 0;
    if (size > MATERIALIZE_ASSET_MAX_BYTES) {
      return {
        success: false,
        message: `"${fileName}" is ${Math.round(size / (1024 * 1024))}MB, over the ${MATERIALIZE_ASSET_MAX_BYTES / (1024 * 1024)}MB limit for asset materialization`
      };
    }

    // ENG-2840: streamed with the byte cap applied while downloading. Drive's reported `size` can be missing or stale (e.g. 0 during a
    // virus scan); before, the whole file was buffered first and only then measured, so a large file with bad metadata was held in memory
    // in full.
    const mediaResponse = await drive.files.get(
      { fileId: file.id!, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    const buffer = await readWithByteCap(mediaResponse.data, MATERIALIZE_ASSET_MAX_BYTES);
    if (!buffer) {
      return {
        success: false,
        message: `"${fileName}" is over the ${MATERIALIZE_ASSET_MAX_BYTES / (1024 * 1024)}MB limit for asset materialization`
      };
    }

    const { uploadFileToS3 } = await import('../../utils/s3Utils');
    const uploadResult = await uploadFileToS3(buffer, file.name || fileName, userId, mimeType);

    if (!uploadResult.success || !uploadResult.url) {
      return {
        success: false,
        message: uploadResult.error || 'Failed to upload asset to S3',
        error: uploadResult.error || 's3_upload_failed'
      };
    }

    return {
      success: true,
      message: `Materialized "${fileName}" from Google Drive as a hosted asset.`,
      url: uploadResult.url,
      file_name: file.name || fileName,
      mime_type: mimeType,
      size,
      kb_identifier: kbIdentifier
    };
  } catch (error: any) {
    console.error('AgentMode: Error materializing knowledge base asset:', error);
    const code = driveErrorCode(error);
    if (code === 404) {
      return { success: false, message: `File "${fileName}" not found or not accessible` };
    }
    const throttled = driveThrottleRefusal(error);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Access denied reading this Google Drive file' };
    }
    return {
      success: false,
      message: `Failed to materialize "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

// Helper: read a document from a ClickUp workspace
export async function readClickUpSharedDoc(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
  const workspaceId = kbIdentifier.replace('clickup:', '');

  try {
    const clickUpToken = await getClickUpAccessToken(userId);
    if (!clickUpToken) {
      return { success: false, message: 'ClickUp not connected' };
    }

    // Verify user has access to this workspace
    const workspaces = await getClickUpWorkspaces(clickUpToken);
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace) {
      return { success: false, message: 'Not authorized to access this ClickUp workspace' };
    }

    // Find the doc by name in the workspace
    const docs = await listClickUpDocs(clickUpToken, workspaceId);
    const doc = docs.find(d => d.name === fileName);
    if (!doc) {
      return { success: false, message: `Document "${fileName}" not found in ClickUp workspace "${workspace.name}"` };
    }

    // Read doc content (all pages concatenated)
    const content = await readClickUpDocContent(clickUpToken, workspaceId, doc.id);

    const maxContentLength = 1_000_000;
    const truncated = content.length > maxContentLength
      ? content.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
      : content;

    return {
      success: true,
      message: `Successfully read ClickUp document "${fileName}"`,
      kb_identifier: kbIdentifier,
      file_name: fileName,
      name: workspace.name,
      content: truncated,
      size: content.length,
      type: 'clickup',
      dateUpdated: doc.dateUpdated,
    };
  } catch (error) {
    console.error('AgentMode: Error reading ClickUp doc:', error);
    // ENG-1300: carry the real numeric HTTP status through so a clean
    // 401/403/404 classifies as auth/not_found instead of the generic
    // Error/bug fallback once toolResultError rebuilds an Error from the
    // message alone.
    const code = (error as any)?.response?.status || (error as any)?.code;
    return {
      success: false,
      message: `Failed to read ClickUp document "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      code,
    };
  }
}

// Helper: read a task from a ClickUp workspace
export async function readClickUpTask(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
  const workspaceId = kbIdentifier.replace('clickup-tasks:', '');

  try {
    const clickUpToken = await getClickUpAccessToken(userId);
    if (!clickUpToken) {
      return { success: false, message: 'ClickUp not connected' };
    }

    // Verify user has access to this workspace
    const workspaces = await getClickUpWorkspaces(clickUpToken);
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace) {
      return { success: false, message: 'Not authorized to access this ClickUp workspace' };
    }

    // Find the task by name in the workspace
    const tasks = await listClickUpTasks(clickUpToken, workspaceId);
    const task = tasks.find(t => t.name === fileName);
    if (!task) {
      return { success: false, message: `Task "${fileName}" not found in ClickUp workspace "${workspace.name}"` };
    }

    // Read task content (formatted as markdown)
    const content = await readClickUpTaskContent(clickUpToken, task.id);

    const maxContentLength = 1_000_000;
    const truncated = content.length > maxContentLength
      ? content.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
      : content;

    return {
      success: true,
      message: `Successfully read ClickUp task "${fileName}"`,
      kb_identifier: kbIdentifier,
      file_name: fileName,
      name: workspace.name,
      content: truncated,
      size: content.length,
      type: 'clickup-tasks',
      dateUpdated: task.dateUpdated,
    };
  } catch (error) {
    console.error('AgentMode: Error reading ClickUp task:', error);
    // ENG-1300: carry the real numeric HTTP status through — see readClickUpSharedDoc above.
    const code = (error as any)?.response?.status || (error as any)?.code;
    return {
      success: false,
      message: `Failed to read ClickUp task "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      code,
    };
  }
}

// Helper: create a new document in a ClickUp workspace
export async function writeClickUpDoc(
  workspaceId: string,
  name: string,
  content: string,
  userId: string,
  parentDocId?: string
): Promise<{ success: boolean; message: string; docId?: string; code?: number; errorType?: ClickUpDocErrorType }> {
  // ENG-1892: reject malformed arguments locally and name the bad parameter,
  // instead of letting ClickUp answer with an unreadable 400.
  const badParam = !isNonEmptyString(workspaceId) ? 'workspace_id'
    : !isNonEmptyString(name) ? 'name'
    : typeof content !== 'string' ? 'content'
    : parentDocId !== undefined && parentDocId !== null && !isNonEmptyString(parentDocId) ? 'parent_doc_id'
    : null;
  if (badParam) {
    return {
      success: false,
      errorType: 'invalid_parameter',
      message: `Invalid parameter "${badParam}" for write_clickup_doc: ${badParam === 'content' ? 'must be a string' : 'must be a non-empty string'}.`,
    };
  }
  try {
    const clickUpToken = await getClickUpAccessToken(userId);
    if (!clickUpToken) {
      return { success: false, errorType: 'configuration', message: 'ClickUp not connected' };
    }

    // Verify user has access to this workspace
    const workspaces = await getClickUpWorkspaces(clickUpToken);
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace) {
      return { success: false, errorType: 'configuration', message: 'Not authorized to access this ClickUp workspace' };
    }

    if (parentDocId) {
      // Create as a page inside the specified parent doc
      const page = await createClickUpPageInDoc(clickUpToken, workspaceId, parentDocId, name, content);
      return {
        success: true,
        message: `Successfully created page "${name}" inside ClickUp doc (id: ${parentDocId}) in workspace "${workspace.name}"`,
        docId: page.id,
      };
    }

    // Create as a standalone doc at workspace root, then attach the content as its
    // first page. ClickUp's doc-create endpoint has no `content` param — content
    // must be added via a separate page-create call, mirroring the parentDocId branch above.
    const doc = await createClickUpDoc(clickUpToken, workspaceId, name);
    try {
      await createClickUpPageInDoc(clickUpToken, workspaceId, doc.id, name, content);
    } catch (pageError) {
      // The doc itself already exists in ClickUp at this point. Reporting a hard
      // failure would risk the caller retrying and creating a second, duplicate
      // empty doc — report partial success with the doc id instead.
      console.error('AgentMode: Created ClickUp doc but failed to add its content page:', pageError);
      return {
        success: true,
        message: `Created ClickUp document "${name}" in workspace "${workspace.name}", but failed to save its content: ${pageError instanceof Error ? pageError.message : 'Unknown error'}. Retry by calling write_clickup_doc with parent_doc_id="${doc.id}" to add the content as a page.`,
        docId: doc.id,
      };
    }
    return {
      success: true,
      message: `Successfully created ClickUp document "${name}" in workspace "${workspace.name}"`,
      docId: doc.id,
    };
  } catch (error: any) {
    console.error('AgentMode: Error creating ClickUp doc:', error);

    // ENG-1354: ClickUp's own API error body ({ err, ECODE }) is the only thing
    // that can distinguish an OAuth-scope problem from a workspace-side
    // permission restriction from a malformed request — Axios's generic
    // "Request failed with status code N" collapses all three into the same
    // unreadable message. Mirrors the error.response?.data extraction already
    // used in publishBlogArticle.
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const clickUpError = error?.response?.data;
    if (clickUpError?.err) {
      errorMessage = `${clickUpError.err}${clickUpError.ECODE ? ` (ClickUp code: ${clickUpError.ECODE})` : ''}`;
    }

    // ENG-1300: carry the real numeric HTTP status through — see readClickUpSharedDoc
    // above. Deliberately NOT the ECODE extracted above, which is ClickUp's own
    // business code (e.g. "OAUTH_019"), not an HTTP status.
    const code = error?.response?.status;
    const errorType = classifyClickUpDocError(code);
    const bodySnippet = !clickUpError?.err && clickUpError !== undefined
      ? ` ClickUp response: ${truncateForError(clickUpError)}`
      : '';
    const statusText = typeof code === 'number' ? ` (HTTP ${code})` : '';
    const guidance = errorType === 'configuration'
      ? ' Reconnect ClickUp in Settings > Integrations and make sure the AgentWeb app is allowed to create Docs in this workspace.'
      : errorType === 'invalid_parameter'
        ? ' Check workspace_id, name, content and parent_doc_id (parent_doc_id must be a docId from list_knowledge_base_files).'
        : '';

    return {
      success: false,
      errorType,
      message: `Failed to create ClickUp document "${name}"${statusText}: ${errorMessage}.${bodySnippet}${guidance}`,
      code,
    };
  }
}

export type ClickUpDocErrorType = 'configuration' | 'invalid_parameter' | 'not_found' | 'runtime';

// ENG-1892: one class per failure family so the agent (and reliability runs)
// can tell auth/config from schema from runtime failures.
export function classifyClickUpDocError(status: unknown): ClickUpDocErrorType {
  if (status === 401 || status === 403) return 'configuration';
  if (status === 400 || status === 422) return 'invalid_parameter';
  if (status === 404) return 'not_found';
  return 'runtime';
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function truncateForError(body: unknown): string {
  let text: string;
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    text = String(body);
  }
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

// Helper: read a Foreplay ad from swipefile or a board
export async function readForeplayAd(kbIdentifier: string, fileName: string, userId: string): Promise<any> {
  try {
    const foreplayToken = await getForeplayAccessToken(userId);
    if (!foreplayToken) {
      return { success: false, message: 'Foreplay not connected' };
    }

    let ads: ForeplayAd[] = [];
    let sourceName = '';

    if (kbIdentifier === 'foreplay-swipefile') {
      const result = await getForeplaySwipefileAds(foreplayToken, { limit: 250 });
      ads = result.ads;
      sourceName = 'Swipe File';
    } else if (kbIdentifier.startsWith('foreplay-board:')) {
      const boardId = kbIdentifier.replace('foreplay-board:', '');
      ads = await getAllForeplayBoardAds(foreplayToken, boardId);
      sourceName = `Board ${boardId}`;
    }

    // Find the ad by name, headline, or ID
    const ad = ads.find(a =>
      (a.name && a.name === fileName) ||
      (a.headline && a.headline === fileName) ||
      a.id === fileName
    );

    if (!ad) {
      return { success: false, message: `Ad "${fileName}" not found in Foreplay ${sourceName}` };
    }

    const content = formatForeplayAdAsMarkdown(ad);
    const maxContentLength = 50000;
    const truncated = content.length > maxContentLength
      ? content.substring(0, maxContentLength) + '\n\n[Content truncated due to size limit]'
      : content;

    return {
      success: true,
      message: `Successfully read Foreplay ad "${fileName}"`,
      kb_identifier: kbIdentifier,
      file_name: fileName,
      name: ad.brandName || 'Unknown Brand',
      content: truncated,
      size: content.length,
      type: kbIdentifier === 'foreplay-swipefile' ? 'foreplay-swipefile' : 'foreplay-board',
    };
  } catch (error) {
    console.error('AgentMode: Error reading Foreplay ad:', error);
    return {
      success: false,
      message: `Failed to read Foreplay ad "${fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: (error as any)?.response?.status
    };
  }
}
