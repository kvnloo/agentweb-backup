/**
 * ENG-2103 (F2) — search & research tool cluster, extracted from
 * `AgentModeService`. Cluster 20 in this series.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 *   - `performDataAnalysis` (public, ~10374-11065 pre-extraction) — a large,
 *     non-contiguous method (Gemini code-execution data analysis) that sits
 *     far from the other four, per the scattered-cluster shape seen in
 *     clusters 18/19.
 *   - `youSearchWeb`, `youSearchNews`, `googleSearchWeb` (all public,
 *     contiguous with each other, ~17920-18001 pre-extraction).
 *   - `performDeepResearchTool` (public, ~19260-19363 pre-extraction) —
 *     also non-contiguous; a thin dispatcher to `deepResearchService`
 *     (see below), not the LLM-calling method itself.
 *
 * Eight private/exclusive helpers, found by whole-backend grep to have zero
 * callers outside this cluster, moved alongside as module-scope (non-exported)
 * functions/state:
 *   - `contentTypeForFilename` (private static, ~10289-10301) — exclusive to
 *     `extractAndUploadAnalysisFiles`.
 *   - `extractAndUploadAnalysisFiles` (private, ~10309-10357) — exclusive to
 *     `performDataAnalysis`.
 *   - `pruneDataAnalysisConsistencyCache` (private, ~10360-10372) plus the
 *     `dataAnalysisConsistencyCache` instance Map and its two
 *     `DATA_ANALYSIS_CONSISTENCY_*` constants (~1303-1305) — a pure cache with
 *     no cross-cutting meaning (per the F2 design draft §3.2), promoted to
 *     module-level singleton state exactly as `fileContentCache`-shaped caches
 *     in earlier clusters were.
 *   - `formatWebSearchResults` (private, ~17422-17458) — exclusive to
 *     `googleSearchWeb` AND `searchWithYou` (i.e. also `youSearchWeb`/
 *     `youSearchNews` transitively); non-contiguous with the you.com/Google
 *     search methods it serves, interleaved with ~500 lines of unrelated ads
 *     methods (the scattered-cluster shape again).
 *   - `searchWithYou` (private, ~18003-18111) — exclusive to `youSearchWeb`/
 *     `youSearchNews`.
 *   - `isRetryableSearchError` (private, ~18113-18138) — exclusive to
 *     `searchWithYou`.
 *   - `performYouSearch` (was `public`, ~18303-18332) — exclusive to
 *     `searchWithYou`, confirmed by whole-backend grep to have no other
 *     caller despite being public; demoted to a module-internal (non-exported)
 *     function here since nothing outside this cluster ever called it.
 *   - `performGoogleSearch` (was `public`, ~18334-18351) — exclusive to
 *     `googleSearchWeb`, same treatment as `performYouSearch`.
 *
 * `DATA_ANALYSIS_FILE_START_PREFIX`/`_MARKER_SUFFIX`/`_END_MARKER` (module-
 * level consts in the original file, ~1154-1156) are exclusive to
 * `performDataAnalysis`/`extractAndUploadAnalysisFiles` (confirmed by
 * whole-backend grep) and moved here too.
 *
 * One deliberate non-verbatim exception, disclosed rather than silent:
 * `searchWithYou`'s retry loop called `this.sleep(delayMs)`, a private class
 * method whose OTHER two call sites (a scheduled-Gemini-iteration pacer and a
 * swap-verification backoff, both unrelated to search) mean it cannot be
 * deleted or moved. `sleep`'s entire body is the one-line
 * `await new Promise(resolve => setTimeout(resolve, ms))` with zero instance-
 * state dependency, so rather than inventing injected-parameter machinery
 * (the pattern used elsewhere in this series for helpers with REAL state,
 * e.g. `AccountResolver`/`EmployerSizeFilterResolver`) for a stateless
 * one-liner, the equivalent `setTimeout` Promise is inlined directly at the
 * single call site. Behavior is unchanged; `AgentModeService.prototype.sleep`
 * itself is untouched and still serves its other two callers.
 *
 * All 5 public entry points are kept as delegating wrappers on
 * `AgentModeService.prototype.*` (none deleted) — every one has a real caller
 * beyond `emma/tools.ts`, found by grepping the whole backend:
 *   - `performDataAnalysis`: `routes/emmaApi.ts` AND `routes/crm.ts` (a real
 *     production REST caller in each), plus
 *     `agentModeService.performDataAnalysis.test.ts`'s many direct
 *     real-instance calls.
 *   - `youSearchWeb`: `services/crmEnrichmentService.ts` (4 call sites),
 *     `services/enrichmentV3RealDeps.ts` (3 call sites),
 *     `services/specialists/crunchbaseSpecialist.ts`, `routes/emmaApi.ts`,
 *     plus `agentModeService.youSearchWebParams.test.ts`'s
 *     `jest.spyOn(agentModeService, 'youSearchWeb')` and several
 *     `crm.*.test.ts`/`enrichmentV3RealDeps*.test.ts` files that mock
 *     `agentModeService.youSearchWeb` directly.
 *   - `youSearchNews`: `routes/emmaApi.ts`, plus
 *     `agentModeService.youSearchNews.test.ts`'s direct real-instance calls.
 *   - `googleSearchWeb`: `routes/emmaApi.ts`, plus
 *     `agentModeService.googleSearchWeb.test.ts`'s direct real-instance calls.
 *   - `performDeepResearchTool`: `routes/emmaApi.ts`, plus
 *     `agentModeService.performDeepResearch.test.ts`'s many direct
 *     real-instance calls.
 * `emma/tools.ts`'s 5 tool call sites are repointed to call this module
 * directly instead — the class wrappers above exist only for the real
 * callers named next to each one, not for `emma/tools.ts` anymore.
 *
 * `performYouSearch`/`performGoogleSearch` are NOT kept as wrappers (deleted
 * from the class outright): confirmed by whole-backend grep to have exactly
 * one caller each, both inside this cluster (`searchWithYou`/`googleSearchWeb`
 * respectively) — no route, controller, or test anywhere calls
 * `agentModeService.performYouSearch`/`.performGoogleSearch` directly, despite
 * both having been `public`.
 *
 * Zero `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in this cluster — every
 * one of the 5 public methods and 8 helpers was read in full and individually
 * grepped for the four names; none matched.
 *
 * `performDeepResearchTool` does NOT call an LLM itself — it is a thin
 * dispatcher: lazily `await import('./deepResearchService')`s
 * `deepResearchService`, calls its `isAvailable()`/`performDeepResearch()`,
 * then uploads the resulting markdown to S3. Verified (not assumed, per this
 * cluster's brief) that `deepResearchService.ts` is NOT the
 * already-independent file its own pre-extraction doc comment might suggest:
 * it has a STATIC top-level `import { agentModeService } from
 * './agentModeService'` (used for `agentModeService.callLLM` and
 * `.getOpenRouterClient()` inside its own implementation) — a real, disclosed
 * transitive-import trap. It is safe to move `performDeepResearchTool`
 * verbatim regardless, because the ORIGINAL code already reached
 * `deepResearchService` via a LAZY `await import(...)` inside the function
 * body, not a static import — so this module never loads
 * `deepResearchService.ts` (or, transitively, `agentModeService.ts`) at its
 * own module-load time, only when `performDeepResearchTool` actually runs.
 * This is the exact same shape `emma/impl/blog.ts` already documented and
 * relies on for `createBlogArticle`'s own deep-research branch — not a new
 * finding, but independently re-verified here rather than assumed from that
 * precedent.
 *
 * Transitive-import notes for the search-provider dependencies
 * (`YouSearchProvider`, `SearchPurpose`/
 * `SearchResultSource`, `inferSearchFreshness`, and the `csvProvenance`
 * helpers) — all STATIC imports here, exactly matching how
 * `agentModeService.ts` already imported every one of them: none of these
 * modules imports `agentModeService.ts`, `chatbotService.ts`,
 * `settingsService.ts`, `orgProfileResolver.ts`, `brandGuidelinesPopulation.ts`,
 * or `services/db.ts`, confirmed by reading each one's own import list
 * directly. `getSecret`/`getS3ObjectAsString`/`meterUsageFromResponse`/axios/
 * `GoogleGenerativeAI` are likewise unchanged static imports, matching the
 * original file. `uploadFileToS3` stays a lazy `await import('../../utils/s3Utils')`
 * inside `extractAndUploadAnalysisFiles` and `performDeepResearchTool`,
 * exactly as it already was in the original code (only the relative path was
 * adjusted, `../utils/s3Utils` -> `../../utils/s3Utils`).
 *
 * Verified with a module-isolation test
 * (`searchResearch.moduleIsolation.test.ts`) that requiring this module alone
 * does NOT load `agentModeService.ts`, `chatbotService.ts`, or
 * `deepResearchService.ts`.
 */
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getSecret } from '../../utils/secretsManager';
import { getS3ObjectAsString } from '../../utils/s3Utils';
import {
  CALLER_URL_BLOCKED_MESSAGE,
  CallerUrlBlockedError,
  CallerUrlTooLargeError,
  fetchCallerUrlBuffer,
} from '../../utils/callerUrlFetch';
import { meterUsageFromResponse } from '../../utils/llmClients';
import {
  parseCsvProvenance,
  findCsvIdNameCollisions,
  checkCsvIdGrounding,
  estimateRowsIn,
  buildDataAnalysisCacheKey,
} from '../../services/agentMode/csvProvenance';
import { YouSearchProvider } from '../../search/youSearchProvider';
import { SearchPurpose, SearchResultSource } from '../../search/searchProvider';
import { inferSearchFreshness } from '../../search/searchFreshness';

// Markers used by perform_data_analysis to capture files the Gemini code-execution
// sandbox produces. The sandbox filesystem is discarded after execution and Gemini
// never returns arbitrary on-disk files (only inline images), so the model is told
// to print a file's full contents to stdout between these markers. The backend then
// extracts the content and uploads it to real, downloadable S3 storage.
const DATA_ANALYSIS_FILE_START_PREFIX = '<<<AGENTWEB_FILE:';
const DATA_ANALYSIS_FILE_MARKER_SUFFIX = '>>>';
const DATA_ANALYSIS_FILE_END_MARKER = '<<<AGENTWEB_FILE_END>>>';

// ENG-1295 hardening: self-consistency cache for perform_data_analysis. Keyed by
// userId + a hash of the exact (file_urls, analysis_instruction) pair, so a
// literal repeat of the same call can be checked against its own prior grouping-
// key result instead of silently returning a contradictory answer. Bounded size
// and TTL since this lives on the long-running module-level singleton (promoted
// from an AgentModeService instance field per the F2 design draft §3.2 — a pure
// cache with no cross-cutting meaning).
const dataAnalysisConsistencyCache: Map<string, { groupingKeyValues: string[]; timestamp: number }> = new Map();
const DATA_ANALYSIS_CONSISTENCY_CACHE_MAX = 500;
const DATA_ANALYSIS_CONSISTENCY_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Test-only: process-level state would otherwise leak between cases in one
 * suite. Before this cluster's extraction, `dataAnalysisConsistencyCache` was
 * an `AgentModeService` instance field, so tests that constructed a fresh
 * `new AgentModeService()` per case got isolation for free; promoting it to
 * module-level singleton state (§3.2 of the F2 design draft — a pure cache
 * with no cross-cutting meaning, matching every other cache this series has
 * promoted) makes that isolation this module's own responsibility instead.
 * Production is unaffected either way: `agentModeService` is already a
 * single module-level singleton (`export const agentModeService = new
 * AgentModeService()`), so there was only ever one real cache instance.
 */
export function __resetDataAnalysisConsistencyCacheForTests(): void {
  dataAnalysisConsistencyCache.clear();
}

function pruneDataAnalysisConsistencyCache(): void {
  const now = Date.now();
  for (const [key, entry] of dataAnalysisConsistencyCache) {
    if (now - entry.timestamp > DATA_ANALYSIS_CONSISTENCY_TTL_MS) {
      dataAnalysisConsistencyCache.delete(key);
    }
  }
  while (dataAnalysisConsistencyCache.size > DATA_ANALYSIS_CONSISTENCY_CACHE_MAX) {
    const oldestKey = dataAnalysisConsistencyCache.keys().next().value;
    if (oldestKey === undefined) break;
    dataAnalysisConsistencyCache.delete(oldestKey);
  }
}

function contentTypeForFilename(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'tsv': return 'text/tab-separated-values';
    case 'md': return 'text/markdown';
    case 'html': case 'htm': return 'text/html';
    case 'xml': return 'application/xml';
    case 'txt': return 'text/plain';
    default: return 'text/plain';
  }
}

async function extractAndUploadAnalysisFiles(
  text: string,
  userId: string
): Promise<{ cleanedText: string; links: string[] }> {
  const links: string[] = [];
  if (!text || !text.includes(DATA_ANALYSIS_FILE_START_PREFIX)) {
    return { cleanedText: text, links };
  }

  // Match a start marker (capturing the filename), the body, and the end marker.
  // [\s\S] so the body can span newlines; non-greedy so adjacent files don't merge.
  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `${escapeRegExp(DATA_ANALYSIS_FILE_START_PREFIX)}([^\\r\\n>]*?)${escapeRegExp(DATA_ANALYSIS_FILE_MARKER_SUFFIX)}\\r?\\n([\\s\\S]*?)\\r?\\n?${escapeRegExp(DATA_ANALYSIS_FILE_END_MARKER)}`,
    'g'
  );

  const { uploadFileToS3 } = await import('../../utils/s3Utils');
  let cleanedText = text;
  const matches = [...text.matchAll(pattern)];
  let fallbackIndex = 0;
  for (const match of matches) {
    const rawName = (match[1] || '').trim();
    const body = match[2] ?? '';
    // Sanitize/default the filename so we never produce an unusable S3 key.
    const safeName = rawName.replace(/[\r\n]/g, '').trim() || `analysis_output_${fallbackIndex++}.csv`;
    try {
      const uploadResult = await uploadFileToS3(
        Buffer.from(body, 'utf-8'),
        safeName,
        userId,
        contentTypeForFilename(safeName)
      );
      if (uploadResult.success && uploadResult.url) {
        links.push(`**File saved:** [${safeName}](${uploadResult.url})`);
        // Replace the whole marker block with a concise reference instead of the raw contents.
        cleanedText = cleanedText.replace(match[0], `[Generated file: ${safeName} — download link below]`);
      } else {
        console.error(`AgentMode: performDataAnalysis failed to upload generated file "${safeName}":`, uploadResult.error);
        cleanedText = cleanedText.replace(match[0], `[Generated file: ${safeName} — upload failed]`);
      }
    } catch (error) {
      console.error(`AgentMode: performDataAnalysis error uploading generated file "${safeName}":`, error);
      cleanedText = cleanedText.replace(match[0], `[Generated file: ${safeName} — upload failed]`);
    }
  }

  return { cleanedText, links };
}

/**
 * ENG-1889 — semantic class for a perform_data_analysis structured failure.
 * The tool's failures are RETURNED (`{ success: false, message }`), and the
 * run recorder previously bucketed most of them as a generic `Error`, which
 * made the 33% failure cluster undiagnosable. Every failure now carries a
 * class from KNOWN_TOOL_ERROR_CLASSES so telemetry and retry guidance can
 * distinguish caller mistakes from upstream/runtime faults.
 */
export function classifyDataAnalysisFailure(result: { message?: unknown; error?: unknown }): string {
  const code = typeof result.error === 'string' ? result.error : '';
  if (code === 'invalid_argument') return 'invalid_args';
  if (code === 'execution_failed' || code === 'inconsistent_result') return 'invalid_output';
  const m = (typeof result.message === 'string' ? result.message : '').toLowerCase();
  // Timeout first: its guidance text also says "too large".
  if (/timed out/.test(m)) return 'timeout';
  // Before the broad "is empty" pattern: "Gemini API key is empty" is a config fault.
  if (/gemini api key/.test(m)) return 'tool_unavailable';
  if (/too large|exceeds the .* limit|is required|must be|local file paths|cannot parse s3 url/.test(m)) return 'invalid_args';
  if (/could not be read|no longer available|cannot read tool-response|is empty|failed to download or process file/.test(m)) return 'not_found';
  if (/did not return any results/.test(m)) return 'empty_result';
  return 'upstream_5xx';
}

/** Total time one plain-URL download may take (redirects included). The guarded fetch enforces it as ONE deadline. */
const DOWNLOAD_TIMEOUT_MS = 30000;

/**
 * The guarded fetch gives a download ONE total deadline (redirects included). A host that cannot send the file in time surfaces as an
 * aborted request (axios `ERR_CANCELED`) or a timeout, and is a bad argument for this tool (a slow or huge file), not an account or config fault.
 */
function isDownloadTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.code === 'ERR_CANCELED') return true;
  if (e?.name === 'CanceledError' || e?.name === 'TimeoutError') return true;
  return typeof e?.message === 'string' && /timed out following redirects|timeout of \d+ms exceeded|aborted due to timeout/i.test(e.message);
}

/**
 * ENG-3151: the model often turns a tool-response key it was shown ("tool-responses/<uuid>/call_N.txt") into a URL by guessing the
 * bucket host (agentweb-tool-responses-prod.s3..., aw-team-internal-storage.s3..., bare s3.amazonaws.com). Every guess 404s. When an
 * https URL on an amazonaws.com host carries a tool-responses key as its path, return that key so it is read like a bare key, under the
 * same ownership check. Any other URL, and any path that is not exactly a tool-responses key, returns null (a plain download as before).
 *
 * Deliberate choices:
 *  - The host is ignored for ANY `*.amazonaws.com` host: the invented hosts are exactly what this repairs. Nothing is fetched from the
 *    host (the key is read from OUR bucket by the server), so userinfo and port are ignored too, and the query string / fragment is dropped.
 *    Safety comes from the exact key shape plus the caller's ownership check (`fileAccess.check`), not from the host.
 *  - Path-style URLs (`https://s3.<region>.amazonaws.com/<bucket>/tool-responses/...`) are intentionally NOT repaired: the path then starts
 *    with the bucket name, so it is not a key and returns null (out of scope; it falls through to the guarded fetch as before).
 *  - Dot segments are resolved by the WHATWG URL parser before this runs; encoded slashes decode into extra `/`, which the key regex refuses.
 */
function toolResponseKeyFromAmazonUrl(fileUrl: string): string | null {
  let u: URL;
  try { u = new URL(fileUrl); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)amazonaws\.com$/i.test(u.hostname)) return null;
  let key: string;
  try { key = decodeURIComponent(u.pathname.replace(/^\/+/, '')); } catch { return null; }
  if (!/^tool-responses\/[a-z0-9-]{36}\/[^/]+$/i.test(key)) return null;
  return key;
}

/**
 * ENG-3151: every file goes to the Gemini code-execution sandbox labelled `text/csv`, which Google documents as working best with
 * text and CSV. PDF and Excel files sent that way were answered with HTTP 400 `invalid_argument` after seconds to minutes of
 * upload. They are refused up front instead: by extension before anything is downloaded or read, and by the file's first bytes
 * (PDF `%PDF-`, zip container `PK\x03\x04`, legacy Office `D0 CF 11 E0`) before the model call. The cause of the 400 is not proven;
 * the refusal is safe either way because these files already fail.
 */
const BINARY_EXTENSIONS: Record<string, string> = {
  pdf: 'PDF', xlsx: 'Excel', xlsm: 'Excel', xlsb: 'Excel', xls: 'Excel', docx: 'Word', doc: 'Word', pptx: 'PowerPoint', zip: 'zip archive',
};

function binaryKindFromName(entry: string): string | null {
  let path = entry;
  try { path = entry.includes('://') ? new URL(entry).pathname : entry; } catch { return null; }
  let last = path.slice(path.lastIndexOf('/') + 1);
  try { last = decodeURIComponent(last); } catch { /* keep the raw name */ }
  const dot = last.lastIndexOf('.');
  return dot < 0 ? null : (BINARY_EXTENSIONS[last.slice(dot + 1).toLowerCase()] ?? null);
}

function binaryKindFromBytes(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'Excel/Word/zip';
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'Office';
  return null;
}

function binaryFileRefusal(entry: string, kind: string) {
  const shown = entry.length > 120 ? `${entry.slice(0, 117)}...` : entry;
  return {
    success: false,
    message: `file_urls entry "${shown}" is a ${kind} file, and perform_data_analysis reads text files only (CSV, TSV, JSON or plain text). Convert the data to CSV and pass that file, or put the data inline in analysis_instruction.`,
    errorClass: 'invalid_args',
  };
}

/** ENG-2993: HTTP status of a failed file download (axios response, else message). */
function downloadHttpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === 'number') return status;
  const m = error instanceof Error ? /status code (\d{3})\b/.exec(error.message) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Public entry point. Validates argument types against the declared tool
 * schema (file_urls: string[]; analysis_instruction: string — no stricter
 * handler-only constraints) and stamps a structured `errorClass` on every
 * failure, including unexpected throws, so no failure surfaces as a bare
 * generic `Error`.
 */
export async function performDataAnalysis(fileUrls: string[], analysisInstruction: string, userId: string): Promise<any> {
  if (fileUrls !== undefined && fileUrls !== null
    && (!Array.isArray(fileUrls) || fileUrls.some(u => typeof u !== 'string'))) {
    return {
      success: false,
      message: 'file_urls must be an array of S3 or HTTPS URL strings. Pass an empty array when all data is inline in analysis_instruction.',
      error: 'invalid_argument',
      errorClass: 'invalid_args',
    };
  }
  if (analysisInstruction !== undefined && analysisInstruction !== null && typeof analysisInstruction !== 'string') {
    return {
      success: false,
      message: 'analysis_instruction must be a string describing the analysis task.',
      error: 'invalid_argument',
      errorClass: 'invalid_args',
    };
  }
  let result: any;
  try {
    result = await performDataAnalysisUnclassified(fileUrls, analysisInstruction, userId);
  } catch (error) {
    // Defensive: the implementation catches internally, but anything that
    // escapes must still be structured and actionable.
    console.error('AgentMode: performDataAnalysis unexpected throw:', error);
    return {
      success: false,
      message: 'The data analysis failed with an unexpected internal error. Retry once; if it fails again, save the dataset with save_file and retry with a shorter, more specific analysis_instruction.',
      error: error instanceof Error ? error.message : String(error),
      errorClass: 'upstream_5xx',
    };
  }
  if (result && result.success === false && !result.errorClass) {
    result.errorClass = classifyDataAnalysisFailure(result);
  }
  return result;
}

async function performDataAnalysisUnclassified(fileUrls: string[], analysisInstruction: string, userId: string): Promise<any> {
  try {
    const urlsToProcess = Array.isArray(fileUrls) ? fileUrls.filter(url => !!url) : [];

    // The SDK reads below use the SERVER's credentials, which can read every bucket in the account. So each key a caller
    // names is checked against the caller with the same rule as the REST file routes (ENG-2988). One lookup cache per call.
    // Loaded here, not with the static imports: the access policy reaches the database layer and chatbotService, which this
    // module must not load when it is merely required (see the header note and searchResearch.moduleIsolation.test.ts).
    const { TOOL_FILE_REFUSAL_MESSAGE, TOOL_FILE_UNAVAILABLE_MESSAGE, createToolFileAccess } = await import('./toolStorageAccess');
    const fileAccess = createToolFileAccess('perform_data_analysis', userId);
    // `invalid_args`, not `not_found`: the model named a file the caller may not read, a bad argument. `not_found` is bucketed as a
    // config/account fault ("resolve the account, not the code"), the phantom cluster ENG-2993 removed for dead caller URLs.
    const refuseFile = () => ({
      success: false,
      message: TOOL_FILE_REFUSAL_MESSAGE,
      error: 'File not accessible',
      errorClass: 'invalid_args',
    });
    // The check itself could not run (a lookup failed): tell the model to retry, not that the file is gone.
    const fileCheckUnavailable = () => ({
      success: false,
      message: TOOL_FILE_UNAVAILABLE_MESSAGE,
      error: 'File access check unavailable',
      errorClass: 'upstream_5xx',
    });

    if (!analysisInstruction) {
      return {
        success: false,
        message: 'Analysis instruction is required'
      };
    }

    // Reject oversized instructions early so the LLM can self-correct rather than sending a
    // payload that will be rejected and cause it to simulate results.
    const MAX_INLINE_INSTRUCTION_CHARS = 200_000; // ~50K tokens — well within Gemini's 1M context
    if (analysisInstruction.length > MAX_INLINE_INSTRUCTION_CHARS) {
      return {
        success: false,
        message: `The analysis_instruction is too large (${analysisInstruction.length.toLocaleString()} characters, max ${MAX_INLINE_INSTRUCTION_CHARS.toLocaleString()}). IMPORTANT: Do NOT retry perform_data_analysis with inline data. You MUST first call save_file to upload the dataset as a .csv or .txt file and get an S3 URL, then call perform_data_analysis with that URL in file_urls and a short analysis_instruction (no inline data).`
      };
    }

    // Gemini code execution runs in a remote isolated sandbox — it cannot access local file paths
    // or S3-offloaded tool response paths from previous tool calls. When the LLM embeds S3 tool-
    // response keys in the instruction (a common pattern after read_tool_response), auto-resolve
    // them by fetching the content from S3 and embedding it inline, rather than failing and
    // forcing the LLM into a retry loop.
    const localPathPattern = /(?:open|read|load)\s*\(\s*['"`]\/|with open\(['"`]\//i;
    const s3KeyPathPattern = /tool-responses\/[a-z0-9-]{36}\//i;
    if (s3KeyPathPattern.test(analysisInstruction)) {
      // Extract all unique tool-response S3 keys from the instruction
      const keyMatches = analysisInstruction.match(/tool-responses\/[a-z0-9-]{36}\/[^\s'"`)]+/gi) || [];
      const uniqueKeys = [...new Set(keyMatches)];
      let resolved = analysisInstruction;
      const resolvedKeys: string[] = [];
      const failedKeys: string[] = [];
      // Check EVERY key before reading any: a call that names a file the caller may not read is refused whole, with the same
      // answers as the other two read sites (a refusal is `invalid_args`; a check that could not run says "try again").
      const keyDecisions: string[] = [];
      for (const key of uniqueKeys) keyDecisions.push(await fileAccess.check(key));
      if (keyDecisions.includes('refuse')) return refuseFile();
      if (keyDecisions.includes('unavailable')) return fileCheckUnavailable();
      const instructionTooLarge = (size?: number) => ({
        success: false,
        message: `After resolving tool-response references, the analysis_instruction is too large (${size !== undefined ? `${size.toLocaleString()} characters, ` : ''}max ${MAX_INLINE_INSTRUCTION_CHARS.toLocaleString()}). IMPORTANT: Do NOT retry perform_data_analysis with inline data. You MUST first call save_file to upload the dataset as a .csv or .txt file and get an S3 URL, then call perform_data_analysis with that URL in file_urls and a short analysis_instruction (no inline data).`
      });
      for (const key of uniqueKeys) {
        try {
          // Read at most what could still fit in the instruction (a character is at most 3 UTF-8 bytes), shared by every place the key is
          // named (each is replaced by the content): a larger object is refused without loading it or building the multiplied text, as
          // the whole instruction would be refused after it anyway.
          const occurrences = Math.max(1, resolved.split(key).length - 1);
          const allowance = Math.max(0, Math.floor((3 * (MAX_INLINE_INSTRUCTION_CHARS - resolved.length)) / occurrences));
          const content = await getS3ObjectAsString(key, undefined, { maxBytes: allowance });
          if (content) {
            // Replace all occurrences of the key with the actual content inline
            resolved = resolved.split(key).join(`\n[Content of ${key}]:\n${content}\n`);
            resolvedKeys.push(key);
            // A key named many times multiplies its content: stop as soon as the instruction is over the limit.
            if (resolved.length > MAX_INLINE_INSTRUCTION_CHARS) return instructionTooLarge(resolved.length);
          } else {
            failedKeys.push(key);
          }
        } catch (readErr) {
          if ((readErr as any)?.name === 'S3ObjectTooLargeError') return instructionTooLarge();
          failedKeys.push(key);
        }
      }
      if (failedKeys.length > 0 && resolvedKeys.length === 0) {
        return {
          success: false,
          message: `The analysis_instruction references tool-response S3 keys that could not be read: ${failedKeys.join(', ')}. Use read_tool_response to load the data first, then embed it directly in analysis_instruction or save it via save_file and pass the URL in file_urls.`
        };
      }
      analysisInstruction = resolved;
      // Re-check size after resolution
      if (analysisInstruction.length > MAX_INLINE_INSTRUCTION_CHARS) {
        return {
          success: false,
          message: `After resolving tool-response references, the analysis_instruction is too large (${analysisInstruction.length.toLocaleString()} characters, max ${MAX_INLINE_INSTRUCTION_CHARS.toLocaleString()}). IMPORTANT: Do NOT retry perform_data_analysis with inline data. You MUST first call save_file to upload the dataset as a .csv or .txt file and get an S3 URL, then call perform_data_analysis with that URL in file_urls and a short analysis_instruction (no inline data).`
        };
      }
    } else if (localPathPattern.test(analysisInstruction)) {
      return {
        success: false,
        message: `The analysis_instruction references local file paths (e.g. open('/home/bard/...')). The code execution sandbox is remote and isolated — it has no access to any local files. All data must be provided via: (1) file_urls — pass S3 URLs of files (use save_file to upload data and get a URL first), or (2) analysis_instruction — embed the data directly as text if it is small enough.`
      };
    }

    // Get Gemini API key from Secrets Manager
    const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    const geminiSecretName = environment === 'prod'
      ? 'prod/AgentWeb/GeminiAPIKey'
      : 'dev/AgentWeb/GeminiAPIKey';
    let geminiApiKey: string;
    try {
      geminiApiKey = await getSecret(geminiSecretName);
    } catch (error) {
      console.error('AgentMode: Failed to retrieve Gemini API key from Secrets Manager:', error);
      return {
        success: false,
        message: 'Failed to retrieve Gemini API key from Secrets Manager'
      };
    }

    geminiApiKey = geminiApiKey.trim();
    if (!geminiApiKey) {
      return {
        success: false,
        message: 'Gemini API key is empty'
      };
    }

    // Initialize Google Generative AI client
    const genAI = new GoogleGenerativeAI(geminiApiKey);

    // Get the model name from environment or use default. gemini-3.5-flash is
    // Google's documented code-execution model and reliably materializes input
    // files on the sandbox filesystem; the older gemini-2.5-flash intermittently
    // returns HTTP 500 on the same payloads.
    const modelName = process.env.DATA_ANALYSIS_LLM_NAME || 'gemini-3.5-flash';

    // Get file size limit from environment or use default (50MB)
    // 50MB in bytes. A value that is not a number must not switch the cap off (a NaN limit compares false with everything).
    const configuredMaxTotalSize = parseInt(process.env.DATA_ANALYSIS_FILE_SIZE || '52428800');
    const maxTotalSize = Number.isFinite(configuredMaxTotalSize) && configuredMaxTotalSize >= 0 ? configuredMaxTotalSize : 52428800;
    const totalSizeExceeded = () => ({
      success: false,
      message: `Total file size exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`,
    });

    // Prepare file data for analysis.
    // IMPORTANT: Gemini code_execution only writes a file part to the sandbox
    // filesystem when its mimeType is text/csv. application/json is rejected
    // (HTTP 400) and text/plain is silently NOT written to disk. So every file
    // is sent as text/csv regardless of its real content type, and the model is
    // told the exact on-disk filenames (input_file_<n>.csv in /root) so it reads
    // from disk instead of re-inlining and truncating large payloads.
    const SANDBOX_FILE_MIME = 'text/csv';
    const fileParts: any[] = [];
    // Human-readable source description per file, parallel to fileParts, used to
    // build the filename manifest in the prompt.
    const fileSources: string[] = [];
    // Decoded raw content per file, parallel to fileSources — kept only for the
    // ENG-1295 provenance stub's rows_in estimate, not sent anywhere else.
    const fileRawContents: string[] = [];
    let totalSize = 0;

    // ENG-3151: refuse formats the sandbox cannot read before any download. Only plain URLs here: an s3:// or tool-responses key is
    // judged after its access check below, so a key the caller may not read still gets the one uniform "not found or no access" answer.
    for (const entry of urlsToProcess) {
      if (entry.startsWith('s3://') || /^tool-responses\/[a-z0-9-]{36}\//i.test(entry)) continue;
      const kind = binaryKindFromName(entry);
      if (kind) return binaryFileRefusal(entry, kind);
    }

    for (const fileUrl of urlsToProcess) {
      try {
        // If the LLM passed an s3:// URI (e.g. "s3://bucket/key"), fetch directly via SDK
        // instead of handing it to axios which only supports http/https.
        if (fileUrl.startsWith('s3://')) {
          const withoutScheme = fileUrl.slice('s3://'.length);
          const slashIdx = withoutScheme.indexOf('/');
          const s3Bucket = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
          const s3Key = slashIdx === -1 ? '' : withoutScheme.slice(slashIdx + 1);
          if (!s3Key) {
            return {
              success: false,
              message: `Cannot parse S3 URL "${fileUrl}": no object key found. Use the full s3://bucket/key format.`,
            };
          }
          // Only our own bucket, and only a key this caller may read: the bucket here is whatever the caller wrote.
          if (!fileAccess.isOurBucket(s3Bucket)) return refuseFile();
          const s3Decision = await fileAccess.check(s3Key);
          if (s3Decision !== 'allow') return s3Decision === 'unavailable' ? fileCheckUnavailable() : refuseFile();
          { const kind = binaryKindFromName(s3Key); if (kind) return binaryFileRefusal(fileUrl, kind); }
          let s3Content: string;
          try {
            // Read at most what is left of the total allowance: an object larger than that is refused without loading it.
            s3Content = await getS3ObjectAsString(s3Key, s3Bucket, { maxBytes: Math.max(maxTotalSize - totalSize, 0) });
          } catch (s3Err) {
            if ((s3Err as any)?.name === 'S3ObjectTooLargeError') return totalSizeExceeded();
            const s3ErrMsg = s3Err instanceof Error ? s3Err.message : String(s3Err);
            return {
              success: false,
              message: `Failed to download or process file: ${fileUrl}`,
              error: s3ErrMsg,
            };
          }
          const contentBuffer = Buffer.from(s3Content, 'utf-8');
          totalSize += contentBuffer.byteLength;
          if (totalSize > maxTotalSize) {
            return {
              success: false,
              message: `Total file size (${totalSize} bytes) exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`
            };
          }
          fileParts.push({
            inlineData: {
              mimeType: SANDBOX_FILE_MIME,
              data: contentBuffer.toString('base64'),
            }
          });
          fileSources.push(fileUrl);
          fileRawContents.push(s3Content);
          continue;
        }

        // If the LLM passed a bare S3 tool-response key (e.g. "tool-responses/<uuid>/foo.txt")
        // instead of a proper URL, read it directly from S3 rather than failing with "Invalid URL".
        const bareS3KeyPattern = /^tool-responses\/[a-z0-9-]{36}\//i;
        // ENG-3151: also a key the model wrapped in an invented amazonaws.com host.
        const toolResponseKey = toolResponseKeyFromAmazonUrl(fileUrl) ?? fileUrl;
        if (bareS3KeyPattern.test(toolResponseKey)) {
          const bareDecision = await fileAccess.check(toolResponseKey);
          if (bareDecision !== 'allow') return bareDecision === 'unavailable' ? fileCheckUnavailable() : refuseFile();
          { const kind = binaryKindFromName(fileUrl); if (kind) return binaryFileRefusal(fileUrl, kind); }
          let s3Content: string;
          try {
            s3Content = await getS3ObjectAsString(toolResponseKey, undefined, { maxBytes: Math.max(maxTotalSize - totalSize, 0) });
          } catch (s3Err) {
            if ((s3Err as any)?.name === 'S3ObjectTooLargeError') return totalSizeExceeded();
            const s3ErrMsg = s3Err instanceof Error ? s3Err.message : String(s3Err);
            return {
              success: false,
              message: `Cannot read tool-response file "${toolResponseKey}" from S3: ${s3ErrMsg}. The data is no longer available. Re-run the original tool call to regenerate the data, then pass the new S3 key.`,
            };
          }
          if (!s3Content) {
            return {
              success: false,
              message: `Tool-response file "${toolResponseKey}" exists in S3 but is empty. Re-run the original tool call to regenerate the data.`,
            };
          }
          const contentBuffer = Buffer.from(s3Content, 'utf-8');
          totalSize += contentBuffer.byteLength;
          if (totalSize > maxTotalSize) {
            return {
              success: false,
              message: `Total file size (${totalSize} bytes) exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`
            };
          }
          fileParts.push({
            inlineData: {
              mimeType: SANDBOX_FILE_MIME,
              data: contentBuffer.toString('base64'),
            }
          });
          fileSources.push(fileUrl);
          fileRawContents.push(s3Content);
          continue;
        }

        // An entry that is not a URL at all (a plain file name, a local path) is a mistake of the caller, not a blocked address: say so, and do
        // not log it as a refused URL.
        let parsesAsUrl = true;
        try { new URL(fileUrl); } catch { parsesAsUrl = false; }
        if (!parsesAsUrl) {
          return {
            success: false,
            message: `file_urls entry "${fileUrl}" is not a URL. Pass a public https link, an s3:// key from save_file or a tool-responses key, or put the data inline in analysis_instruction.`,
            errorClass: 'invalid_args',
          };
        }

        // Download the file. A URL the caller chose is fetched only through the guarded fetch (public addresses only, every redirect
        // checked again), and the body is capped at what is left of the total budget, so one URL cannot stream an unbounded body into memory.
        const { buffer: fileBuffer } = await fetchCallerUrlBuffer(fileUrl, {
          tool: 'perform_data_analysis',
          userId,
          maxBytes: Math.max(maxTotalSize - totalSize, 0),
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        });

        // ENG-3151: a binary file behind a URL with no telling extension.
        const sniffed = binaryKindFromBytes(fileBuffer);
        if (sniffed) return binaryFileRefusal(fileUrl, sniffed);

        // Check file size
        totalSize += fileBuffer.byteLength;
        if (totalSize > maxTotalSize) {
          return {
            success: false,
            message: `Total file size (${totalSize} bytes) exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`
          };
        }

        // Send to Gemini as text/csv so the file materializes on the sandbox
        // filesystem (see SANDBOX_FILE_MIME note above). The actual content may
        // be CSV, JSON, or plain text — the model is told this in the prompt.
        const base64Content = fileBuffer.toString('base64');

        fileParts.push({
          inlineData: {
            mimeType: SANDBOX_FILE_MIME,
            data: base64Content,
          }
        });
        fileSources.push(fileUrl);
        fileRawContents.push(fileBuffer.toString('utf-8'));

      } catch (error) {
        // A URL the guard refuses: one generic answer, nothing about why (no address, no DNS text) and no `error` echo, so the
        // answer cannot be used to map the internal network. A bad argument, not a tool fault.
        if (error instanceof CallerUrlBlockedError) {
          return {
            success: false,
            message: `Cannot fetch file_urls entry ${fileUrl}: ${CALLER_URL_BLOCKED_MESSAGE} Put the data inline in analysis_instruction, or pass an s3:// key from save_file or a tool-responses key.`,
            errorClass: 'invalid_args',
          };
        }
        if (error instanceof CallerUrlTooLargeError) {
          return {
            success: false,
            message: `Total file size exceeds the ${maxTotalSize} bytes limit. Please reduce the number or size of files.`,
            errorClass: 'invalid_args',
          };
        }
        console.error(`Error processing file ${fileUrl}:`, error);
        if (isDownloadTimeout(error)) {
          return {
            success: false,
            message: `Downloading ${fileUrl} did not finish within the ${DOWNLOAD_TIMEOUT_MS / 1000}-second download limit. The host is too slow or the file too large: use a smaller file or a faster link, or put the data inline in analysis_instruction.`,
            errorClass: 'timeout',
          };
        }
        // ENG-2993: an HTTP 4xx (other than 429) on a caller-supplied URL means
        // the model passed a dead, expired, or non-public link. There is no
        // account to repair, so it must not cluster as not_found -> `config`.
        const httpStatus = downloadHttpStatus(error);
        if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
          return {
            success: false,
            message: `Failed to download or process file: ${fileUrl} returned HTTP ${httpStatus} — the URL does not exist, has expired, or is not publicly readable. This is a bad file_urls value, not a tool fault: re-run the tool that produced the data and pass its fresh URL or tool-responses S3 key, or put the data inline in analysis_instruction.`,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorClass: 'invalid_args',
          };
        }
        return {
          success: false,
          message: `Failed to download or process file: ${fileUrl}`,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }

    // Prepare content parts
    const parts: any[] = [];

    // Add file parts
    fileParts.forEach(part => parts.push(part));

    // Build a manifest mapping each attached file to its exact on-disk filename.
    // Gemini writes the Nth file part to <SANDBOX_INPUT_OUTPUT_DIRECTORY>/input_file_<N>.csv
    // (SANDBOX_INPUT_OUTPUT_DIRECTORY is the sandbox working directory). The model
    // MUST read these files from disk — they are the complete, untruncated dataset.
    let fileGuidance: string;
    if (fileParts.length > 0) {
      const manifest = fileSources
        .map((src, i) => `- input_file_${i}.csv (from ${src})`)
        .join('\n');
      fileGuidance = `The following data files have been written to the code-execution sandbox filesystem in the working directory (also available via the SANDBOX_INPUT_OUTPUT_DIRECTORY environment variable):\n${manifest}\n\nIMPORTANT: Read these files FROM DISK with Python (e.g. open('input_file_0.csv').read()). They contain the COMPLETE dataset — do NOT rely on any data pasted inline in this instruction, which may be truncated. Although the filenames end in .csv, the contents may be CSV, JSON, JSONL, or plain text; detect the format and parse accordingly (e.g. json.loads for JSON). Also incorporate any small structured data included in the instruction text below.`;
    } else {
      fileGuidance = 'No external files are attached; treat the information in the instruction as the complete dataset for this task.';
    }

    // Add text part with analysis instruction so the model knows how to proceed with or without files
    parts.push({
      text: `Please perform the following analysis task. ${fileGuidance}\n\n${analysisInstruction}\n\nUse Python code execution to analyze the data and provide detailed insights. Do not ask questions as the user is not present.\n\nIMPORTANT: When generating charts or visualizations, you MUST use matplotlib or seaborn to produce rasterized PNG images. Do NOT use altair, vega, vega-lite, or any library that produces JSON specs instead of rendered images. Always call plt.savefig() or equivalent to emit the image as inline output, then call plt.close() to free memory.\n\nSAVING FILES FOR DOWNLOAD: If the task asks you to save, export, or otherwise produce a file the user should download (e.g. a CSV, JSON, or text file), you MUST print its COMPLETE contents to stdout with print(), wrapped EXACTLY in these markers, each on its own line:\n${DATA_ANALYSIS_FILE_START_PREFIX}<filename>${DATA_ANALYSIS_FILE_MARKER_SUFFIX}\n<full file contents>\n${DATA_ANALYSIS_FILE_END_MARKER}\nUse a short, descriptive filename with the correct extension (e.g. seed_audience.csv). The platform captures everything between these markers and saves it to real, downloadable storage, then returns a working download link to the user. Do NOT invent, guess, fabricate, or report any download URL, S3 key, or file path yourself (e.g. a bare filename, an "https://...s3..." URL, or a "sandbox:/..." path) — the sandbox filesystem is discarded after execution and ANY such path will fail to download. Printing the contents between the markers above is the ONLY way to deliver a file to the user.`
    });

    // Call Gemini API directly via REST to enable code execution
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    const apiResponse = await axios.post(apiUrl,
      {
        tools: [{ code_execution: {} }],
        contents: [
          {
            parts: parts
          }
        ]
      },
      {
        headers: {
          'x-goog-api-key': geminiApiKey,
          'Content-Type': 'application/json'
        },
        timeout: 20 * 60 * 1000, // 20 minutes — code execution can be slow but must not hang indefinitely
      }
    );

    // Usage metering (Ship 1): direct REST call — meter off the resolved response
    // via the shared hook. Charges the user's cap (all-cost-to-user policy), fail-open.
    if ((apiResponse.data as any)?.usageMetadata) {
      meterUsageFromResponse(
        { userId, model: modelName, provider: 'gemini', feature: 'agent_task' },
        apiResponse.data
      );
    }

    // Extract and format the response
    const candidates = (apiResponse.data as any).candidates;

    if (!candidates || candidates.length === 0) {
      return {
        success: false,
        message: 'No response received from Gemini API'
      };
    }

    const resultParts: string[] = [];
    let codeExecuted = false;
    let hasNarrativeText = false;
    // Cleaned stdout from code-execution parts, kept separate from resultParts.
    // Used ONLY as a fallback when the model emits no narrative `text` part (see
    // the post-loop block) — folding every intermediate code stdout into the
    // analysis would bury the real summary under print()-debugging noise.
    const codeExecOutputs: string[] = [];
    // ENG-1295: the generated CSV text (if any), kept separately from resultParts
    // so the provenance stub and self-consistency check below can parse it.
    let generatedCsvText: string | null = null;
    // ENG-1600: Gemini can return more than one text/csv inline part. Every one is shown to
    // the caller as Computed Data, but only one can back the provenance stub and the
    // cross-call cache. Comparing an arbitrary part against a previous run's arbitrary part
    // fabricates an inconsistency and hard-rejects a correct analysis, so the count is
    // tracked and the comparison is skipped when it exceeds one.
    let generatedCsvPartCount = 0;

    // Extract parts from response
    const responseParts = candidates[0].content.parts || [];

    // Generated-file download links collected from marked stdout/text blocks.
    const fileLinks: string[] = [];

    for (const part of responseParts) {
      if (part.text) {
        hasNarrativeText = true;
        const { cleanedText, links } = await extractAndUploadAnalysisFiles(part.text, userId);
        fileLinks.push(...links);
        resultParts.push(`**Analysis:** ${cleanedText}`);
      }
      // Capture the model's executed-code output. Gemini returns executed-code
      // stdout in a codeExecutionResult / code_execution_result part. This is
      // also where the marker protocol delivers generated file contents, so we
      // always mine it for download links. We additionally KEEP the cleaned
      // stdout as a fallback narrative: code-execution models (gemini-3.5-flash
      // especially) intermittently end a turn after the last code block WITHOUT
      // a summary `text` part — the computed answer then lives only in this
      // stdout. Surfacing it (when no text part exists) prevents a good analysis
      // from being dropped as "No analysis results received from Gemini"
      // (scheduled session 8aa71237 failed 4x this way on a ~400KB payload).
      const execResult = (part as any).codeExecutionResult || (part as any).code_execution_result;
      if (execResult && typeof execResult.output === 'string') {
        codeExecuted = true;
        const { cleanedText, links } = await extractAndUploadAnalysisFiles(execResult.output, userId);
        fileLinks.push(...links);
        if (cleanedText && cleanedText.trim()) {
          codeExecOutputs.push(cleanedText.trim());
        }
      }
      // Handle inline data (images/charts from code execution) (handle both camelCase and snake_case)
      if ((part as any).inlineData && (part as any).inlineData.data) {
        const mimeType = (part as any).inlineData.mimeType || 'image/png';
        if (mimeType === 'text/csv') {
          // Gemini's code-execution sandbox returns generated tabular data (e.g. a
          // df.to_csv() write) as an inlineData part with mimeType text/csv rather
          // than through stdout/codeExecutionResult. Discarding this — as the old
          // code did for every non-image inlineData — left the caller with only the
          // model's separate narrative `text` summary, ungrounded by the real
          // computed output. That is how perform_data_analysis reported hallucinated
          // ad-group names and contradictory row counts (ENG-1295).
          codeExecuted = true;
          try {
            const csvText = Buffer.from((part as any).inlineData.data, 'base64').toString('utf-8').trim();
            if (csvText) {
              resultParts.push(`**Computed Data:**\n${csvText}`);
              generatedCsvText = csvText;
              generatedCsvPartCount++;
              // ENG-1295 follow-up: this Gemini response shape is rare and non-deterministic, so it
              // could not be re-triggered on demand to confirm the fix still fires in real traffic.
              // A positive signal here means the next organic occurrence shows up in CloudWatch.
              console.log('AgentMode: performDataAnalysis surfaced generated CSV via inlineData (mimeType=text/csv)');
            }
          } catch (error) {
            console.error('AgentMode: performDataAnalysis error decoding generated CSV inlineData:', error);
          }
        } else if (!mimeType.startsWith('image/')) {
          // Gemini returned non-image data (e.g. Vega-Lite JSON from altair) — skip it
          console.warn(`AgentMode: performDataAnalysis skipping non-image inlineData with mimeType=${mimeType}`);
        } else {
          // A rendered chart image is itself proof that code actually ran in the
          // sandbox (ENG-1295 hard guard below) — set this regardless of whether
          // the subsequent S3 upload succeeds.
          codeExecuted = true;
          try {
            const imageData = (part as any).inlineData.data;

            // Convert base64 string to Buffer for S3 upload
            const imageBuffer = Buffer.from(imageData, 'base64');

            // Upload image to S3
            const { uploadFileToS3 } = await import('../../utils/s3Utils');
            const imageFilename = `analysis_chart_${Date.now()}.png`;
            const uploadResult = await uploadFileToS3(
              imageBuffer,
              imageFilename,
              userId,
              mimeType
            );

            if (uploadResult.success && uploadResult.url) {
              resultParts.push(`**Chart/Image Generated:**\n![Analysis Result](${uploadResult.url})`);
            }
          } catch (error) {
            console.error('Error uploading inline data to S3:', error);
            resultParts.push(`**Chart/Image Generated:** (Failed to upload to S3)`);
          }
        }
      } else if ((part as any).inline_data && (part as any).inline_data.data) {
        // Handle snake_case format
        const mimeType = (part as any).inline_data.mimeType || (part as any).inline_data.mime_type || 'image/png';
        if (mimeType === 'text/csv') {
          // See the camelCase inlineData branch above (ENG-1295): a generated CSV
          // must be surfaced, not discarded, or the caller only sees the model's
          // ungrounded narrative summary.
          codeExecuted = true;
          try {
            const csvText = Buffer.from((part as any).inline_data.data, 'base64').toString('utf-8').trim();
            if (csvText) {
              resultParts.push(`**Computed Data:**\n${csvText}`);
              generatedCsvText = csvText;
              generatedCsvPartCount++;
              // ENG-1295 follow-up: snake_case variant of the same rare shape — logged separately
              // so the two branches are distinguishable in CloudWatch.
              console.log('AgentMode: performDataAnalysis surfaced generated CSV via inline_data (mimeType=text/csv)');
            }
          } catch (error) {
            console.error('AgentMode: performDataAnalysis error decoding generated CSV inline_data (snake_case):', error);
          }
        } else if (!mimeType.startsWith('image/')) {
          // Gemini returned non-image data (e.g. Vega-Lite JSON from altair) — skip it
          console.warn(`AgentMode: performDataAnalysis skipping non-image inline_data with mimeType=${mimeType}`);
        } else {
          // See the camelCase branch above — a rendered chart proves code executed.
          codeExecuted = true;
          try {
            const imageData = (part as any).inline_data.data;

            // Convert base64 string to Buffer for S3 upload
            const imageBuffer = Buffer.from(imageData, 'base64');

            // Upload image to S3
            const { uploadFileToS3 } = await import('../../utils/s3Utils');
            const imageFilename = `analysis_chart_${Date.now()}.png`;
            const uploadResult = await uploadFileToS3(
              imageBuffer,
              imageFilename,
              userId,
              mimeType
            );

            if (uploadResult.success && uploadResult.url) {
              resultParts.push(`**Chart/Image Generated:**\n![Analysis Result](${uploadResult.url})`);
            }
          } catch (error) {
            console.error('Error uploading inline_data (snake_case) to S3:', error);
            resultParts.push(`**Chart/Image Generated:** (Failed to upload to S3)`);
          }
        }
      }
    }

    // ENG-1295 hard guard: real external data was supplied (file_urls resolved to
    // at least one sandbox file) but nothing in the response shows code actually
    // executing over it — no generated CSV, no rendered image, no codeExecutionResult
    // stdout. A bare narrative `text` part in this case is unverifiable prose about
    // data the model never touched — exactly how perform_data_analysis reported
    // hallucinated ad-group names and contradictory counts in prod session d789c175.
    // Reject rather than pass it off as computed output. Calls with no file_urls are
    // unaffected: there is no external tabular data to hallucinate about, so
    // inline-only summarization remains a legitimate use of this tool.
    if (fileParts.length > 0 && !codeExecuted) {
      console.warn(
        `AgentMode: performDataAnalysis got narrative text with no verified code execution over ${fileParts.length} supplied file(s) (model=${modelName})`
      );
      return {
        success: false,
        message:
          'The analysis model returned a narrative summary without any verified code execution over the supplied file_urls — ' +
          'this cannot be trusted as computed output and was not returned. Retry with a more explicit instruction that forces ' +
          'Python code execution over the file(s) (e.g. "You MUST read and parse the file(s) with Python and print exact ' +
          'computed values — do not summarize without computing").',
        error: 'execution_failed'
      };
    }

    // Fallback narrative: the model produced executed-code output but no
    // summary `text` part. Surface the final stdout block (the last code cell's
    // output is the result; earlier cells are typically inspection/debug) so the
    // computed answer is not lost. Only when there's no narrative text — when a
    // text part exists, that is the intended human-readable summary.
    if (!hasNarrativeText && codeExecOutputs.length > 0) {
      resultParts.push(`**Output:**\n${codeExecOutputs[codeExecOutputs.length - 1]}`);
    }

    // Surface real, downloadable links for any files the model generated.
    if (fileLinks.length > 0) {
      resultParts.push(`**Generated Files:**\n${fileLinks.join('\n')}`);
    }

    if (resultParts.length === 0) {
      // The turn produced no text, no code-execution output, and no images.
      // The dominant cause is the model pausing on an internal tool/functionCall
      // (run_command, python_interpreter) instead of completing the inline
      // code_execution in one shot — we send a single-shot request with no
      // tool-call loop, so the turn just ends empty. This is transient and
      // resolves on a re-run, but the OLD generic message ("No analysis results
      // received from Gemini") was classified as empty_result and triggered the
      // model to retry blindly with the same payload. Return an actionable
      // message that names the real next step and log the finishReason so the
      // failure mode is diagnosable from prod logs.
      const finishReason = (candidates[0] as any)?.finishReason;
      const sawFunctionCall = responseParts.some((p: any) => p.functionCall || p.function_call);
      console.warn(
        `AgentMode: performDataAnalysis got no usable parts (finishReason=${finishReason}, ` +
        `numParts=${responseParts.length}, sawFunctionCall=${sawFunctionCall}, model=${modelName})`
      );
      return {
        success: false,
        message:
          'The data analysis did not return any results — the code-execution model ended its turn without producing output. ' +
          'This is usually transient. Try again once with the same file_urls and a simpler, more direct analysis_instruction ' +
          '(e.g. ask for specific totals or columns rather than an open-ended report). Do NOT re-inline the raw data.'
      };
    }

    // ENG-1295 hardening: cross-call self-consistency and a provenance stub
    // (including intra-CSV id/name collision and source-grounding checks) for
    // generated CSV data.
    if (generatedCsvText) {
      const provenance = parseCsvProvenance(generatedCsvText);
      if (provenance) {
        // 1. Cross-call self-consistency: an exact repeat call whose grouping-key
        // set changed since its last run.
        const cacheKey = buildDataAnalysisCacheKey(userId, urlsToProcess, analysisInstruction);
        // ENG-1600: with several CSV parts, `provenance` describes only one of them and which
        // one depends on part order. Comparing that against a previous run — which may have
        // captured a different part — is a fabricated inconsistency, and this check hard-rejects.
        const comparable = generatedCsvPartCount <= 1;
        const prior = comparable ? dataAnalysisConsistencyCache.get(cacheKey) : undefined;
        if (prior) {
          const priorSet = new Set(prior.groupingKeyValues);
          const currentSet = new Set(provenance.groupingKeyValues);
          const isConsistent = priorSet.size === currentSet.size &&
            [...priorSet].every(v => currentSet.has(v));
          if (!isConsistent) {
            console.warn(
              `AgentMode: performDataAnalysis inconsistent result on an identical repeat call (userId=${userId}): ` +
              `prior grouping keys=[${prior.groupingKeyValues.join(', ')}] vs current=[${provenance.groupingKeyValues.join(', ')}]`
            );
            return {
              success: false,
              message:
                'This exact analysis call (identical file_urls and analysis_instruction) previously returned a DIFFERENT set of ' +
                'result names than this run — the data-analysis model is not consistently computing over the real data, so ' +
                'neither result can be trusted. Do NOT retry with the identical arguments. Instead, re-run grouping strictly by ' +
                'a stable ID field (not a name) so the result is verifiable against the source data.',
              error: 'inconsistent_result'
            };
          }
        }
        // Only cache a single-part result: storing one arbitrary part of a multi-part answer
        // would poison the NEXT call's comparison exactly the same way.
        if (comparable) {
          dataAnalysisConsistencyCache.set(cacheKey, { groupingKeyValues: provenance.groupingKeyValues, timestamp: Date.now() });
          pruneDataAnalysisConsistencyCache();
        }

        // 2. Provenance stub: cheap-to-verify rows_in / rows_out / distinct
        // grouping-key values, so the caller doesn't have to trust the narrative
        // summary about what the tool actually computed. Includes two
        // informational (not hard-reject) caveats:
        // - id grounding: a distinct id in the CSV that can't be found anywhere
        //   in the raw source file(s) — a substring miss can also mean the
        //   model reformatted the id, so this doesn't block a possibly-correct
        //   result.
        // - id/name collisions: the same id mapped to more than one name within
        //   this CSV (the exact shape of the prod hallucination). Deliberately
        //   NOT a hard reject — a real entity (an ad group, a CRM lead's
        //   company) can legitimately be renamed within a query's date window,
        //   which produces this same shape from genuinely correct data. We
        //   can't tell "renamed" apart from "fabricated" from the CSV alone, so
        //   this is surfaced for the caller to judge rather than risking a hard
        //   failure on a correct result.
        const rowsInPerFile = fileRawContents.map(c => estimateRowsIn(c)).filter((n): n is number => n !== null);
        const rowsIn = rowsInPerFile.length > 0 ? rowsInPerFile.reduce((a, b) => a + b, 0) : null;
        const MAX_DISTINCT_VALUES_SHOWN = 25;
        const distinctPreview = provenance.groupingKeyValues.slice(0, MAX_DISTINCT_VALUES_SHOWN);
        const moreCount = provenance.groupingKeyValues.length - distinctPreview.length;
        const grounding = checkCsvIdGrounding(provenance.header, provenance.rows, fileRawContents);
        const collisions = findCsvIdNameCollisions(provenance.header, provenance.rows);
        if (collisions.length > 0) {
          console.warn(
            `AgentMode: performDataAnalysis intra-CSV id/name collision (userId=${userId}, informational): ` +
            collisions.map(c => `id=${c.id} names=[${c.names.join(', ')}]`).join('; ')
          );
        }
        resultParts.push(
          `**Provenance:**\n` +
          `rows_in: ${rowsIn !== null ? rowsIn : 'unknown (no parsable input file)'}\n` +
          `rows_out: ${provenance.rowsOut}\n` +
          `distinct grouping-key values (${provenance.groupingKeyValues.length}): ${distinctPreview.join(', ')}` +
          (moreCount > 0 ? ` … (+${moreCount} more)` : '') +
          (grounding && grounding.unverified > 0
            ? `\n⚠️ ${grounding.unverified} of ${grounding.checked} id(s) in this result could not be found in the raw source file(s) — treat those rows as unverified.`
            : '') +
          (collisions.length > 0
            ? `\n⚠️ ${collisions.length} id(s) map to more than one name within this result — e.g. id "${collisions[0].id}" as [${collisions[0].names.join(', ')}]. ` +
              'This can mean the source entity was renamed during the query window, or that a row was fabricated/corrupted — verify before trusting these names.'
            : '')
        );

        // 3. Explicit untrusted-narrative caveat: make it part of the tool's own
        // contract that the free-form prose has not been cross-checked, rather
        // than relying on the calling agent to know to verify it independently
        // (the ad-hoc behavior that happened to save prod session d789c175).
        if (hasNarrativeText) {
          resultParts.push(
            '**Note:** The prose above has not been independently verified. Treat **Computed Data** and **Provenance** as ' +
            'the trusted, verified source — cross-check any names, ids, or counts mentioned in the prose against them before repeating them.'
          );
        }
      }
    }

    // Combine all results
    const analysisResult = resultParts.join('\n\n');

    return {
      success: true,
      message: 'Data analysis completed successfully',
      analysis: analysisResult,
      codeExecuted: codeExecuted,
      formattedContent: analysisResult,
      fileUrls: fileLinks.length > 0 ? fileLinks : undefined
    };

  } catch (error) {
    console.error('AgentMode: Error performing data analysis:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = (error as any)?.response?.status;
    const isPayloadTooLarge = statusCode === 413 ||
      /payload size exceeds|request too large|too large|exceeds.*limit/i.test(errorMessage);
    const isTimeout = (error as any)?.code === 'ECONNABORTED' ||
      /timeout|timed out|ETIMEDOUT/i.test(errorMessage);
    // ENG-1295 (recommendation #4): a raw Gemini 400/422 that ISN'T already
    // classified as payload-too-large is an invalid-argument rejection (e.g. a
    // malformed file_urls entry, an unfetchable reference, or a request the
    // sandbox otherwise refused). Previously this fell through to the generic
    // "check that the file URLs are accessible" message with no distinct error
    // code — the exact ambiguous failure hit in prod session 97a28948.
    const isInvalidArgument = !isPayloadTooLarge && (statusCode === 400 || statusCode === 422);
    if (isPayloadTooLarge) {
      return {
        success: false,
        message: `The data payload sent to Gemini was too large. IMPORTANT: Do NOT retry perform_data_analysis with inline data. You MUST first call save_file to upload the dataset as a .csv or .txt file and get an S3 URL, then call perform_data_analysis with that URL in file_urls and a short analysis_instruction (no inline data).`,
        error: errorMessage
      };
    }
    if (isTimeout) {
      return {
        success: false,
        message: `The data analysis timed out — the dataset or analysis task is too large for a single call. Break it into smaller pieces: (1) split the data into smaller subsets, (2) call perform_data_analysis separately for each subset with a focused analysis_instruction, then (3) synthesize the individual results into a final summary.`,
        error: errorMessage
      };
    }
    if (isInvalidArgument) {
      return {
        success: false,
        message: `The data analysis request was rejected as invalid by the model API (HTTP ${statusCode}). This usually means a file_urls entry could not be read or parsed, or the request violated a sandbox limit. Verify each file_urls entry is a real, fetchable S3 URL or tool-response key, and that analysis_instruction does not reference unsupported content. Do NOT blindly retry the identical call — fix the arguments first.`,
        error: 'invalid_argument'
      };
    }
    return {
      success: false,
      message: `The data analysis failed during upstream code execution (${errorMessage.slice(0, 200)}). Verify each file_urls entry is a fetchable S3/HTTPS URL, then retry once with a simpler, more specific analysis_instruction. Do NOT re-inline the raw data.`,
      error: errorMessage
    };
  }
}

function formatWebSearchResults(searchResult: any): string {
  const { query, results, totalResults, resultSource, freshness } = searchResult;
  // ENG-1050: news searches mix news articles with recent web pages from the
  // same freshness window, so label each entry and make an empty result read as
  // "no coverage found" rather than an ambiguous failure.
  const isNewsSearch = resultSource === 'news';
  const heading = isNewsSearch ? '📰 News Search Results' : '🔍 Web Search Results';

  if (!results || results.length === 0) {
    const emptyNote = isNewsSearch
      ? `No news articles or recent web pages were found for this query within the ${freshness || 'week'} freshness window. `
        + `The search itself succeeded — treat this as "no coverage found", not as a search failure.`
      : 'No results found for your search query.';
    return `<strong>${heading} for "${query}"</strong><br>${emptyNote}`;
  }

  let summary = `<strong>${heading} for "${query}"</strong><br>`;
  summary += `I found ${totalResults} relevant search results:<br><br>`;

  results.forEach((result: any, index: number) => {
    const sourceLabel = isNewsSearch
      ? (result.sourceType === 'news' ? '📰 News article — ' : '🌐 Recent web page — ')
      : '';
    summary += `<strong>${index + 1}. ${sourceLabel}${result.title}</strong><br>`;
    summary += `🔗 <a href="${result.url}" target="_blank">${result.url}</a><br>`;
    summary += `<em>${result.snippet}</em><br>`;
    if (result.publishedDate) {
      const date = new Date(result.publishedDate);
      summary += `📅 Published: ${date.toLocaleDateString()}<br>`;
    }
    summary += `<br>`;
  });

  summary += `<em>💡 I've gathered this current information to provide you with data-driven insights and recommendations.</em>`;

  return summary;
}

function isRetryableSearchError(error: any): boolean {
  const statusCode = error?.code || error?.response?.status || error?.status;
  const message = String(error?.message || '').toLowerCase();
  const reason = String(error?.errors?.[0]?.reason || '').toLowerCase();

  const hasQuotaSignal =
    message.includes('quota') ||
    message.includes('rate limit') ||
    reason.includes('quot') ||
    reason.includes('ratelimit') ||
    reason.includes('rate_limit_exceeded');

  const hasTransientSignal =
    statusCode === 429 ||
    statusCode === 408 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('temporarily unavailable');

  return hasQuotaSignal || hasTransientSignal;
}

async function performYouSearch(params: {
  query: string;
  maxResults: number;
  resultSource?: SearchResultSource;
  freshness?: string;
  includeDomains?: string[];
  userId?: string;
  purpose?: SearchPurpose;
}) {
  const freshness = params.freshness || inferSearchFreshness(params.query);
  const provider = new YouSearchProvider();
  const response = await provider.search({
    query: params.query,
    count: params.maxResults,
    freshness,
    resultSource: params.resultSource || 'all',
    purpose: params.purpose || (params.resultSource === 'news' ? 'news' : 'agent_research'),
    userId: params.userId,
    ...(params.includeDomains?.length ? { includeDomains: params.includeDomains } : {}),
  });

  console.log(`You.com Search returned ${response.results.length} ${params.resultSource || 'all'} results for query: "${params.query}"`);
  return {
    ...response,
    metadata: {
      ...(response.metadata || {}),
      freshness,
    },
  };
}

async function searchWithYou(params: {
  toolName: 'you_search_web' | 'you_search_news';
  query: string;
  maxResults: number;
  resultSource: SearchResultSource;
  freshness?: string;
  includeDomains?: string[];
  userId?: string;
  purpose: SearchPurpose;
}): Promise<any> {
  const { toolName, query, maxResults, resultSource } = params;
  try {
    console.log(`AgentMode: ${toolName} using You.com for query:`, query, 'maxResults:', maxResults);

    // Limit max results to 10
    const limitedMaxResults = Math.min(maxResults, 10);
    const maxAttempts = Math.max(1, Number(process.env.SEARCH_WEB_MAX_RETRIES || 4));
    const baseDelayMs = Math.max(100, Number(process.env.SEARCH_WEB_RETRY_BASE_MS || 600));
    let attempt = 0;
    let searchResponse: Awaited<ReturnType<YouSearchProvider['search']>> | null = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        searchResponse = await performYouSearch({
          query,
          maxResults: limitedMaxResults,
          resultSource,
          freshness: params.freshness,
          includeDomains: params.includeDomains,
          userId: params.userId,
          purpose: params.purpose,
        });
        break;
      } catch (error) {
        const isLastAttempt = attempt >= maxAttempts;
        const shouldRetry = isRetryableSearchError(error);

        if (!shouldRetry || isLastAttempt) {
          throw error;
        }

        // Exponential backoff with jitter to reduce burst pressure and quota spikes.
        const jitterMs = Math.floor(Math.random() * 300);
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1) + jitterMs;
        console.warn(
          `AgentMode: searchWeb retry ${attempt}/${maxAttempts} for query "${query}" after ${delayMs}ms due to:`,
          error instanceof Error ? error.message : error
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const normalizedResults = searchResponse?.results || [];
    const provider = searchResponse?.provider || 'you';
    const freshness = searchResponse?.metadata?.freshness || params.freshness || inferSearchFreshness(query);

    // Format the results for LLM consumption
    const formattedContent = formatWebSearchResults({
      query,
      results: normalizedResults,
      totalResults: normalizedResults.length,
      resultSource,
      freshness,
    });

    // ENG-1050: a news search can be answered by news articles, by recent web
    // pages from the same freshness window, or by neither. Say which, so a
    // digest can tell "no coverage this week" from "the search returned
    // nothing", and never presents a web page as a news article.
    const newsArticleCount = normalizedResults.filter((result: any) => result.sourceType === 'news').length;
    const recentPageCount = normalizedResults.length - newsArticleCount;
    const isEmptyNewsSearch = resultSource === 'news' && normalizedResults.length === 0;
    const message = isEmptyNewsSearch
      // "Found 0 results" reads as a broken search, which is the ambiguity this
      // ticket is about. Say the same thing the LLM-facing content says.
      ? `No coverage found for "${query}" within the ${freshness || 'week'} window — `
        + `the search itself succeeded, there is simply nothing published`
      : resultSource === 'news'
        ? `Found ${normalizedResults.length} results for "${query}" within the ${freshness || 'week'} window `
          + `(${newsArticleCount} news article${newsArticleCount === 1 ? '' : 's'}, `
          + `${recentPageCount} recent web page${recentPageCount === 1 ? '' : 's'})`
        : `Found ${normalizedResults.length} web search results for "${query}"`;

    return {
      success: true,
      message,
      query,
      results: normalizedResults,
      totalResults: normalizedResults.length,
      provider,
      toolName,
      resultSource,
      freshness,
      metadata: searchResponse?.metadata,
      formattedContent
    };
  } catch (error) {
    console.error(`AgentMode: Error in ${toolName}:`, error);
    return {
      success: false,
      message: 'Failed to search You.com. Please try again.',
      provider: 'you',
      toolName,
      resultSource,
      error: error instanceof Error ? error.message : 'Unknown error',
      // ENG-1300/ENG-1281: surface the numeric HTTP status (axios .response.status,
      // or .status/.code) so failures classify as auth/rate_limit, not unknown.
      code: (error as any)?.status ?? (error as any)?.code ?? (error as any)?.response?.status,
    };
  }
}

export async function youSearchWeb(
  query: string,
  maxResults: number = 10,
  freshness?: string,
  includeDomains?: string[],
  userId?: string,
  purpose: SearchPurpose = 'agent_research',
): Promise<any> {
  return searchWithYou({
    toolName: 'you_search_web',
    query,
    maxResults,
    resultSource: 'web',
    freshness,
    includeDomains,
    userId,
    purpose,
  });
}

export async function youSearchNews(query: string, maxResults: number = 10, freshness?: string, userId?: string): Promise<any> {
  return searchWithYou({
    toolName: 'you_search_news',
    query,
    maxResults,
    resultSource: 'news',
    freshness: freshness || inferSearchFreshness(query) || 'week',
    userId,
    purpose: 'news',
  });
}

/**
 * ENG-1281: Google's Custom Search JSON API is closed to new customers and
 * sunsets in January 2027, so AgentWeb no longer calls it. `google_search_web`
 * stays registered as a legacy alias (skills, saved prompts and tool budgets
 * reference the name) and is served by the same You.com web search as
 * `you_search_web`. Result shape is unchanged for callers; `provider` truthfully
 * reports 'you' and `toolName` stays 'google_search_web'.
 */
export async function googleSearchWeb(query: string, maxResults: number = 10, userId?: string, purpose: SearchPurpose = 'agent_research'): Promise<any> {
  const result = await searchWithYou({
    toolName: 'you_search_web',
    query,
    maxResults,
    resultSource: 'web',
    userId,
    purpose,
  });
  return { ...result, toolName: 'google_search_web' };
}

export async function performDeepResearchTool(
  topic: string,
  prompt?: string,
  tone: string = 'professional',
  depth: string = 'detailed',
  focus_areas?: string[],
  userId?: string
): Promise<any> {

  try {
    console.log('AgentMode: Performing deep research on topic:', topic, 'tone:', tone, 'depth:', depth, 'focus_areas:', focus_areas);

    // Import the deep research service
    const { deepResearchService } = await import('../../services/deepResearchService');

    // Check if the service is available
    const isAvailable = await deepResearchService.isAvailable();
    if (!isAvailable) {
      return {
        success: false,
        message: 'Deep Research service is not available. Please check API key configuration.',
        error: 'Service unavailable'
      };
    }

    // Perform the deep research
    const researchResult = await deepResearchService.performDeepResearch({
      topic,
      prompt,
      tone,
      depth,
      focus_areas,
      userId
    });

    if (!researchResult.success || !researchResult.markdownContent) {
      // ENG-738: deepResearchService already retried once at a reduced depth
      // internally if the first attempt timed out (see DEPTH_DEGRADE there);
      // a failure reaching here means that already happened and still didn't
      // produce content, so tell the model plainly rather than inviting an
      // identical, doomed-to-repeat retry of the same call.
      return {
        success: false,
        message: researchResult.error || 'Deep research failed',
        error: researchResult.error || 'Unknown error'
      };
    }

    // Calculate word count for context
    const wordCount = researchResult.markdownContent.split(/\s+/).length;

    // Upload markdown content to S3
    const { uploadFileToS3 } = await import('../../utils/s3Utils');
    const sanitizedTopic = topic.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 50);
    const filename = `research-${sanitizedTopic}-${Date.now()}.md`;

    const uploadResult = await uploadFileToS3(
      researchResult.markdownContent,
      filename,
      userId || 'anonymous',
      'text/markdown'
    );

    if (!uploadResult.success || !uploadResult.url) {
      return {
        success: false,
        message: 'Failed to upload research content to S3',
        error: 'S3 upload failed'
      };
    }

    console.log('AgentMode: Deep research uploaded to S3:', uploadResult.url);

    // ENG-738: a success that only landed after an automatic depth downgrade
    // must report the depth actually delivered, not the one originally
    // requested — reporting the request depth here would misrepresent the
    // result (e.g. claiming "comprehensive" when the agent produced "overview").
    const actualDepth = researchResult.actualDepth || depth;
    const successDepthNote = researchResult.degradedFrom
      ? ` at "${actualDepth}" depth (automatically reduced from "${researchResult.degradedFrom}" after the first attempt timed out)`
      : '';

    return {
      success: true,
      message: `Deep research completed successfully${successDepthNote}. Generated ${wordCount} words of content and saved to S3.`,
      data: {
        research_url: uploadResult.url,
        title: researchResult.title,
        summary: researchResult.researchSummary,
        word_count: wordCount,
        research_depth: actualDepth,
        topic: topic
      }
    };

  } catch (error: any) {
    console.error('AgentMode: Error performing deep research:', error);
    return {
      success: false,
      message: 'Failed to perform deep research',
      error: error.message
    };
  }
}
