import { findUndeclaredToolReferences } from "../utils/skillToolReferences";

// A representative slice of the real tool universe. `search_web` is a deliberate
// substring of `you_search_web` to exercise whole-token matching.
const KNOWN = new Set([
  "you_search_web",
  "search_web",
  "search_knowledge_base",
  "list_knowledge_base_files",
  "read_knowledge_base_files",
  "read_brand_guidelines",
  "read_market_strategy",
  "post_on_connected_account",
  "email", // bare dictionary-word tool name — must never match prose
]);

describe("findUndeclaredToolReferences", () => {
  it("flags a known tool referenced in the prompt but missing from toolNames (the Brand Strategy bug)", () => {
    const skill = {
      toolNames: ["read_brand_guidelines", "read_market_strategy"],
      systemPrompt:
        "Always use `you_search_web` for research, or `search_knowledge_base`. " +
        "Use `list_knowledge_base_files` to see available files.",
    };
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([
      "list_knowledge_base_files",
      "search_knowledge_base",
      "you_search_web",
    ]);
  });

  it("does NOT flag a shorter tool name that only appears inside a longer one (word boundary)", () => {
    // `search_web` appears only as a substring of the declared `you_search_web`.
    const skill = {
      toolNames: ["you_search_web"],
      systemPrompt: "Use you_search_web to look things up.",
    };
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([]);
  });

  it("ignores prose that is not a known tool name", () => {
    const skill = {
      toolNames: ["read_brand_guidelines"],
      systemPrompt:
        "Read the brand guidelines and analyze the market strategy thoroughly.",
    };
    // "brand guidelines" / "market strategy" as prose must not match the
    // underscored tool identifiers.
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([]);
  });

  it("does NOT flag a bare dictionary-word tool name that appears as prose", () => {
    // `email` is a real tool name AND an everyday word — matching it in
    // "send an email" prose would be a false positive.
    const skill = {
      toolNames: ["read_brand_guidelines"],
      systemPrompt: "Draft an email to the lead and send the email today.",
    };
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([]);
  });

  it("returns [] when the skill has no systemPrompt", () => {
    expect(
      findUndeclaredToolReferences(
        { toolNames: ["read_brand_guidelines"], systemPrompt: undefined },
        KNOWN,
      ),
    ).toEqual([]);
  });

  it("treats a missing toolNames array as zero declared tools", () => {
    const skill = {
      toolNames: undefined as unknown as string[],
      systemPrompt: "Call read_market_strategy first.",
    };
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([
      "read_market_strategy",
    ]);
  });

  it("returns [] when every referenced known tool is declared (happy path)", () => {
    const skill = {
      toolNames: [
        "you_search_web",
        "read_brand_guidelines",
        "post_on_connected_account",
      ],
      systemPrompt:
        "Use `you_search_web`, load `read_brand_guidelines`, then `post_on_connected_account`.",
    };
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([]);
  });

  it("deduplicates repeated references and returns a sorted list", () => {
    const skill = {
      toolNames: [],
      systemPrompt: "you_search_web ... you_search_web ... read_market_strategy",
    };
    expect(findUndeclaredToolReferences(skill, KNOWN)).toEqual([
      "read_market_strategy",
      "you_search_web",
    ]);
  });
});
