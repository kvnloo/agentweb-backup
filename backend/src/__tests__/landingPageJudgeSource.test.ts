/**
 * ENG-2192: the landing-page source the rubric judge reads, taken from the v0 output a deploy
 * already holds in memory.
 */
import { landingPageSourceForJudge, type GeneratedFile } from '../services/landingPageJudgeSource';

const file = (path: string, content: string): GeneratedFile => ({ path, content: Buffer.from(content) });

describe('landingPageSourceForJudge', () => {
  it('returns the route file, then the page\'s own components in path order, without shadcn primitives or config', () => {
    const source = landingPageSourceForJudge([
      file('components/ui/button.tsx', 'export function Button() {}'),
      file('package.json', '{}'),
      file('components/pricing.tsx', 'export function Pricing() { return <p>$49</p>; }'),
      file('app/page.tsx', 'export default function Page() { return <Hero />; }'),
      file('components/hero.tsx', 'export function Hero() { return <h1>Close 40% faster</h1>; }'),
      file('app/layout.tsx', 'export default function Layout() {}'),
    ]);

    expect(source?.split('\n').filter((l) => l.startsWith('// file: '))).toEqual([
      '// file: app/page.tsx',
      '// file: components/hero.tsx',
      '// file: components/pricing.tsx',
    ]);
    expect(source).toContain('Close 40% faster');
    expect(source).not.toContain('Button');
  });

  it('returns undefined when there is no route file', () => {
    expect(landingPageSourceForJudge([file('components/hero.tsx', 'x')])).toBeUndefined();
  });
});
