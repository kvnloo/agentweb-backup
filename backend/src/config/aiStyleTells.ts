/**
 * AI-tell style rules for Emma-generated external copy (ENG-1815).
 *
 * Data only: edit this list to tune the guard. The detector lives in
 * `services/aiStyleGuard.ts`. Patterns are matched case-insensitively.
 */
export type AiStyleTellCategory =
  | "banned_word"
  | "stock_opener"
  | "negative_parallelism";

export interface AiStyleTellRule {
  id: string;
  category: AiStyleTellCategory;
  /** Regex source (no flags). Matched with "gi". */
  pattern: string;
  /** Short reason shown to the writer / rewrite pass. */
  hint: string;
}

const word = (id: string, forms: string, hint: string): AiStyleTellRule => ({
  id,
  category: "banned_word",
  pattern: `\\b(?:${forms})\\b`,
  hint,
});

const opener = (id: string, phrase: string): AiStyleTellRule => ({
  id,
  category: "stock_opener",
  pattern: `\\b${phrase}\\b`,
  hint: "Stock filler phrase; cut it and start with the point.",
});

export const AI_STYLE_TELL_RULES: readonly AiStyleTellRule[] = [
  word("delve", "delve|delves|delved|delving", "Say 'look at' or 'dig into'."),
  word("crucial", "crucial", "Say why it matters instead."),
  word("pivotal", "pivotal", "Say why it matters instead."),
  word("tapestry", "tapestry|tapestries", "Name the actual things."),
  word("foundational", "foundational", "Be concrete."),
  word("robust", "robust", "Say what it survives or handles."),
  word("seamless", "seamless|seamlessly", "Say what actually happens."),
  word("landscape", "landscape", "Name the market or field."),
  word("realm", "realm|realms", "Name the field."),
  opener("heres-the-thing", "here['’]s the thing"),
  opener("hope-this-helps", "hope this helps"),
  opener("after-careful-consideration", "after careful consideration"),
  opener("quick-update", "i wanted to (?:provide|give) (?:you )?a quick update"),
  {
    id: "not-x-its-y",
    category: "negative_parallelism",
    // "It's not X, it's Y" / "This isn't X. It's Y."
    pattern:
      "\\b(?:it|this|that)(?:['’]s not| is not|\\s+isn['’]t)\\b[^.!?\\n]{1,80}?[,.;—-]\\s*(?:it|this|that)['’]s\\b",
    hint: "Negative parallelism; state the claim directly.",
  },
];
