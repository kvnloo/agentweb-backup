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

export interface OperatorExecution {
  executionId: string;
  taskId: string;
  status: string;
  startTime?: string;
  completedAt?: string;
  llmName?: string;
  result?: string;
  error?: string;
  result_files?: Array<{ filename: string; url: string; token?: string }>;
  details_gif?: string;
  browser_use_log?: string;
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
  executionId?: string;
}

export interface OperatorView {
  scope: 'tasks' | 'executions';
  tasks: OperatorTask[];
  taskId?: string;
  executions: OperatorExecution[];
  executionId?: string;
  detail?: OperatorExecution;
  confirm?: OperatorConfirm;
  busy?: boolean;
  notice?: string;
  lastUpdated?: string;
}

/** Never propagate query-string credentials or a URL with user info to TSP. */
export function safeArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
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
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => safeArtifactUrl(raw) ?? '[private URL]')
    .trim();
  const bounded = Math.max(0, Math.min(limit, 4000));
  return text.length > bounded ? text.slice(0, bounded) + '…' : text;
}

export function displayExecution(execution: OperatorExecution): Record<string, unknown> {
  return {
    executionId: execution.executionId,
    taskId: execution.taskId,
    status: safeText(execution.status, 40),
    startTime: safeText(execution.startTime, 80),
    completedAt: safeText(execution.completedAt, 80),
    model: safeText(execution.llmName, 90),
    result: safeText(execution.result),
    error: safeText(execution.error),
    artifacts: (execution.result_files ?? []).slice(0, 20).map(file => ({
      filename: safeText(file.filename, 120),
      url: safeArtifactUrl(file.url) ?? null,
    })),
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
    ...(view.detail ? { detail: displayExecution(view.detail) } : {}),
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
