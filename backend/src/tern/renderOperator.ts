import type { TspNode } from './renderEmma';
import {
  OperatorExecution, OperatorTask, OperatorView,
  elapsedExecution, safeArtifactUrl, safeText,
} from './operatorModel';

function runTone(status: string): string {
  const value = status.toLowerCase();
  if (value === 'failed' || value === 'error') return 'error';
  if (value === 'running' || value === 'pending') return 'pending';
  if (value === 'completed') return 'success';
  return 'muted';
}

function taskItem(task: OperatorTask): Record<string, unknown> {
  const latest = task.latestExecution;
  return {
    id: task.taskId,
    label: safeText(task.name, 100) || task.taskId,
    detail: safeText(task.status, 40),
    dot: latest ? runTone(latest.status) : 'muted',
    facts: {
      task: safeText(task.status, 32),
      latest: safeText(latest?.status, 32) || 'none',
    },
    badges: latest ? [{ text: safeText(latest.status, 32), tone: runTone(latest.status) }] : [],
  };
}

function executionItem(run: OperatorExecution): Record<string, unknown> {
  return {
    id: run.executionId,
    label: safeText(run.executionId, 75),
    detail: safeText(run.startTime, 60) || 'No start time',
    dot: runTone(run.status),
    facts: {
      status: safeText(run.status, 32),
      started: safeText(run.startTime, 30),
    },
    badges: [{ text: safeText(run.status, 32), tone: runTone(run.status) }],
  };
}

function detailNode(execution: OperatorExecution, asOf?: string): TspNode {
  const result = safeText(execution.result, 1800);
  const error = safeText(execution.error, 1000);
  const children: TspNode[] = [{
    id: 'operator.run.facts',
    k: 'kv',
    p: {
      items: [
        { k: 'Execution', v: execution.executionId },
        { k: 'Status', v: safeText(execution.status, 40) },
        { k: 'Model', v: safeText(execution.llmName, 80) || '—' },
        { k: 'Started', v: safeText(execution.startTime, 60) || '—' },
        { k: 'Finished', v: safeText(execution.endTime || execution.completedAt, 60) || '—' },
        { k: 'Elapsed', v: elapsedExecution(execution, asOf) || '—' },
      ],
    },
  }];

  if (result) {
    children.push({
      id: 'operator.run.result',
      k: 'section',
      p: { head: 'Result' },
      c: [{ id: 'operator.run.result.text', k: 'md', p: { text: result } }],
    });
  }
  if (error) {
    children.push({
      id: 'operator.run.error',
      k: 'section',
      p: { head: 'Error', tone: 'error' },
      c: [{ id: 'operator.run.error.text', k: 'text', p: { text: error, tone: 'error' } }],
    });
  }

  const files = Array.isArray(execution.result_files) ? execution.result_files.slice(0, 20) : [];
  if (files.length) {
    children.push({
      id: 'operator.run.artifacts',
      k: 'section',
      p: { head: 'Artifacts' },
      c: files.map((file, index): TspNode => {
        const href = safeArtifactUrl(file.url);
        return {
          id: 'operator.run.artifact.' + index,
          k: 'text',
          p: {
            text: safeText(file.filename, 120) + (href ? '' : ' (private link withheld)'),
            ...(href ? {
              href,
              spans: [{ t: safeText(file.filename, 120), s: 'link', href }],
              actions: { click: 'open', menu: ['open', 'copy'] },
            } : {}),
          },
        };
      }),
    });
  }

  const events = Array.isArray(execution.activity) ? execution.activity.slice(-40) : [];
  const latest = events[events.length - 1];
  if (latest) {
    children.push({
      id: 'operator.run.latest',
      k: 'kv',
      p: {
        items: [
          { k: 'Latest activity', v: safeText(latest.summary, 120) },
          { k: 'Observed', v: safeText(latest.when, 50) },
        ],
      },
    });
    children.push({
      id: 'operator.run.timeline',
      k: 'table',
      p: {
        cols: [
          { id: 'when', head: 'Log time' },
          { id: 'level', head: 'Level' },
          { id: 'activity', head: 'Browser execution activity', grow: 2 },
        ],
        rows: events.map(item => ({
          id: safeText(item.id, 80),
          cells: {
            when: safeText(item.when, 50),
            level: safeText(item.level, 10),
            activity: safeText(item.summary, 120),
          },
        })),
      },
    });
  } else if (execution.activityUnavailable) {
    children.push({
      id: 'operator.run.activity-state', k: 'text',
      p: { text: 'Execution activity temporarily unavailable.', tone: 'warning' },
    });
  } else if (execution.browser_use_log) {
    children.push({
      id: 'operator.run.activity-state', k: 'text',
      p: { text: 'No browser execution events in the available log tail yet.', tone: 'muted' },
    });
  }

  // Questions are real human-interaction records, not browser/tool events.
  const interactions = Array.isArray(execution.userInteractions)
    ? execution.userInteractions.slice(-12)
    : [];
  if (interactions.length) {
    children.push({
      id: 'operator.run.user-requests',
      k: 'table',
      p: {
        cols: [
          { id: 'when', head: 'Time' },
          { id: 'status', head: 'State' },
          { id: 'activity', head: 'User request', grow: 2 },
        ],
        rows: interactions.map((item, index) => ({
          id: safeText(item.id, 80) || 'interaction-' + index,
          cells: {
            when: typeof item.timestamp === 'number'
              && Number.isFinite(item.timestamp)
              && Math.abs(item.timestamp) <= 8640000000000000
              ? new Date(item.timestamp).toISOString()
              : '—',
            status: safeText(item.status, 40),
            activity: safeText(item.question, 130) || 'User interaction',
          },
        })),
      },
    });
  }

  return { id: 'operator.run.preview', k: 'col', p: { gap: 'sm' }, c: children };
}

/** Semantic TSP roots; keyed IDs allow the existing reconciler to patch in place. */
export function renderOperator(view: OperatorView): TspNode[] {
  const currentTask = view.tasks.find(task => task.taskId === view.taskId);
  const runs = [...view.executions].sort((a, b) =>
    (b.startTime || '').localeCompare(a.startTime || ''));
  const selected = runs.find(run => run.executionId === view.executionId);
  const current = view.detail?.executionId === view.executionId
    && view.detail.taskId === view.taskId ? view.detail : selected;
  const isRuns = view.scope === 'executions';
  const items = isRuns ? runs.map(executionItem) : view.tasks.map(taskItem);

  const picker: TspNode = {
    id: isRuns ? 'operator.runs' : 'operator.tasks',
    k: 'picker',
    p: {
      title: isRuns ? safeText(currentTask?.name, 90) || 'Task executions' : 'AgentWeb Tasks',
      subtitle: isRuns ? 'Backend-authoritative run history' : 'Select a task to inspect runs',
      noun: isRuns ? 'executions' : 'tasks',
      icon: isRuns ? 'activity' : 'list',
      size: 'screen',
      layout: 'cards',
      preview: 'side',
      columns: isRuns ? [
        { id: 'status', format: 'dim' },
        { id: 'started', format: 'time' },
      ] : [
        { id: 'task', format: 'dim' },
        { id: 'latest', format: 'dim' },
      ],
      items,
      order: items.map(item => item.id),
      selected: isRuns ? view.executionId ?? null : view.taskId ?? null,
      total: items.length,
      empty: isRuns ? 'No executions for this task' : 'No tasks returned for this account',
      actions: isRuns ? [
        { id: 'refresh', label: 'Refresh', keys: ['r'] },
        ...(current?.status.toLowerCase() === 'running'
          ? [{ id: 'stop', label: 'Stop run…', keys: ['x'] }] : []),
        { id: 'tasks', label: 'All tasks', keys: ['esc'], end: true },
      ] : [
        { id: 'open', label: 'Inspect runs', keys: ['enter'], primary: true },
        { id: 'start', label: 'Run task…', keys: ['s'] },
        { id: 'refresh', label: 'Refresh', keys: ['r'] },
        { id: 'close', label: 'Exit', keys: ['esc'], end: true },
      ],
      state: view.busy ? 'loading' : 'ready',
    },
    c: isRuns
      ? current ? [detailNode(current, view.lastUpdated)] : []
      : currentTask ? [{
          id: 'operator.task.preview',
          k: 'kv',
          p: {
            items: [
              { k: 'Task', v: safeText(currentTask.name, 120) },
              { k: 'Status', v: safeText(currentTask.status, 40) },
              { k: 'Last run', v: safeText(currentTask.latestExecution?.status, 40) || '—' },
              { k: 'Created', v: safeText(currentTask.createdAt, 50) || '—' },
            ],
          },
        }] : [],
  };

  const notice = safeText(view.notice, 300);
  const dock: TspNode = {
    id: 'dock',
    k: 'col',
    c: [{
      id: 'operator.status',
      k: 'status',
      p: { transparent: true },
      c: [
        {
          id: 'operator.status.left',
          k: 'seg',
          p: {
            side: 'left',
            spans: [
              { t: view.busy ? 'Working' : 'Ready', s: view.busy ? 'accent' : 'muted' },
              { t: notice ? ' · ' + notice : '', s: notice ? 'warning' : 'dim' },
            ],
          },
        },
        {
          id: 'operator.status.refresh',
          k: 'seg',
          p: {
            side: 'right',
            spans: [{ t: 'Refresh', s: 'muted' }],
            actions: { click: 'refresh' },
          },
        },
      ],
    }],
  };

  const confirm = view.confirm;
  const layer: TspNode = {
    id: 'layer',
    k: 'col',
    c: confirm ? [{
      id: 'operator.confirm',
      k: 'picker',
      p: {
        title: confirm.kind === 'stop' ? 'Stop this running execution?' : 'Start a new execution?',
        subtitle: 'AgentWeb will enforce current ownership and execution policy.',
        noun: 'choices',
        size: 'md',
        layout: 'list',
        items: [
          { id: 'cancel', label: 'Cancel', detail: 'No backend change' },
          { id: 'confirm', label: confirm.kind === 'stop' ? 'Stop execution' : 'Start execution',
            detail: 'Send exactly one request to AgentWeb' },
        ],
        order: ['cancel', 'confirm'],
        selected: view.confirmSelected ?? 'cancel',
        actions: [
          { id: 'cancel', label: 'Cancel', keys: ['esc'], end: true },
          { id: 'confirm', label: 'Confirm', keys: ['enter'], primary: true },
        ],
        state: view.busy ? 'loading' : 'ready',
      },
    }] : [],
  };

  return [{ id: 'main', k: 'col', c: [picker] }, dock, layer];
}
