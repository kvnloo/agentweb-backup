import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PartnerJobOverview, { getPartnerJobOverview } from '../PartnerJobOverview';
import { portalRouteCatalog } from '../../navigation/catalog';

describe('PartnerJobOverview', () => {
  it('gives a first-time partner the two supported ways to begin work', () => {
    expect(getPartnerJobOverview().map(({ id, title, status }) => ({ id, title, status }))).toEqual([
      { id: 'create-task', title: 'Run a task', status: 'Ready to start' },
      { id: 'create-workflow', title: 'Build a workflow', status: 'Ready to start' },
    ]);
  });

  it('keeps the next action and relevant drill-down reachable for every job', () => {
    const routeIds = getPartnerJobOverview()
      .flatMap(({ primaryRouteId, secondaryRouteId }) => [primaryRouteId, secondaryRouteId]);

    expect(routeIds).toEqual(['task-create', 'tasks', 'workflow-new', 'workflows']);
  });

  it('does not surface a placeholder, dead-end, or admin-only route as partner work', () => {
    const routesById = new Map(portalRouteCatalog.map((route) => [route.id, route]));

    for (const job of getPartnerJobOverview()) {
      for (const routeId of [job.primaryRouteId, job.secondaryRouteId]) {
        const route = routesById.get(routeId);
        expect(route).toMatchObject({ availability: 'available', routeRegistered: true });
        expect(route?.access).not.toBe('admin');
      }
    }
  });

  it('uses labels and destinations from the single navigation catalog', () => {
    const routesById = new Map(portalRouteCatalog.map((route) => [route.id, route]));

    for (const job of getPartnerJobOverview()) {
      expect(job.primaryAction).toBe(routesById.get(job.primaryRouteId)?.label);
      expect(job.primaryDestination).toBe(routesById.get(job.primaryRouteId)?.destination);
      expect(job.secondaryAction).toBe(routesById.get(job.secondaryRouteId)?.label);
      expect(job.secondaryDestination).toBe(routesById.get(job.secondaryRouteId)?.destination);
    }
  });

  it('shows a status, next action, and drill-down for each primary partner job', () => {
    render(
      <MemoryRouter>
        <PartnerJobOverview />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('Ready to start')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Create task' })).toHaveAttribute('href', '/tasks/create');
    expect(screen.getByRole('link', { name: 'View Tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.getByRole('link', { name: 'New workflow' })).toHaveAttribute('href', '/workflows/new');
    expect(screen.getByRole('link', { name: 'View Workflows' })).toHaveAttribute('href', '/workflows');
  });
});
