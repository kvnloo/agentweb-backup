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
    expect(description.toLowerCase()).toContain('plain');
    expect(description).toContain('<ul>');
    expect(description).toContain('<strong>');
    expect(description).toContain('**bold**');
  });

  test('variable_values_json parameter description repeats the plain-text instruction', () => {
    const paramDescription = definition!.inputSchema.properties.variable_values_json.description as string;
    expect(paramDescription.toLowerCase()).toContain('literal plain text');
  });

  test('array_variable_values_json parameter description repeats the plain-text instruction', () => {
    const paramDescription = definition!.inputSchema.properties.array_variable_values_json.description as string;
    expect(paramDescription.toLowerCase()).toContain('literal plain text');
  });
});
