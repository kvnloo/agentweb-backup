import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

describe('remove_image_background tool registration', () => {
  const defs = emmaToolRegistry.getAllToolDefinitions();
  const byName = (n: string) => defs.find((d: any) => d.name === n);

  it('registers remove_image_background with expected schema', () => {
    const d: any = byName('remove_image_background');
    expect(d).toBeTruthy();
    expect(Object.keys(d.inputSchema.properties).sort()).toEqual(
      ['filename', 'image_url', 'surface_color', 'tolerance'].sort()
    );
    expect(d.inputSchema.required).toEqual(['image_url']);
    expect(d.description).toMatch(/transparent-alpha PNG/i);
  });

  it('updated remove_c2pa_from_image description disclaims background removal', () => {
    const d: any = byName('remove_c2pa_from_image');
    expect(d.description).toMatch(/does NOT remove/i);
    expect(d.description).toMatch(/remove_image_background/);
  });

  it('generate_image description steers transparent-bg requests to remove_image_background', () => {
    const d: any = byName('generate_image');
    expect(d.description).toMatch(/remove_image_background/);
  });

  it('update_html_file description has container-scoped selector guidance', () => {
    const d: any = byName('update_html_file');
    expect(d.description).toMatch(/SELECTOR SCOPING/);
    expect(d.description).toMatch(/linear-gradient/);
  });
});
