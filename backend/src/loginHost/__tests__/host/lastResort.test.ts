/**
 * ENG-2113 (security review): the last-resort handlers. Whatever slips past the guards ends the host at once with ONE fixed-code log line (never the error's
 * message or stack, which can quote customer-controlled text), exit code 1 so `Restart=on-failure` restarts it. They never keep the process running.
 */
import { EventEmitter } from "events";
import { installLastResortHandlers } from "../../host/main";

function rig(logThrows = false) {
  const proc = new EventEmitter();
  const lines: Array<[string, unknown]> = [];
  const exits: number[] = [];
  installLastResortHandlers(
    {
      info: () => undefined,
      warn: (e, f) => {
        lines.push([e, f]);
        if (logThrows) throw new Error("log down");
      },
    },
    (c) => void exits.push(c),
    proc as unknown as Pick<NodeJS.Process, "on">,
  );
  return { proc, lines, exits };
}

describe("installLastResortHandlers", () => {
  it("MUTATION TARGET: an uncaught exception logs ONE fixed code (no message, no stack) and exits 1", () => {
    const r = rig();
    r.proc.emit("uncaughtException", new Error("Unexpected token in JSON: SECRET-CUSTOMER-TEXT"));
    expect(r.lines).toEqual([["host_uncaught_exception", undefined]]);
    expect(JSON.stringify(r.lines)).not.toContain("SECRET");
    expect(r.exits).toEqual([1]);
  });

  it("MUTATION TARGET: an unhandled rejection does the same under its own code", () => {
    const r = rig();
    r.proc.emit("unhandledRejection", new Error("SECRET"), Promise.resolve());
    expect(r.lines).toEqual([["host_unhandled_rejection", undefined]]);
    expect(r.exits).toEqual([1]);
  });

  it("MUTATION TARGET: a second failure while exiting does not log or exit again", () => {
    const r = rig();
    r.proc.emit("uncaughtException", new Error("a"));
    r.proc.emit("unhandledRejection", new Error("b"));
    r.proc.emit("uncaughtException", new Error("c"));
    expect(r.lines).toHaveLength(1);
    expect(r.exits).toEqual([1]);
  });

  it("MUTATION TARGET: a logger that throws still ends the process", () => {
    const r = rig(true);
    r.proc.emit("uncaughtException", new Error("x"));
    expect(r.exits).toEqual([1]);
  });
});
