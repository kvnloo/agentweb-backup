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
  messages?: EmmaMessage[];
}

export interface RunningTool {
  id: string;
  name: string;
  startedAt: number;
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
        c: [{
          id: 'status.left',
          k: 'seg',
          p: { spans: statusSpans, side: 'left', priority: 10 },
        }],
      },
    ],
  };
}
