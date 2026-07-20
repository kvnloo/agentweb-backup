import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

describe('search_ads_knowledge_base tool registration', () => {
  const description: string = emmaToolRegistry.getTool('search_ads_knowledge_base')!.definition.description;

  it('steers bulk/scheduled ad-creative extraction to the reliable discovery source', () => {
    // ENG-382: the tool description is half the fix — the string the LLM reads.
    expect(description).toMatch(/RELIABLE source/);
    expect(description).toMatch(/best-effort only/);
    expect(description).toMatch(/DOM virtualization/i);
    expect(description).toMatch(/bulk or scheduled/i);
    expect(description).toMatch(/source='discovery'/);
    expect(description).toMatch(/official Meta Ad Library API/);
  });

  it('documents the ~20-per-call ceiling and cursor paging path for scaling beyond one call', () => {
    // ENG-382: the 100-ad scenario must have a path to scale past the 20-result cap.
    expect(description).toMatch(/20 ads per call|capped at 20/);
    expect(description).toMatch(/cursor/);
    expect(description).toMatch(/hasMore/);
  });

  it('documents how to target a specific company vs. a broad keyword sweep', () => {
    // ENG-382 was keyword/category research, not a single-company lookup. These
    // per-argument mechanics live here (tool description), not in the always-on
    // system prompt.
    expect(description).toMatch(/company_name/);
    expect(description).toMatch(/broad keyword/i);
    expect(description).toMatch(/do NOT force company_name/i);
  });

  it('exposes a cursor input so the agent can page through discovery results', () => {
    const props = emmaToolRegistry.getTool('search_ads_knowledge_base')!.definition.inputSchema.properties;
    expect(props.cursor).toBeTruthy();
    expect(props.cursor.type).toBe('string');
  });
});
