import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools'; // registers create_html_from_template as a side effect of import

// ENG-1880: real production data (the Haven autonomous report session) proved
// the HTML markup that leaked into a customer report (e.g. <ul><li><strong>) was
// NOT produced by performDataAnalysis (whose real output is Markdown, not HTML) —
// it was composed by the LLM turn that fills in create_html_from_template's own
// variable_values_json, which had no formatting guidance at all. Live-verified on
// test-env1: with this description, gemini-3.7-flash (the same model that
// produced the real bug) writes plain-text insight values instead of HTML.
describe('create_html_from_template tool description — plain-text variable values', () => {
  const definition = emmaToolRegistry.getTool('create_html_from_template')?.definition;

  test('tool is registered', () => {
    expect(definition).toBeDefined();
  });

  test('top-level description instructs plain text, forbids HTML tags and Markdown', () => {
    const description = definition!.description as string;
    // Assert the prohibition as one contiguous phrase binding "do NOT" directly to
    // the tag/syntax examples — a plain substring check on 'plain'/'<ul>'/'**bold**'
    // alone would still pass even if someone reworded this to ALLOW markup (e.g.
    // "you may format values with HTML tags like <ul>"), silently losing the one
    // guarantee ENG-1880 depends on.
    expect(description).toContain(
      'do NOT format values with HTML tags (e.g. <ul>, <li>, <strong>) or Markdown syntax (e.g. **bold**'
    );
    expect(description.toLowerCase()).toContain('plain sentences only');
  });

  test('variable_values_json parameter description repeats the plain-text instruction as a prohibition', () => {
    const paramDescription = definition!.inputSchema.properties.variable_values_json.description as string;
    expect(paramDescription).toContain('inserted as literal plain text — no HTML tags or Markdown formatting');
  });

  test('array_variable_values_json parameter description repeats the plain-text instruction as a prohibition', () => {
    const paramDescription = definition!.inputSchema.properties.array_variable_values_json.description as string;
    expect(paramDescription).toContain('inserted as literal plain text — no HTML tags or Markdown formatting');
  });
});
