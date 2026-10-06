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
  EmmaMessage,
  EmmaSessionLike,
  renderEmmaDock,
  renderEmmaMain,
  RunningTool,
  TspNode,
} from '../tern/renderEmma';

const SURFACE_ID = 'agentweb-emma';
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

function nodeAdd(node: TspNode): [string, string, string, null, TspNode] {
  return ['add', node.id, SURFACE_ID, null, node];
}

class FrameSender {
  private sequence = 0;
  private inFlight: number | null = null;
  private pending: unknown[][] | null = null;

  constructor(private readonly apcLimit: number) {}

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
    // replacement deterministic and coalesces rapid editor updates for this P0.
    if (this.inFlight !== null || !this.pending) return;
    const ops = this.pending;
    this.pending = null;
    const s = ++this.sequence;
    this.inFlight = s;
    process.stdout.write(
      encodeTspJson('f', { sf: SURFACE_ID, s, ops }, undefined, this.apcLimit),
    );
  }
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
    if (chunk.includes('\x03')) {
      closeAndExit(130);
      return;
    }

    for (const raw of reader.push(chunk)) {
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

  const requiredKinds = ['col', 'card', 'md', 'editor', 'status', 'seg', 'tool'];
  const missingKinds = requiredKinds.filter(kind => !hello.kinds.includes(kind));
  if (missingKinds.length > 0) {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    throw new Error(`Tern is missing required TSP kinds: ${missingKinds.join(', ')}`);
  }

  const apcLimit = typeof hello.apc === 'number'
    ? hello.apc
    : TSP_DEFAULT_APC_LIMIT;
  const frames = new FrameSender(apcLimit);

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
  const undoStack: Array<{ text: string; cursor: number }> = [];

  const render = (dockOnly = false) => {
    const dock = renderEmmaDock({
      text: composer,
      cursor,
      running,
      session,
      error: errorText,
    });

    if (!rendered) {
      const mainNode = renderEmmaMain(session, runningTools);
      frames.request([
        nodeAdd(mainNode),
        nodeAdd(dock),
        ['focus', 'composer'],
      ]);
      rendered = true;
      return;
    }

    if (dockOnly) {
      frames.request([
        ['del', 'dock'],
        nodeAdd(dock),
        ['focus', 'composer'],
      ]);
      return;
    }

    const mainNode = renderEmmaMain(session, runningTools);
    frames.request([
      ['del', 'main'],
      nodeAdd(mainNode),
      ['del', 'dock'],
      nodeAdd(dock),
      ['focus', 'composer'],
    ]);
  };

  const applyEdit = (event: Record<string, unknown>) => {
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
        if (typeof event.s === 'number') frames.ack(event.s);
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
      case 'gone':
        // Tern may drop retained inline nodes after scrollback compaction. A full
        // re-render is safe because AgentWeb remains the source of truth.
        render();
        break;
      case 'error':
        if (typeof event.msg === 'string') {
          errorText = event.msg;
          render(true);
        }
        break;
      default:
        break;
    }
  };

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
