import ts from 'typescript';
import postcss from 'postcss';

/** Parse only: no project, dependency resolution, typecheck, or build. */
export function checkCodingAgentSyntax(filePath: string, content: string): string[] {
  if (/\.css$/i.test(filePath)) {
    try {
      postcss.parse(content, { from: filePath });
      return [];
    } catch (error) {
      const e = error as postcss.CssSyntaxError;
      return [`${filePath}:${e.line || 1}:${e.column || 1}: ${e.reason || e.message}`];
    }
  }
  if (!/\.[jt]sx?$/i.test(filePath)) return [];
  // transpileModule cannot emit declarations; a source-only Program provides
  // public syntactic diagnostics for .d.ts too, without loading any dependencies.
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: name => name === filePath ? source : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
    getDirectories: () => [], fileExists: name => name === filePath,
    readFile: name => name === filePath ? content : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([filePath], { noResolve: true, noLib: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, host);
  return program.getSyntacticDiagnostics(source).map(d => {
    const pos = source.getLineAndCharacterOfPosition(d.start || 0);
    return `${filePath}:${pos.line + 1}:${pos.character + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}
