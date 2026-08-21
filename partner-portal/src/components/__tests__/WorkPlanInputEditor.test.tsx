import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import WorkPlanInputEditor from '../WorkPlanInputEditor';
import type { EditableWorkPlanInputRequest } from '../workPlanInputSchema';

const fixture: EditableWorkPlanInputRequest = {
  title: 'Choose the business to audit',
  prompt: 'Enter a website.',
  fields: [
    { id: 'website', label: 'Business website', type: 'url', required: true },
    { id: 'lookback', label: 'Lookback window', type: 'number', required: false },
  ],
};

function Harness({ initial = fixture }: { initial?: EditableWorkPlanInputRequest }) {
  const [value, setValue] = useState(initial);
  return <WorkPlanInputEditor value={value} onChange={setValue} />;
}

describe('WorkPlanInputEditor', () => {
  it('updates the customer preview live', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Card title'), { target: { value: 'Tell us about the company' } });
    expect(screen.getByTestId('workplan-input-preview')).toHaveTextContent('Tell us about the company');
  });

  it('supports select choices without asking an admin to edit JSON', () => {
    render(<Harness />);
    fireEvent.mouseDown(screen.getAllByLabelText('Answer type')[0]);
    fireEvent.click(screen.getByRole('option', { name: 'Choose from a list' }));
    expect(screen.getByText('Choices')).toBeInTheDocument();
    expect(screen.getByTestId('workplan-input-preview').querySelector('select')).toBeInTheDocument();
  });

  it('reorders fields while retaining their stable machine keys', () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Move answer down' })[0]);
    const preview = screen.getByTestId('workplan-input-preview');
    expect(preview.textContent?.indexOf('Lookback window')).toBeLessThan(preview.textContent?.indexOf('Business website') ?? 0);
  });

  it('shows validation beside the editor before save', () => {
    render(<Harness initial={{ ...fixture, title: '' }} />);
    expect(screen.getByText('Add a card title.')).toBeInTheDocument();
  });
});
