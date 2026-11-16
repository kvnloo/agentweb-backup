/**
 * ENG-2790: generate_book_content rejected 4/9 calls at schema validation with
 * 'Missing required argument "chapter_id"', even though the schema documents
 * chapter_id as optional and the handler generates section content when it is
 * absent. The declared schema must agree with the handler.
 */
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';

describe('generate_book_content schema contract (ENG-2790)', () => {
  const tool = emmaToolRegistry.getTool('generate_book_content');
  const inputSchema = (tool!.definition as any).inputSchema;

  it('accepts a section-level call without chapter_id (observed model shape)', () => {
    const result = validateAndRepairToolArgs({
      toolName: 'generate_book_content',
      args: { book_id: 'book-1', section_id: 'sec-1', content_description: 'Intro section', length: 'short' },
      inputSchema,
      effect: 'internal_write',
    });
    expect(result.status).toBe('valid');
  });

  it('still requires book_id, section_id and content_description', () => {
    expect(inputSchema.required).toEqual(['book_id', 'section_id', 'content_description']);
    const result = validateAndRepairToolArgs({
      toolName: 'generate_book_content',
      args: { book_id: 'book-1', content_description: 'x' },
      inputSchema,
      effect: 'internal_write',
    });
    expect(result.status).not.toBe('valid');
  });
});
