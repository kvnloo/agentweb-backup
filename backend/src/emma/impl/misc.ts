/**
 * ENG-2103 (F2) — skills/admin + file ops + misc tool cluster, extracted from
 * `AgentModeService`. Cluster 22 in this series — the LAST mechanical
 * cluster, combining three small originally-separate planned groups
 * ("skills/admin", "file ops", "misc") into one module since each is tiny.
 * After this cluster, the only remaining un-migrated `emma/tools.ts` call
 * sites are the three flagged `this.callLLM`-coupled design-decision
 * exclusions (`createHtmlFromTemplate`, `modifyWorkPlan`,
 * `resolveEmployersForSizeFilter`) plus `linkedinManagePost` (cluster 16,
 * kept on the class for a sibling-method-spy test-compatibility reason).
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 *   - `getAdminToolNames` (was `public`, fully synchronous, ~6607-6609
 *     pre-extraction) — returns the admin-only tool-name allowlist.
 *   - `saveFile` (`public async`, ~17016-17130 pre-extraction) — content-hash
 *     deduplicated S3 upload for the `save_file` tool. NOT a pure verbatim
 *     move: see "fileContentCache: injected parameters, not a module
 *     singleton" below for the one deliberate deviation from this series'
 *     usual cache-promotion treatment, and why.
 *   - `readFileContent` (`public async`, ~17146-17410 pre-extraction) — reads
 *     and extracts text from a file URL (S3, Google Drive/Docs refusal,
 *     external fetch; PDF/Excel/Word/plain-text extraction). Zero instance-
 *     state dependency — a pure function of its one argument.
 *   - `sendEmailFromConfiguredSender` (`public async`, ~10261-10449
 *     pre-extraction) — ad-hoc chat-driven email send through the user's
 *     configured CRM sender(s). Non-contiguous: sits in the leads/CRM area
 *     (cluster 6's territory) but was deliberately left out of that round.
 *     Its only instance-state dependency, `this.getCrmSenders(userId)`, is
 *     already a thin delegating wrapper around
 *     `emma/impl/shared/crmSenders.ts`'s `getCrmSenders` (a cluster-6
 *     extraction). This module imports that shared function directly and uses
 *     it as the DEFAULT for an injected `getCrmSendersFn` parameter — see
 *     `sendEmailFromConfiguredSender`'s own doc comment below for why it is
 *     injected rather than hardcoded (a real `jest.spyOn(service,
 *     'getCrmSenders')` test dependency, not a hypothetical one).
 *     `providerLabel` was already a plain, stateless top-level import
 *     (`./crmSenderTypes`) in the original file — imported here unchanged.
 *
 * One of the six originally-scoped methods is explicitly NOT moved — a
 * judgment call, reported per the cluster brief rather than forced through:
 *
 *   - `installSkills` — depends on three skills-subsystem methods:
 *     `this.getSkillsForDisplay` (public, itself calls the same
 *     `loadAuthorizedSkillCatalog`/`getUnassociatedTools` infrastructure
 *     described below) and two PRIVATE methods, `this.classifySkillRejections`
 *     and `this.describeRejections` — both substantial, actively-tuned
 *     entitlement/error-classification logic (ENG-1795, ENG-1237, ENG-1945
 *     references throughout), not incidental reads. Extracting `installSkills`
 *     would need three injected function parameters just to keep it working —
 *     more machinery than any single-parameter `AccountResolver`/
 *     `EmployerSizeFilterResolver` precedent in this series — for a module
 *     function that would still be, in substance, almost entirely calls back
 *     into class-internal skills infrastructure. Not worth forcing. Kept
 *     entirely on the class, same treatment as `linkedinManagePost`
 *     (cluster 16). `emma/tools.ts`'s `install_skills` tool,
 *     `mcp/server/apiTools.ts`, `controllers/agentModeController.ts`, and
 *     `controllers/benchmark.ts` all keep calling `agentModeService.
 *     installSkills` unchanged.
 *
 * Confirmed via grep: `installSkills` (nor anything in this cluster) touches
 * any of the ~9 remaining out-of-scope skills-subsystem methods' own bodies —
 * `getFoundationToolNames`, `loadFoundationTools`, `updateFoundationTools`,
 * `buildAvailableSkillsMessage`, `loadAuthorizedSkillCatalog`,
 * `getAuthorizedSkill`, `applyOpeningAction`, `classifySkillRejections`,
 * `describeRejections` are all untouched, still on the class, exactly as
 * before this cluster. `convertToPdf` (cluster 5, already a thin delegate to
 * `htmlTools.ts` sitting between `saveFile` and `readFileContent` in the
 * original file) is also untouched.
 *
 * ENG-2103 F2 FOLLOW-UP (design-decision list, item 9/12) — `getUnassociatedTools`
 * (private) and `getUnassociatedToolNames` (public) MOVED here, reversing this
 * cluster's original "kept entirely on the class" call. The original scoping
 * (see git history on this file) theorized this was a "promote a mutable
 * static field to a module singleton" job — that theory was WRONG. The real
 * shape is the same injected-parameter pattern as `AccountResolver`
 * (cluster 15) / `EmployerSizeFilterResolver` (cluster 16), with TWO
 * dependencies:
 *   1. `AgentModeService.FOUNDATION_TOOLS` — a `public static Set<string>`
 *      REASSIGNED at runtime by two still-out-of-scope methods
 *      (`loadFoundationTools`/`updateFoundationTools`, core turn-loop/session-init
 *      infrastructure, never touched by this cluster). Since the whole `Set`
 *      object is replaced wholesale (`AgentModeService.FOUNDATION_TOOLS = new
 *      Set(merged)`), a value captured once at construction/import time would
 *      go stale the moment a `foundation_tools` DB override loads or an admin
 *      calls `PUT /foundation-tools`. Injected as `foundationTools:
 *      ReadonlySet<string>` — the class wrapper reads
 *      `AgentModeService.FOUNDATION_TOOLS` fresh on every call (not captured
 *      in a closure), so this module never needs to know the field is
 *      mutable, only that it receives a current snapshot each invocation.
 *   2. `this.toolRegistry.getAllTools()` — `toolRegistry` is a PRIVATE,
 *      per-INSTANCE `ToolRegistry` (`mcp/client/toolRegistry.ts`, constructed
 *      once in the constructor: `this.toolRegistry = new ToolRegistry()`).
 *      This is NOT the same object as the module-level `emmaToolRegistry`
 *      singleton in `emma/registry.ts` (a different class, `McpToolRegistry`,
 *      used by the external-facing MCP server path) — conflating the two
 *      would silently return the wrong tool population. `this.toolRegistry`'s
 *      contents change at runtime (tools are registered/unregistered
 *      post-construction, e.g. during `initialize()` and per-session MCP tool
 *      registration), so this is injected as a `getAllTools: () => AgentTool[]`
 *      function parameter — same shape as `AccountResolver` — rather than a
 *      pre-resolved array, so a snapshot is never captured before the caller
 *      is ready to use it.
 *
 * Since `toolRegistry` is private instance state, NONE of the three real
 * external callers of `getUnassociatedToolNames` beyond this cluster
 * (`emma/tools.ts`'s `list_available_skills` tool; `services/subscriptionService.
 * ts`'s `resolveSkillsToToolNames`, confirmed via its own pre-existing doc
 * comment; and `routes/admin.ts`'s `GET /available-skills`, found by a
 * whole-backend grep the original brief's scoping had missed) have any legal
 * way to reach `this.toolRegistry` — all three keep calling
 * `agentModeService.getUnassociatedToolNames(publishedSkills)` on the
 * singleton unchanged, the same load-bearing "tools.ts cannot repoint" shape
 * `fileContentCache`/`saveFile` below already established in this cluster.
 * `getUnassociatedTools` (private) also keeps three real IN-CLASS callers
 * (`buildAvailableSkillsMessage`, `getSkillsForDisplay`, `buildSkillContext` —
 * all still-out-of-scope skills-subsystem methods, untouched) reaching it via
 * `this.getUnassociatedTools(publishedSkills)`, so the class keeps a private
 * delegating wrapper too, not just the public one.
 *
 * `getUnassociatedToolNames` calls sibling `getUnassociatedTools` internally
 * (same as the original class code) — both now live in this module, so per
 * the cluster-10 sibling-function-spy lesson, the internal call goes through
 * a same-module self-import (`import * as self from './misc'`) rather than a
 * bare local reference, so an external `jest.spyOn(miscImpl,
 * 'getUnassociatedTools')` still intercepts it.
 *
 * `IMAGE_EXTENSIONS`/`VIDEO_EXTENSIONS` (were module-level consts in
 * `agentModeService.ts`, ~1121-1122) are MOVED here, not duplicated: cluster
 * 21's `video.ts` already duplicated its own copy of `IMAGE_EXTENSIONS` for
 * `describeVideo`, noting at the time that the original was "shared with an
 * out-of-scope call site elsewhere" — that call site was `readFileContent`,
 * which is THIS cluster. Now that `readFileContent` moves too, the original
 * `agentModeService.ts` constants have zero remaining callers and are deleted
 * outright (confirmed by whole-backend grep — no other reference anywhere).
 * `PDFData` (was a module-level interface, ~908-915) is exclusive to
 * `readFileContent` and moved here the same way.
 *
 * `ADMIN_SKILL_TOOL_NAMES` (was a module-level const in `agentModeService.ts`,
 * ~line 307, still exported from there today) is DUPLICATED here, not
 * imported back — it is used both here (`getUnassociatedTools`'s exclusion
 * set, moved in the F2 follow-up above) AND by three other, still-out-of-scope
 * skills-subsystem call sites in the class (the admin-tools virtual-skill
 * catalog entry, `applyOpeningAction`'s neighborhood allowlist, and the admin
 * skill-context prose in `buildSkillContext`), so importing it back would
 * either re-export class-adjacent state or force a static import of
 * `agentModeService.ts` itself. Per the F2 design draft §3.2 ("just
 * strings/literals; inline them")
 * and the exact precedent cluster 21's `video.ts` set for `IMAGE_EXTENSIONS`
 * in the same shared-with-out-of-scope situation, this is a plain literal
 * duplicate. Confirmed the source array is a plain `const`, never mutated
 * anywhere in the class (only `.forEach`/`.join`/spread), so there is no
 * runtime-drift risk the way `FOUNDATION_TOOLS` above has — the only
 * maintenance cost is two literals to keep in sync by hand if the admin tool
 * list ever changes, an accepted tradeoff matching prior-cluster precedent.
 *
 * `fileContentCache`: injected parameters, not a module singleton — a
 * DELIBERATE departure from this series' usual "pure cache → module-level
 * singleton" treatment (cluster 20's `dataAnalysisConsistencyCache`, the F2
 * design draft §3.2's own flagship example, which names `fileContentCache`
 * itself as an example of the pattern). Two things make this cache NOT
 * "pure" in the sense §3.2 means: (1) `agentModeService.fileCache.test.ts`
 * (334 lines) does deep, direct reflection on real `AgentModeService`
 * instance internals — `(service as any).fileContentCache`,
 * `.cleanupFileCache()`, `.startFileCacheCleanup()`,
 * `.fileCacheCleanupInterval` — across ~15 test cases, each constructing a
 * fresh `new AgentModeService()` and expecting a FRESH, empty cache; a
 * module-level singleton would reproduce cluster 20's exact "promoting from
 * an instance field broke test ISOLATION" regression, at higher cost since
 * this test suite's coupling to instance internals is far deeper than a
 * single fake-timer test. (2) The cache's lifecycle is genuinely
 * instance-bound, not just co-located: `startFileCacheCleanup()` (called once
 * from the constructor) owns a real `setInterval` handle
 * (`fileCacheCleanupInterval`) that `shutdown()` clears — neither of which is
 * part of this cluster's two target methods, so promoting the cache alone
 * would split one lifecycle across two files for no benefit. Instead,
 * `saveFile` here takes the cache `Map` and a `cleanupFileContentCache`
 * callback as parameters; `AgentModeService.prototype.saveFile` passes
 * `this.fileContentCache` and `() => this.cleanupFileCache()` unchanged — so
 * `fileContentCache`/`cleanupFileCache`/`startFileCacheCleanup`/
 * `fileCacheCleanupInterval`/the three `FILE_CACHE_*` constants all stay
 * exactly as they were on the class, and `agentModeService.fileCache.test.ts`
 * needed zero changes. This is the same "injected parameter, not global
 * promotion" escape hatch this series already uses for shared PRIVATE
 * capabilities (`AccountResolver` — cluster 15, `EmployerSizeFilterResolver`
 * — cluster 16) applied here to a cache with a real per-instance lifecycle
 * instead.
 *
 * Because `fileContentCache` stays private instance state, `emma/tools.ts`'s
 * `save_file` tool has no legal way to reach it and keeps calling
 * `agentModeService.saveFile(...)` directly — a real, load-bearing exception
 * to the "always repoint tools.ts" rule, the same shape as cluster 15's three
 * `AccountResolver`-dependent tools. `readFileContent` and
 * `sendEmailFromConfiguredSender` have zero such dependency and both
 * `emma/tools.ts` call sites for each are repointed to call this module
 * directly.
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in this cluster — all
 * moved methods were read in full and individually grepped for the four
 * names; none matched.
 *
 * All moved-and-still-externally-called methods kept as delegating wrappers
 * on `AgentModeService.prototype.*` (none deleted):
 *   - `getAdminToolNames`: real callers beyond `emma/tools.ts` —
 *     `services/chatbotService.ts` and three call sites in
 *     `controllers/agentModeController.ts`, plus
 *     `agentModeService.skills.test.ts`'s direct real-instance calls.
 *   - `saveFile`: real caller beyond `emma/tools.ts` — `routes/emmaApi.ts`'s
 *     `POST /save-file`, plus `agentModeService.fileCache.test.ts`'s many
 *     direct real-instance calls (see above).
 *   - `readFileContent`: real caller beyond `emma/tools.ts` —
 *     `routes/emmaApi.ts`'s `POST /read-file-content`, plus
 *     `readFileContent.test.ts`/`emma.readFileContentTool.test.ts`'s direct
 *     real-instance calls.
 *   - `sendEmailFromConfiguredSender`: `emma/tools.ts` is its only real
 *     production caller, but `agentModeService.senderDailyLimit.test.ts`
 *     calls `(agentModeService as any).sendEmailFromConfiguredSender(...)`
 *     directly on the real singleton — kept as a wrapper for that reason
 *     alone, same standard cluster 12/13/etc. already applied
 *     ("real callers" includes direct-instance test calls, not just
 *     production code paths).
 *   - `getUnassociatedToolNames` (F2 follow-up, moved above): real callers
 *     beyond `emma/tools.ts` — `services/subscriptionService.ts`'s
 *     `resolveSkillsToToolNames`, `routes/admin.ts`'s `GET /available-skills`,
 *     plus `agentModeService.skills.test.ts`'s direct real-instance calls —
 *     all reach the singleton, none can reach `this.toolRegistry` directly.
 *   - `getUnassociatedTools` (private, F2 follow-up, moved above): kept as a
 *     private delegating wrapper (not deleted, not public) for its three
 *     real in-class callers (`buildAvailableSkillsMessage`,
 *     `getSkillsForDisplay`, `buildSkillContext`), plus
 *     `agentModeService.skills.test.ts`'s direct real-instance calls via
 *     `(agentModeService as any).getUnassociatedTools(...)`.
 *
 * Transitive-import notes: `extractS3KeyFromUrl`/`getS3ObjectStream`/
 * `getS3ObjectMetadata` stay STATIC imports from `../../utils/s3Utils`
 * (verified: that file imports only `aws-sdk` and `crypto`, nothing that
 * chains back to `agentModeService.ts`/`chatbotService.ts`/
 * `settingsService.ts`/`orgProfileResolver.ts`/`brandGuidelinesPopulation.ts`/
 * `services/db.ts`). `saveFile`'s own `uploadFileToS3` stays a LAZY
 * `await import('../../utils/s3Utils')` inside the function body, exactly as
 * it already was in the original code (only the relative path was adjusted
 * from `../utils/s3Utils`). `pdfPageRender` is a static import from
 * `./shared/pdfTextRender` (a pre-existing, already-safe shared extraction —
 * that module's own header comment already named `readFileContent` as an
 * anticipated future caller). `getCrmSenders` (`./shared/crmSenders`) and
 * `providerLabel` (`../../services/crmSenderTypes`) are both static imports;
 * both source files were read directly and confirmed to import nothing
 * problematic (`crmSenderTypes.ts` has zero imports at all). `pdf-parse`/
 * `xlsx`/`mammoth` stay inline `require()`s inside `readFileContent`, exactly
 * matching the original code — never top-level imports. `AgentTool` (used to
 * type the injected `getAllTools` parameter of `getUnassociatedTools`/
 * `getUnassociatedToolNames`) is imported with `import type` from
 * `../../mcp/client/toolRegistry` — type-only, so it is erased at compile
 * time and carries zero runtime import risk even though `toolRegistry.ts`
 * itself statically imports `evaluationPolicy.ts`/`anonymousToolAccess.ts`/
 * `scheduledPublishConsentGuard.ts`.
 *
 * Verified with a module-isolation test (`misc.moduleIsolation.test.ts`) that
 * requiring this module alone does NOT load `agentModeService.ts` or
 * `chatbotService.ts`.
 */
import axios from 'axios';
import { createHash } from 'crypto';
import { extractS3KeyFromUrl, getS3ObjectStream, getS3ObjectMetadata } from '../../utils/s3Utils';
import { pdfPageRender } from './shared/pdfTextRender';
import { resolvePinnedPublicAddress, SsrfBlockedError } from '../../utils/ssrfGuard';
import { getCrmSenders } from './shared/crmSenders';
import type { AgentTool } from '../../mcp/client/toolRegistry';
// Self-import: `getUnassociatedToolNames` reaches sibling `getUnassociatedTools`
// (both defined in this same module, below) through `self.<fn>` rather than a
// local function reference, so an external `jest.spyOn(miscImpl,
// 'getUnassociatedTools')` actually intercepts the internal call — the
// cluster-10 lesson.
import * as self from './misc';
import { providerLabel } from '../../services/crmSenderTypes';

// Type declaration for pdf-parse module (moved from agentModeService.ts,
// exclusive to readFileContent).
interface PDFData {
  text: string;
  numpages: number;
  numrender: number;
  info: any;
  metadata: any;
  version: string;
}

// Moved from agentModeService.ts (~1121-1122) — exclusive to readFileContent
// now that describeVideo (cluster 21) carries its own separately-duplicated
// copy of IMAGE_EXTENSIONS.
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'avif', 'heic', 'heif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv', 'm4v', 'ogv', '3gp', 'ts']);

// Duplicated from agentModeService.ts's own ADMIN_SKILL_TOOL_NAMES (~line 307)
// — see this module's header comment ("ADMIN_SKILL_TOOL_NAMES is DUPLICATED
// here, not imported back") for why this is a plain literal copy rather than
// a shared import.
const ADMIN_SKILL_TOOL_NAMES = ['evaluation_workspace', 'inspect_orphaned_org_join_requests', 'manage_linear_governance_label', 'read_linear_issues', 'manage_user_funnel_status', 'manage_predefined_work_plan', 'list_skills', 'manage_skill', 'get_chat_history', 'get_session_transcript', 'get_user_by_id', 'inspect_client_usage', 'list_all_clients', 'assess_client_health', 'read_client_meta_activity', 'monitor_lead_volume', 'check_account_tracking_health', 'diagnose_leads_at_zero', 'get_pr_digest', 'freeze_user_account', 'manage_scoring_judges', 'manage_user_notes', 'get_users_by_lifecycle_stage', 'get_registration_status', 'resolve_landing_page_by_url', 'share_landing_page_with_org', 'get_landing_page_effective_view'];

export function getAdminToolNames(): string[] {
  return [...ADMIN_SKILL_TOOL_NAMES];
}

/**
 * Get tools that are not associated with any published skill.
 * Excludes foundation tools and admin-only tools.
 *
 * `foundationTools`/`getAllTools` are injected — see this module's header
 * comment ("ENG-2103 F2 FOLLOW-UP") for why: `foundationTools` must be a LIVE
 * snapshot of `AgentModeService.FOUNDATION_TOOLS` (reassigned at runtime by
 * out-of-scope `loadFoundationTools`/`updateFoundationTools`), and
 * `getAllTools` must read the caller's own per-instance `this.toolRegistry`
 * (private, NOT the module-level `emmaToolRegistry` singleton) fresh on every
 * call, since tools are registered into it after construction.
 */
export function getUnassociatedTools(
  publishedSkills: any[],
  foundationTools: ReadonlySet<string>,
  getAllTools: () => AgentTool[],
): { name: string; description: string }[] {
  // Collect all tool names used by any published skill. Callers (e.g.
  // loadAuthorizedSkillCatalog) pass a catalog that also mixes in unpublished
  // private/org-shared skills for install purposes — those must NOT count here,
  // or a single draft skill nobody published can silently steal a tool out of
  // the shared __other_skills__ bundle for an entire org (ENG-1237).
  const associatedToolNames = new Set<string>();
  publishedSkills.forEach(skill => {
    if (skill.isPublished !== true) return;
    skill.toolNames?.forEach((t: string) => associatedToolNames.add(t));
  });

  // Build exclusion set: foundation tools + admin-only tools + page-context-only tools
  const excludedTools = new Set<string>(foundationTools);
  ADMIN_SKILL_TOOL_NAMES.forEach(t => excludedTools.add(t));
  // get_visual_context is page-embedded Emma only — never expose in Agent Mode or __other_skills__
  excludedTools.add('get_visual_context');

  // Get all registered tools and find those not in any skill
  const allTools = getAllTools();

  return allTools
    .filter(tool => !associatedToolNames.has(tool.name) && !excludedTools.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.definition?.function?.description || tool.name
    }));
}

/**
 * Get tool names not associated with any published skill (excludes infrastructure tools).
 * Public version of getUnassociatedTools for use by subscriptionService.resolveSkillsToToolNames.
 *
 * Calls sibling `getUnassociatedTools` via the `self` import (not a bare local
 * reference) so an external `jest.spyOn(miscImpl, 'getUnassociatedTools')`
 * still intercepts this internal call — see this module's header comment.
 */
export function getUnassociatedToolNames(
  publishedSkills: any[],
  foundationTools: ReadonlySet<string>,
  getAllTools: () => AgentTool[],
): string[] {
  return self.getUnassociatedTools(publishedSkills, foundationTools, getAllTools).map(t => t.name);
}

// Save file to S3 and return URL with content-based deduplication.
//
// `fileContentCache`/`cleanupFileContentCache` are injected by the caller
// (AgentModeService.prototype.saveFile passes `this.fileContentCache` and
// `() => this.cleanupFileCache()`) rather than owned here — see this module's
// header comment for why this cache stays instance-scoped instead of being
// promoted to a module-level singleton like this series' other pure caches.
// ENG-1608: save_file structured error contract.
export const SAVE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SAVE_FILE_MAX_NAME_LENGTH = 200;
export type SaveFileErrorCode =
  | 'MISSING_FILE_NAME'
  | 'INVALID_FILE_NAME'
  | 'MISSING_FILE_CONTENT'
  | 'INVALID_FILE_CONTENT'
  | 'EMPTY_FILE_CONTENT'
  | 'FILE_TOO_LARGE'
  | 'STORAGE_WRITE_FAILED';

function saveFileError(error_code: SaveFileErrorCode, message: string) {
  return { success: false, error_code, message, error: message };
}

export function validateSaveFileArgs(fileName: unknown, fileContent: unknown) {
  if (typeof fileName !== 'string' || fileName.trim().length === 0) {
    return saveFileError('MISSING_FILE_NAME', 'file_name is required and must be a non-empty string with an extension (e.g. "report.html").');
  }
  if (
    fileName.length > SAVE_FILE_MAX_NAME_LENGTH ||
    /[\\/]/.test(fileName) ||
    fileName.includes('..') ||
    /[\x00-\x1f]/.test(fileName)
  ) {
    return saveFileError('INVALID_FILE_NAME', `file_name "${fileName.slice(0, 80)}" is invalid: use a plain name with no slashes, "..", or control characters, at most ${SAVE_FILE_MAX_NAME_LENGTH} characters (e.g. "report.html").`);
  }
  if (fileContent === undefined || fileContent === null) {
    return saveFileError('MISSING_FILE_CONTENT', 'file_content is required: pass the COMPLETE file content as a string in this call.');
  }
  if (typeof fileContent !== 'string') {
    return saveFileError('INVALID_FILE_CONTENT', `file_content must be a string, received ${Array.isArray(fileContent) ? 'array' : typeof fileContent}. Serialize objects (e.g. JSON.stringify) before saving.`);
  }
  if (fileContent.trim().length === 0) {
    return saveFileError('EMPTY_FILE_CONTENT', 'file_content is empty: generate the full content first, then call save_file with it.');
  }
  const bytes = Buffer.byteLength(fileContent, 'utf8');
  if (bytes > SAVE_FILE_MAX_BYTES) {
    return saveFileError('FILE_TOO_LARGE', `file_content is ${bytes} bytes, above the ${SAVE_FILE_MAX_BYTES}-byte save_file limit. Split it into smaller files.`);
  }
  return null;
}

export async function saveFile(
  fileName: string,
  fileContent: string,
  userId: string,
  sessionId: string,
  fileContentCache: Map<string, { file_url: string; file_name: string; file_size: number; timestamp: number }>,
  cleanupFileContentCache: () => void,
): Promise<any> {
  try {
    console.log('AgentMode: Saving file:', fileName, 'for user:', userId, 'session:', sessionId);

    // ENG-1608: validate before any storage write and return a structured,
    // actionable error (error_code + message) instead of a generic Error.
    const invalid = validateSaveFileArgs(fileName, fileContent);
    if (invalid) return invalid;

    // Generate content hash for deduplication
    const contentHash = createHash('sha256').update(fileContent).digest('hex');

    // Cleanup cache before checking/adding entries
    cleanupFileContentCache();

    // Check if we already have this content cached
    const cachedFile = fileContentCache.get(contentHash);
    if (cachedFile) {
      console.log('AgentMode: File content already exists, returning cached URL:', cachedFile.file_url);
      // Update timestamp to mark as recently used
      cachedFile.timestamp = Date.now();
      fileContentCache.set(contentHash, cachedFile);

      // Format the save result for LLM consumption
      const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${cachedFile.file_url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

      return {
        success: true,
        message: `File "${fileName}" has been saved successfully.`,
        file_url: cachedFile.file_url,
        file_name: fileName,
        file_size: fileContent.length,
        formattedContent
      };
    }

    const { uploadFileToS3 } = await import('../../utils/s3Utils');

    // Determine content type based on file extension
    const extension = fileName.split('.').pop()?.toLowerCase();
    const contentTypes: { [key: string]: string } = {
      'txt': 'text/plain',
      'md': 'text/markdown',
      'json': 'application/json',
      'csv': 'text/csv',
      'html': 'text/html',
      'xml': 'application/xml',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
    const contentType = contentTypes[extension || ''] || 'application/octet-stream';

    // Upload to S3 using common utility
    const uploadResult = await uploadFileToS3(
      fileContent,
      fileName,
      userId,
      contentType
    );

    if (uploadResult.success) {
      // Cache the file content hash to URL mapping with timestamp
      fileContentCache.set(contentHash, {
        file_url: uploadResult.url || '',
        file_name: fileName || 'unknown',
        file_size: fileContent.length,
        timestamp: Date.now()
      });

      console.log(`AgentMode: File uploaded and cached with hash: ${contentHash} (cache size: ${fileContentCache.size})`);

      // Format the save result for LLM consumption
      const formattedContent = `📁 **File Saved Successfully**\nFile: ${fileName}\nSize: ${fileContent.length} bytes\nURL: ${uploadResult.url}\n\nThe file has been uploaded to S3 and is ready for sharing or reference.`;

      return {
        success: true,
        message: `File "${fileName}" has been saved successfully.`,
        file_url: uploadResult.url,
        file_name: fileName,
        file_size: fileContent.length,
        formattedContent
      };
    } else {
      return saveFileError(
        'STORAGE_WRITE_FAILED',
        `Storage rejected the write for "${fileName}": ${uploadResult.error || 'unknown storage error'}. Retry once; if it fails again, report the error instead of retrying.`,
      );
    }
  } catch (error) {
    console.error('AgentMode: Error saving file:', error);
    const detail = error instanceof Error ? error.message : 'Unknown error';
    return saveFileError(
      'STORAGE_WRITE_FAILED',
      `Saving "${fileName}" failed: ${detail}. Retry once; if it fails again, report the error instead of retrying.`,
    );
  }
}

/**
 * ENG-2420: caller identity for readFileContent. The shared private bucket holds
 * every tenant's uploads, so an S3 key is only readable when it sits under one
 * of the caller's own prefixes. No userId => no private-bucket read at all.
 */
export interface ReadFileCallerContext {
  userId?: string | null;
}

/** Key prefixes a user owns in the shared bucket (see s3Utils/brand/books/sandbox writers). */
export function isS3KeyOwnedByUser(key: string, userId: string | null | undefined): boolean {
  if (typeof userId !== 'string' || userId.trim() === '' || userId.includes('/')) return false;
  if (typeof key !== 'string' || key.includes('..')) return false;
  return key.startsWith(`users/${userId}/`) || key.startsWith(`sandbox/${userId}/`);
}

const READ_FILE_MAX_REDIRECTS = 5;

/**
 * ENG-2656: true for any AWS S3 endpoint host (virtual-hosted or path style).
 * readFileContent only reaches this check after extractS3KeyFromUrl declined
 * the URL, so a match here is a bucket that is NOT AgentWeb's upload bucket.
 * Real chat attachments always live in our bucket; a foreign S3 URL is almost
 * always a model-guessed "attachment" location (FlatFeeCorp, Oct 22), so we
 * refuse it without making any network request.
 */
export function isForeignS3Host(host: string): boolean {
  const h = (host || '').toLowerCase();
  return h === 's3.amazonaws.com'
    || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(h)
    || /\.s3\.amazonaws\.com$/.test(h)
    || /\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(h);
}

export const FOREIGN_STORAGE_REFUSAL_MESSAGE =
  'This URL points to an S3 bucket that is not AgentWeb file storage, so it is not a chat attachment and was not fetched. ' +
  'Never guess or construct attachment URLs. If the user said they attached a file but the message has no Attached Files link, ' +
  'reply: "I don\'t see an attachment on that message — please re-attach the file." Only read URLs that appear verbatim in the conversation.';

/**
 * ENG-2420: SSRF-safe external GET. Every hop is DNS-resolved and refused if any
 * answer is private/loopback/link-local, then the connection is pinned to the
 * validated address (no rebinding window) and redirects are followed manually so
 * each Location is re-validated.
 */
async function ssrfSafeGet(startUrl: string): Promise<{ data: any; headers: Record<string, any> }> {
  let url = startUrl;
  for (let hop = 0; hop <= READ_FILE_MAX_REDIRECTS; hop++) {
    const pinned = await resolvePinnedPublicAddress(url);
    const response: any = await axios.get(url, {
      timeout: 30000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'AgentWeb-Backend/1.0',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      maxRedirects: 0,
      validateStatus: (s: number) => s >= 200 && s < 400,
      lookup: (_hostname: string, options: any, callback: any) => {
        if (typeof options === 'function') callback = options;
        if (options && options.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
    } as any);
    const status = typeof response?.status === 'number' ? response.status : 200;
    if (status >= 300 && status < 400) {
      const location = response.headers?.location ?? response.headers?.Location;
      if (!location) throw new Error(`Redirect ${status} with no Location header`);
      const next = new URL(String(location), url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new SsrfBlockedError(`Refusing non-http(s) redirect to ${next.protocol}`);
      }
      url = next.toString();
      continue;
    }
    return { data: response.data, headers: response.headers || {} };
  }
  throw new Error(`Too many redirects (>${READ_FILE_MAX_REDIRECTS})`);
}

// Read file content from URL with support for various file types
export async function readFileContent(fileUrl: string, caller?: ReadFileCallerContext): Promise<any> {
  try {
    console.log('AgentMode: Reading file content from URL:', fileUrl);

    if (typeof fileUrl !== 'string' || fileUrl.trim().length === 0) {
      return {
        success: false,
        message: 'file_url is required and must be a non-empty HTTP or HTTPS URL.',
        error: 'Missing file_url'
      };
    }

    const normalizedFileUrl = fileUrl.trim();

    // Validate URL format
    if (!normalizedFileUrl.startsWith('http://') && !normalizedFileUrl.startsWith('https://')) {
      return {
        success: false,
        message: 'Invalid URL format. Must be HTTP or HTTPS.',
        error: 'Invalid URL format'
      };
    }

    // Determine file type from URL
    const urlPath = new URL(normalizedFileUrl).pathname;
    const extension = urlPath.split('.').pop()?.toLowerCase() || '';

    // SVG is XML text as well as an image (ENG-1468): read_file_content returns its
    // source (labels, dimensions, metadata); describe_image still owns visual analysis.
    if (IMAGE_EXTENSIONS.has(extension) && extension !== 'svg') {
      return {
        success: false,
        message: `This is an image file (.${extension}). Use the describe_image tool to analyze its visual content instead.`,
        error: 'Image files must be analyzed with describe_image, not read_file_content'
      };
    }

    if (VIDEO_EXTENSIONS.has(extension)) {
      return {
        success: false,
        message: `This is a video file (.${extension}). Use the describe_video tool to analyze its content instead.`,
        error: 'Video files must be analyzed with describe_video, not read_file_content'
      };
    }

    // Fetch the file content — S3 objects are private, use SDK directly for our bucket
    let buffer: Buffer;
    let contentType: string;

    const s3Key = extractS3KeyFromUrl(normalizedFileUrl);
    if (s3Key) {
      // ENG-2420: never stream another tenant's object. Same message whether the
      // key exists or not, so the response cannot be used as an existence oracle.
      if (!isS3KeyOwnedByUser(s3Key, caller?.userId)) {
        console.warn('AgentMode: read_file_content refused S3 key outside caller prefixes');
        return {
          success: false,
          message: 'File not found or you do not have access to it.',
          error: 'File not accessible'
        };
      }
      // Private bucket object — stream via SDK (same pattern as filesController)
      const stream = getS3ObjectStream(s3Key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
      try {
        const meta = await getS3ObjectMetadata(s3Key);
        contentType = meta.ContentType || '';
      } catch {
        contentType = '';
      }
      console.log(`AgentMode: Fetched S3 file via SDK, size: ${buffer.length} bytes, type: ${contentType}`);
    } else {
      // Google Drive / Docs links require the user's OAuth token — unauthenticated
      // fetches return 401 for Workspace-restricted orgs. Tell the user to upload instead.
      const urlHost = new URL(normalizedFileUrl).hostname.toLowerCase();
      if (isForeignS3Host(urlHost)) {
        console.warn('AgentMode: read_file_content refused non-AgentWeb S3 host (ENG-2656)');
        return {
          success: false,
          message: FOREIGN_STORAGE_REFUSAL_MESSAGE,
          error: 'Not an AgentWeb storage URL'
        };
      }
      if (urlHost === 'drive.google.com' || urlHost === 'docs.google.com') {
        return {
          success: false,
          message: 'Google Drive and Docs links cannot be read directly — your organization may have restricted sharing. Please download the file and upload it using the attachment button in the chat instead.',
          error: 'Google Drive links require authenticated access'
        };
      }

      // External URL — plain fetch. Send no-cache headers so scrapes (e.g.
      // onboarding brand-build reading the user's live site) reflect the
      // CURRENT content and never a stale CDN/intermediary copy.
      const response = await ssrfSafeGet(normalizedFileUrl);
      buffer = Buffer.from(response.data as ArrayBuffer);
      contentType = response.headers['content-type'] || '';
      console.log(`AgentMode: Fetched external file, size: ${buffer.length} bytes, type: ${contentType}`);
    }

    // Process content based on file type
    let extractedContent = '';
    let fileType = 'unknown';

    const PDF_PARSE_TIMEOUT_MS = 60000;
    if (extension === 'pdf' || contentType.includes('application/pdf')) {
      // Handle PDF files
      try {
        const pdfParse = require('pdf-parse');
        const pdfData: PDFData = await Promise.race([
          pdfParse(buffer, { pagerender: pdfPageRender }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('PDF parse timed out')), PDF_PARSE_TIMEOUT_MS)
          ),
        ]);
        extractedContent = pdfData.text;
        fileType = 'pdf';
        console.log(`AgentMode: Successfully parsed PDF, extracted ${extractedContent.length} characters`);
      } catch (pdfError) {
        console.error('AgentMode: Error parsing PDF:', pdfError);
        return {
          success: false,
          message: 'Failed to parse PDF file. The file may be corrupted, password-protected, or too complex.',
          error: pdfError instanceof Error ? pdfError.message : 'PDF parsing failed'
        };
      }
    } else if (['xlsx', 'xls', 'xlsm', 'xlsb'].includes(extension) ||
      contentType.includes('spreadsheetml') || contentType.includes('ms-excel')) {
      // Handle Excel/spreadsheet files
      try {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const lines: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv.trim()) {
            lines.push(`Sheet: ${sheetName}`);
            lines.push(csv);
          }
        }
        extractedContent = lines.join('\n\n');
        fileType = 'spreadsheet';
        console.log(`AgentMode: Successfully parsed Excel file (${workbook.SheetNames.length} sheet(s)), extracted ${extractedContent.length} characters`);
      } catch (xlsxError) {
        console.error('AgentMode: Error parsing Excel file:', xlsxError);
        return {
          success: false,
          message: 'Failed to parse Excel file. The file may be corrupted or in an unsupported format.',
          error: xlsxError instanceof Error ? xlsxError.message : 'Excel parsing failed'
        };
      }
    } else if (['docx', 'doc'].includes(extension) ||
      contentType.includes('wordprocessingml') || contentType.includes('msword')) {
      // Handle Word documents
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        extractedContent = result.value;
        fileType = 'document';
        console.log(`AgentMode: Successfully parsed Word document, extracted ${extractedContent.length} characters`);
      } catch (docxError) {
        console.error('AgentMode: Error parsing Word document:', docxError);
        return {
          success: false,
          message: 'Failed to parse Word document. The file may be corrupted or in an unsupported format.',
          error: docxError instanceof Error ? docxError.message : 'Word document parsing failed'
        };
      }
    } else if (['txt', 'md', 'csv', 'json', 'xml', 'svg', 'html', 'htm', 'js', 'css', 'log', 'yml', 'yaml'].includes(extension)) {
      // Handle text-based files
      try {
        extractedContent = buffer.toString('utf-8');
        fileType = 'text';
        console.log(`AgentMode: Successfully read text file, extracted ${extractedContent.length} characters`);
      } catch (textError) {
        console.error('AgentMode: Error reading text file:', textError);
        return {
          success: false,
          message: 'Failed to read text file. The file may contain invalid characters.',
          error: textError instanceof Error ? textError.message : 'Text file reading failed'
        };
      }
    } else {
      // For other file types, try to read as text but with a warning
      try {
        extractedContent = buffer.toString('utf-8');
        fileType = 'text';
        console.log(`AgentMode: Attempted to read unknown file type as text, extracted ${extractedContent.length} characters`);
      } catch (textError) {
        console.error('AgentMode: Error reading file as text:', textError);
        return {
          success: false,
          message: `Unsupported file type (${extension}). Only text files, PDFs, spreadsheets, and common document formats are supported.`,
          error: 'Unsupported file type'
        };
      }
    }

    // Truncate to avoid overwhelming the LLM context window
    const MAX_CONTENT_LENGTH = 100_000;
    let truncated = false;
    if (extractedContent.length > MAX_CONTENT_LENGTH) {
      extractedContent = extractedContent.slice(0, MAX_CONTENT_LENGTH);
      truncated = true;
      console.log(`AgentMode: Content truncated to ${MAX_CONTENT_LENGTH} characters`);
    }

    const contentHash = createHash('sha256').update(extractedContent).digest('hex');
    console.log(`AgentMode: Computed content hash: ${contentHash}`);

    return {
      success: true,
      content: extractedContent,
      content_hash: contentHash,
      file_type: fileType,
      file_size: buffer.length,
      content_length: extractedContent.length,
      truncated,
      file_url: normalizedFileUrl,
      message: `Successfully read ${fileType} file content (${extractedContent.length} characters${truncated ? ' — content was truncated, call again with a byte-range if you need more' : ''})`
    };

  } catch (error: any) {
    console.error('AgentMode: Error reading file content:', error);

    if (error instanceof SsrfBlockedError || error?.name === 'SsrfBlockedError') {
      return {
        success: false,
        message: 'This URL points to a private or internal network address and cannot be read.',
        error: 'URL blocked: private or internal address'
      };
    }

    let errorMessage = 'Failed to read file content';
    let statusCode = 500;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
    } else if (error.code === 'ENOTFOUND') {
      statusCode = 404;
      errorMessage = 'File not found or URL is unreachable';
    } else if (error.code === 'ETIMEDOUT') {
      statusCode = 408;
      errorMessage = 'Request timeout while fetching file';
    }

    // ENG-1162: a 401/403 from this plain external-URL fetch (not S3, not an
    // AgentWeb-connected account) means the PUBLISHER refused the request —
    // bot-blocking, a WAF, or a paywall — not an AgentWeb auth/permission
    // problem. Left as a bare "HTTP 403: Forbidden", classifyToolErrorClass's
    // embedded-status regex sweeps this into the generic 'auth' class, whose
    // model-visible guidance says to have the user "reconnect the account" —
    // nonsensical for an anonymous read, and it gave no signal that a failed
    // read is NOT evidence the content doesn't exist (the run silently
    // degraded to search instead of reporting the source as unverified).
    // Named here so classifyToolErrorClass can match the marker and route to
    // 'publisher_refused' instead.
    //
    // This rewrite is local to THIS call site, not a systemic guard — the
    // classifier can only recognize the marker text below, not "this was an
    // anonymous unauthenticated fetch" in the abstract. Any other tool that
    // anonymously fetches an arbitrary external URL (not S3, not a connected
    // account) and forwards a bare `HTTP ${status}: ...`-shaped message on a
    // 401/403 will fall right back into classifyToolErrorClass's generic
    // embedded-status regex and get the wrong 'auth'/"reconnect the account"
    // guidance. Apply the same isAxiosError-gated rewrite there too.
    const isPublisherRefusal = error.isAxiosError && (statusCode === 401 || statusCode === 403);
    if (isPublisherRefusal) {
      errorMessage = `The publisher refused this fetch (${errorMessage}) — this is a site-side access block (bot filtering, WAF, or paywall), not an AgentWeb account or permissions problem.`;
    }

    return {
      success: false,
      message: errorMessage,
      error: isPublisherRefusal ? errorMessage : error.message,
      file_url: typeof fileUrl === 'string' ? fileUrl : undefined
    };
  }
}

/**
 * Send a one-off / ad-hoc email using the user's configured CRM sender(s).
 *
 * This is the counterpart to sendEmailToLead for emails that are NOT tied to a
 * CRM lead + saved draft. The generic `email` tool can only send through a
 * connected Gmail OAuth account; users who configured a sender (Resend custom
 * domain, or a Gmail-account sender) but never connected a raw Gmail account
 * previously had no way to send an arbitrary email from chat. This routes the
 * send through the same configured senders sendEmailToLead uses.
 *
 * Sender resolution: explicit senderId → defaultSenderId → first available.
 *
 * `getCrmSendersFn` is an injected parameter, not a hardcoded call to the
 * `getCrmSenders` import above — defaults to that same shared function (so
 * `emma/tools.ts`'s repointed call site needs no change), but
 * `AgentModeService.prototype.sendEmailFromConfiguredSender` passes
 * `this.getCrmSenders.bind(this)` instead. That preserves
 * `agentModeService.crmTools.test.ts`'s 13
 * `jest.spyOn(service as any, 'getCrmSenders')` tests, which spy on the
 * INSTANCE method — calling the shared function directly here would silently
 * stop routing through that spy, the same "stale mock" regression class this
 * series has repeatedly hit, just via `jest.spyOn` instead of `jest.mock`.
 * Same injected-capability shape as `AccountResolver` (cluster 15) and
 * `EmployerSizeFilterResolver` (cluster 16).
 */
export async function sendEmailFromConfiguredSender(
  userId: string,
  params: { to: string; subject?: string; html?: string; text?: string; body?: string; senderId?: string },
  getCrmSendersFn: typeof getCrmSenders = getCrmSenders,
): Promise<any> {
  try {
    const to = (params.to || '').trim();
    if (!to) {
      return { success: false, reason: 'missing_field', code: 400, message: 'Recipient required', error: 'A recipient email address ("to") is required' };
    }
    // Reject clearly malformed recipients up front so the user gets an
    // actionable "check the address" message instead of a generic provider
    // failure (Resend) or a silent accept-then-bounce (Gmail). Note: a
    // well-formed but non-existent mailbox cannot be detected at send time —
    // that bounce is asynchronous and outside this tool's control.
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return { success: false, reason: 'invalid_recipient', code: 400, message: 'Invalid recipient', error: `The recipient address "${to}" is not a valid email address. Please check it and try again.` };
    }
    if (!params.subject || !params.subject.trim()) {
      return { success: false, reason: 'missing_field', code: 400, message: 'Subject required', error: 'An email subject is required' };
    }

    // Normalize the body. Accept `body` as an alias for `text` (the generic
    // `email` tool and most LLM calls use `body`), and treat empty/whitespace
    // values as absent so we never send a blank email. html takes precedence.
    const htmlBody = params.html && params.html.trim() ? params.html : undefined;
    const textBody = (() => {
      const t = params.text && params.text.trim() ? params.text : undefined;
      if (t) return t;
      return params.body && params.body.trim() ? params.body : undefined;
    })();
    if (!htmlBody && !textBody) {
      return { success: false, reason: 'missing_field', code: 400, message: 'Email body required', error: 'The email body (html or text) is required and cannot be empty' };
    }

    // Resolve sender from the user's configured CRM senders.
    const sendersResult = await getCrmSendersFn(userId);
    if (!sendersResult.success || sendersResult.senders.length === 0) {
      return { success: false, reason: 'no_sender', code: 404, message: 'No senders configured', error: 'No sender email is configured for your account. To set one up, open CRM, select a lead list, and click "Senders".' };
    }

    let sender: any = null;
    if (params.senderId) {
      // The model can't see internal sender IDs, so accept an id, an email
      // address, a from-name (case-insensitive), or a provider keyword like
      // "gmail" / "outlook" — whatever the user named ("send from my outlook sender").
      const needle = params.senderId.trim().toLowerCase();
      sender = sendersResult.senders.find((s: any) =>
        s.id === params.senderId ||
        (s.email && s.email.toLowerCase() === needle) ||
        (s.fromName && s.fromName.toLowerCase() === needle)
      );

      // Fall back to matching by provider (e.g. the single connected-mailbox sender).
      if (!sender) {
        const wantedProvider = ['gmail', 'outlook'].find(
          (p) => needle === p || needle === `${p} sender` || needle === `my ${p}` || needle === `my ${p} sender`,
        );
        if (wantedProvider) {
          const matches = sendersResult.senders.filter(
            (s: any) => (s.senderProvider || s.senderType) === wantedProvider,
          );
          if (matches.length === 1) {
            sender = matches[0];
          } else if (matches.length > 1) {
            const list = matches.map((s: any) => `${s.fromName} <${s.email}>`).join(', ');
            return {
              success: false,
              reason: 'ambiguous_sender',
              code: 400,
              message: `Multiple ${wantedProvider} senders`,
              error: `You have more than one ${wantedProvider} sender: ${list}. Tell me which one to use by its email address.`,
              availableSenders: matches.map((s: any) => ({ id: s.id, email: s.email, fromName: s.fromName, senderType: wantedProvider })),
            };
          }
        }
      }

      if (!sender) {
        const available = sendersResult.senders.map((s: any) => ({ id: s.id, email: s.email, fromName: s.fromName, senderType: s.senderProvider || s.senderType || 'resend' }));
        const list = available.map((s: any) => `${s.fromName} <${s.email}> [${s.senderType}]`).join(', ');
        return {
          success: false,
          reason: 'sender_not_found',
          code: 404,
          message: 'Sender not found',
          error: `No configured sender matches "${params.senderId}". Available senders: ${list}. Pass one of their email addresses as sender_id, or omit sender_id to use the default sender.`,
          availableSenders: available,
        };
      }
    } else {
      const defaultSenderId = sendersResult.defaultSenderId;
      sender = defaultSenderId
        ? sendersResult.senders.find((s: any) => s.id === defaultSenderId)
        : sendersResult.senders[0];
      if (!sender) {
        sender = sendersResult.senders[0];
      }
    }

    if (!sender) {
      return { success: false, reason: 'no_sender', code: 404, message: 'No valid sender', error: 'Could not resolve a valid sender email' };
    }

    let emailId: string;

    // Accept both shapes: senderProvider is the neutral field, senderType the legacy
    // persisted key. A sender resolved outside loadSenderConfig may only carry the latter.
    const senderProvider: string = (sender as any).senderProvider || (sender as any).senderType || 'resend';

    const connectedAccountId = (sender as any).connectedAccountId || (sender as any).gmailAccountId;
    if (senderProvider !== 'resend' && !connectedAccountId) {
      return {
        success: false,
        reason: 'sender_misconfigured',
        code: 401,
        message: `${providerLabel(senderProvider)} sender misconfigured`,
        error: `The ${providerLabel(senderProvider)} sender is missing its connected account id`,
      };
    }
    const label = providerLabel(senderProvider);

    // ENG-673: this send names an address, not a lead, so a contact marked do-not-contact is looked up and refused here.
    const { blockedRecipients, blockedMessage, unverifiedContactError } = await import('../../services/contactGuard');
    let blockedTo: string[];
    try {
      blockedTo = await blockedRecipients([userId], to);
    } catch (e) {
      console.error('[Emma] do-not-contact check failed, not sending:', e);
      return { success: false, reason: 'do_not_contact_unverified', code: 503, message: 'Could not check do-not-contact', error: unverifiedContactError };
    }
    if (blockedTo.length > 0) {
      return { success: false, reason: 'do_not_contact', code: 409, message: 'Do not contact', error: blockedMessage(blockedTo) };
    }

    // ENG-265: route through sendAsSender so this chat-driven ad-hoc send is subject
    // to the same daily-cap/warmup enforcement as every other send path.
    const { resolveSenderForSend } = await import('../../services/crmSenderService');
    const { sendAsSender, SenderDailyLimitExceededError } = await import('../../services/sendAsSender');
    // Fail closed rather than falling back to a synthesized sender — see the matching
    // comment in sendEmailToLead for why a null here must not become an uncapped send.
    const crmSender = await resolveSenderForSend(userId, sender.id, sender.email);
    if (!crmSender) {
      return {
        success: false,
        reason: 'sender_not_found',
        code: 404,
        message: 'Sender no longer available',
        error: 'This sender was removed or changed just now. Please pick a sender again and retry.',
      };
    }

    try {
      const sendResult = await sendAsSender(userId, crmSender, {
        to,
        subject: params.subject,
        html: htmlBody,
        text: textBody,
      });
      emailId = sendResult.messageId;
    } catch (error: any) {
      if (error instanceof SenderDailyLimitExceededError) {
        return { success: false, reason: 'daily_limit', code: 429, message: 'Daily sending limit reached', error: error.message };
      }
      // Translate OAuth failures into an actionable message that names the
      // affected sender. Raw errors like "unauthorized_client" / "invalid_grant"
      // are otherwise opaque and get mis-paraphrased by the LLM (e.g. "no account
      // configured"). Nearly all are resolved by reconnecting in Settings.
      const raw = error instanceof Error ? error.message : String(error);
      const needsReconnect = senderProvider !== 'resend' && /unauthorized_client|invalid_grant|invalid_client|token|revoked|expired|not connected|not authorized|insufficient|scope/i.test(raw);
      // ENG-1300: Gmail/Outlook throw fully-typed EmailProviderError subclasses
      // with no HTTP status of their own — mapped by name. undefined for Resend
      // and any other error shape, which is fine: the fields below are additive.
      const { emailProviderErrorStatus } = await import('../../services/emailProviderService');
      const code = emailProviderErrorStatus(error);
      if (needsReconnect) {
        return {
          success: false,
          reason: 'needs_reconnect',
          message: `${label} sender needs reconnecting`,
          error: `Could not send from the ${label} sender ${sender.email} (${connectedAccountId}): ${raw}. Please reconnect this account in Settings → Connected Accounts (make sure to grant send permission), or use a different configured sender.`,
          // ENG-2064: never leave a reconnect failure without an HTTP-range code —
          // without one, toolResultError's rebuilt Error classifies as generic 'Error'.
          code: code ?? 401,
        };
      }
      // ENG-2064: provider-side failure. A typed provider status (EmailProviderError)
      // or an HTTP status on the thrown error is kept verbatim; otherwise the send was
      // submitted and the provider failed it, so surface it as an upstream failure
      // (502) instead of an unclassified generic Error.
      const thrownStatus = [(error as any)?.statusCode, (error as any)?.status, (error as any)?.code]
        .find((n) => typeof n === 'number' && n >= 100 && n <= 599) as number | undefined;
      const providerCode = code ?? thrownStatus ?? 502;
      return {
        success: false,
        reason: providerCode >= 500 ? 'provider_unavailable' : 'provider_rejected',
        message: `${label} send failed`,
        error: `Could not send from the ${label} sender ${sender.email}: ${raw}`,
        code: providerCode,
      };
    }

    return {
      success: true,
      message: `Email sent successfully to ${to}`,
      emailId,
      to,
      from: sender.email,
      subject: params.subject,
    };
  } catch (error) {
    console.error('AgentMode: Error sending email from configured sender:', error);
    const { emailProviderErrorStatus } = await import('../../services/emailProviderService');
    return {
      success: false,
      reason: 'internal_error',
      message: 'Failed to send email',
      error: error instanceof Error ? error.message : 'Unknown error',
      code: emailProviderErrorStatus(error)
    };
  }
}
