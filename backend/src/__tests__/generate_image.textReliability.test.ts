import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

describe('generate_image text/data reliability guidance (ENG-1027)', () => {
  const d: any = emmaToolRegistry.getAllToolDefinitions().find((t: any) => t.name === 'generate_image');

  it('warns that small exact strings (IDs, spelled words) cannot be reliably rendered, and says to brief around it rather than retry', () => {
    expect(d.description).toMatch(/cannot reliably render small exact (text|strings)/i);
    expect(d.description).toMatch(/do NOT retry/i);
    expect(d.description).toMatch(/brief around/i);
  });

  it('warns that data-shaped layouts (tables/cells) get invented numbers and instructs leaving unknown cells blank', () => {
    expect(d.description).toMatch(/invent(s|ed)? (plausible )?(numbers|data)/i);
    expect(d.description).toMatch(/leave (it|them|the cell|those cells) (blank|empty)/i);
  });

  // ENG-1027 round 3: the post-generation backstop needs an explicit escape hatch
  // for genuinely real, tool-sourced data, or a customer with accurate numbers can
  // get told their real figures "were never verified as real" — a false positive
  // that erodes trust in correct data just as much as the original bug eroded trust
  // by shipping fake data. metrics_verified is that hatch, and it must actually be
  // registered on the tool (not just described in prose) for Emma to use it.
  it('registers a metrics_verified input so Emma can declare real, tool-sourced data and skip the reliability check', () => {
    expect(d.inputSchema.properties.metrics_verified).toBeDefined();
    expect(d.inputSchema.properties.metrics_verified.type).toBe('boolean');
    expect(d.description).toMatch(/metrics_verified/);
  });
});
