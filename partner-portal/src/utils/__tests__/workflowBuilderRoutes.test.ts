import { matchPath } from 'react-router-dom';
import { isNewWorkflowRoute, savedWorkflowEditPath } from '../workflowBuilderRoutes';

// Mirrors the workflow routes registered in src/App.tsx.
const REGISTERED_WORKFLOW_ROUTES = [
  '/workflows',
  '/workflows/new',
  '/workflows/:id',
  '/workflows/:id/edit',
  '/workflows/:id/run',
  '/workflows/:id/executions/:executionId',
];

describe('workflow builder post-save routing (ENG-2401)', () => {
  it('navigates a newly created workflow to the registered edit route', () => {
    const path = savedWorkflowEditPath({ workflowId: 'wf-123' });
    expect(path).toBe('/workflows/wf-123/edit');
    const match = REGISTERED_WORKFLOW_ROUTES.find((pattern) => matchPath(pattern, path!));
    expect(match).toBe('/workflows/:id/edit');
    expect(matchPath('/workflows/:id/edit', path!)?.params.id).toBe('wf-123');
  });

  it('never targets the unregistered /workflows/builder/:id path', () => {
    expect(savedWorkflowEditPath({ workflowId: 'wf-1' })).not.toMatch(/\/workflows\/builder\//);
  });

  it('uses the API workflowId key, falling back to id', () => {
    expect(savedWorkflowEditPath({ id: 'legacy-1' })).toBe('/workflows/legacy-1/edit');
    expect(savedWorkflowEditPath({ workflowId: 'a', id: 'b' })).toBe('/workflows/a/edit');
  });

  it('returns null when the response carries no usable id', () => {
    expect(savedWorkflowEditPath({})).toBeNull();
    expect(savedWorkflowEditPath(null)).toBeNull();
    expect(savedWorkflowEditPath({ workflowId: 'new' })).toBeNull();
  });

  it('treats the /workflows/new mount (no :id param) as a new workflow', () => {
    expect(isNewWorkflowRoute(undefined)).toBe(true);
    expect(isNewWorkflowRoute('new')).toBe(true);
    expect(isNewWorkflowRoute('wf-123')).toBe(false);
  });
});
