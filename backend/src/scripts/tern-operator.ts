#!/usr/bin/env node
/**
 * Optional, read-mostly Tern task/run operator. Session/task state stays in
 * AgentWeb. This process only retains transient selection and confirmation UI.
 *
 * Reuses the Emma experiment's TSP v1 framing, keyed reconciler and the
 * Stencil/Hermes Tern picker interaction model.
 */
import { AgentWebOperatorClient } from '../tern/operatorClient';
import {
  confirmationMatches, displayOperatorJson,
  OperatorConfirm, OperatorExecution, OperatorView,
} from '../tern/operatorModel';
import {
  encodeHelloQuery, encodeTspJson, parseTspJson,
  TSP_DEFAULT_APC_LIMIT, TspStreamReader,
} from '../tern/protocol';
import { TspSurfaceReconciler } from '../tern/reconcile';
import { renderOperator } from '../tern/renderOperator';

const SURFACE_ID = 'agentweb-operator';
const DA1 = '\x1b[c';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
const KITTY_PUSH = '\x1b[>1u';
const KITTY_POP = '\x1b[<u';

interface HelloReply {
  r: 'hello';
  v: number;
  term: string;
  kinds: string[];
  apc?: number;
  credits?: number;
}

function isHello(value: Record<string, unknown>): value is Record<string, unknown> & HelloReply {
  return value.r === 'hello' && value.v === 1
    && typeof value.term === 'string'
    && Array.isArray(value.kinds)
    && value.kinds.every(kind => typeof kind === 'string');
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

class CreditFrames {
  private sequence = 0;
  private acked = 0;
  private pending?: { ops: unknown[][]; after: () => void };

  constructor(private readonly surfaceId: string, private readonly limit: number, private readonly credits: number) {}

  send(ops: unknown[][], after: () => void): void {
    this.pending = { ops, after };
    this.pump();
  }

  ack(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence <= this.acked) return;
    this.acked = Math.min(sequence, this.sequence);
    this.pump();
  }

  private pump(): void {
    if (!this.pending || this.sequence - this.acked >= this.credits) return;
    const { ops, after } = this.pending;
    this.pending = undefined;
    if (ops.length) {
      process.stdout.write(encodeTspJson('f',
        { sf: this.surfaceId, s: ++this.sequence, ops }, undefined, this.limit));
    }
    after();
  }
}

async function main(): Promise<void> {
  const token = process.env.AGENTWEB_TOKEN;
  if (!token) throw new Error('AGENTWEB_TOKEN required; see backend/src/tern/OPERATOR.md');
  const client = new AgentWebOperatorClient({
    baseUrl: process.env.AGENTWEB_API_URL || 'http://localhost:3001',
    token,
  });

  const requestedTask = option('--task');
  const requestedExecution = option('--execution');
  if (requestedExecution && !requestedTask) {
    throw new Error('--execution requires --task');
  }

  const view: OperatorView = {
    scope: 'tasks', tasks: [], executions: [],
  };
  view.tasks = await client.listTasks();
  if (requestedTask && !view.tasks.some(task => task.taskId === requestedTask)) {
    throw new Error('Requested task is not visible to this account');
  }
  view.taskId = requestedTask || view.tasks[0]?.taskId;
  if (requestedTask && view.taskId) {
    view.scope = 'executions';
    view.executions = await client.listExecutions(view.taskId);
    view.executionId = requestedExecution
      || [...view.executions].sort((a, b) =>
        (b.startTime || '').localeCompare(a.startTime || ''))[0]?.executionId;
    if (requestedExecution && !view.executions.some(run => run.executionId === requestedExecution)) {
      throw new Error('Requested execution is not visible for this task');
    }
    if (view.executionId) {
      view.detail = await client.getExecution(view.taskId, view.executionId);
    }
  }
  view.lastUpdated = new Date().toISOString();

  // Explicit JSON mode is a useful non-Tern/read-only fallback. No probe is
  // emitted into redirected stdout; scripts get one allowlisted JSON object.
  if (process.argv.includes('--json') || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(displayOperatorJson(view), null, 2) + '\n');
    return;
  }

  const reader = new TspStreamReader();
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  let helloResolve: ((value: HelloReply) => void) | undefined;
  let eventHandler: ((event: Record<string, unknown>) => void) | undefined;
  let rawHandler: ((raw: string) => void) | undefined;
  let open = false;
  let modesArmed = false;
  let shuttingDown = false;
  let visible = true;
  let recoveries = 0;
  let activeSurfaceId = SURFACE_ID;
  let protocolFailed = false;
  let sender: CreditFrames;
  let reconciler: TspSurfaceReconciler;
  let apcLimit = TSP_DEFAULT_APC_LIMIT;
  let credits = 2;
  let polling: NodeJS.Timeout | undefined;
  let rawBuffer = '';
  let escapeFlush: NodeJS.Timeout | undefined;
  let refreshInFlight = false;
  let runsEpoch = 0;
  let detailEpoch = 0;

  function close(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    if (polling) clearInterval(polling);
    if (escapeFlush) clearTimeout(escapeFlush);
    if (open) {
      process.stdout.write(encodeTspJson('x', { id: activeSurfaceId, keep: false }, undefined, apcLimit));
      open = false;
    }
    if (modesArmed) process.stdout.write(KITTY_POP + PASTE_OFF);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.exit(code);
  }

  process.on('SIGINT', () => close(130));
  process.on('SIGTERM', () => close(143));
  process.on('SIGHUP', () => close(129));

  process.stdin.on('data', (chunk: string) => {
    for (const part of reader.pushParts(chunk)) {
      if (part.type === 'raw') {
        rawHandler?.(part.data);
        continue;
      }
      const value = parseTspJson(part.message);
      if (!value) continue;
      if (part.message.verb === 'r' && isHello(value)) helloResolve?.(value);
      else if (part.message.verb === 'e') eventHandler?.(value);
    }
  });

  const hello = await new Promise<HelloReply>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      'Tern host unavailable. Use --json for a non-Tern read-only view.',
    )), 800);
    helloResolve = reply => {
      clearTimeout(timer);
      resolve(reply);
    };
    process.stdout.write(encodeHelloQuery('agentweb-operator') + DA1);
  });
  const missing = ['col', 'picker', 'kv', 'status', 'seg', 'text', 'section', 'md', 'table']
    .filter(kind => !hello.kinds.includes(kind));
  if (missing.length) throw new Error('Unsupported TSP node kinds: ' + missing.join(', '));

  apcLimit = typeof hello.apc === 'number' && hello.apc > 0
    ? hello.apc : TSP_DEFAULT_APC_LIMIT;
  credits = typeof hello.credits === 'number' && hello.credits > 0
    ? Math.floor(hello.credits) : 2;
  process.stdout.write(PASTE_ON + KITTY_PUSH);
  modesArmed = true;

  function render(): void {
    if (shuttingDown || !open || protocolFailed) return;
    const roots = renderOperator(view);
    const rec = reconciler;
    const ops = rec.diff(roots) as unknown[][];
    sender.send(ops, () => rec.commit(roots));
  }

  function openSurface(): void {
    activeSurfaceId = SURFACE_ID + (recoveries ? '-' + recoveries : '');
    protocolFailed = false;
    sender = new CreditFrames(activeSurfaceId, apcLimit, credits);
    reconciler = new TspSurfaceReconciler(activeSurfaceId);
    process.stdout.write(encodeTspJson('o', {
      id: activeSurfaceId, mode: 'screen', title: 'AgentWeb Operator',
      role: 'agentweb.operator',
    }, undefined, apcLimit));
    open = true;
    render();
  }

  async function loadDetail(taskId: string, executionId: string): Promise<void> {
    const epoch = ++detailEpoch;
    try {
      const detail = await client.getExecution(taskId, executionId);
      if (epoch === detailEpoch && taskId === view.taskId && executionId === view.executionId) {
        view.detail = detail;
        render();
      }
    } catch (error) {
      if (epoch === detailEpoch && taskId === view.taskId && executionId === view.executionId) {
        view.notice = 'Run read failed: ' + errorStatus(error);
        render();
      }
    }
  }

  async function loadRuns(taskId: string, preferred?: string): Promise<void> {
    const epoch = ++runsEpoch;
    try {
      const runs = await client.listExecutions(taskId);
      if (epoch !== runsEpoch || taskId !== view.taskId) return;
      view.executions = runs;
      const sorted = [...runs].sort((a, b) =>
        (b.startTime || '').localeCompare(a.startTime || ''));
      const target = preferred || view.executionId;
      const previous = view.executionId;
      view.executionId = (target && runs.some(run => run.executionId === target))
        ? target : sorted[0]?.executionId;
      if (view.executionId !== previous) view.detail = undefined;
      if (view.executionId) await loadDetail(taskId, view.executionId);
      else render();
    } catch (error) {
      if (epoch === runsEpoch && taskId === view.taskId) {
        view.notice = 'Runs read failed: ' + errorStatus(error);
        render();
      }
    }
  }

  async function refresh(): Promise<void> {
    if (refreshInFlight || view.busy) return;
    refreshInFlight = true;
    try {
      const tasks = await client.listTasks();
      view.tasks = tasks;
      if (!tasks.some(task => task.taskId === view.taskId)) {
        view.taskId = tasks[0]?.taskId;
        view.scope = 'tasks';
        view.executionId = undefined;
        view.executions = [];
        view.detail = undefined;
        view.confirm = undefined;
      }
      if (view.scope === 'executions' && view.taskId) {
        await loadRuns(view.taskId);
      }
      view.lastUpdated = new Date().toISOString();
      view.notice = undefined;
      render();
    } catch (error) {
      view.notice = 'Refresh failed: ' + errorStatus(error);
      render();
    } finally {
      refreshInFlight = false;
    }
  }

  function selectTask(taskId: string): void {
    if (view.busy || !view.tasks.some(task => task.taskId === taskId)) return;
    view.taskId = taskId;
    view.executions = [];
    view.executionId = undefined;
    view.detail = undefined;
    view.confirm = undefined;
    ++runsEpoch;
    ++detailEpoch;
    render();
  }

  function selectExecution(executionId: string): void {
    if (view.busy || !view.executions.some(run => run.executionId === executionId)
        || !view.taskId) return;
    view.executionId = executionId;
    view.detail = undefined;
    view.confirm = undefined;
    render();
    void loadDetail(view.taskId, executionId);
  }

  function openRuns(): void {
    if (view.busy || !view.taskId || !view.tasks.some(task => task.taskId === view.taskId)) return;
    view.scope = 'executions';
    view.notice = undefined;
    view.confirm = undefined;
    render();
    void loadRuns(view.taskId);
  }

  function backToTasks(): void {
    if (view.busy) return;
    view.scope = 'tasks';
    view.confirm = undefined;
    render();
  }

  function requestConfirmation(kind: 'run' | 'stop'): void {
    if (view.busy || !view.taskId) return;
    const confirm: OperatorConfirm = {
      kind, taskId: view.taskId,
      ...(kind === 'stop' ? { executionId: view.executionId } : {}),
    };
    if (!confirmationMatches(view, confirm)) {
      view.notice = 'Select an eligible task or currently running execution';
      render();
      return;
    }
    view.confirm = confirm;
    view.confirmSelected = 'cancel';
    render();
  }

  async function submitConfirmation(): Promise<void> {
    const confirm = view.confirm;
    if (!confirm || view.confirmSelected !== 'confirm'
        || !confirmationMatches(view, confirm)) {
      view.confirm = undefined;
      view.notice = 'Confirmation cancelled or execution state changed';
      render();
      return;
    }
    view.busy = true;
    view.confirm = undefined;
    view.confirmSelected = undefined;
    view.notice = undefined;
    render();
    try {
      let execution: OperatorExecution;
      if (confirm.kind === 'run') {
        // One POST, never retry a possibly-started execution after a timeout.
        execution = await client.startTask(confirm.taskId);
      } else {
        execution = await client.stopExecution(confirm.taskId, confirm.executionId!);
      }
      if (view.taskId === confirm.taskId) {
        view.scope = 'executions';
        view.executionId = execution.executionId;
        view.detail = execution;
        view.notice = confirm.kind === 'run' ? 'Execution requested' : 'Stop requested';
      }
      // Backend write acknowledged. A follow-up read failing must not relabel
      // that acknowledged write as ambiguous or trigger a second mutation.
      try {
        const runs = await client.listExecutions(confirm.taskId);
        if (view.taskId === confirm.taskId) view.executions = runs;
      } catch {
        view.notice = 'Action accepted; run refresh unavailable';
      }
    } catch (error) {
      // Network failure after a mutation is ambiguous. Do not retry or infer success.
      view.notice = 'Action not confirmed (' + errorStatus(error)
        + '). Inspect AgentWeb before any retry.';
    } finally {
      view.busy = false;
      render();
    }
  }

  function errorStatus(error: unknown): string {
    const status = (error as { response?: { status?: unknown } })?.response?.status;
    return typeof status === 'number' ? 'HTTP ' + status : 'network or unexpected response';
  }

  function selectConfirmation(item: string, activate: boolean): void {
    if (!view.confirm || view.busy || (item !== 'cancel' && item !== 'confirm')) return;
    view.confirmSelected = item;
    if (activate) {
      if (item === 'cancel') {
        view.confirm = undefined;
        render();
      } else {
        void submitConfirmation();
      }
    } else render();
  }

  function moveSelection(delta: number): void {
    if (view.confirm) {
      view.confirmSelected = delta > 0 ? 'confirm' : 'cancel';
      render();
      return;
    }
    if (view.scope === 'tasks') {
      const index = view.tasks.findIndex(task => task.taskId === view.taskId);
      const next = view.tasks[Math.min(view.tasks.length - 1, Math.max(0, index + delta))];
      if (next) selectTask(next.taskId);
    } else {
      const sorted = [...view.executions].sort((a, b) =>
        (b.startTime || '').localeCompare(a.startTime || ''));
      const index = sorted.findIndex(run => run.executionId === view.executionId);
      const next = sorted[Math.min(sorted.length - 1, Math.max(0, index + delta))];
      if (next) selectExecution(next.executionId);
    }
  }

  function key(name: string): void {
    if (name === 'ctrl-c' || name === 'q') return close(name === 'q' ? 0 : 130);
    if (view.busy) return;
    if (view.confirm) {
      if (name === 'escape') selectConfirmation('cancel', true);
      else if (name === 'up' || name === 'down') moveSelection(name === 'down' ? 1 : -1);
      else if (name === 'enter') selectConfirmation(view.confirmSelected || 'cancel', true);
      return;
    }
    if (name === 'up' || name === 'down') moveSelection(name === 'down' ? 1 : -1);
    else if (name === 'r') void refresh();
    else if (view.scope === 'tasks') {
      if (name === 'enter') openRuns();
      else if (name === 's') requestConfirmation('run');
      else if (name === 'escape') close(0);
    } else {
      if (name === 'x') requestConfirmation('stop');
      else if (name === 'escape') backToTasks();
    }
  }

  function drainRaw(): void {
    for (;;) {
      if (!rawBuffer) return;
      if (rawBuffer === '\x1b') {
        clearTimeout(escapeFlush);
        escapeFlush = setTimeout(() => { rawBuffer = ''; key('escape'); }, 35);
        return;
      }
      if (rawBuffer.startsWith('\x1b[') && rawBuffer.length < 3) return;
      if (rawBuffer.startsWith('\x1b[A')) { rawBuffer = rawBuffer.slice(3); key('up'); continue; }
      if (rawBuffer.startsWith('\x1b[B')) { rawBuffer = rawBuffer.slice(3); key('down'); continue; }
      const csi = /^\x1b\[[0-9:;]*[A-Za-z~]/.exec(rawBuffer);
      if (csi) { rawBuffer = rawBuffer.slice(csi[0].length); continue; }
      const char = rawBuffer[0];
      rawBuffer = rawBuffer.slice(1);
      if (char === '\x03') key('ctrl-c');
      else if (char === '\r' || char === '\n') key('enter');
      else if (char === '\x1b') key('escape');
      else if ('qrsx'.includes(char)) key(char);
    }
  }

  rawHandler = raw => {
    rawBuffer += raw;
    clearTimeout(escapeFlush);
    escapeFlush = undefined;
    drainRaw();
  };

  eventHandler = event => {
    if (event.sf && event.sf !== activeSurfaceId) return;
    if (event.ev === 'ack' && typeof event.s === 'number') {
      sender.ack(event.s);
      return;
    }
    if (event.ev === 'visible') {
      visible = event.visible !== false;
      if (visible) void refresh();
      return;
    }
    if (event.ev === 'gone') {
      const ids = Array.isArray(event.ids)
        ? event.ids.filter((id): id is string => typeof id === 'string') : [];
      if (ids.includes(activeSurfaceId)) {
        open = false;
        if (++recoveries > 3) return close(1);
        openSurface();
      } else {
        reconciler.forget(ids);
        render();
      }
      return;
    }
    if (event.ev === 'error') {
      protocolFailed = true;
      process.stderr.write('tern:operator: TSP operation rejected; reconnect the pane\n');
      return;
    }
    if (event.ev === 'select' || event.ev === 'activate') {
      if (typeof event.item !== 'string') return;
      const activate = event.ev === 'activate';
      if (event.id === 'operator.confirm') selectConfirmation(event.item, activate);
      else if (!view.confirm && event.id === 'operator.tasks') {
        selectTask(event.item);
        if (activate) openRuns();
      } else if (!view.confirm && event.id === 'operator.runs') {
        selectExecution(event.item);
      }
      return;
    }
    if (event.ev !== 'action' || typeof event.act !== 'string') return;
    if (event.id === 'operator.confirm') {
      if (event.act === 'cancel' || event.act === 'close') selectConfirmation('cancel', true);
      else if (event.act === 'confirm') selectConfirmation('confirm', true);
      return;
    }
    if (view.confirm) return;
    if (event.act === 'refresh') void refresh();
    else if (event.id === 'operator.tasks') {
      if (event.act === 'open') openRuns();
      else if (event.act === 'start') requestConfirmation('run');
      else if (event.act === 'close') close(0);
    } else if (event.id === 'operator.runs') {
      if (event.act === 'stop') requestConfirmation('stop');
      else if (event.act === 'tasks') backToTasks();
    }
  };

  openSurface();
  polling = setInterval(() => {
    if (visible && !shuttingDown && !view.confirm && !view.busy) void refresh();
  }, 10000);
}

main().catch(error => {
  if (process.stdout.isTTY) process.stdout.write(KITTY_POP + PASTE_OFF);
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  process.stderr.write('tern:operator: ' +
    (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
