/**
 * The landing-page source the creative rubric judge reads (ENG-2192).
 *
 * A deploy already holds the generated v0 output in memory (`app/page.tsx` plus its section
 * components), so the judge reads that instead of fetching or rendering the live page. shadcn UI
 * primitives (`components/ui/`) are left out: they are shared boilerplate, not page content.
 *
 * Pure: no IO.
 */

export interface GeneratedFile {
  path: string;
  content: Buffer;
}

const ROUTE_FILE = 'app/page.tsx';

function isPageComponent(path: string): boolean {
  return path.startsWith('components/') && !path.startsWith('components/ui/') && path.endsWith('.tsx');
}

/**
 * The route file first, then the page's own components in path order, each under a `// file:`
 * header. Undefined when the output has no route file (nothing a visitor would see to judge).
 */
export function landingPageSourceForJudge(files: readonly GeneratedFile[]): string | undefined {
  const route = files.find((f) => f.path === ROUTE_FILE);
  if (!route) return undefined;
  const components = files.filter((f) => isPageComponent(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  return [route, ...components].map((f) => `// file: ${f.path}\n${f.content.toString('utf-8').trim()}`).join('\n\n');
}
