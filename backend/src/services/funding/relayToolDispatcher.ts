/**
 * ENG-2113 (tool relay, backend side): executes the `tool-call` events of ONE relay turn, out of band.
 *
 * Why a class of its own. A relayed call is a request the worker is WAITING on, so it must never run inside the awaited `onEvent` of `runHostTurn` (the
 * stream would stall behind the tool, the lease renewals and a Stop would queue behind it, and two calls could not overlap). `start()` returns at once;
 * the call runs as a tracked promise and posts its own `turn.toolResult`. `settle()` lets the turn wait for them before the run is closed (A2).
 *
 * What this file guarantees (each has a test, several have a mutation check):
 *   - IDENTITY comes from the closure that built the dispatcher (connection, epoch, turn id), never from an event field. An event carries an
 *     operationId, a tool name, an input and a message id, and nothing else is read from it.
 *   - Every call goes through `ToolBridge.callTool` with the run's INTERNAL token (never sent to the worker), so the liveness check before each execution, the
 *     run's tool list, the halts, the ledger and the write confirmation are exactly the ones the HTTP path has. The dispatcher additionally refuses a name
 *     that is not in the manifest, a locked name that has not been unlocked, and a second event with an operationId it already saw.
 *   - Only `tool-call` events are executed. The stream-derived `tool-use` / `tool-result` events are informational and never reach this class.
 *   - Near the soft deadline no further tool runs ("write your final answer now"), after a Stop / revoke no further tool runs, and every operation is
 *     ANSWERED (an unanswered one holds the worker's single pending slot until the turn's deadline).
 *   - "Result lost" (the worker no longer takes the answer) is not an error of the tool: the outcome stays in the bridge ledger, the call id is remembered so the
 *     persisted tool result gets the deterministic note, and an identical retry gets the original outcome back instead of running again.
 *   - Nothing here logs a frame, an argument, a result or an image: log lines carry fixed codes and counts.
 */
import { IMAGE_LIMITS, toolImage, type ToolImage } from "../../loginHost/protocol";
import { LoginHostError, ToolResultLostError, type LoginHostClient } from "./loginHostClient";
import { ToolBridgeAuthError, stableStringify, type BridgeCallResult, type BridgeListedTool } from "./toolBridge";

export const SOFT_DEADLINE_MESSAGE = "The time limit for this turn is almost reached, so no more tools can run. Write your final answer now using what you already have.";
export const STOPPED_MESSAGE = "This turn has ended; this call was not run.";
export const NOT_IN_RUN_MESSAGE = "That tool is not available in this run.";
export const BAD_INPUT_MESSAGE = "A tool call needs an object of arguments.";
export const TOO_MANY_MESSAGE = "Too many tool calls are in progress. Wait for them to finish.";
export const CALL_CAP_MESSAGE = "This turn has made too many tool calls. Write your final answer now.";
export const DELIVERY_FAILED_MESSAGE = "The tool ran but its result could not be returned to you. Do not repeat it blindly; check its current state first or ask the user.";
/** Written into the PERSISTED tool result of a call whose result the worker could no longer take (A1): the model reads it on the next turn. */
export const RESULT_LOST_NOTE =
  "[Note: this action ran, but its result did not reach the assistant before the turn ended. It was not repeated. Check its current state before doing it again.]";
/** Prefix of the answer to an identical retry of a call whose result was lost. */
export const REPLAY_NOTE = "This identical call already ran earlier in this turn, but its result could not be delivered then. It was NOT run again. Its original result follows.\n";

/** Hard limits of what is sent to the worker for one result (the worker's own are in loginHost/protocol.ts; these stay inside them). */
const MAX_CONTENT_CHARS = 1_000_000;
const MAX_BODY_CHARS = 7 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_CALLS = 400;
const MAX_REPLAYS = 8;
const MAX_REPLAY_CHARS = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 3;
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface RelayBridgePort {
  callTool(token: string, call: { name: string; args: Record<string, unknown>; callId?: string }, runId: string, opts?: { signal?: AbortSignal }): Promise<BridgeCallResult>;
  listTools(token: string, runId: string): Promise<BridgeListedTool[]>;
  noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void;
  /** Non-clearing snapshot of the run's ledger (to learn whether a call really ran). */
  takeLedger(runId: string): { records: Array<{ toolCallId: string; kind: string }>; truncated: number };
}

export interface RelayDispatcherOptions {
  client: Pick<LoginHostClient, "turnToolResult">;
  /** From the backend's own per-turn closure. NEVER from an event. */
  ids: { connectionId: string; turnId: string; epoch: number };
  runId: string;
  /** The run's internal token: it stays in this process. */
  token: string;
  bridge: RelayBridgePort;
  /** The manifest sent to the worker: `open` names are callable from the start, `locked` ones after a result unlocked them. */
  manifest: { open: ReadonlySet<string>; locked: ReadonlySet<string> };
  /** True once a Stop, a revoke, a kill switch or a flag-off aborted the turn. */
  isStopped(): boolean;
  /** Epoch ms after which no further tool may start. */
  softDeadlineAt?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxCalls?: number;
  /** Progress hooks (the chat's "executing" statuses). Must not throw. */
  onCall?: (phase: "start" | "end", name: string) => void;
}

/** The fields of a `tool-call` event the dispatcher reads. Anything else on the event is ignored on purpose. */
export interface RelayCallEvent {
  operationId: string;
  messageId: string;
  name: string;
  input: unknown;
}

interface Answer {
  content: string;
  isError: boolean;
  images?: ToolImage[];
  unlock?: string[];
  /** For a real execution: how to remember its original text if the worker cannot take the answer. */
  replay?: { key: string; content: string };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class RelayToolDispatcher {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly seenOps = new Set<string>();
  private readonly unlocked = new Set<string>();
  private readonly lost = new Set<string>();
  private readonly replays = new Map<string, string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private calls = 0;

  constructor(private readonly o: RelayDispatcherOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
  }

  /** Calls started and not yet answered. */
  get pending(): number {
    return this.inFlight.size;
  }

  /** Ids (the operation ids, which are the bridge ledger's toolCallIds) of calls whose answer the worker could no longer take. */
  lostCallIds(): ReadonlySet<string> {
    return this.lost;
  }

  /**
   * Starts a call and returns at once. Never throws, never rejects. An operationId this dispatcher already saw is dropped (a replayed event
   * must not execute twice), and the 128-bit id the worker generates is the only identity of the call.
   */
  start(ev: RelayCallEvent): void {
    try {
      const op = ev?.operationId;
      if (typeof op !== "string" || op.length === 0) return;
      if (this.seenOps.has(op)) {
        this.log("duplicate_operation");
        return;
      }
      this.seenOps.add(op);
      const work = this.run(op, ev).catch(() => this.log("dispatch_failed"));
      this.inFlight.add(work);
      void work.finally(() => this.inFlight.delete(work));
    } catch {
      this.log("start_failed");
    }
  }

  /** Waits (bounded) for every started call to be answered, so the run can be closed with their records in the ledger. */
  async settle(timeoutMs: number): Promise<{ settled: boolean; pending: number }> {
    const end = this.now() + Math.max(0, timeoutMs);
    while (this.inFlight.size > 0) {
      const remaining = end - this.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return { settled: this.inFlight.size === 0, pending: this.inFlight.size };
  }

  // ───────────────────────────── one call ─────────────────────────────

  private async run(op: string, ev: RelayCallEvent): Promise<void> {
    const name = typeof ev.name === "string" ? ev.name : "";
    this.o.onCall?.("start", name);
    try {
      await this.deliver(op, await this.decide(op, ev, name));
    } finally {
      this.o.onCall?.("end", name);
    }
  }

  /** Runs the call (or refuses it) and returns the answer to send. */
  private async decide(op: string, ev: RelayCallEvent, name: string): Promise<Answer> {
    const refuse = (message: string): Answer => ({ content: message, isError: true });
    if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
    if (this.o.softDeadlineAt !== undefined && this.now() >= this.o.softDeadlineAt) return refuse(SOFT_DEADLINE_MESSAGE);
    if (++this.calls > (this.o.maxCalls ?? DEFAULT_MAX_CALLS)) return refuse(CALL_CAP_MESSAGE);
    if (this.inFlight.size > MAX_IN_FLIGHT) return refuse(TOO_MANY_MESSAGE);
    // The manifest is the worker's view; the bridge's current list (checked again inside callTool) is the authority. A name outside the manifest, or a locked
    // one that no accepted answer has unlocked, never reaches the bridge.
    const inManifest = this.o.manifest.open.has(name) || (this.o.manifest.locked.has(name) && this.unlocked.has(name));
    if (!inManifest) return refuse(NOT_IN_RUN_MESSAGE);
    if (!isPlainObject(ev.input)) return refuse(BAD_INPUT_MESSAGE);

    const key = `${name}\u0000${stableStringify(ev.input)}`;
    const replay = this.replays.get(key);
    if (replay !== undefined) return { content: REPLAY_NOTE + replay, isError: false };

    // The message id groups the calls of one model message (collapsing identical ones, admitting siblings of a halted preview). The host reads it from the
    // CLI's stream; anything unusable becomes a unique id, which splits groups (the safe direction).
    const messageId = typeof ev.messageId === "string" && MESSAGE_ID.test(ev.messageId) ? ev.messageId : `msg-${op}`;
    let result: BridgeCallResult;
    try {
      this.o.bridge.noteToolUse(this.o.runId, op, name, ev.input, messageId);
      result = await this.o.bridge.callTool(this.o.token, { name, args: ev.input, callId: op }, this.o.runId);
    } catch (err) {
      // A closed run (Stop, revoke, kill switch) rejects here: nothing executed.
      this.log(err instanceof ToolBridgeAuthError ? "run_ended" : "bridge_failed");
      return refuse(STOPPED_MESSAGE);
    }
    const answer: Answer = { content: result.content, isError: result.isError === true };
    if (result.images?.length) {
      const { images, dropped } = this.fitImages(result.images);
      if (images.length) answer.images = images;
      if (dropped > 0) answer.content += `\n[${dropped} image${dropped === 1 ? "" : "s"} could not be attached (unsupported, too large, or over the limit of ${IMAGE_LIMITS.maxImages}).]`;
    }
    const unlock = await this.newlyUnlocked();
    if (unlock.length) answer.unlock = unlock;
    answer.replay = { key, content: result.content };
    return answer;
  }

  private fitImages(images: Array<{ mimeType: string; data: string }>): { images: ToolImage[]; dropped: number } {
    const kept: ToolImage[] = [];
    let total = 0;
    for (const image of images) {
      const parsed = toolImage.safeParse(image);
      if (!parsed.success || kept.length >= IMAGE_LIMITS.maxImages || total + parsed.data.data.length > IMAGE_LIMITS.maxBase64Total) continue;
      kept.push(parsed.data);
      total += parsed.data.data.length;
    }
    return { images: kept, dropped: images.length - kept.length };
  }

  /** Locked manifest tools the bridge's CURRENT list now offers (a skill install), not yet unlocked. Never throws. */
  private async newlyUnlocked(): Promise<string[]> {
    const waiting = [...this.o.manifest.locked].filter((n) => !this.unlocked.has(n));
    if (waiting.length === 0) return [];
    try {
      const current = new Set((await this.o.bridge.listTools(this.o.token, this.o.runId)).map((t) => t.name));
      return waiting.filter((n) => current.has(n));
    } catch {
      return [];
    }
  }

  // ───────────────────────────── the answer ─────────────────────────────

  private async deliver(op: string, first: Answer): Promise<void> {
    const ids = this.o.ids;
    let answer = this.bound(first);
    let attempts = 0;
    let shrinks = 0;
    for (;;) {
      try {
        await this.o.client.turnToolResult({
          connectionId: ids.connectionId,
          turnId: ids.turnId,
          epoch: ids.epoch,
          operationId: op,
          content: answer.content,
          ...(answer.isError ? { isError: true } : {}),
          ...(answer.images?.length ? { images: answer.images } : {}),
          ...(answer.unlock?.length ? { unlock: answer.unlock } : {}),
        });
        for (const n of answer.unlock ?? []) this.unlocked.add(n);
        this.rememberReplay(op, answer);
        return;
      } catch (err) {
        if (err instanceof ToolResultLostError) {
          // The tool may have run. NEVER a wipe, never a retry: the outcome stays in the ledger and the persisted result gets the note.
          this.lost.add(op);
          this.rememberReplay(op, answer);
          this.log(`result_lost_${err.reason}`);
          return;
        }
        if (err instanceof LoginHostError && err.code === "EINVALID" && err.detail === "result_too_large" && shrinks < 4) {
          shrinks++;
          answer = this.shrink(answer);
          continue;
        }
        if (err instanceof LoginHostError && err.code === "EINVALID" && err.detail === "unlock_unknown_tool" && answer.unlock) {
          answer = { ...answer, unlock: undefined };
          continue;
        }
        if (err instanceof LoginHostError && err.ambiguous && ++attempts < MAX_DELIVERY_ATTEMPTS) {
          await this.sleep(300 * attempts);
          continue;
        }
        // Not deliverable at all. The worker still holds the operation open, so the model gets a plain answer instead (once), and the persisted result is noted.
        this.lost.add(op);
        this.rememberReplay(op, answer);
        this.log(err instanceof LoginHostError ? `deliver_${err.code}` : "deliver_invalid");
        if (answer.content === DELIVERY_FAILED_MESSAGE) return;
        answer = { content: DELIVERY_FAILED_MESSAGE, isError: true };
        attempts = 0;
      }
    }
  }

  /** The limits of what one answer may carry. The worker re-checks them; these keep a normal answer from ever being refused. */
  private bound(a: Answer): Answer {
    let content = a.content;
    if (content.length > MAX_CONTENT_CHARS) content = `${content.slice(0, MAX_CONTENT_CHARS)}\n[truncated: the tool's output was longer than can be returned]`;
    let images = a.images;
    let dropped = 0;
    while (images?.length && content.length + images.reduce((n, i) => n + i.data.length, 0) > MAX_BODY_CHARS) {
      images = images.slice(0, -1);
      dropped++;
    }
    if (dropped > 0) content += `\n[${dropped} image${dropped === 1 ? "" : "s"} could not be attached (too large).]`;
    return { ...a, content, images: images?.length ? images : undefined };
  }

  /** The worker refused the answer as too large: images go first, then the text is halved. */
  private shrink(a: Answer): Answer {
    if (a.images?.length) return { ...a, content: `${a.content}\n[the images could not be attached (too large).]`, images: undefined };
    return { ...a, content: `${a.content.slice(0, Math.max(1_000, Math.floor(a.content.length / 2)))}\n[truncated: the tool's output was longer than can be returned]` };
  }

  /** Remembers the original text of a call whose answer the worker could not take, so an identical retry gets it back instead of running again. */
  private rememberReplay(op: string, a: Answer): void {
    const p = a.replay;
    if (!p || !this.lost.has(op)) return;
    if (this.replays.size >= MAX_REPLAYS) return;
    // Only a call that really ran may be replayed: a refusal ("run ended", "too many") must not block a later honest retry.
    const ran = this.o.bridge.takeLedger(this.o.runId).records.some((r) => r.toolCallId === op && (r.kind === "executed" || r.kind === "failed"));
    if (ran) this.replays.set(p.key, p.content.slice(0, MAX_REPLAY_CHARS));
  }

  private log(code: string): void {
    console.error(`[relay-dispatch] ${code}`, { calls: this.calls, pending: this.inFlight.size });
  }
}
