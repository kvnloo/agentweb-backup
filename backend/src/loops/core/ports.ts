/**
 * Injected ports — the boundary between `loops/core/` and the host system.
 *
 * Every external dependency the framework needs (S3, DynamoDB, Bedrock,
 * Slack, time, logging) arrives through one of these interfaces. The host
 * application (agentweb backend) provides concrete implementations at the
 * point where the orchestrator is wired into a cron; the framework itself
 * has no knowledge of AWS SDK versions, the agentweb logger, the Slack
 * client wrapper, or any other host-specific concern.
 *
 * Why this exists: it's the constraint that makes the framework
 * open-source-ready. A consumer outside agentweb writes their own
 * implementations of these interfaces (or grabs the AWS reference impls
 * if they're on AWS too) and the framework runs unchanged. It's also what
 * makes the smoke harness possible — tests inject stub ports and the
 * orchestrator never knows.
 */

// ---------------------------------------------------------------------------
// S3 port — only the operations the framework actually needs (config
// read/write with versioning, listing bucket versions). NOT the full AWS S3
// API surface.
// ---------------------------------------------------------------------------

export interface S3GetObjectResult {
  body: string;
  versionId: string;
}

export interface S3PutObjectResult {
  versionId: string;
}

export interface S3Port {
  getObject(bucket: string, key: string): Promise<S3GetObjectResult>;
  putObject(bucket: string, key: string, body: string, contentType?: string): Promise<S3PutObjectResult>;
}

// ---------------------------------------------------------------------------
// DynamoDB port — Get/Put/Query for the framework's own tables (LoopRuns,
// LoopEvents, LoopLearning) and read-only Query for sensor implementations
// that consume DynamoDB-backed event sources.
// ---------------------------------------------------------------------------

export type DynamoAttributeValue = string | number | boolean | null | DynamoAttributeMap | readonly DynamoAttributeValue[];
export interface DynamoAttributeMap {
  readonly [key: string]: DynamoAttributeValue;
}

export interface DynamoQueryParams {
  tableName: string;
  indexName?: string;
  keyConditionExpression: string;
  filterExpression?: string;
  expressionAttributeNames?: Readonly<Record<string, string>>;
  expressionAttributeValues?: Readonly<Record<string, DynamoAttributeValue>>;
  limit?: number;
}

export interface DynamoQueryResult {
  items: readonly DynamoAttributeMap[];
  lastEvaluatedKey?: DynamoAttributeMap;
}

export interface DynamoPort {
  putItem(tableName: string, item: DynamoAttributeMap): Promise<void>;
  putItemIfAbsent?(
    tableName: string,
    item: DynamoAttributeMap,
    keyAttributes: readonly string[],
  ): Promise<boolean>;
  getItem(tableName: string, key: DynamoAttributeMap): Promise<DynamoAttributeMap | null>;
  query(params: DynamoQueryParams): Promise<DynamoQueryResult>;
}

// ---------------------------------------------------------------------------
// Bedrock port — single `invoke` operation. Implementations handle their own
// retries, inference-profile selection, and token accounting.
// ---------------------------------------------------------------------------

export interface BedrockInvocation {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Optional max output tokens. Implementations pick a sensible default. */
  maxTokens?: number;
  /** Optional images for vision models (base64-encoded). */
  imagesBase64?: readonly string[];
}

export interface BedrockResult {
  text: string;
  /** Token usage so the orchestrator can enforce per-cycle budget caps. */
  inputTokens: number;
  outputTokens: number;
  /** Dollar cost of this invocation, computed by the impl. */
  costUsd: number;
}

export interface BedrockPort {
  invoke(call: BedrockInvocation): Promise<BedrockResult>;
}

// ---------------------------------------------------------------------------
// Slack port — digest/notification operations used by loop instances.
// ---------------------------------------------------------------------------

export interface SlackMessageHandle {
  channel: string;
  ts: string;
}

export interface SlackPort {
  /** Send a DM or channel message. */
  postMessage(channelOrUserId: string, markdown: string): Promise<SlackMessageHandle>;
}

// ---------------------------------------------------------------------------
// Clock port — abstracts `Date.now()` so the smoke harness can fast-forward
// time without monkey-patching globals.
// ---------------------------------------------------------------------------

export interface ClockPort {
  now(): Date;
}

// ---------------------------------------------------------------------------
// Logger port — minimal structured-logging interface. Implementations
// forward to whatever the host uses (console, pino, AWS CloudWatch, etc.).
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Readonly<Record<string, unknown>>;

export interface LoggerPort {
  log(level: LogLevel, message: string, context?: LogContext): void;
}

// ---------------------------------------------------------------------------
// LoopPorts — convenience bundle the orchestrator accepts.
// ---------------------------------------------------------------------------

export interface LoopPorts {
  s3: S3Port;
  dynamo: DynamoPort;
  bedrock: BedrockPort;
  slack: SlackPort;
  clock: ClockPort;
  logger: LoggerPort;
}
