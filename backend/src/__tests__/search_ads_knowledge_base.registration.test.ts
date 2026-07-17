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

  it('exposes a cursor input so the agent can page through discovery results', () => {
    const props = emmaToolRegistry.getTool('search_ads_knowledge_base')!.definition.inputSchema.properties;
    expect(props.cursor).toBeTruthy();
    expect(props.cursor.type).toBe('string');
  });
});
