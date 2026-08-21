import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import WorkPlanInputEditor from '../WorkPlanInputEditor';
import type { EditableWorkPlanInputRequest } from '../workPlanInputSchema';
import { validateEditableInputRequest } from '../workPlanInputSchema';

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

  it('rejects blank select choice labels', () => {
    expect(validateEditableInputRequest({
      ...fixture,
      fields: [{ id: 'kind', label: 'Kind', type: 'select', options: [{ value: 'a', label: '' }, { value: 'b', label: 'B' }] }],
    })).toContain("Kind's choices need labels.");
  });

  it('rejects defaults whose runtime type does not match the field type', () => {
    expect(validateEditableInputRequest({
      ...fixture,
      fields: [{ id: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: 'true' as unknown as boolean }],
    })).toContain("Enabled's default has the wrong type.");
  });

  it('returns a recoverable error for malformed persisted cards', () => {
    expect(validateEditableInputRequest({ title: 'Broken' })).toEqual([
      'This answer card is malformed. Remove it and add it again.',
    ]);
  });

  it.each([
    ['non-array options', 'not-an-array'],
    ['null option entries', [null, { value: 'b', label: 'B' }]],
    ['option entries with non-string properties', [{ value: 1, label: 'A' }, { value: 'b', label: 'B' }]],
  ])('returns a recoverable error for select fields with %s', (_case, options) => {
    expect(validateEditableInputRequest({
      ...fixture,
      fields: [{ id: 'kind', label: 'Kind', type: 'select', options }],
    })).toEqual([
      'This answer card is malformed. Remove it and add it again.',
    ]);
  });
});
