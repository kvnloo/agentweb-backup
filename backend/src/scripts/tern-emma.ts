#!/usr/bin/env node
import { AgentWebClient, EmmaStreamEvent } from '../tern/agentWebClient';
import {
  encodeHelloQuery,
  encodeTspJson,
  parseTspJson,
  TSP_DEFAULT_APC_LIMIT,
  TspStreamReader,
} from '../tern/protocol';
import {
  AgentRunSummaryLike,
  ApprovalDeckInboundAnswer,
  ApprovalDeckUiState,
  EmmaMessage,
  EmmaSessionLike,
  approvalDeckAllAnswered,
  approvalDeckIsAwaiting,
  filterSessions,
  renderAgentRunsScreen,
  renderApprovalDeck,
  renderEmmaDock,
  renderEmmaMain,
  renderEmptyLayer,
  renderSessionPicker,
  RunningTool,
  SessionPickerState,
  TspNode,
} from '../tern/renderEmma';

const SURFACE_ID = 'agentweb-emma';
const RUNS_SURFACE_ID = 'agentweb-runs';
const DA1 = '\x1b[c';

interface HelloReply {
  r: 'hello';
  v: number;
  term: string;
  kinds: string[];
  features?: string[];
  apc?: number;
  credits?: number;
}

interface PickerKey {
  name: string;
  text?: string;
  ctrl?: boolean;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: AGENTWEB_TOKEN=<token> npm run tern:emma -- [--session <id> | --new]\n' +
    '       Optional: AGENTWEB_API_URL=http://localhost:3001\n',
  );
  process.exit(1);
}

function isHello(value: Record<string, unknown>): value is Record<string, unknown> & HelloReply {
  return value.r === 'hello'
    && typeof value.v === 'number'
    && typeof value.term === 'string'
    && Array.isArray(value.kinds)
    && value.kinds.every(item => typeof item === 'string');
}

function nodeAdd(node: TspNode, surfaceId = SURFACE_ID): [string, string, string, null, TspNode] {
  return ['add', node.id, surfaceId, null, node];
}

class FrameSender {
  private sequence = 0;
  private inFlight: number | null = null;
  private pending: unknown[][] | null = null;

  constructor(
    private readonly surfaceId: string,
    private readonly apcLimit: number,
  ) {}

  request(ops: unknown[][]): void {
    this.pending = ops;
    this.flush();
  }

  ack(sequence: number): void {
    if (this.inFlight !== null && sequence >= this.inFlight) {
      this.inFlight = null;
      this.flush();
    }
  }

  private flush(): void {
    // Intentionally use one credit even when Tern grants more. It makes full-root
    // replacement deterministic and coalesces rapid editor/picker updates for P0.
    if (this.inFlight !== null || !this.pending) return;
    const ops = this.pending;
    this.pending = null;
    const s = ++this.sequence;
    this.inFlight = s;
    process.stdout.write(
      encodeTspJson('f', { sf: this.surfaceId, s, ops }, undefined, this.apcLimit),
    );
  }
}

function decodePickerKey(buffer: string): { key?: PickerKey; used: number; needMore?: boolean } {
  if (!buffer) return { used: 0, needMore: true };

  if (buffer.startsWith('\x1b[200~')) {
    const end = buffer.indexOf('\x1b[201~', 6);
    if (end < 0) return { used: 0, needMore: true };
    return {
      key: { name: 'paste', text: buffer.slice(6, end) },
      used: end + 6,
    };
  }

  const first = buffer[0];
  if (first !== '\x1b') {
    const code = buffer.codePointAt(0);
    if (code === undefined) return { used: 1 };
    const char = String.fromCodePoint(code);
    const used = char.length;

    if (char === '\r' || char === '\n') return { key: { name: 'enter' }, used };
    if (char === '\t') return { key: { name: 'tab' }, used };
    if (char === '\x7f' || char === '\b') return { key: { name: 'backspace' }, used };
    if (char === '\x03') return { key: { name: 'c', ctrl: true }, used };
    if (code >= 1 && code <= 26) {
      return { key: { name: String.fromCharCode(code + 96), ctrl: true }, used };
    }
    if (code < 32) return { used };
    return { key: { name: char.toLowerCase(), text: char }, used };
  }

  if (buffer.length === 1) return { used: 0, needMore: true };

  const simple: Record<string, string> = {
    '\x1b[A': 'up',
    '\x1b[B': 'down',
    '\x1b[C': 'right',
    '\x1b[D': 'left',
    '\x1b[H': 'home',
    '\x1b[F': 'end',
    '\x1b[3~': 'delete',
    '\x1b[5~': 'page_up',
    '\x1b[6~': 'page_down',
  };
  for (const [sequence, name] of Object.entries(simple)) {
    if (buffer.startsWith(sequence)) return { key: { name }, used: sequence.length };
    if (sequence.startsWith(buffer)) return { used: 0, needMore: true };
  }

  const csi = /^\x1b\[([0-9:;]*)([A-Za-z~])/.exec(buffer);
  if (!csi && buffer.startsWith('\x1b[') && buffer.length < 64) {
    return { used: 0, needMore: true };
  }
  if (csi) {
    const [sequence, params, final] = csi;
    if (final === 'u') {
      const pieces = params.split(';');
      const code = Number((pieces[0] || '').split(':')[0]);
      const modifier = Number((pieces[1] || '1').split(':')[0]);
      const bits = Math.max(0, modifier - 1);
      const ctrl = (bits & 4) !== 0;
      const named: Record<number, string> = {
        13: 'enter',
        9: 'tab',
        27: 'escape',
        127: 'backspace',
        57417: 'left',
        57418: 'right',
        57419: 'up',
        57420: 'down',
        57421: 'page_up',
        57422: 'page_down',
        57423: 'home',
        57424: 'end',
        57426: 'delete',
      };
      const name = named[code];
      if (name) return { key: { name, ctrl }, used: sequence.length };
      if (Number.isInteger(code) && code >= 32 && code <= 0x10ffff) {
        const text = String.fromCodePoint(code);
        return { key: { name: text.toLowerCase(), text: ctrl ? undefined : text, ctrl }, used: sequence.length };
      }
      return { used: sequence.length };
    }

    const arrowName: Record<string, string> = {
      A: 'up',
      B: 'down',
      C: 'right',
      D: 'left',
      H: 'home',
      F: 'end',
    };
    if (arrowName[final]) return { key: { name: arrowName[final] }, used: sequence.length };
    if (final === '~') {
      const n = Number(params.split(';')[0]);
      const name = n === 3 ? 'delete' : n === 5 ? 'page_up' : n === 6 ? 'page_down' : undefined;
      return { ...(name ? { key: { name } } : {}), used: sequence.length };
    }
    return { used: sequence.length };
  }

  // A lone ESC is ambiguous with an escape-sequence prefix; the caller flushes it
  // after a short deadline. Unknown completed ESC sequences are consumed.
  if (buffer.startsWith('\x1b')) return { used: 1, key: { name: 'escape' } };
  return { used: 1 };
}

async function main(): Promise<void> {
  const token = process.env.AGENTWEB_TOKEN;
  if (!token) usage('AGENTWEB_TOKEN is required.');

  const baseUrl = process.env.AGENTWEB_API_URL || 'http://localhost:3001';
  const client = new AgentWebClient({ baseUrl, token });
  const requestedSession = argValue('--session');
  const forceNew = process.argv.includes('--new');

  let session: EmmaSessionLike;
  if (requestedSession) {
    session = await client.getSession(requestedSession);
  } else if (forceNew) {
    session = await client.createSession();
  } else {
    const sessions = await client.listEmmaSessions(1);
    session = sessions[0] ?? await client.createSession();
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    usage('tern:emma must run in an interactive Tern pane.');
  }

  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  const reader = new TspStreamReader();
  let helloResolve: ((hello: HelloReply) => void) | undefined;
  let eventHandler: ((event: Record<string, unknown>) => void) | undefined;
  let rawHandler: ((raw: string) => void) | undefined;
  let shuttingDown = false;
  let surfaceOpened = false;

  const closeAndExit = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (surfaceOpened) {
      process.stdout.write(
        encodeTspJson('x', { id: SURFACE_ID, keep: false }),
      );
    }
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.exit(code);
  };

  process.on('SIGTERM', () => closeAndExit(143));
  process.on('SIGHUP', () => closeAndExit(129));

  process.stdin.on('data', (chunk: string) => {
    for (const part of reader.pushParts(chunk)) {
      if (part.type === 'raw') {
        rawHandler?.(part.data);
        continue;
      }

      const raw = part.message;
      const value = parseTspJson(raw);
      if (!value) continue;
      if (raw.verb === 'r' && isHello(value)) {
        helloResolve?.(value);
        continue;
      }
      if (raw.verb === 'e') eventHandler?.(value);
    }
  });

  const hello = await new Promise<HelloReply>((resolve, reject) => {
    helloResolve = resolve;
    const timer = setTimeout(
      () => reject(new Error('Tern Surface Protocol hello timed out')),
      800,
    );
    const wrapped = (reply: HelloReply) => {
      clearTimeout(timer);
      resolve(reply);
    };
    helloResolve = wrapped;

    process.stdout.write(encodeHelloQuery('agentweb-emma'));
    // DA1 is the standard capability-probe sentinel used by Tern clients.
    process.stdout.write(DA1);
  }).catch(error => {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    throw error;
  });

  const requiredKinds = ['col', 'card', 'md', 'editor', 'status', 'seg', 'tool', 'picker', 'kv', 'section', 'checklist', 'progress', 'table'];
  const missingKinds = requiredKinds.filter(kind => !hello.kinds.includes(kind));
  if (missingKinds.length > 0) {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    throw new Error(`Tern is missing required TSP kinds: ${missingKinds.join(', ')}`);
  }

  const apcLimit = typeof hello.apc === 'number'
    ? hello.apc
    : TSP_DEFAULT_APC_LIMIT;
  const frames = new FrameSender(SURFACE_ID, apcLimit);

  process.stdout.write(
    encodeTspJson(
      'o',
      {
        id: SURFACE_ID,
        mode: 'inline',
        title: session.title || 'Emma',
        role: 'agentweb.emma',
      },
      undefined,
      apcLimit,
    ),
  );
  surfaceOpened = true;

  let composer = '';
  let cursor = 0;
  let running = false;
  let runningTools: RunningTool[] = [];
  let toolCounter = 0;
  let errorText: string | undefined;
  let rendered = false;
  let pickerState: SessionPickerState | undefined;
  let approvalState: ApprovalDeckUiState | undefined;
  let runState: { runs: AgentRunSummaryLike[]; selected: number } | undefined;
  let runFrames: FrameSender | undefined;
  let runsSurfaceOpened = false;
  const dismissedDecks = new Set<string>();
  let pickerKeyBuffer = '';
  let escapeFlush: NodeJS.Timeout | undefined;
  const undoStack: Array<{ text: string; cursor: number }> = [];

  const render = (dockOnly = false) => {
    const dock = renderEmmaDock({
      text: composer,
      cursor,
      running,
      session,
      error: errorText,
    });
    const layer = pickerState
      ? renderSessionPicker(pickerState, session.sessionId)
      : approvalState && approvalDeckIsAwaiting(session.pendingApprovalDeck)
        ? renderApprovalDeck(session.pendingApprovalDeck, approvalState)
        : renderEmptyLayer();

    const focusComposer = !pickerState && !approvalState ? [['focus', 'composer']] : [];

    if (!rendered) {
      const mainNode = renderEmmaMain(session, runningTools);
      frames.request([
        nodeAdd(mainNode),
        nodeAdd(dock),
        nodeAdd(layer),
        ...focusComposer,
      ]);
      rendered = true;
      return;
    }

    if (dockOnly && !pickerState && !approvalState) {
      frames.request([
        ['del', 'dock'],
        nodeAdd(dock),
        ...focusComposer,
      ]);
      return;
    }

    const mainNode = renderEmmaMain(session, runningTools);
    frames.request([
      ['del', 'main'],
      nodeAdd(mainNode),
      ['del', 'dock'],
      nodeAdd(dock),
      ['del', 'layer'],
      nodeAdd(layer),
      ...focusComposer,
    ]);
  };

  const renderRuns = () => {
    if (!runState || !runFrames) return;
    const root = renderAgentRunsScreen(runState.runs, runState.selected);
    runFrames.request([
      ['del', 'run-picker'],
      nodeAdd(root, RUNS_SURFACE_ID),
    ]);
  };

  const closeAgentRuns = () => {
    runState = undefined;
    runFrames = undefined;
    pickerKeyBuffer = '';
    clearTimeout(escapeFlush);
    escapeFlush = undefined;
    if (runsSurfaceOpened) {
      process.stdout.write(
        encodeTspJson('x', { id: RUNS_SURFACE_ID, keep: false }, undefined, apcLimit),
      );
      runsSurfaceOpened = false;
    }
  };

  const refreshAgentRuns = async () => {
    if (!runState) return;
    try {
      const runs = await client.getAgentRuns(session.sessionId, 3);
      runState.runs = runs;
      runState.selected = Math.max(0, Math.min(runState.selected, Math.max(0, runs.length - 1)));
      renderRuns();
    } catch (error: any) {
      const status = error?.response?.status;
      closeAgentRuns();
      errorText = status === 401 || status === 403
        ? 'AgentRun Inspector requires admin access'
        : error instanceof Error
          ? error.message
          : String(error);
      render(true);
    }
  };

  const openAgentRuns = async () => {
    if (running) return;
    try {
      const runs = await client.getAgentRuns(session.sessionId, 3);
      runState = { runs, selected: 0 };
      pickerState = undefined;
      approvalState = undefined;
      pickerKeyBuffer = '';
      runFrames = new FrameSender(RUNS_SURFACE_ID, apcLimit);
      process.stdout.write(
        encodeTspJson(
          'o',
          {
            id: RUNS_SURFACE_ID,
            mode: 'screen',
            title: 'AgentRun Inspector',
            role: 'agentweb.runs',
          },
          undefined,
          apcLimit,
        ),
      );
      runsSurfaceOpened = true;
      runFrames.request([nodeAdd(renderAgentRunsScreen(runs, 0), RUNS_SURFACE_ID)]);
    } catch (error: any) {
      const status = error?.response?.status;
      errorText = status === 401 || status === 403
        ? 'AgentRun Inspector requires admin access'
        : error instanceof Error
          ? error.message
          : String(error);
      render(true);
    }
  };

  const closePicker = () => {
    pickerState = undefined;
    pickerKeyBuffer = '';
    clearTimeout(escapeFlush);
    escapeFlush = undefined;
    render();
  };

  const maybeOpenApprovalDeck = () => {
    const deck = session.pendingApprovalDeck;
    if (!approvalDeckIsAwaiting(deck) || dismissedDecks.has(deck.deckId)) {
      approvalState = undefined;
      return;
    }
    if (approvalState && session.pendingApprovalDeck?.deckId === deck.deckId) return;
    const firstItem = deck.items[0];
    const firstChoices = firstItem?.metaWriteManifestDigest
      ? [{ id: 'approve' }, { id: 'reject' }]
      : firstItem?.options ?? [];
    approvalState = {
      itemIndex: 0,
      answers: [],
      selectedVerdict:
        firstChoices.find((choice: any) => choice.recommended)?.id
        || firstChoices[0]?.id,
    };
    pickerState = undefined;
    pickerKeyBuffer = '';
  };

  const closeApprovalDeck = () => {
    const deck = session.pendingApprovalDeck;
    if (approvalDeckIsAwaiting(deck)) dismissedDecks.add(deck.deckId);
    approvalState = undefined;
    pickerKeyBuffer = '';
    clearTimeout(escapeFlush);
    escapeFlush = undefined;
    render();
  };

  const visiblePickerSessions = (): EmmaSessionLike[] =>
    pickerState ? filterSessions(pickerState.sessions, pickerState.query) : [];

  const clampPickerSelection = () => {
    if (!pickerState) return;
    const visible = visiblePickerSessions();
    pickerState.selected = Math.max(0, Math.min(pickerState.selected, Math.max(0, visible.length - 1)));
  };

  const switchSession = async (sessionId: string) => {
    if (running) return;
    try {
      closeAgentRuns();
      const next = await client.getSession(sessionId);
      session = next;
      composer = '';
      cursor = 0;
      errorText = undefined;
      undoStack.length = 0;
      pickerState = undefined;
      approvalState = undefined;
      maybeOpenApprovalDeck();
      render();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      render();
    }
  };

  const createNewSession = async () => {
    if (running) return;
    try {
      closeAgentRuns();
      session = await client.createSession();
      composer = '';
      cursor = 0;
      errorText = undefined;
      undoStack.length = 0;
      pickerState = undefined;
      approvalState = undefined;
      render();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      render();
    }
  };

  const resumeSelectedSession = () => {
    const selected = visiblePickerSessions()[pickerState?.selected ?? -1];
    if (selected) void switchSession(selected.sessionId);
  };

  const openSessionPicker = async () => {
    if (running) return;
    approvalState = undefined;
    try {
      const sessions = await client.listEmmaSessions(50);
      if (!sessions.some(item => item.sessionId === session.sessionId)) sessions.unshift(session);
      const sorted = filterSessions(sessions, '');
      const selected = Math.max(0, sorted.findIndex(item => item.sessionId === session.sessionId));
      pickerState = { sessions, query: '', cursor: 0, selected };
      pickerKeyBuffer = '';
      errorText = undefined;
      render();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      render(true);
    }
  };

  const updatePickerQuery = (next: string, nextCursor: number) => {
    if (!pickerState) return;
    pickerState.query = next;
    pickerState.cursor = Math.max(0, Math.min(nextCursor, next.length));
    pickerState.selected = 0;
    clampPickerSelection();
    render();
  };

  const currentApprovalDeck = () =>
    approvalDeckIsAwaiting(session.pendingApprovalDeck) ? session.pendingApprovalDeck : undefined;

  const approvalChoices = () => {
    const deck = currentApprovalDeck();
    const item = deck?.items[approvalState?.itemIndex ?? -1];
    if (!item) return [];
    if (item.metaWriteManifestDigest) {
      return [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ];
    }
    return item.options ?? [];
  };

  const syncApprovalSelection = () => {
    const deck = currentApprovalDeck();
    if (!deck || !approvalState) return;
    const item = deck.items[approvalState.itemIndex];
    if (!item) return;
    const existing = approvalState.answers.find(answer => answer.itemId === item.itemId);
    const choices = approvalChoices();
    approvalState.selectedVerdict =
      existing?.verdict
      || choices.find((choice: any) => choice.recommended)?.id
      || choices[0]?.id;
  };

  const recordApprovalChoice = (delegated = false): boolean => {
    const deck = currentApprovalDeck();
    if (!deck || !approvalState) return false;
    const item = deck.items[approvalState.itemIndex];
    if (!item) return false;

    let answer: ApprovalDeckInboundAnswer;
    if (delegated) {
      if (!item.allowEmmaDecide || item.metaWriteManifestDigest) return false;
      answer = { itemId: item.itemId, verdict: '', delegated: true };
    } else {
      const verdict = approvalState.selectedVerdict;
      if (!verdict) return false;
      answer = { itemId: item.itemId, verdict };
    }

    approvalState.answers = [
      ...approvalState.answers.filter(existing => existing.itemId !== item.itemId),
      answer,
    ];
    return true;
  };

  const moveApproval = (delta: number) => {
    const deck = currentApprovalDeck();
    if (!deck || !approvalState) return;
    approvalState.itemIndex = Math.max(0, Math.min(deck.items.length - 1, approvalState.itemIndex + delta));
    approvalState.selectedVerdict = undefined;
    syncApprovalSelection();
    render();
  };

  const submitApprovalDeck = async () => {
    const deck = currentApprovalDeck();
    if (!deck || !approvalState || running || !approvalDeckAllAnswered(deck, approvalState)) return;
    running = true;
    errorText = undefined;
    const answers = [...approvalState.answers];
    approvalState = undefined;
    render();

    try {
      session = await client.submitApprovalDeck(session, deck.deckId, answers);
      dismissedDecks.delete(deck.deckId);
      maybeOpenApprovalDeck();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      try {
        session = await client.getSession(session.sessionId);
      } catch {
        // Keep the existing session and surface the error in the status line.
      }
      if (approvalDeckIsAwaiting(session.pendingApprovalDeck)) {
        approvalState = { itemIndex: 0, answers };
        syncApprovalSelection();
      }
    } finally {
      running = false;
      render();
    }
  };

  const chooseApprovalAndAdvance = (delegated = false) => {
    const deck = currentApprovalDeck();
    if (!deck || !approvalState || !recordApprovalChoice(delegated)) return;
    if (approvalState.itemIndex < deck.items.length - 1) {
      moveApproval(1);
    } else {
      render();
    }
  };

  const handleRunKey = (key: PickerKey): boolean => {
    if (!runState) return false;

    if (key.ctrl && key.name === 'c') {
      closeAndExit(130);
      return true;
    }
    if (key.name === 'escape') {
      closeAgentRuns();
      return true;
    }
    if (!key.ctrl && key.name === 'r') {
      void refreshAgentRuns();
      return true;
    }
    if (key.name === 'up') {
      runState.selected = Math.max(0, runState.selected - 1);
      renderRuns();
      return true;
    }
    if (key.name === 'down') {
      runState.selected = Math.min(Math.max(0, runState.runs.length - 1), runState.selected + 1);
      renderRuns();
      return true;
    }
    if (key.name === 'home') {
      runState.selected = 0;
      renderRuns();
      return true;
    }
    if (key.name === 'end') {
      runState.selected = Math.max(0, runState.runs.length - 1);
      renderRuns();
      return true;
    }
    return true;
  };

  const handlePickerKey = (key: PickerKey) => {
    if (runState && handleRunKey(key)) return;

    if (approvalState) {
      const choices = approvalChoices();
      const current = approvalState.selectedVerdict;
      let selectedIndex = Math.max(0, choices.findIndex((choice: any) => choice.id === current));

      if (key.ctrl && key.name === 'c') {
        closeAndExit(130);
        return;
      }
      if (key.ctrl && key.name === 'enter') {
        void submitApprovalDeck();
        return;
      }
      if (key.name === 'escape') {
        closeApprovalDeck();
        return;
      }
      if (key.name === 'left') {
        moveApproval(-1);
        return;
      }
      if (key.name === 'right') {
        const deck = currentApprovalDeck();
        if (deck && approvalState.itemIndex < deck.items.length - 1) moveApproval(1);
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        selectedIndex += key.name === 'up' ? -1 : 1;
        selectedIndex = Math.max(0, Math.min(choices.length - 1, selectedIndex));
        approvalState.selectedVerdict = choices[selectedIndex]?.id;
        render();
        return;
      }
      if (key.name === 'enter') {
        chooseApprovalAndAdvance(false);
        return;
      }
      if (!key.ctrl && key.name === 'd') {
        chooseApprovalAndAdvance(true);
        return;
      }
      return;
    }

    if (!pickerState) {
      if (key.ctrl && key.name === 'c') closeAndExit(130);
      return;
    }

    if (key.ctrl && key.name === 'c') {
      closeAndExit(130);
      return;
    }
    if (key.ctrl && key.name === 'n') {
      void createNewSession();
      return;
    }

    switch (key.name) {
      case 'escape':
        closePicker();
        return;
      case 'enter':
        resumeSelectedSession();
        return;
      case 'up':
        pickerState.selected--;
        clampPickerSelection();
        render();
        return;
      case 'down':
        pickerState.selected++;
        clampPickerSelection();
        render();
        return;
      case 'page_up':
        pickerState.selected -= 8;
        clampPickerSelection();
        render();
        return;
      case 'page_down':
        pickerState.selected += 8;
        clampPickerSelection();
        render();
        return;
      case 'left':
        pickerState.cursor = Math.max(0, pickerState.cursor - 1);
        render();
        return;
      case 'right':
        pickerState.cursor = Math.min(pickerState.query.length, pickerState.cursor + 1);
        render();
        return;
      case 'home':
        pickerState.cursor = 0;
        render();
        return;
      case 'end':
        pickerState.cursor = pickerState.query.length;
        render();
        return;
      case 'backspace':
        if (pickerState.cursor > 0) {
          const at = pickerState.cursor;
          updatePickerQuery(
            pickerState.query.slice(0, at - 1) + pickerState.query.slice(at),
            at - 1,
          );
        }
        return;
      case 'delete':
        if (pickerState.cursor < pickerState.query.length) {
          const at = pickerState.cursor;
          updatePickerQuery(
            pickerState.query.slice(0, at) + pickerState.query.slice(at + 1),
            at,
          );
        }
        return;
      case 'paste':
        if (key.text) {
          const at = pickerState.cursor;
          updatePickerQuery(
            pickerState.query.slice(0, at) + key.text + pickerState.query.slice(at),
            at + key.text.length,
          );
        }
        return;
      default:
        if (key.text) {
          const at = pickerState.cursor;
          updatePickerQuery(
            pickerState.query.slice(0, at) + key.text + pickerState.query.slice(at),
            at + key.text.length,
          );
        }
    }
  };

  const drainPickerKeys = (finalEscape = false) => {
    for (;;) {
      if (!pickerKeyBuffer) return;
      if (finalEscape && pickerKeyBuffer === '\x1b') {
        pickerKeyBuffer = '';
        handlePickerKey({ name: 'escape' });
        return;
      }

      const decoded = decodePickerKey(pickerKeyBuffer);
      if (decoded.needMore && decoded.used === 0) return;
      if (decoded.used <= 0) return;
      pickerKeyBuffer = pickerKeyBuffer.slice(decoded.used);
      if (decoded.key) handlePickerKey(decoded.key);
    }
  };

  rawHandler = raw => {
    if (!pickerState && !approvalState && !runState) {
      if (raw.includes('\x03')) closeAndExit(130);
      return;
    }

    pickerKeyBuffer += raw;
    clearTimeout(escapeFlush);
    escapeFlush = undefined;
    drainPickerKeys();

    if (pickerKeyBuffer === '\x1b') {
      escapeFlush = setTimeout(() => {
        escapeFlush = undefined;
        drainPickerKeys(true);
      }, 30);
    }
  };

  const applyEdit = (event: Record<string, unknown>) => {
    if (event.id === 'session-picker' && pickerState) {
      const from = event.from;
      const to = event.to;
      const text = event.text;
      const nextCursor = event.cursor;
      if (
        typeof from === 'number'
        && typeof to === 'number'
        && typeof text === 'string'
        && typeof nextCursor === 'number'
        && from >= 0
        && to >= from
        && to <= pickerState.query.length
      ) {
        updatePickerQuery(
          pickerState.query.slice(0, from) + text + pickerState.query.slice(to),
          nextCursor,
        );
      }
      return;
    }

    if (event.id !== 'composer') return;
    const from = event.from;
    const to = event.to;
    const text = event.text;
    const nextCursor = event.cursor;
    if (
      typeof from !== 'number'
      || typeof to !== 'number'
      || typeof text !== 'string'
      || typeof nextCursor !== 'number'
      || from < 0
      || to < from
      || to > composer.length
    ) return;

    undoStack.push({ text: composer, cursor });
    if (undoStack.length > 100) undoStack.shift();
    composer = composer.slice(0, from) + text + composer.slice(to);
    cursor = Math.max(0, Math.min(nextCursor, composer.length));
    errorText = undefined;
    render(true);
  };

  const sendPrompt = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || running) return;

    if (text === '/runs') {
      composer = '';
      cursor = 0;
      void openAgentRuns();
      return;
    }
    if (text === '/resume' || text === '/sessions') {
      composer = '';
      cursor = 0;
      void openSessionPicker();
      return;
    }
    if (text === '/new') {
      composer = '';
      cursor = 0;
      void createNewSession();
      return;
    }

    running = true;
    errorText = undefined;
    composer = '';
    cursor = 0;
    undoStack.length = 0;
    runningTools = [];

    const optimistic: EmmaMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    session = {
      ...session,
      messages: [...(session.messages ?? []), optimistic],
    };
    render();

    try {
      const complete = await client.streamMessage(
        session.sessionId,
        text,
        (event: EmmaStreamEvent) => {
          if (event.type !== 'tool_start' || typeof event.name !== 'string') return;
          runningTools = [
            ...runningTools,
            {
              id: String(++toolCounter),
              name: event.name,
              startedAt: Date.now(),
            },
          ];
          render();
        },
      );

      if (complete.session) {
        session = complete.session;
      } else {
        session = await client.getSession(session.sessionId);
      }
      errorText = complete.error ? 'Last turn failed' : undefined;
      maybeOpenApprovalDeck();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      try {
        session = await client.getSession(session.sessionId);
      } catch {
        // Keep the optimistic local transcript; the status line already shows the failure.
      }
    } finally {
      running = false;
      runningTools = [];
      render();
    }
  };

  eventHandler = event => {
    switch (event.ev) {
      case 'ack':
        if (typeof event.s === 'number') {
          if (event.sf === RUNS_SURFACE_ID) runFrames?.ack(event.s);
          else frames.ack(event.s);
        }
        break;
      case 'edit':
        applyEdit(event);
        break;
      case 'undo': {
        if (event.id !== 'composer') break;
        const previous = undoStack.pop();
        if (!previous) break;
        composer = previous.text;
        cursor = previous.cursor;
        render(true);
        break;
      }
      case 'send':
        if (event.id === 'composer' && typeof event.text === 'string') {
          void sendPrompt(event.text);
        }
        break;
      case 'select':
      case 'activate': {
        if (event.id === 'run-picker' && typeof event.item === 'string' && runState) {
          const index = runState.runs.findIndex(run => run.runId === event.item);
          if (index >= 0) {
            runState.selected = index;
            renderRuns();
          }
          break;
        }
        if (event.id === 'approval-picker' && typeof event.item === 'string' && approvalState) {
          approvalState.selectedVerdict = event.item;
          if (event.ev === 'activate') chooseApprovalAndAdvance(false);
          else render();
          break;
        }
        if (event.id !== 'session-picker' || typeof event.item !== 'string' || !pickerState) break;
        const visible = visiblePickerSessions();
        const index = visible.findIndex(item => item.sessionId === event.item);
        if (index < 0) break;
        pickerState.selected = index;
        if (event.ev === 'activate') resumeSelectedSession();
        else render();
        break;
      }
      case 'action': {
        if (event.act === 'runs' && event.id === 'status.runs') {
          void openAgentRuns();
          break;
        }
        if (event.id === 'run-picker' && runState) {
          if (event.act === 'refresh') void refreshAgentRuns();
          else if (event.act === 'close' || event.act === 'cancel') closeAgentRuns();
          break;
        }
        if (event.act === 'sessions' && event.id === 'status.sessions') {
          void openSessionPicker();
          break;
        }
        if (event.id === 'approval-picker' && approvalState) {
          if (event.act === 'choose') chooseApprovalAndAdvance(false);
          else if (event.act === 'delegate') chooseApprovalAndAdvance(true);
          else if (event.act === 'prev') moveApproval(-1);
          else if (event.act === 'next') moveApproval(1);
          else if (event.act === 'submit') void submitApprovalDeck();
          else if (event.act === 'close' || event.act === 'cancel') closeApprovalDeck();
          break;
        }
        if (event.id !== 'session-picker') break;
        if (event.act === 'resume') resumeSelectedSession();
        else if (event.act === 'new') void createNewSession();
        else if (event.act === 'close' || event.act === 'cancel') closePicker();
        break;
      }
      case 'gone':
        // Tern may drop retained inline nodes after scrollback compaction. A full
        // re-render is safe because AgentWeb remains the source of truth.
        render();
        break;
      case 'error':
        if (typeof event.msg === 'string') {
          errorText = event.msg;
          if (event.sf === RUNS_SURFACE_ID) {
            closeAgentRuns();
          } else {
            render(pickerState === undefined && approvalState === undefined);
          }
        }
        break;
      default:
        break;
    }
  };

  maybeOpenApprovalDeck();
  if (approvalState) syncApprovalSelection();
  render();
}

main().catch(error => {
  try {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  } catch {
    // no-op
  }
  process.stderr.write(`tern:emma: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
