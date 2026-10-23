import { createHash } from 'crypto';

/**
 * Allowlisted task/run projection for Tern. The transport and JSON fallback
 * never serialize DB records: identities, tokens and tool arguments stay out.
 */
export interface OperatorTask {
  taskId: string;
  name: string;
  status: string;
  createdAt?: string;
  latestExecution?: {
    executionId?: string;
    status: string;
    startTime?: string;
    completedAt?: string;
    error?: string;
  };
}

export interface OperatorActivity {
  /** Hash of the original, persisted browser-use log line (not a poll position). */
  id: string;
  when: string;
  kind: 'step' | 'action' | 'log';
  level: 'INFO' | 'WARNING' | 'ERROR';
  summary: string;
}

export interface OperatorActivityEnvelope {
  source: 'browser-log';
  events: OperatorActivity[];
}

export interface OperatorExecution {
  executionId: string;
  taskId: string;
  status: string;
  startTime?: string;
  completedAt?: string;
  endTime?: string;
  llmName?: string;
  result?: string;
  error?: string;
  result_files?: Array<{ filename: string; url: string; token?: string }>;
  details_gif?: string;
  browser_use_log?: string;
  activity?: OperatorActivity[];
  activityUnavailable?: boolean;
  userInteractions?: Array<{
    id: string;
    question?: string;
    response?: string;
    status: string;
    timestamp?: number;
    screenshot_url?: string;
  }>;
}

export interface OperatorConfirm {
  kind: 'run' | 'stop';
  taskId: string;
  taskName: string;
  executionId?: string;
  /** Monotonic, process-local native picker generation. Never reuse on reopen. */
  generation: number;
  /** Native surface epoch on which the confirmation was opened. */
  surfaceId: string;
}

export interface OperatorView {
  scope: 'tasks' | 'executions';
  tasks: OperatorTask[];
  taskId?: string;
  executions: OperatorExecution[];
  executionId?: string;
  detail?: OperatorExecution;
  confirm?: OperatorConfirm;
  confirmSelected?: 'cancel' | 'confirm';
  busy?: boolean;
  notice?: string;
  lastUpdated?: string;
  /** Optional trusted portal origin; never an API JWT or artifact URL. */
  portalBaseUrl?: string;
}

/**
 * The agent engine writes escaped Python logger lines into an S3 HTML <pre>.
 * This is interpreted on the AUTHENTICATED BACKEND only. We never return
 * logger messages, destinations, arguments, URLs or header data: they can
 * contain credentials even after the engine's best-effort log filter.
 *
 * Each entry is backed by a real browser_use logger line, not a status poll.
 * SHA-derived keys survive the engine's 30s S3 overwrite and sliding tail.
 */
export function parseOperatorBrowserLogHtml(html: string): OperatorActivity[] {
  const close = html.lastIndexOf('</pre>');
  if (close < 0) return [];
  const open = html.lastIndexOf('<pre>', close);
  const source = html.slice(open >= 0 ? open + 5 : 0, close);
  const lines = source.split(/\r?\n/);
  const seen = new Map<string, number>();
  const events: OperatorActivity[] = [];
  for (const line of lines) {
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[,\.]\d+)?)\s+-\s+(browser_use(?:\.[\w]+)*)\s+-\s+(INFO|WARNING|ERROR|DEBUG)\s+-\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, when, , rawLevel, message] = match;
    if (rawLevel === 'DEBUG') continue;
    const level = rawLevel as OperatorActivity['level'];
    const step = /\b(?:step|iteration)\s*(?:#|:)?\s*(\d{1,5})\b/i.exec(message);
    const action = /\b(?:action(?:\s+\d+)?\s*[:=-]\s*|execut(?:ing|ed)\s+)(click|scroll|type|input|navigate|go_to_url|search|extract|wait|open_tab|close_tab|switch_tab|done)\b/i.exec(message);
    const kind: OperatorActivity['kind'] = step ? 'step' : action ? 'action' : 'log';
    const summary = step ? 'Browser step ' + step[1]
      : action ? 'Browser action: ' + action[1].toLowerCase()
      : level === 'ERROR' ? 'Browser log error'
      : level === 'WARNING' ? 'Browser log warning'
      : 'Browser execution log';
    const hash = createHash('sha256').update(line).digest('hex').slice(0, 20);
    const repeat = seen.get(hash) || 0;
    seen.set(hash, repeat + 1);
    events.push({ id: 'browser.' + hash + '.' + repeat, when, kind, level, summary });
  }
  return events.slice(-40);
}

/** Elapsed clock duration; a completed execution uses its persisted endTime. */
export function elapsedExecution(execution: OperatorExecution, asOf?: string): string | undefined {
  const start = Date.parse(execution.startTime || '');
  const finish = Date.parse(execution.endTime || execution.completedAt || asOf || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return undefined;
  const seconds = Math.floor((finish - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? hours + 'h ' + minutes + 'm ' + remainder + 's'
    : minutes ? minutes + 'm ' + remainder + 's'
    : remainder + 's';
}

/**
 * agent-engine/task_utils.py uploads files to
 * task_results/<executionId>/<20-character random_token>/<filename> and
 * persists the same random_token as result_files[].token. That path grants
 * possession-based access even without query parameters.
 */
export function isTaskResultCapabilityPath(pathname: string): boolean {
  let path = pathname;
  for (let depth = 0; depth < 3; depth++) {
    if (/(?:^|\/)task_results\/[^/]+\/[^/]+(?:\/|$)/i.test(path)) return true;
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) return false;
      path = decoded;
    } catch {
      return true; // Ambiguous percent encoding: fail closed.
    }
  }
  return /(?:^|\/)task_results\/[^/]+\/[^/]+(?:\/|$)/i.test(path);
}

/** Never expose file bearer tokens, including path-embedded S3 capabilities. */
export function safeArtifactUrl(value: unknown, fileToken?: unknown): string | undefined {
  if (typeof fileToken === 'string' && fileToken.length > 0) return undefined;
  if (typeof value !== 'string' || !value || value.length > 2048 || /\s/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password || url.search || url.hash
        || isTaskResultCapabilityPath(url.pathname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Existing authenticated Partner Portal execution route (App.tsx). No bearer data. */
export function operatorPortalPath(taskId: string, executionId: string): string | undefined {
  if (![taskId, executionId].every(id =>
      typeof id === 'string' && id.length > 0 && id.length <= 256
      && !/[\x00-\x1f\x7f]/.test(id))) return undefined;
  return '/tasks/' + encodeURIComponent(taskId) + '/executions/' + encodeURIComponent(executionId);
}

/** Only a user-configured, credential-free portal origin may become a native open action. */
export function safeOperatorPortalUrl(base: unknown, taskId: string, executionId: string): string | undefined {
  const path = operatorPortalPath(taskId, executionId);
  if (typeof base !== 'string' || !path || base.length > 2048 || /\s/.test(base)) return undefined;
  try {
    const origin = new URL(base);
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:')
      || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/') return undefined;
    return new URL(path, origin.origin).toString();
  } catch {
    return undefined;
  }
}

/** Bounded visible text: no raw objects, bearer credentials, or signed URLs. */
export function safeText(value: unknown, limit = 700): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*["']?[^\s,"'}]+/gi, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL withheld]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9_-]{12,})\b/g, '[credential withheld]')
    .trim();
  const bounded = Math.max(0, Math.min(limit, 4000));
  return text.length > bounded ? text.slice(0, bounded) + '…' : text;
}

export function displayExecution(execution: OperatorExecution, asOf?: string): Record<string, unknown> {
  return {
    executionId: execution.executionId,
    taskId: execution.taskId,
    status: safeText(execution.status, 40),
    startTime: safeText(execution.startTime, 80),
    completedAt: safeText(execution.endTime || execution.completedAt, 80),
    elapsed: elapsedExecution(execution, asOf) ?? null,
    model: safeText(execution.llmName, 90),
    result: safeText(execution.result),
    error: safeText(execution.error),
    latestActivity: execution.activity?.length
      ? {
          when: safeText(execution.activity[execution.activity.length - 1].when, 40),
          summary: safeText(execution.activity[execution.activity.length - 1].summary, 100),
        }
      : null,
    timeline: (Array.isArray(execution.activity) ? execution.activity : []).slice(-40)
      .map(item => ({
        id: safeText(item.id, 85),
        when: safeText(item.when, 40),
        kind: safeText(item.kind, 20),
        summary: safeText(item.summary, 100),
      })),
    activityUnavailable: execution.activityUnavailable === true,
    artifacts: (Array.isArray(execution.result_files) ? execution.result_files : []).slice(0, 20).map(file => ({
      filename: safeText(file.filename, 120),
      url: safeArtifactUrl(file.url, file.token) ?? null,
    })),
    ...((Array.isArray(execution.result_files) ? execution.result_files : []).slice(0, 20)
      .some(file => !safeArtifactUrl(file.url, file.token))
      ? { privateArtifactPortal: operatorPortalPath(execution.taskId, execution.executionId) ?? null }
      : {}),
  };
}

export function displayOperatorJson(view: OperatorView): Record<string, unknown> {
  return {
    scope: view.scope,
    taskId: view.taskId,
    tasks: view.tasks.map(task => ({
      taskId: task.taskId,
      name: safeText(task.name, 120),
      status: safeText(task.status, 40),
      latestRunStatus: safeText(task.latestExecution?.status, 40),
    })),
    executions: view.executions.map(run => ({
      executionId: run.executionId,
      status: safeText(run.status, 40),
      startedAt: safeText(run.startTime, 80),
    })),
    ...(view.detail ? { detail: displayExecution(view.detail, view.lastUpdated) } : {}),
    ...(view.notice ? { notice: safeText(view.notice, 300) } : {}),
  };
}

/** A stale or retargeted confirmation never authorizes a different operation. */
export function confirmationMatches(view: OperatorView, confirm: OperatorConfirm): boolean {
  if (view.busy || view.taskId !== confirm.taskId) return false;
  if (confirm.kind === 'run') return view.tasks.some(task => task.taskId === confirm.taskId);
  return view.scope === 'executions'
    && view.executionId === confirm.executionId
    && view.detail?.executionId === confirm.executionId
    && view.detail?.taskId === confirm.taskId
    && view.detail.status.toLowerCase() === 'running';
}


/** Picker identity is scoped to an open, not merely to the selected task. */
export function operatorConfirmNodeId(confirm: OperatorConfirm): string {
  return 'operator.confirm.' + confirm.generation;
}

export type NativeConfirmationDecision = 'ignored' | 'selected' | 'cancel' | 'submit';

/**
 * Pure native-event gate shared by the CLI and regression harness.
 * A delayed select/activate/action for a deleted picker cannot act on the
 * next picker, even if the newer picker selects the same task or run.
 */
export function applyNativeConfirmationEvent(
  view: OperatorView,
  event: { id?: unknown; sf?: unknown; ev?: unknown; item?: unknown; act?: unknown },
  activeSurfaceId: string,
): NativeConfirmationDecision {
  const confirm = view.confirm;
  if (!confirm || view.busy || confirm.surfaceId !== activeSurfaceId
    || event.id !== operatorConfirmNodeId(confirm)
    || (event.sf !== undefined && event.sf !== activeSurfaceId)
    || !confirmationMatches(view, confirm)) return 'ignored';

  if (event.ev === 'select' || event.ev === 'activate') {
    if (event.item !== 'cancel' && event.item !== 'confirm') return 'ignored';
    view.confirmSelected = event.item;
    if (event.ev === 'select') return 'selected';
    return event.item === 'confirm' ? 'submit' : 'cancel';
  }
  if (event.ev === 'action') {
    if (event.act === 'cancel' || event.act === 'close') return 'cancel';
    if (event.act === 'confirm') {
      view.confirmSelected = 'confirm';
      return 'submit';
    }
  }
  return 'ignored';
}
