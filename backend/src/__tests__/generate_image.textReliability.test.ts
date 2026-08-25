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
});
