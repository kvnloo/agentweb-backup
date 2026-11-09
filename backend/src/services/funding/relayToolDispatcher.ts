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
import { LogThrottle, approxJsonBytes } from "../../loginHost/relay/bounds";
import { IMAGE_LIMITS, RELAY_RESULT_MAX_BYTES, toolImage, type ToolDef, type ToolImage } from "../../loginHost/protocol";
import { MAX_NAMES_PER_REASON, toToolDef, toolNote, type ToolNote } from "./relayManifest";
import { safeText } from "./logSafe";
import { LoginHostError, ToolResultLostError, type LoginHostClient } from "./loginHostClient";
import { ToolBridgeAuthError, stableStringify, type BridgeCallResult, type BridgeListedTool } from "./toolBridge";

export const SOFT_DEADLINE_MESSAGE = "The time limit for this turn is almost reached, so no more tools can run. Write your final answer now using what you already have.";
export const STOPPED_MESSAGE = "This turn has ended; this call was not run.";
export const NOT_IN_RUN_MESSAGE = "That tool is not available in this run.";
export const BAD_INPUT_MESSAGE = "A tool call needs an object of arguments.";
/** What a call gets after a halt (the same words the bridge uses). */
export const HALTED_MESSAGE = "This conversation is waiting for the user to confirm an earlier action. No tool can run until the user replies. Stop here and ask the user to confirm.";
export const ARGS_TOO_LARGE_MESSAGE = "The arguments of this call are too large to be processed. The tool was not run; send a smaller request.";
/** The tool ran but the answer could not be prepared (an internal failure after the bridge returned). */
export const RAN_NOT_PREPARED_MESSAGE = "The tool ran, but its result could not be prepared. Do not repeat it blindly; check its current state first or ask the user.";
/** A write whose answer was lost and whose identical retry must not run again (the replay table may no longer hold its result). */
export const ALREADY_RAN_MESSAGE = "This identical action already ran earlier in this turn, but its result could not be returned. It was NOT run again. Check its current state before doing it again.";
export const BAD_ARGS_MESSAGE = "The arguments of this call could not be read (they are nested too deeply). The tool was not run.";
export const DELIVERY_FAILED_MESSAGE = "The tool ran but its result could not be returned to you. Do not repeat it blindly; check its current state first or ask the user.";
/** Written into the PERSISTED tool result of a call whose result the worker could no longer take (A1): the model reads it on the next turn. */
export const RESULT_LOST_NOTE =
  "[Note: this action ran, but its result did not reach the assistant before the turn ended. It was not repeated. Check its current state before doing it again.]";
/** Appended to a result when a tool that became available could not be loaded for the worker: the model must not wait for it. */
export const UNLOADABLE_NOTE = "[Note: a tool that just became available could not be loaded on your Claude plan, so it cannot be used in this turn.]";
/** Prefix of the answer to an identical retry of a call whose result was lost. */
export const REPLAY_NOTE = "This identical call already ran earlier in this turn, but its result could not be delivered then. It was NOT run again. Its original result follows.\n";

/** Hard limits of what is sent to the worker for one result (the worker's own are in loginHost/protocol.ts; these stay inside them). Documented in docs/plan-route-tool-limits.md.
 * The text of a result is held to RELAY_RESULT_MAX_BYTES (loginHost/protocol.ts, prod parity with MAX_TOOL_CONTENT_SIZE = 300,000 characters in agentModeService.ts:375;
 * here in UTF-8 BYTES, so a multi-byte text is cut earlier, never later). The CLI's own output limit is derived from the same constant (relayCliEnv). */
/** UTF-8 bytes of the whole serialized turn.toolResult body; the worker's cap for that route is 8 MiB. */
const MAX_BODY_BYTES = 7.5 * 1024 * 1024;
const MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_CALLS = 400;
const MAX_REPLAYS = 8;
const MAX_REPLAY_BYTES = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 3;
/** Stream announcements kept per turn (oldest dropped). */
const MAX_ANNOUNCED = 512;
/**
 * Work bounds on data the worker controls (a stream tool-use costs a canonicalization + a hash; measured: 67 ms for a 700 KB object, 95 ms for a 1 MB array, so
 * ~100 events/s would pin the API server's event loop).
 *  - at most MAX_ANNOUNCEMENTS_PER_TURN announcements are recorded per turn (a turn is capped at 400 calls); later stream events are ignored;
 *  - one input larger than ANNOUNCE_HASH_MAX_INPUT is never hashed: it is recorded by name only, like the host's truncation marker;
 *  - the inputs hashed in a turn add up to at most ANNOUNCE_BUDGET_BYTES (about 8 MB, roughly 0.1 s of work); after that stream events are ignored.
 * An ignored or name-only announcement never matches a call by content: the call runs unannounced (its own group; refused after a halt): the safe direction.
 */
const MAX_ANNOUNCEMENTS_PER_TURN = 1_024;
const ANNOUNCE_HASH_MAX_INPUT = 64 * 1024;
const ANNOUNCE_BUDGET_BYTES = 8 * 1024 * 1024;
/**
 * A tool call's arguments are canonicalized (stringify + hash) before they run. One argument over CALL_INPUT_MAX_BYTES is refused unread (700 KB cost ~350 ms
 * of synchronous work); the larger inputs of a turn add up to at most CALL_INPUT_BUDGET_BYTES, after which only inputs up to SMALL_INPUT_BYTES are accepted.
 * 256 KiB is about 60,000 words in one argument: far above any real tool call (the registry's largest SCHEMA is 15 KB and the host already caps a call
 * at 1 MiB and 32 levels); a measurement of real call sizes is not possible from the registry, so this is a judgment, flagged in the fragment.
 */
// Documented for tool authors in docs/plan-route-tool-limits.md: change it there too.
const CALL_INPUT_MAX_BYTES = 256 * 1024;
const CALL_INPUT_BUDGET_BYTES = 2 * 1024 * 1024;
const SMALL_INPUT_BYTES = 16 * 1024;
/** How long a call waits for the stream line that announces it (the worker can hand the call over a moment before that line). */
const DEFAULT_ANNOUNCE_WAIT_MS = 1_500;

export interface RelayBridgePort {
  callTool(token: string, call: { name: string; args: Record<string, unknown>; callId?: string }, runId: string, opts?: { signal?: AbortSignal }): Promise<BridgeCallResult>;
  listTools(token: string, runId: string): Promise<BridgeListedTool[]>;
  noteToolUse(runId: string, callId: string, name: string, input: unknown, messageId?: string): void;
  /** Non-clearing snapshot of the run's ledger (to learn whether a call really ran). */
  takeLedger(runId: string): { records: Array<{ toolCallId: string; kind: string }>; truncated: number };
  /** Whether the call really ran (not refused), from the bridge's own bookkeeping, which does not depend on the persisted record surviving the ledger's caps. */
  ranCall?(runId: string, callId: string): boolean;
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
  /**
   * True once a Stop, a revoke or a shutdown aborted the turn (the run's abort signal). A kill switch or a flag-off does NOT set it: `ClaudeRunRegistry.cancelOwner` has
   * no caller today, and a flag turned off is seen by the bridge's liveness check instead: a WRITE is refused at once (the check is read fresh for writes), READS go on
   * until the turn ends, for up to about 65 s (the flags are cached for 60 s and a positive read check for 5 s).
   */
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
  /** Whether THIS call is the one whose result carries the confirmation request (the bridge recorded a halt for it). */
  isHaltingCall: (operationId: string) => boolean;
  /** See DEFAULT_ANNOUNCE_WAIT_MS (tests shorten it). */
  announceWaitMs?: number;
  /**
   * Batched confirmations (one deck for every preview of a model message). FALSE (the default, and the production setting): after a halt EVERY call is refused
   * here, never announced to the bridge. Why: the announcements come from the worker's stream, so a compromised worker could announce its own "sibling" (a name and
   * an input) and have it run after the halt, relying only on that tool's own approval token; and approval cards do not exist yet, so batching buys nothing
   * (the first confirmation ends the turn's tool work either way). The code path stays for the approval-cards change, which sets this to true.
   */
  admitPostHaltSiblings?: boolean;
  /** Progress hooks (the chat's "executing" statuses). Must not throw. The caller drops them once its turn is over (`turnOver` in claudeCodeBackend.ts). */
  onCall?: (phase: "start" | "end", name: string) => void;
}

/** The fields of a `tool-call` event the dispatcher reads. Anything else on the event is ignored on purpose. */
export interface RelayCallEvent {
  operationId: string;
  messageId: string;
  name: string;
  input: unknown;
  /** Set by the stream reader when the call's input was too big to be read at all (`input` is then null): the call is answered with ARGS_TOO_LARGE_MESSAGE. */
  inputTooLarge?: boolean;
}

/** The parsed input of one call, held ONLY while the call is being decided and cleared as soon as it has been used (see `start`). */
interface CallInput {
  input: unknown;
  tooLarge: boolean;
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

/** What one call has done so far (a record per call, never shared between concurrent calls). */
interface CallState {
  /** The bridge's `callTool` returned: the tool ran (or was refused by the bridge). */
  executed: boolean;
  key?: string;
  content?: string;
  isError?: boolean;
}

/** The fixed stand-in the host forwards for a stream input nested deeper than 32 levels or larger than 1 MiB (loginHost/relay/bounds.ts `boundedValue`). */
function isTruncationMarker(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const t = (v as { _truncated?: unknown })._truncated;
  return keys.length === 1 && keys[0] === "_truncated" && (t === "depth" || t === "size");
}

/** A bounded, canonical key for a tool input (key order does not matter). */
function argKey(input: unknown): string {
  return digestOf(stableStringify(input ?? {}));
}
function digestOf(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
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
  /** Keys are `name\0sha256(canonical input)`: small, whatever the input. */
  private readonly replays = new Map<string, { content: string; isError: boolean }>();
  /** Every non-read-only call whose answer was lost (at most one per call, so at most the call cap): an identical retry is refused, never run again. */
  private readonly lostWrites = new Set<string>();
  private announceCount = 0;
  private hashedBytes = 0;
  private inputBudget = CALL_INPUT_BUDGET_BYTES;
  private readonly throttle = new LogThrottle(5, 60_000);
  /** Operations whose answer the worker ACCEPTED (the model read it). Every other executed call of the turn is "result lost". */
  private readonly delivered = new Set<string>();
  private defsLock: Promise<void> = Promise.resolve();
  /**
   * The id the BRIDGE (and so the persisted chat and the replay logic) knows a call by: made here, never the worker's operation id (a compromised worker picks
   * that). `tc_<12 hex of a hash of the run id>_<n>`: at most 24 characters, only [A-Za-z0-9_], unique across the turns of a session (every turn has its own run id).
   */
  private readonly callIds = new Map<string, string>();
  private idPrefix: string | undefined;
  private cid(op: string): string {
    let id = this.callIds.get(op);
    if (id === undefined) {
      this.idPrefix ??= `tc_${createHash("sha256").update(this.o.runId).digest("hex").slice(0, 12)}_`;
      id = `${this.idPrefix}${this.callIds.size + 1}`;
      this.callIds.set(op, id);
    }
    return id;
  }
  private execTail: Promise<void> = Promise.resolve();
  /** Aborts every answer post still in flight when `close()` ends the turn (after `settle` has given them their window: a Stop or a tripped limit also ends in `settle` then `close`), so a worker that never finishes a reply cannot pin a call. */
  private readonly posts = new AbortController();
  /** The worker's final `result` has arrived: no further call starts (calls already running finish). */
  private resultSeen = false;
  private closed = false;
  private tripped = false;
  /**
   * The model messages, as the CLI's stream announced them (B1). A stream `tool-use` is informational and never executed; it is recorded here (name, a
   * canonical form of the input) in BATCHES: consecutive tool-uses with no tool-result between them are one model message. A relayed call is grouped by
   * the announcement it matches, NOT by the worker's message id (which a worker can get wrong, or forge).
   */
  private readonly announced: Array<{ seq: number; batch: number; name: string; key: string; claimed: boolean; marker?: true }> = [];
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

  /** Ids (the backend-made call ids, which are the bridge ledger's toolCallIds) of calls whose answer the worker could no longer take. */
  lostCallIds(): ReadonlySet<string> {
    return this.lost;
  }

  /** Ids of calls whose answer the worker accepted. A call that executed and is NOT in here never reached the model (S1). */
  deliveredCallIds(): ReadonlySet<string> {
    return this.delivered;
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
      // The dispatcher takes ownership of the (possibly large) parsed input: it is moved off the event, used by `decide`, and dropped. A call whose answer is still
      // being posted (a worker that never finishes the reply) must not keep megabytes of input alive: 16 such calls held ~500 MB.
      const box: CallInput = { input: ev.input, tooLarge: ev.inputTooLarge === true };
      try {
        ev.input = undefined;
      } catch {
        /* a frozen event: nothing to drop */
      }
      const work = this.run(op, ev, box).catch(() => this.log("dispatch_failed"));
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
      if (this.announceCount >= MAX_ANNOUNCEMENTS_PER_TURN) return; // work bound: later stream events are ignored (see the constants)
      if (!this.batchOpen) {
        this.batch++;
        this.batchOpen = true;
      }
      // The host replaces a stream input that is too deep or too large with a fixed marker. A marker says "a call of this tool was announced" and nothing
      // about its arguments, so it can NEVER be matched to a real call by content (a real call whose arguments look exactly like the marker included):
      // it carries no key, and is only consumed by a call that found no exact announcement (which then runs in a group of its own).
      const size = approxJsonBytes(input, ANNOUNCE_HASH_MAX_INPUT + 1); // iterative and bounded: never walks more than it will hash
      if (isTruncationMarker(input) || size > ANNOUNCE_HASH_MAX_INPUT) {
        this.announceCount++;
        this.announced.push({ seq: ++this.announceSeq, batch: this.batch, name, key: "", claimed: false, marker: true });
      } else {
        if (this.hashedBytes + size > ANNOUNCE_BUDGET_BYTES) return; // budget spent: ignored
        this.hashedBytes += size;
        this.announceCount++;
        this.announced.push({ seq: ++this.announceSeq, batch: this.batch, name, key: argKey(input), claimed: false });
      }
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
    // No exact announcement. If the stream announced a call of this tool with a truncated input, this is probably it: do not wait for an announcement that
    // will never match, and do not group it (its own group: after a halt it is refused, never admitted on a guess).
    const marker = this.announced.find((a) => !a.claimed && a.marker === true && a.name === name);
    if (marker) {
      marker.claimed = true;
      return undefined;
    }
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
    if (!this.inManifest(name)) return;
    try {
      this.o.onCall?.(phase, name);
    } catch {
      /* best effort */
    }
  }

  /** The `result` event arrived: the turn is over, so a tool-call that follows it (the stream stays open) is refused, not run. */
  noteResult(): void {
    this.resultSeen = true;
  }

  /**
   * Ends the dispatcher: posts still in flight are aborted (their calls are recorded as lost), no further call starts, and the sets that only matter while calls run
   * are released. Safe to call more than once. Call it after `settle`.
   */
  close(): void {
    this.closed = true;
    this.posts.abort();
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

  private async run(op: string, ev: RelayCallEvent, box: CallInput): Promise<void> {
    const name = typeof ev.name === "string" ? ev.name : "";
    this.progress("start", name);
    try {
      let answer: Answer;
      const st: CallState = { executed: false };
      try {
        answer = await this.decide(op, box, name, st);
        box.input = undefined;
      } catch {
        box.input = undefined;
        // Something unforeseen. The operation must still be answered: an unanswered one holds the worker's single pending slot until the turn's deadline.
        if (!st.executed) {
          // Before the bridge was called nothing ran (a hostile input that cannot be serialized, say).
          this.log("decide_failed");
          answer = { content: STOPPED_MESSAGE, isError: true };
        } else {
          // AFTER the bridge returned: the tool ran. Never say "not run" (the model would repeat a write). Treat it like a lost result: the persisted result
          // is noted, the outcome is remembered so an identical retry is answered from it or refused, never run again.
          this.log("decide_failed_after_run");
          this.lost.add(this.cid(op));
          if (st.key !== undefined) {
            this.lostWrites.add(st.key); // its kind is unknown here: treated as a write
            if (this.replays.size < MAX_REPLAYS && st.content !== undefined) this.replays.set(st.key, { content: truncateUtf8(st.content, MAX_REPLAY_BYTES), isError: st.isError === true });
          }
          answer = { content: RAN_NOT_PREPARED_MESSAGE, isError: true };
        }
      }
      await this.deliver(op, answer);
    } finally {
      this.progress("end", name);
    }
  }

  /** Runs the call (or refuses it) and returns the answer to send. */
  private async decide(op: string, box: CallInput, name: string, st: CallState): Promise<Answer> {
    const refuse = (message: string): Answer => ({ content: message, isError: true });
    // The turn is over (a `result` has arrived, or the dispatcher was closed): no further call starts. Calls already running finish and are answered.
    if (this.resultSeen || this.closed) return refuse(STOPPED_MESSAGE);
    if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
    if (this.o.softDeadlineAt !== undefined && this.now() >= this.o.softDeadlineAt) return refuse(SOFT_DEADLINE_MESSAGE);
    // After a halt nothing else runs (see `admitPostHaltSiblings`): refused here, without being announced to the bridge.
    if (this.o.admitPostHaltSiblings !== true && this.o.isHalted()) return refuse(HALTED_MESSAGE);
    // The manifest is the worker's view; the bridge's current list (checked again inside callTool) is the authority. A name the worker was never sent
    // (not in the manifest, not in the definitions of an answer) never reaches the bridge.
    if (!this.inManifest(name)) return refuse(NOT_IN_RUN_MESSAGE);
    if (box.tooLarge) return refuse(ARGS_TOO_LARGE_MESSAGE);
    if (!isPlainObject(box.input)) return refuse(BAD_INPUT_MESSAGE);
    const input = box.input as Record<string, unknown>;

    // Work bound before anything is serialized: the size is estimated iteratively and capped.
    const inputSize = approxJsonBytes(input, CALL_INPUT_MAX_BYTES + 1);
    if (inputSize > CALL_INPUT_MAX_BYTES) return refuse(ARGS_TOO_LARGE_MESSAGE);
    if (inputSize > SMALL_INPUT_BYTES) {
      if (inputSize > this.inputBudget) return refuse(ARGS_TOO_LARGE_MESSAGE);
      this.inputBudget -= inputSize;
    }
    let key: string;
    let argsKey: string;
    try {
      argsKey = digestOf(stableStringify(input)); // one canonicalization serves the replay key and the announcement match
      key = `${name}\u0000${argsKey}`;
    } catch {
      return refuse(BAD_ARGS_MESSAGE); // input that cannot be canonicalized (absurd nesting, say): nothing ran, and the model is told why
    }
    st.key = key;
    const replay = this.replays.get(key);
    if (replay === undefined && this.lostWrites.has(key)) return refuse(ALREADY_RAN_MESSAGE); // its result is no longer held: still never run a second time
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
    // S9 (the default): after a halt NOTHING else runs. The calls are executed ONE AT A TIME, the halt check made again when a call's turn comes: calls that
    // arrive in the same tick would otherwise all pass the check before the first one (the confirm-needed one) has halted. The shim already serializes parallel
    // reads (S4), so this costs nothing real. The stream announcement is still matched, but in this mode ONLY so the bridge can collapse an identical call of the
    // same model message (as Emma does): after a halt no call is announced to the bridge at all, so a group can never be used to admit one.
    const strict = this.o.admitPostHaltSiblings !== true;
    const ann = await this.claimOrWait(name, argsKey);
    if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
    const release = strict ? await this.acquireExec() : undefined;
    let result: BridgeCallResult;
    try {
      if (strict) {
        if (this.o.isStopped()) return refuse(STOPPED_MESSAGE);
        if (this.o.softDeadlineAt !== undefined && this.now() >= this.o.softDeadlineAt) return refuse(SOFT_DEADLINE_MESSAGE);
        if (this.o.isHalted()) return refuse(HALTED_MESSAGE);
      }
      // After a halt a call that is not an announced sibling of the halted message is NOT announced to the bridge at all (neither `noteToolUse` nor a group
      // close): the bridge admits only announced siblings, so it refuses this call, and the halted group's cursor is left alone, so the REAL siblings that follow
      // (a call whose stream input was truncated falls in here) are still admitted: the batch stays usable.
      const halted = this.o.isHalted();
      const sibling = halted && ann !== undefined && this.halt !== undefined && ann.batch === this.halt.batch && ann.seq <= this.halt.cutoff;
      const announce = !halted || sibling;
      const messageId = sibling ? `msg-${ann!.batch}` : !halted && ann ? `msg-${ann.batch}` : `call-${this.cid(op)}`;
      try {
        if (announce) this.o.bridge.noteToolUse(this.o.runId, this.cid(op), name, input, messageId);
        result = await this.o.bridge.callTool(this.o.token, { name, args: input, callId: this.cid(op) }, this.o.runId);
      } catch (err) {
        // A closed run (Stop, revoke, shutdown) rejects here: nothing executed. A flag-off or kill switch does not close the run: the bridge's liveness check refuses the call.
        this.log(err instanceof ToolBridgeAuthError ? "run_ended" : "bridge_failed");
        return refuse(STOPPED_MESSAGE);
      }
      st.executed = true; // from here on the tool has run: an unforeseen throw must not be reported as "not run"
      st.content = result.content;
      st.isError = result.isError === true;
      // The first halt of the turn fixes which message's siblings may still be admitted, and which announcements count (those recorded before this answer
      // goes back). Set BEFORE the post, and before the next call's turn: the worker may hand the next call over before our post returns.
      if (this.halt === undefined && this.o.isHaltingCall(this.cid(op))) this.halt = { batch: ann ? ann.batch : -1, cutoff: this.announceSeq };
    } finally {
      release?.();
    }
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
    // A lost answer is replayed to an identical retry only for a tool that may have changed something (a write, or one whose kind is unknown): re-running a
    // READ-ONLY tool is harmless and returns current data, a replay would hand the model stale data for the rest of the turn.
    if (fresh.readOnly.get(name) !== true) answer.replay = { key, content: result.content, isError: answer.isError };
    return answer;
  }

  /** Serializes the executing phase of calls (see `strict` in `decide`). */
  private async acquireExec(): Promise<() => void> {
    const prev = this.execTail;
    let release: () => void = () => undefined;
    this.execTail = new Promise<void>((resolve) => (release = resolve));
    await prev;
    return release;
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
  private async newTools(): Promise<{ defs: ToolDef[]; notes: string[]; readOnly: Map<string, boolean> }> {
    // Serialized (N3): two calls finishing together must not both pick the same new tools, and the "sent" marks must be exact. The names are marked sent
    // INSIDE the lock; `deliver` unmarks them if the worker refuses.
    const run = this.defsLock.then(() => this.computeNewTools());
    this.defsLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async computeNewTools(): Promise<{ defs: ToolDef[]; notes: string[]; readOnly: Map<string, boolean> }> {
    const readOnly = new Map<string, boolean>();
    let list: BridgeListedTool[];
    try {
      list = await this.o.bridge.listTools(this.o.token, this.o.runId);
    } catch {
      return { defs: [], notes: [], readOnly };
    }
    const defs: ToolDef[] = [];
    let problems = 0;
    const named: Array<ToolNote & { why: string }> = [];
    for (const tool of list) {
      const name = tool?.name;
      if (typeof name !== "string") continue;
      readOnly.set(name, tool.readOnly === true);
      if (this.sentExact.has(name) || this.rejected.has(name)) continue;
      const made = toToolDef(tool);
      if ("skip" in made || made.truncated || this.sent.has(name.toLowerCase())) {
        this.rejected.add(name);
        problems++;
        if (named.length < MAX_NAMES_PER_REASON) named.push({ ...toolNote(tool), why: "skip" in made ? made.skip : made.truncated ? "description_truncated" : "duplicate" });
        continue;
      }
      this.markSent(name); // also makes a later case-only duplicate in this same list a "sent" duplicate
      defs.push(made.def);
    }
    // A tool that became available mid-turn (a skill install) and cannot be offered: named (sanitized, at most MAX_NAMES_PER_REASON) with the sizes that mattered.
    if (problems > 0) this.log("new_tool_unloadable", { count: problems, tools: named });
    return { defs, notes: problems > 0 ? [UNLOADABLE_NOTE] : [], readOnly };
  }

  // ───────────────────────────── the answer ─────────────────────────────

  private async deliver(op: string, first: Answer): Promise<void> {
    const ids = this.o.ids;
    let answer = this.bound(first);
    // S2: the worker hands new definitions to the shim BEFORE it replies to us, so a fast call to a new tool can arrive before this post resolves. The names
    // were marked sent when they were picked (in `newTools`, under its lock) and are unmarked if the worker refuses them; the bridge still checks its
    // CURRENT list on every call, so this grants nothing it does not.
    let attempts = 0;
    let shrinks = 0;
    let budgetShrunk = false;
    for (;;) {
      // The turn is over (Stop, limit, settled, closed): no new post, and one in flight was aborted. The tool ran, so the persisted result says its answer was not delivered.
      if (this.posts.signal.aborted) return this.abandon(op, answer);
      try {
        await this.untilAborted(
          this.o.client.turnToolResult(
            {
              connectionId: ids.connectionId,
              turnId: ids.turnId,
              epoch: ids.epoch,
              operationId: op,
              content: answer.content,
              ...(answer.isError ? { isError: true } : {}),
              ...(answer.images?.length ? { images: answer.images } : {}),
              ...(answer.tools?.length ? { tools: answer.tools } : {}),
            },
            { signal: this.posts.signal },
          ),
        );
        // N2: an operation that was first reported lost and then answered with the plain "could not be returned" text did NOT deliver its real result.
        if (!this.lost.has(this.cid(op))) this.delivered.add(this.cid(op));
        this.rememberReplay(op, answer);
        return;
      } catch (err) {
        if (this.posts.signal.aborted) return this.abandon(op, answer);
        if (err instanceof ToolResultLostError) {
          // The tool may have run. NEVER a wipe, never a retry: the outcome stays in the ledger and the persisted result gets the note.
          this.lost.add(this.cid(op));
          this.rememberReplay(op, answer);
          this.log(`result_lost_${err.reason}`);
          return;
        }
        if (err instanceof LoginHostError && err.code === "EINVALID" && err.detail === "result_too_large" && shrinks < 4) {
          shrinks++;
          answer = this.shrink(answer);
          continue;
        }
        if (err instanceof LoginHostError && err.code === "EINVALID" && err.detail === "result_budget") {
          // The worker's per-turn budget of answered bytes is spent: the operation is still pending. The tool ran, so the persisted result is noted (lost); one smaller
          // answer is tried (it may fit what is left of the budget), then the plain failure text (a few bytes), which the generic path below sends and never repeats.
          this.lost.add(this.cid(op));
          this.rememberReplay(op, answer);
          this.log("deliver_result_budget");
          if (!budgetShrunk && answer.content !== DELIVERY_FAILED_MESSAGE) {
            budgetShrunk = true;
            answer = this.shrink(answer);
            continue;
          }
          if (answer.content === DELIVERY_FAILED_MESSAGE) return;
          for (const t of answer.tools ?? []) this.unmarkSent(t.name);
          answer = { content: DELIVERY_FAILED_MESSAGE, isError: true };
          attempts = 0;
          continue;
        }
        if (answer.tools && refusesTools(err)) {
          // The worker refused the definitions (invalid, or over its cumulative caps) and kept the operation pending: answer again WITHOUT them. They are not
          // marked sent, so the model never sees them this turn, and it is told so.
          for (const t of answer.tools) {
            this.unmarkSent(t.name);
            this.rejected.add(t.name);
          }
          this.log("new_tools_refused", { count: answer.tools.length, reason: safeText(err instanceof LoginHostError ? `${err.code}/${err.detail ?? ""}` : "other", 120), tools: this.namedDefs(answer.tools) });
          answer = { ...answer, tools: undefined, content: `${answer.content}\n${UNLOADABLE_NOTE}` };
          continue;
        }
        if (err instanceof LoginHostError && err.ambiguous && ++attempts < MAX_DELIVERY_ATTEMPTS) {
          await this.sleep(300 * attempts);
          continue;
        }
        // Not deliverable at all. The worker still holds the operation open, so the model gets a plain answer instead (once), and the persisted result is noted.
        this.lost.add(this.cid(op));
        this.rememberReplay(op, answer);
        this.log(err instanceof LoginHostError ? `deliver_${err.code}` : "deliver_invalid");
        if (answer.content === DELIVERY_FAILED_MESSAGE) return;
        for (const t of answer.tools ?? []) this.unmarkSent(t.name);
        answer = { content: DELIVERY_FAILED_MESSAGE, isError: true };
        attempts = 0;
      }
    }
  }

  /** Resolves with `p`, or rejects as soon as the posts are aborted (whether or not the client honours the signal: a hung post must not hold its call). */
  private untilAborted<T>(p: Promise<T>): Promise<T> {
    const signal = this.posts.signal;
    if (signal.aborted) {
      void p.catch(() => undefined);
      return Promise.reject(new Error("aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  /** A post that was aborted with the turn: the answer did not reach the worker. */
  private abandon(op: string, answer: Answer): void {
    this.lost.add(this.cid(op));
    this.rememberReplay(op, answer);
    this.log("deliver_aborted");
  }

  /** The limits of what one answer may carry, in BYTES of the serialized body. The worker re-checks them; these keep a normal answer from being refused. */
  private bound(a: Answer): Answer {
    let content = a.content;
    // The note is part of the budget: text + note never exceed RELAY_RESULT_MAX_BYTES (the CLI's limit is derived from it).
    if (Buffer.byteLength(content, "utf8") > RELAY_RESULT_MAX_BYTES) content = `${truncateUtf8(content, RELAY_RESULT_MAX_BYTES - Buffer.byteLength(TRUNCATED_NOTE, "utf8"))}${TRUNCATED_NOTE}`;
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
      this.log("new_tools_refused", { count: a.tools.length, reason: "result_too_large", tools: this.namedDefs(a.tools) });
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
    if (!p || !this.lost.has(this.cid(op))) return;
    // Only a call that really ran may be remembered: a refusal ("run ended", "too many") must not block a later honest retry.
    const ran = this.o.bridge.ranCall
      ? this.o.bridge.ranCall(this.o.runId, this.cid(op))
      : this.o.bridge.takeLedger(this.o.runId).records.some((r) => r.toolCallId === this.cid(op) && (r.kind === "executed" || r.kind === "failed"));
    if (!ran) return;
    this.lostWrites.add(p.key); // a digest only: a write is never run twice, however many answers were lost
    if (this.replays.size < MAX_REPLAYS) this.replays.set(p.key, { content: truncateUtf8(p.content, MAX_REPLAY_BYTES), isError: p.isError });
  }

  /** A fixed code per line (`extra` carries only counts). Throttled per code: a worker can trigger most of these at will, one line per event would flood the log. */
  private log(code: string, extra: Record<string, unknown> = {}): void {
    const t = this.throttle.check(code);
    if (!t.log) return;
    console.error(`[relay-dispatch] ${code}`, { calls: this.calls, pending: this.inFlight.size, run: this.o.runId, ...extra, ...(t.suppressedBefore > 0 ? { suppressedBefore: t.suppressedBefore } : {}) });
  }

  /** The definitions of an answer, as log notes (names made safe, sizes only; at most MAX_NAMES_PER_REASON). */
  private namedDefs(defs: readonly ToolDef[]): ToolNote[] {
    return defs.slice(0, MAX_NAMES_PER_REASON).map((d) => toolNote(d));
  }
}
