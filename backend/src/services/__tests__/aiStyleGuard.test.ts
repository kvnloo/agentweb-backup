import { detectAiStyleTells } from "../aiStyleGuard";

const ids = (t: string) => detectAiStyleTells(t).map((h) => h.ruleId);

describe("detectAiStyleTells (ENG-1815)", () => {
  it.each([
    ["Let's delve into the data.", "delve"],
    ["This is CRUCIAL for growth.", "crucial"],
    ["A pivotal moment.", "pivotal"],
    ["A rich tapestry of ideas.", "tapestry"],
    ["Foundational work.", "foundational"],
    ["A robust pipeline.", "robust"],
    ["It works seamlessly.", "seamless"],
    ["The marketing landscape shifted.", "landscape"],
    ["In the realm of ads.", "realm"],
  ])("flags banned word in %p", (text, id) => {
    const hits = detectAiStyleTells(text);
    expect(hits.map((h) => h.ruleId)).toEqual([id]);
    expect(hits[0].category).toBe("banned_word");
  });

  it.each([
    ["Here's the thing: ads are expensive.", "heres-the-thing"],
    ["Here’s the thing, really.", "heres-the-thing"],
    ["Hope this helps!", "hope-this-helps"],
    ["After careful consideration, we passed.", "after-careful-consideration"],
    ["I wanted to provide a quick update on Q3.", "quick-update"],
  ])("flags stock opener in %p", (text, id) => {
    expect(ids(text)).toEqual([id]);
  });

  it("flags negative parallelism", () => {
    expect(ids("It's not a budget, it's a plan.")).toEqual(["not-x-its-y"]);
    expect(ids("This isn't a budget. It's a statement of intent.")).toEqual([
      "not-x-its-y",
    ]);
  });

  it("reports match text and offset, sorted by position", () => {
    const hits = detectAiStyleTells("Hope this helps. We delve.");
    expect(hits.map((h) => [h.ruleId, h.match, h.index])).toEqual([
      ["hope-this-helps", "Hope this helps", 0],
      ["delve", "delve", 20],
    ]);
  });

  it("does not match inside unrelated words", () => {
    expect(ids("Robustness, landscaped yards, and seamstress shops.")).toEqual([]);
  });

  it("returns no hits for clean human copy", () => {
    expect(
      ids("We cut our cost per lead by 30% last month. Here is how we did it.")
    ).toEqual([]);
    expect(detectAiStyleTells("")).toEqual([]);
  });
});
