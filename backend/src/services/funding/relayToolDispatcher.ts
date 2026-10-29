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
 *     that is not in the manifest or in the definitions an accepted answer added, and a second event with an operationId it already saw.
 *   - Only `tool-call` events are executed. The stream-derived `tool-use` / `tool-result` events are informational and never reach this class.
 *   - Near the soft deadline no further tool runs ("write your final answer now"), after a Stop / revoke no further tool runs, and every operation is
 *     ANSWERED (an unanswered one holds the worker's single pending slot until the turn's deadline).
 *   - "Result lost" (the worker no longer takes the answer) is not an error of the tool: the outcome stays in the bridge ledger, the call id is remembered so the
 *     persisted tool result gets the deterministic note, and an identical retry gets the original outcome back instead of running again.
 *   - Nothing here logs a frame, an argument, a result or an image: log lines carry fixed codes and counts.
 */
import { createHash } from "crypto";
import { IMAGE_LIMITS, toolImage, type ToolDef, type ToolImage } from "../../loginHost/protocol";
import { toToolDef } from "./relayManifest";
import { LoginHostError, ToolResultLostError, type LoginHostClient } from "./loginHostClient";
import { ToolBridgeAuthError, stableStringify, type BridgeCallResult, type BridgeListedTool } from "./toolBridge";

export const SOFT_DEADLINE_MESSAGE = "The time limit for this turn is almost reached, so no more tools can run. Write your final answer now using what you already have.";
export const STOPPED_MESSAGE = "This turn has ended; this call was not run.";
export const NOT_IN_RUN_MESSAGE = "That tool is not available in this run.";
export const BAD_INPUT_MESSAGE = "A tool call needs an object of arguments.";
export const DELIVERY_FAILED_MESSAGE = "The tool ran but its result could not be returned to you. Do not repeat it blindly; check its current state first or ask the user.";
/** Written into the PERSISTED tool result of a call whose result the worker could no longer take (A1): the model reads it on the next turn. */
export const RESULT_LOST_NOTE =
  "[Note: this action ran, but its result did not reach the assistant before the turn ended. It was not repeated. Check its current state before doing it again.]";
/** Prefix of the answer to an identical retry of a call whose result was lost. */
/** Appended to a result when a tool that became available could not be loaded for the worker: the model must not wait for it. */
export const UNLOADABLE_NOTE = "[Note: a tool that just became available could not be loaded on your Claude plan, so it cannot be used in this turn.]";
export const REPLAY_NOTE = "This identical call already ran earlier in this turn, but its result could not be delivered then. It was NOT run again. Its original result follows.\n";

/** Hard limits of what is sent to the worker for one result (the worker's own are in loginHost/protocol.ts; these stay inside them). */
/** UTF-8 BYTES of the text (the worker's caps are bytes: a multi-byte text must not slip past a character count). */
const MAX_CONTENT_BYTES = 1_000_000;
/** UTF-8 bytes of the whole serialized turn.toolResult body; the worker's cap for that route is 8 MiB. */
const MAX_BODY_BYTES = 7.5 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_CALLS = 400;
const MAX_REPLAYS = 8;
const MAX_REPLAY_BYTES = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 3;
/** Stream announcements kept per turn (oldest dropped). */
const MAX_ANNOUNCED = 512;
/** How long a call waits for the stream line that announces it (the worker can hand the call over a moment before that line). */
const DEFAULT_ANNOUNCE_WAIT_MS = 1_500;

export interface RelayBridgePort {
  callTool(token: string, call: { name: string; args: Record<string, unknown>; callId?: string }, runId: string, opts?: { signal?: AbortSignal }): Promise<BridgeCallResult>;
  listTools(token: string, runId: string): Promise<BridgeListedTool[]>;
  noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void;
  /** Closes the current call group (what a tool-result in the stream does on the HTTP path). */
  noteToolResult(runId: string): void;
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
  /** The manifest sent to the worker: the tools callable from the start. Later ones are added by `tools` in an answer (see `newTools`). */
  manifest: { open: ReadonlySet<string> };
  /** True once a Stop, a revoke, a kill switch or a flag-off aborted the turn. */
  isStopped(): boolean;
  /** Epoch ms after which no further tool may start. */
  softDeadlineAt?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxCalls?: number;
  /** Called ONCE when the worker exceeds the call cap or the in-flight limit: the caller interrupts the turn (A16). Further calls are dropped unanswered. */
  onLimitTripped?: () => void;
  /** Whether the session is waiting on a confirmation (a halt latched). Required: the relay's halt grouping depends on it. */
  isHalted: () => boolean;
  /** See DEFAULT_ANNOUNCE_WAIT_MS (tests shorten it). */
  announceWaitMs?: number;
  /** Progress hooks (the chat's "executing" statuses). Must not throw. Never called after `close()`. */
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
  /** Definitions of tools that became available because of this call (the `tools` of turn.toolResult). */
  tools?: ToolDef[];
  /** For a real execution: how to remember its original text if the worker cannot take the answer. */
  replay?: { key: string; content: string; isError: boolean };
}

/** A bounded, canonical key for a tool input (key order does not matter). */
function argKey(input: unknown): string {
  return createHash("sha256").update(stableStringify(input ?? {})).digest("hex");
}

const TRUNCATED_NOTE = "\n[truncated: the tool's output was longer than can be returned]";

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  while (out.endsWith("\ufffd")) out = out.slice(0, -1); // a cut multi-byte character
  return out;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Whether an error means "the definitions in this answer are not acceptable" (and the operation is still pending): the worker's EINVALID `tools_invalid`,
 * `tools_limit` or `tools:<reason>`, or our own client-side schema check failing on the `tools` field (the same rules, applied before the round trip).
 */
function refusesTools(err: unknown): boolean {
  if (err instanceof LoginHostError) return err.code === "EINVALID" && /^tools[_:]/.test(err.detail ?? "");
  const issues = (err as { issues?: Array<{ path?: unknown[] }> } | undefined)?.issues;
  return (err as { name?: string })?.name === "ZodError" && Array.isArray(issues) && issues.length > 0 && issues.every((i) => i.path?.[0] === "tools");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class RelayToolDispatcher {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly seenOps = new Set<string>();
  /** Names the worker has been sent (the manifest, plus definitions of answers it accepted or is being asked to accept). Case-folded, like the host. */
  private readonly sent = new Set<string>();
  private readonly sentExact = new Set<string>();
  /** Newly available tools the worker refused (or that cannot be offered): not tried again this turn, the model was told once. */
  private readonly rejected = new Set<string>();
  private readonly lost = new Set<string>();
  private readonly replays = new Map<string, { content: string; isError: boolean }>();
  /** Operations whose answer the worker ACCEPTED (the model read it). Every other executed call of the turn is "result lost". */
  private readonly delivered = new Set<string>();
  private closed = false;
  private tripped = false;
  /**
   * The model messages, as the CLI's stream announced them (B1). A stream `tool-use` is informational and never executed; it is recorded here (name, a
   * canonical form of the input) in BATCHES: consecutive tool-uses with no tool-result between them are one model message. A relayed call is grouped by
   * the announcement it matches, NOT by the worker's message id (which a worker can get wrong, or forge).
   */
  private readonly announced: Array<{ seq: number; batch: number; name: string; key: string; claimed: boolean }> = [];
  private announceSeq = 0;
  private batch = 0;
  private batchOpen = false;
  private readonly announceWaiters = new Set<() => void>();
  /** The model message of the call that latched this turn's halt, and the last announcement recorded before its answer went back. */
  private halt: { batch: number; cutoff: number } | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private calls = 0;

  constructor(private readonly o: RelayDispatcherOptions) {
    for (const n of o.manifest.open) this.markSent(n);
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

  /** Ids of calls whose answer the worker accepted. A call that executed and is NOT in here never reached the model (S1). */
  deliveredCallIds(): ReadonlySet<string> {
    return this.delivered;
  }

  /** The turn is over for the caller: no progress callback fires after this (calls still running are answered as usual). */
  close(): void {
    this.closed = true;
  }

  /**
   * Starts a call and returns at once. Never throws, never rejects. An operationId this dispatcher already saw is dropped (a replayed event
   * must not execute twice), and the 128-bit id the worker generates is the only identity of the call.
   */
  start(ev: RelayCallEvent): boolean {
    try {
      const op = ev?.operationId;
      if (typeof op !== "string" || op.length === 0) return false;
      // A worker past the limits is misbehaving: its calls are not run, not answered, not counted and not reported, and the turn is interrupted (SF2).
      // That also bounds everything kept per operation (seenOps, the caller's `uses`, pending promises and posts).
      if (this.tripped) return false;
      if (this.seenOps.has(op)) {
        this.log("duplicate_operation");
        return false;
      }
      if (this.seenOps.size >= (this.o.maxCalls ?? DEFAULT_MAX_CALLS)) return this.trip("call_cap");
      if (this.inFlight.size >= MAX_IN_FLIGHT) return this.trip("in_flight_cap");
      this.seenOps.add(op);
      this.calls++;
      const work = this.run(op, ev).catch(() => this.log("dispatch_failed"));
      this.inFlight.add(work);
      void work.finally(() => this.inFlight.delete(work));
      return true;
    } catch {
      this.log("start_failed");
      return false;
    }
  }

  /** A stream tool-use (informational). Only names of the manifest are kept; never executed, never handed to the bridge. Never throws. */
  noteStreamUse(rawName: unknown, input: unknown): void {
    try {
      if (typeof rawName !== "string") return;
      const name = rawName.replace(/^mcp__[A-Za-z0-9_-]+?__/, "");
      if (!this.inManifest(name)) return;
      if (!this.batchOpen) {
        this.batch++;
        this.batchOpen = true;
      }
      this.announced.push({ seq: ++this.announceSeq, batch: this.batch, name, key: argKey(input), claimed: false });
      if (this.announced.length > MAX_ANNOUNCED) this.announced.splice(0, this.announced.length - MAX_ANNOUNCED);
      for (const wake of [...this.announceWaiters]) wake();
    } catch {
      /* an input that cannot be serialized is simply not an announcement */
    }
  }

  /** A stream tool-result: the model message that was being announced is complete; the next tool-use starts a new one. */
  noteStreamResult(): void {
    this.batchOpen = false;
  }

  private claim(name: string, key: string): { seq: number; batch: number } | undefined {
    const hit = this.announced.find((a) => !a.claimed && a.name === name && a.key === key);
    if (!hit) return undefined;
    hit.claimed = true;
    return hit;
  }

  private async claimOrWait(name: string, key: string): Promise<{ seq: number; batch: number } | undefined> {
    const first = this.claim(name, key);
    if (first) return first;
    const waitMs = this.o.announceWaitMs ?? DEFAULT_ANNOUNCE_WAIT_MS;
    if (waitMs <= 0) return undefined;
    // A real-time bound (not the injectable deadline clock): one timer for the whole wait, each announcement re-checks the claim.
    let expired = false;
    let wakeAll: () => void = () => undefined;
    const timer = setTimeout(() => {
      expired = true;
      wakeAll();
    }, waitMs);
    timer.unref?.();
    try {
      for (;;) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.announceWaiters.delete(wake);
            resolve();
          };
          wakeAll = wake;
          this.announceWaiters.add(wake);
        });
        const hit = this.claim(name, key);
        if (hit) return hit;
        if (expired || this.o.isStopped()) return undefined;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private trip(code: string): false {
    this.tripped = true;
    this.log(code);
    try {
      this.o.onLimitTripped?.();
    } catch {
      /* the calls are dropped either way */
    }
    return false;
  }

  private markSent(name: string): void {
    this.sent.add(name.toLowerCase());
    this.sentExact.add(name);
  }

  private unmarkSent(name: string): void {
    this.sent.delete(name.toLowerCase());
    this.sentExact.delete(name);
  }

  /** The tool names the worker may call: what it was sent. */
  private inManifest(name: string): boolean {
    return this.sentExact.has(name);
  }

  private progress(phase: "start" | "end", name: string): void {
    // Only names of the manifest are ever shown to the user (a hostile worker must not be able to write arbitrary text into the progress status).
    if (this.closed || !this.inManifest(name)) return;
    try {
      this.o.onCall?.(phase, name);
    } catch {
      /* best effort */
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
    this.progress("start", name);
    try {
      let answer: Answer;
      try {
        answer = await this.decide(op, ev, name);
      } catch {
        // Something unforeseen before the tool was handed over (a hostile input that cannot be serialized, say). The operation must still be answered:
        // an unanswered one holds the worker's single pending slot until the turn's deadline.
        this.log("decide_failed");
        answer = { content: STOPPED_MESSAGE, isError: true };
      }
      await this.deliver(op, answer);
    } finally {
      this.progress("end", name);
    }
  }

  /** Runs the call (or refuses it) and returns the answer to send. */
  private async decide(op: string, ev: RelayCallEvent, name: string): Promise<Answer> {
    const refuse = (message: string): Answer => ({ content: message, isError: true });
    if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
    if (this.o.softDeadlineAt !== undefined && this.now() >= this.o.softDeadlineAt) return refuse(SOFT_DEADLINE_MESSAGE);
    // The manifest is the worker's view; the bridge's current list (checked again inside callTool) is the authority. A name the worker was never sent
    // (not in the manifest, not in the definitions of an answer) never reaches the bridge.
    if (!this.inManifest(name)) return refuse(NOT_IN_RUN_MESSAGE);
    if (!isPlainObject(ev.input)) return refuse(BAD_INPUT_MESSAGE);

    const key = `${name}\u0000${stableStringify(ev.input)}`;
    const replay = this.replays.get(key);
    if (replay !== undefined) {
      // Served only while the run is still live: a revoke (which closes the run) or a failed liveness check refuses the replay like any call.
      try {
        await this.o.bridge.listTools(this.o.token, this.o.runId);
      } catch {
        return refuse(STOPPED_MESSAGE);
      }
      if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
      return { content: REPLAY_NOTE + replay.content, isError: replay.isError };
    }

    // Grouping (B1 + SF1). A call belongs to the model message whose stream announcement it matches (name + canonical input); an unmatched call is a group
    // of its own (no collapsing, no admission next to a halt: the safe direction). Once a halt is latched, a call is placed in the halted message's group
    // ONLY if it matches an announcement of THAT message recorded BEFORE the halted answer went back: the batched confirmation AgentWeb gives (one deck
    // for "pause these 5 ad sets"). Anything else, whatever message id the worker sends, starts a new group and the bridge refuses it. A forged follow-up
    // cannot match: the stream announced the message before the answer existed (a confirm needs the approval token that only the answer carries).
    const ann = await this.claimOrWait(name, argKey(ev.input));
    if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
    let messageId: string;
    if (this.o.isHalted()) {
      const sibling = ann !== undefined && this.halt !== undefined && ann.batch === this.halt.batch && ann.seq <= this.halt.cutoff;
      if (sibling) messageId = `msg-${ann.batch}`;
      else {
        this.o.bridge.noteToolResult(this.o.runId); // closes the halted group: this call cannot join it
        messageId = `call-${op}`;
      }
    } else messageId = ann ? `msg-${ann.batch}` : `call-${op}`;
    let result: BridgeCallResult;
    try {
      this.o.bridge.noteToolUse(this.o.runId, op, name, ev.input, messageId);
      result = await this.o.bridge.callTool(this.o.token, { name, args: ev.input, callId: op }, this.o.runId);
    } catch (err) {
      // A closed run (Stop, revoke, kill switch) rejects here: nothing executed.
      this.log(err instanceof ToolBridgeAuthError ? "run_ended" : "bridge_failed");
      return refuse(STOPPED_MESSAGE);
    }
    // The first halt of the turn fixes which message's siblings may still be admitted, and which announcements count (those recorded before this answer
    // goes back). Set BEFORE the post: the worker may hand the next call over before our post returns.
    if (this.halt === undefined && this.o.isHalted()) this.halt = { batch: ann ? ann.batch : -1, cutoff: this.announceSeq };
    const answer: Answer = { content: result.content, isError: result.isError === true };
    if (result.images?.length) {
      const { images, dropped } = this.fitImages(result.images);
      if (images.length) answer.images = images;
      if (dropped > 0) answer.content += `\n[${dropped} image${dropped === 1 ? "" : "s"} could not be attached (unsupported, too large, or over the limit of ${IMAGE_LIMITS.maxImages}).]`;
    }
    // After EVERY executed call (not only install_skills): any tool the run has now that the worker was not sent travels in this answer.
    const fresh = await this.newTools();
    if (fresh.defs.length) answer.tools = fresh.defs;
    if (fresh.notes.length) answer.content += `\n${fresh.notes.join("\n")}`;
    answer.replay = { key, content: result.content, isError: answer.isError };
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

  /**
   * "Newly available" = the bridge's CURRENT tool list for the run, minus the names already sent to the worker (case-folded). The definitions are built with
   * the manifest's own rules; a tool that cannot be offered whole (bad name, oversized schema or description, a case-only duplicate) is NOT sent, stays
   * invisible to the model this turn, and the result text says so (one fixed log code with counts). Never throws.
   */
  private async newTools(): Promise<{ defs: ToolDef[]; notes: string[] }> {
    let list: BridgeListedTool[];
    try {
      list = await this.o.bridge.listTools(this.o.token, this.o.runId);
    } catch {
      return { defs: [], notes: [] };
    }
    const defs: ToolDef[] = [];
    let problems = 0;
    const pending = new Set<string>();
    for (const tool of list) {
      const name = tool?.name;
      if (typeof name !== "string" || this.sentExact.has(name) || this.rejected.has(name)) continue;
      const made = toToolDef(tool);
      const folded = typeof name === "string" ? name.toLowerCase() : "";
      if ("skip" in made || made.truncated || this.sent.has(folded) || pending.has(folded)) {
        this.rejected.add(name);
        problems++;
        continue;
      }
      pending.add(folded);
      defs.push(made.def);
    }
    if (problems > 0) this.log(`new_tool_unloadable count=${problems}`);
    return { defs, notes: problems > 0 ? [UNLOADABLE_NOTE] : [] };
  }

  // ───────────────────────────── the answer ─────────────────────────────

  private async deliver(op: string, first: Answer): Promise<void> {
    const ids = this.o.ids;
    let answer = this.bound(first);
    // S2: the worker hands new definitions to the shim BEFORE it replies to us, so a fast call to a new tool can arrive before this post resolves. The names
    // are marked first (and unmarked if the worker refuses them); the bridge still checks its CURRENT list on every call, so this grants nothing it does not.
    for (const t of answer.tools ?? []) this.markSent(t.name);
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
          ...(answer.tools?.length ? { tools: answer.tools } : {}),
        });
        this.delivered.add(op);
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
        if (answer.tools && refusesTools(err)) {
          // The worker refused the definitions (invalid, or over its cumulative caps) and kept the operation pending: answer again WITHOUT them. They are not
          // marked sent, so the model never sees them this turn, and it is told so.
          for (const t of answer.tools) {
            this.unmarkSent(t.name);
            this.rejected.add(t.name);
          }
          this.log("new_tools_refused");
          answer = { ...answer, tools: undefined, content: `${answer.content}\n${UNLOADABLE_NOTE}` };
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
        for (const t of answer.tools ?? []) this.unmarkSent(t.name);
        answer = { content: DELIVERY_FAILED_MESSAGE, isError: true };
        attempts = 0;
      }
    }
  }

  /** The limits of what one answer may carry, in BYTES of the serialized body. The worker re-checks them; these keep a normal answer from being refused. */
  private bound(a: Answer): Answer {
    let content = a.content;
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) content = `${truncateUtf8(content, MAX_CONTENT_BYTES)}${TRUNCATED_NOTE}`;
    let images = a.images;
    let dropped = 0;
    const size = () => Buffer.byteLength(JSON.stringify({ content, images, tools: a.tools, operationId: "x".repeat(64), connectionId: "x".repeat(64), turnId: "x".repeat(64), epoch: 1e9, isError: true }), "utf8");
    while (images?.length && size() > MAX_BODY_BYTES) {
      images = images.slice(0, -1);
      dropped++;
    }
    if (dropped > 0) content += `\n[${dropped} image${dropped === 1 ? "" : "s"} could not be attached (too large).]`;
    // No further text loop is needed: 1 MB of text escapes to at most 6 MB of JSON (a control character becomes \uXXXX), inside the body cap once the
    // images are gone; the worker's own `result_too_large` check is still handled by `shrink`.
    return { ...a, content, images: images?.length ? images : undefined };
  }

  /** The worker refused the answer as too large: images go first, then the text is halved. */
  private shrink(a: Answer): Answer {
    if (a.images?.length) return { ...a, content: `${a.content}\n[the images could not be attached (too large).]`, images: undefined };
    if (a.tools?.length) {
      for (const t of a.tools) {
        this.unmarkSent(t.name);
        this.rejected.add(t.name);
      }
      return { ...a, content: `${a.content}\n${UNLOADABLE_NOTE}`, tools: undefined };
    }
    return { ...a, content: `${truncateUtf8(a.content, Math.max(1_000, Math.floor(Buffer.byteLength(a.content, "utf8") / 2)))}${TRUNCATED_NOTE}` };
  }

  /** Remembers the original text of a call whose answer the worker could not take, so an identical retry gets it back instead of running again. */
  private rememberReplay(op: string, a: Answer): void {
    const p = a.replay;
    if (!p || !this.lost.has(op)) return;
    if (this.replays.size >= MAX_REPLAYS) return;
    // Only a call that really ran may be replayed: a refusal ("run ended", "too many") must not block a later honest retry.
    const ran = this.o.bridge.takeLedger(this.o.runId).records.some((r) => r.toolCallId === op && (r.kind === "executed" || r.kind === "failed"));
    if (ran) this.replays.set(p.key, { content: truncateUtf8(p.content, MAX_REPLAY_BYTES), isError: p.isError });
  }

  private log(code: string): void {
    console.error(`[relay-dispatch] ${code}`, { calls: this.calls, pending: this.inFlight.size });
  }
}
