/**
 * ENG-1852 regression guard.
 *
 * chatbotService.ts and agentModeService.ts import from each other:
 * agentModeService.ts imports chatbotDb/ChatMessage/searchPlatformKnowledgeBase from
 * chatbotService.ts at module scope. If chatbotService.ts also imports AgentModeService
 * from agentModeService.ts as a top-level VALUE import (not `import type`), that closes
 * a real circular require. Confirmed live in prod via a captured construction stack
 * trace: inside the shared marketing-response worker process, the circularity caused
 * agentModeService.ts's own module-level singleton line to execute a second time —
 * once via the worker's direct import, once via this file's back-reference — producing
 * a second, never-initialized AgentModeService instance that intermittently answered
 * tool-registry reads with an empty result (blocking install_skills(['__other_skills__'])
 * unpredictably).
 *
 * The fix: chatbotService.ts imports only the TYPE at module scope and resolves the
 * runtime value with a lazy `await import('./agentModeService')` at the point of use
 * inside generateChatResponse — the same pattern emmaApi.ts's getAgentModeService()
 * already uses to avoid this exact class of cycle. This test parses the file with the
 * TypeScript AST (not regex) so a reintroduced top-level value import fails loudly
 * instead of silently reopening the cycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const CHATBOT_SERVICE_PATH = path.join(__dirname, '..', 'services', 'chatbotService.ts');

function findTopLevelValueImportsFrom(content: string, moduleSpecifierText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'chatbotService.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleSpecifierText) continue;
    // `import type { X } from '...'` is fully erased at compile time — no runtime
    // require is emitted, so it cannot participate in a circular require. Only a
    // value-level import statement (or a value-level named import within an
    // otherwise-type-only-looking clause) is the real hazard.
    if (statement.importClause?.isTypeOnly) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (element.isTypeOnly) continue;
        found.push(element.name.text);
      }
    }
    if (statement.importClause?.name) {
      found.push(statement.importClause.name.text);
    }
  }
  return found;
}

describe('ENG-1852: chatbotService.ts must not statically import AgentModeService as a value', () => {
  it('has no top-level value import of AgentModeService from agentModeService.ts', () => {
    const content = fs.readFileSync(CHATBOT_SERVICE_PATH, 'utf8');
    const valueImports = findTopLevelValueImportsFrom(content, './agentModeService');
    expect(valueImports).not.toContain('AgentModeService');
  });

  it('still resolves AgentModeService lazily inside generateChatResponse (the fix is actually applied, not just the import removed)', () => {
    const content = fs.readFileSync(CHATBOT_SERVICE_PATH, 'utf8');
    expect(content).toMatch(/await import\(['"]\.\/agentModeService['"]\)/);
  });
});
