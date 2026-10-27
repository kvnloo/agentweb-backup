/**
 * Spintax is `{a|b}`: a single-brace group with no braces inside it and at least one pipe. Smartlead supports it in templates and
 * AgentWeb never writes it into a value. A linear scan, not a regex: the obvious pattern `/\{[^{}]*\|[^{}]*\}/` is quadratic on
 * `{` followed by many `|` with no closing brace (measured: 3.5 s at 100,000 pipes), and this text is customer- or lead-controlled.
 */
export function containsSpintax(text: string): boolean {
  let open = -1;
  let pipe = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      open = i;
      pipe = false;
    } else if (c === "|") {
      if (open >= 0) pipe = true;
    } else if (c === "}") {
      if (open >= 0 && pipe) return true;
      open = -1;
      pipe = false;
    }
  }
  return false;
}
