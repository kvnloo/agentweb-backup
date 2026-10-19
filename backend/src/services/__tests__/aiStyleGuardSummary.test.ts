import { summarizeAiStyleTells } from "../aiStyleGuard";

describe("summarizeAiStyleTells (ENG-2429)", () => {
  it("counts assistant text and tool-call draft arguments", () => {
    const s = summarizeAiStyleTells([
      { role: "assistant", content: "Let's delve in." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "draft_post", arguments: JSON.stringify({ body: "Hope this helps" }) } }],
      },
      { role: "assistant", content: "", metadata: { toolCalls: [{ arguments: { text: "we delve" } }] } },
    ]);
    expect(s.total).toBe(3);
    expect(Object.values(s.byRule).reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.values(s.byCategory).reduce((a, b) => a + (b ?? 0), 0)).toBe(3);
  });

  it("ignores user, system and tool messages", () => {
    const s = summarizeAiStyleTells([
      { role: "user", content: "delve delve. Hope this helps" },
      { role: "system", content: "delve" },
      { role: "tool", content: "delve" },
    ]);
    expect(s).toEqual({ total: 0, byCategory: {}, byRule: {} });
  });

  it("returns an empty summary for clean or missing input", () => {
    expect(summarizeAiStyleTells([{ role: "assistant", content: "Revenue rose 4% in May." }]).total).toBe(0);
    expect(summarizeAiStyleTells().total).toBe(0);
  });
});
