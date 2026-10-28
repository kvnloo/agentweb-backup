import { findResumableUserMessage } from "../resumeSavedMessage";

const note = (over: Record<string, unknown> = {}) => ({ role: "assistant", content: "stopped", metadata: { kind: "claude-plan-stop", resumable: true, ...over } });
const user = (content: string, metadata?: Record<string, unknown>) => ({ role: "user", content, ...(metadata ? { metadata } : {}) });

describe("findResumableUserMessage", () => {
  it("finds the user message under a resumable plan-stop note, and under several", () => {
    expect(findResumableUserMessage([user("hi"), note()])).toEqual({ ok: true, content: "hi" });
    expect(findResumableUserMessage([{ role: "assistant", content: "earlier" }, user("hi"), note(), note()])).toEqual({ ok: true, content: "hi" });
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

  it("refuses an automatic continuation or any other kind of user message, and an empty one", () => {
    expect(findResumableUserMessage([user("hi", { kind: "auto-continuation" }), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([user(""), note()])).toEqual({ ok: false });
    expect(findResumableUserMessage([{ role: "user", content: 5 }, note()] as never)).toEqual({ ok: false });
    expect(findResumableUserMessage([user("hi", { timestamp: "t" }), note()])).toEqual({ ok: true, content: "hi" }); // ordinary metadata is fine
  });
});
