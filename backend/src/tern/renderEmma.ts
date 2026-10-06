export interface TspNode {
  id: string;
  k: string;
  p?: Record<string, unknown>;
  c?: TspNode[];
}

export interface EmmaToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  duration?: number;
}

export interface EmmaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: string;
  timestamp?: string;
  metadata?: {
    toolCalls?: EmmaToolCall[];
    [key: string]: unknown;
  };
}

export interface EmmaSessionLike {
  sessionId: string;
  title?: string;
  llmModel?: string;
  sessionType?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: EmmaMessage[];
}

export interface RunningTool {
  id: string;
  name: string;
  startedAt: number;
}

export interface SessionPickerState {
  sessions: EmmaSessionLike[];
  query: string;
  cursor: number;
  selected: number;
}

function toolLabel(name: string): string {
  return name
    .replace(/^mcp__/, '')
    .replace(/__/g, ' / ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function compact(value: unknown, max = 1200): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}

function persistedToolNode(tool: EmmaToolCall, id: string): TspNode {
  const result = tool.result as { success?: boolean } | undefined;
  const failed = tool.error !== undefined || result?.success === false;
  const body = compact(failed ? tool.error ?? tool.result : undefined);

  return {
    id,
    k: 'tool',
    p: {
      name: tool.name,
      title: toolLabel(tool.name),
      status: failed ? 'error' : 'done',
      ...(typeof tool.duration === 'number' ? { took: tool.duration } : {}),
    },
    ...(body
      ? {
          c: [{
            id: `${id}.detail`,
            k: 'code',
            p: { text: body, lang: 'json', wrap: true },
          }],
        }
      : {}),
  };
}

function runningToolNode(tool: RunningTool, now: number): TspNode {
  return {
    id: `running.${tool.id}`,
    k: 'tool',
    p: {
      name: tool.name,
      title: toolLabel(tool.name),
      status: 'running',
      age: Math.max(0, now - tool.startedAt),
    },
  };
}

function messageNode(message: EmmaMessage, index: number): TspNode | null {
  if (message.role === 'system' || message.role === 'tool') return null;
  const content = typeof message.content === 'string' ? message.content : '';
  const id = `msg.${index}`;
  const who = message.role === 'user' ? 'You' : 'Emma';
  const children: TspNode[] = [];

  if (content) {
    children.push({
      id: `${id}.body`,
      k: 'md',
      p: { text: content },
    });
  }

  if (message.role === 'assistant') {
    for (const [toolIndex, tool] of (message.metadata?.toolCalls ?? []).entries()) {
      children.push(persistedToolNode(tool, `${id}.tool.${tool.id ?? toolIndex}`));
    }
  }

  if (children.length === 0) return null;

  return {
    id,
    k: 'card',
    p: {
      head: who,
      ...(message.role === 'user' ? { tone: 'user' } : {}),
      variant: 'bare',
    },
    c: children,
  };
}

export function renderEmmaMain(
  session: EmmaSessionLike,
  runningTools: readonly RunningTool[] = [],
  now = Date.now(),
): TspNode {
  const children: TspNode[] = [];

  for (const [index, message] of (session.messages ?? []).entries()) {
    const node = messageNode(message, index);
    if (node) children.push(node);
  }

  for (const tool of runningTools) children.push(runningToolNode(tool, now));

  if (children.length === 0) {
    children.push({
      id: 'empty',
      k: 'text',
      p: { text: 'Start a conversation with Emma.', tone: 'muted' },
    });
  }

  return {
    id: 'main',
    k: 'col',
    p: { gap: 'sm' },
    c: children,
  };
}

export function renderEmmaDock(options: {
  text: string;
  cursor: number;
  running: boolean;
  session: EmmaSessionLike;
  error?: string;
}): TspNode {
  const { text, cursor, running, session, error } = options;
  const model = session.llmModel || 'default';
  const statusSpans: Array<{ t: string; s?: string }> = [
    { t: running ? 'Working' : 'Ready', s: running ? 'accent' : 'muted' },
    { t: ' · ', s: 'dim' },
    { t: model, s: 'muted mono' },
  ];

  if (error) {
    statusSpans.push(
      { t: ' · ', s: 'dim' },
      { t: error, s: 'error' },
    );
  }

  return {
    id: 'dock',
    k: 'col',
    p: { gap: 'xs' },
    c: [
      {
        id: 'composer',
        k: 'editor',
        p: {
          text,
          cursor,
          placeholder: running ? 'Emma is working…' : 'Message Emma…',
          prompt: '›',
          sendable: !running,
          maxLines: 8,
        },
      },
      {
        id: 'status',
        k: 'status',
        p: { transparent: true },
        c: [
          {
            id: 'status.left',
            k: 'seg',
            p: { spans: statusSpans, side: 'left', priority: 10 },
          },
          {
            id: 'status.sessions',
            k: 'seg',
            p: {
              spans: [{ t: 'Sessions', s: 'muted' }],
              side: 'right',
              priority: 5,
              actions: { click: 'sessions' },
              aria: 'Open Emma sessions',
            },
          },
        ],
      },
    ],
  };
}

function firstUserMessage(session: EmmaSessionLike): string {
  const message = (session.messages ?? []).find(item => item.role === 'user' && item.content?.trim());
  return message?.content?.replace(/\s+/g, ' ').trim() ?? '';
}

function sessionLabel(session: EmmaSessionLike): string {
  return session.title?.trim() || firstUserMessage(session) || session.sessionId;
}

function sessionTime(session: EmmaSessionLike): number {
  const raw = session.updatedAt || session.createdAt;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageLabel(at: number, now = Date.now()): string {
  if (!at) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function filterSessions(
  sessions: readonly EmmaSessionLike[],
  query: string,
): EmmaSessionLike[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a));
  if (tokens.length === 0) return sorted;

  return sorted.filter(session => {
    const text = [
      session.sessionId,
      session.title,
      session.llmModel,
      session.sessionType,
      firstUserMessage(session),
    ].filter(Boolean).join(' ').toLowerCase();
    return tokens.every(token => text.includes(token));
  });
}

export function renderSessionPicker(
  picker: SessionPickerState,
  currentSessionId: string,
): TspNode {
  const visible = filterSessions(picker.sessions, picker.query);
  const selected = visible[Math.max(0, Math.min(picker.selected, visible.length - 1))];
  const items = visible.map(session => {
    const badges: Array<{ text: string; tone?: string }> = [];
    if (session.sessionId === currentSessionId) badges.push({ text: 'current', tone: 'accent' });
    if (session.sessionType === 'scheduled') badges.push({ text: 'scheduled' });

    return {
      id: session.sessionId,
      label: sessionLabel(session),
      ...(firstUserMessage(session) && session.title
        ? { detail: firstUserMessage(session) }
        : {}),
      facts: {
        when: ageLabel(sessionTime(session)),
        model: session.llmModel || 'default',
      },
      ...(badges.length ? { badges } : {}),
    };
  });

  const previewChildren: TspNode[] = [];
  if (selected) {
    previewChildren.push(
      {
        id: 'session-preview.title',
        k: 'text',
        p: { text: sessionLabel(selected), role: 'agentweb.picker.title' },
      },
      {
        id: 'session-preview.facts',
        k: 'kv',
        p: {
          items: [
            { k: 'Model', v: selected.llmModel || 'default' },
            { k: 'Type', v: selected.sessionType || 'regular' },
            { k: 'Updated', v: ageLabel(sessionTime(selected)) || 'unknown' },
          ],
        },
      },
    );

    const tail = (selected.messages ?? [])
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-4)
      .map(message => `${message.role === 'user' ? 'You' : 'Emma'}: ${message.content ?? ''}`)
      .join('\n\n')
      .trim();
    if (tail) {
      previewChildren.push({
        id: 'session-preview.transcript',
        k: 'section',
        p: { head: 'Recent conversation' },
        c: [{
          id: 'session-preview.transcript.body',
          k: 'md',
          p: { text: tail.length > 1800 ? `…${tail.slice(-1800)}` : tail },
        }],
      });
    }
  }

  return {
    id: 'layer',
    k: 'col',
    c: [{
      id: 'session-picker',
      k: 'picker',
      p: {
        title: 'Emma sessions',
        icon: 'history',
        noun: 'sessions',
        size: 'lg',
        layout: 'cards',
        preview: 'side',
        query: picker.query,
        cursor: picker.cursor,
        placeholder: 'Search Emma sessions…',
        columns: [
          { id: 'when', format: 'time' },
          { id: 'model', format: 'dim' },
        ],
        items,
        order: items.map(item => item.id),
        selected: selected?.sessionId ?? null,
        current: [currentSessionId],
        total: picker.sessions.length,
        empty: 'No Emma sessions found',
        actions: [
          { id: 'resume', label: 'Resume', keys: ['enter'], primary: true },
          { id: 'new', label: 'New session', keys: ['ctrl', 'n'] },
          { id: 'close', label: 'Close', keys: ['esc'], end: true },
        ],
        state: 'ready',
      },
      ...(previewChildren.length ? { c: previewChildren } : {}),
    }],
  };
}

export function renderEmptyLayer(): TspNode {
  return { id: 'layer', k: 'col' };
}
