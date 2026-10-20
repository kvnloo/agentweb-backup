import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyState, ErrorState } from '../StatusState';

describe('EmptyState (ENG-2526)', () => {
  it('renders title, description and the next action', () => {
    const onClick = jest.fn();
    render(
      <EmptyState
        title="No workflows found"
        description="Create one to get started."
        action={{ label: 'Create your first workflow', onClick }}
      />,
    );
    expect(screen.getByText('No workflows found')).toBeInTheDocument();
    expect(screen.getByText('Create one to get started.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create your first workflow' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders without an action button when none is given', () => {
    render(<EmptyState title="Nothing yet" description="Check back later." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ErrorState (ENG-2526)', () => {
  it('is an alert with a default explanation and a working Retry', () => {
    const onRetry = jest.fn();
    render(<ErrorState title="We couldn't load your tasks" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your tasks");
    expect(screen.getByText(/try again/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('disables Retry while a retry is in flight', () => {
    render(<ErrorState title="Failed" onRetry={jest.fn()} retrying />);
    expect(screen.getByRole('button', { name: /retrying/i })).toBeDisabled();
  });
});
