import { findResumableUserMessage } from "../resumeSavedMessage";

const marker = () => ({ role: "assistant", content: "Continuing your last message.", metadata: { kind: "claude-plan-continue", isErrorMessage: true } });

const note = (over: Record<string, unknown> = {}) => ({ role: "assistant", content: "stopped", metadata: { kind: "claude-plan-stop", resumable: true, ...over } });
const user = (content: string, metadata?: Record<string, unknown>) => ({ role: "user", content, ...(metadata ? { metadata } : {}) });

describe("findResumableUserMessage", () => {
  it("finds the user message under a resumable plan-stop note, and under several", () => {
    expect(findResumableUserMessage([user("hi"), note()])).toEqual({ ok: true, content: "hi" });
    expect(findResumableUserMessage([{ role: "assistant", content: "earlier" }, user("hi"), note(), note()])).toEqual({ ok: true, content: "hi" });
  });

  it("a continue marker means a continue started: it is not continuable until a resumable stop note follows the marker", () => {
    expect(findResumableUserMessage([user("hi"), note(), marker()])).toEqual({ ok: false }); // the continue's own verdict was never saved
    expect(findResumableUserMessage([user("hi"), note(), marker(), note()])).toEqual({ ok: true, content: "hi" }); // it stopped again having run no tool
    expect(findResumableUserMessage([user("hi"), note(), marker(), note({ resumable: false })])).toEqual({ ok: false }); // it stopped after a tool ran
    expect(findResumableUserMessage([user("hi"), note({ resumable: false }), marker(), note()])).toEqual({ ok: false }); // an earlier turn ran a tool
    expect(findResumableUserMessage([user("hi"), note(), marker(), { role: "assistant", content: "answered" }])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi"), marker(), note()])).toEqual({ ok: true, content: "hi" }); // a marker between is skipped; the tail note decides
  });

  it("refuses when any note is not resumable, even the older one", () => {
    expect(findResumableUserMessage([user("hi"), note({ resumable: false })])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi"), note({ resumable: false }), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi"), note(), note({ resumable: undefined })])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi"), note({ resumable: "true" })])).toEqual({ ok: false });
  });

  it("refuses when the chat does not end with a plan-stop note after a plain user message", () => {
    expect(findResumableUserMessage(undefined)).toEqual({ ok: false });
    expect(findResumableUserMessage([])).toEqual({ ok: false });
    expect(findResumableUserMessage([note()])).toEqual({ ok: false }); // a note with no message under it
    expect(findResumableUserMessage([user("hi")])).toEqual({ ok: false }); // no stop at all
    expect(findResumableUserMessage([user("hi"), note(), { role: "assistant", content: "answered" }])).toEqual({ ok: false }); // the chat moved on
    expect(findResumableUserMessage([user("hi"), { role: "assistant", content: "x", metadata: { kind: "other", resumable: true } }])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi"), { role: "user", content: "x", metadata: { kind: "claude-plan-stop", resumable: true } }])).toEqual({ ok: false }); // wrong role
    expect(findResumableUserMessage([{ role: "assistant", content: "a" }, note()])).toEqual({ ok: false }); // the message under the note is not a user message
  });

  it("refuses a message that carries attachments (a continue would answer without the files), but not an empty list", () => {
    expect(findResumableUserMessage([user("hi", { attachments: [{ url: "u", filename: "f" }] }), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi", { attachments: "x" }), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi", { attachments: [] }), note()])).toEqual({ ok: true, content: "hi" });
  });

  it("refuses an automatic continuation or any other kind of user message, and an empty one", () => {
    expect(findResumableUserMessage([user("hi", { kind: "auto-continuation" }), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([user(""), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([{ role: "user", content: 5 }, note()] as never)).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi", { timestamp: "t" }), note()])).toEqual({ ok: true, content: "hi" }); // ordinary metadata is fine
  });
});
