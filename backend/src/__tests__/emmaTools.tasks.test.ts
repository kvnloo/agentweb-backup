/**
 * ENG-2103 F2 — proves emma/tools.ts's task-management tool execute() bodies
 * call emma/impl/tasks.ts directly (not agentModeService.<method>) and
 * forward the result unchanged. Same pattern as emmaTools.blog.test.ts/
 * emmaTools.knowledgeBase.test.ts/emmaTools.leads.test.ts/
 * emmaTools.workPlans.test.ts.
 *
 * `create_image_task_from_prompt` was added in a follow-up pass (it was
 * initially excluded from this cluster on a false-positive callLLM-coupling
 * theory — see emma/impl/tasks.ts's module header for the correction) and is
 * now covered here like the other 4. The mocked agentModeService below is a
 * throwing Proxy so that if any of the 5 tools covered here ever called back
 * into the class (a regression), the test would fail loudly instead of
 * silently succeeding against the real service.
 */

jest.mock('../emma/impl/tasks', () => ({
  listTaskTemplates: jest.fn(),
  createTaskFromTemplate: jest.fn(),
  createTaskFromPrompt: jest.fn(),
  createRevision: jest.fn(),
  createImageTaskFromPrompt: jest.fn(),
}));

// agentModeService.<taskMethod> must NOT be called by these 5 tools anymore
// — mock the whole module so a regression (a call site accidentally left
// pointed at the class) would throw instead of silently succeeding against
// the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the task-management tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as tasksImpl from '../emma/impl/tasks';
import '../emma/tools';

const mockTasks = tasksImpl as jest.Mocked<typeof tasksImpl>;

describe('Task management tool cluster delegates to emma/impl/tasks.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('list_task_templates calls tasksImpl.listTaskTemplates with no arguments and returns the result unchanged', async () => {
    const expected = { success: true, totalTemplates: 0 };
    mockTasks.listTaskTemplates.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('list_task_templates')!;
    const result = await tool.execute({}, { userId: 'u1', sessionId: 's1' });

    expect(mockTasks.listTaskTemplates).toHaveBeenCalledWith();
    expect(result).toBe(expected);
  });

  it('create_task_from_template parses parameters_json, forwards template_id/parameters/user/session/attach flags/urls/async, and returns the result unchanged', async () => {
    const expected = { success: true, taskId: 't1' };
    mockTasks.createTaskFromTemplate.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_task_from_template')!;
    const result = await tool.execute(
      {
        template_id: 'tmpl-1',
        parameters_json: '{"site_url":"example.com"}',
        attach_previous_task_results: true,
        attached_file_urls: ['https://x/file.pdf'],
        async: true,
      },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockTasks.createTaskFromTemplate).toHaveBeenCalledWith(
      'tmpl-1',
      { site_url: 'example.com' },
      'u1',
      's1',
      true,
      ['https://x/file.pdf'],
      true
    );
    expect(result).toBe(expected);
  });

  it('create_task_from_template falls back to defaults for attached_file_urls/async when omitted', async () => {
    const expected = { success: true, taskId: 't2' };
    mockTasks.createTaskFromTemplate.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_task_from_template')!;
    await tool.execute(
      { template_id: 'tmpl-1', parameters_json: '{}' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockTasks.createTaskFromTemplate).toHaveBeenCalledWith(
      'tmpl-1', {}, 'u1', 's1', undefined, [], false
    );
  });

  it('create_task_from_prompt forwards task_name/prompt/category/user/session/attach flags/urls/async and returns the result unchanged', async () => {
    const expected = { success: true, taskId: 't3' };
    mockTasks.createTaskFromPrompt.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_task_from_prompt')!;
    const result = await tool.execute(
      {
        task_name: 'Research task',
        prompt: 'Do the thing',
        category: 'Research',
        attach_previous_task_results: false,
        attached_file_urls: [],
        async: false,
      },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockTasks.createTaskFromPrompt).toHaveBeenCalledWith(
      'Research task', 'Do the thing', 'Research', 'u1', 's1', false, [], false
    );
    expect(result).toBe(expected);
  });

  it('create_revision forwards task_id/execution_id/revision_prompt/user/target_result_name and returns the result unchanged', async () => {
    const expected = { success: true, assetType: 'report' };
    mockTasks.createRevision.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_revision')!;
    const result = await tool.execute(
      {
        task_id: 'task-1',
        execution_id: 'exec-1',
        revision_prompt: 'Make it blue',
        target_result_name: 'report.html',
      },
      { userId: 'u1' }
    );

    expect(mockTasks.createRevision).toHaveBeenCalledWith('task-1', 'exec-1', 'Make it blue', 'u1', 'report.html');
    expect(result).toBe(expected);
  });

  it('create_image_task_from_prompt forwards task_name/prompt/category/user/session/attach flag and returns the result unchanged', async () => {
    const expected = { success: true, taskId: 't4' };
    mockTasks.createImageTaskFromPrompt.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_image_task_from_prompt')!;
    const result = await tool.execute(
      {
        task_name: 'Ad images',
        prompt: 'Bright, modern product shots',
        category: 'Creatives',
        attach_previous_task_results: true,
      },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockTasks.createImageTaskFromPrompt).toHaveBeenCalledWith(
      'Ad images', 'Bright, modern product shots', 'Creatives', 'u1', 's1', true
    );
    expect(result).toBe(expected);
  });
});
