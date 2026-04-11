import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Isolated mirror of the Tier filter dropdown in AdminDashboard.tsx.
// The real dropdown was previously hardcoded with a static MenuItem list
// (Managed / Super Premium / Advanced / Basic / Free), which silently drifted
// as new tiers like "Pro" and "Premium" were added to AW-Settings. The fix
// renders options dynamically from availableSubscriptionTypes (the same state
// that already powers the per-user edit dropdown), so any tier defined in
// the settings record automatically appears in the filter.

interface TestProps {
  availableSubscriptionTypes: string[];
  initialValue?: string;
  onChange?: (value: string) => void;
}

const TestTierFilter: React.FC<TestProps> = ({
  availableSubscriptionTypes,
  initialValue = 'all',
  onChange,
}) => {
  const [value, setValue] = useState(initialValue);
  return (
    <div>
      <label htmlFor="tier-filter">Tier</label>
      <select
        id="tier-filter"
        aria-label="Tier"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
      >
        <option value="all">All Tiers</option>
        {availableSubscriptionTypes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        <option value="none">No Tier</option>
      </select>
    </div>
  );
};

describe('AdminDashboard tier filter (isolated)', () => {
  it('renders every tier from availableSubscriptionTypes as an option', () => {
    render(
      <TestTierFilter
        availableSubscriptionTypes={['Free', 'Basic', 'Pro', 'Premium', 'Managed', 'Super Premium']}
      />,
    );

    expect(screen.getByRole('option', { name: 'All Tiers' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Free' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Basic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Pro' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Premium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Managed' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Super Premium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'No Tier' })).toBeInTheDocument();
  });

  it('includes "Pro" even though the old hardcoded list omitted it', () => {
    // Regression: the pre-fix filter hardcoded Managed / Super Premium / Advanced
    // / Basic / Free only. Pro was defined in AW-Settings but missing from the
    // filter, so admins could not filter users on the Pro tier.
    render(<TestTierFilter availableSubscriptionTypes={['Free', 'Basic', 'Pro', 'Managed']} />);

    expect(screen.getByRole('option', { name: 'Pro' })).toBeInTheDocument();
  });

  it('always keeps the "all" and "none" sentinel options', () => {
    render(<TestTierFilter availableSubscriptionTypes={['Pro']} />);

    expect(screen.getByRole('option', { name: 'All Tiers' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'No Tier' })).toBeInTheDocument();
  });

  it('shows only the sentinel options when availableSubscriptionTypes is empty', () => {
    render(<TestTierFilter availableSubscriptionTypes={[]} />);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('All Tiers');
    expect(options[1]).toHaveTextContent('No Tier');
  });

  it('selecting a dynamic tier fires onChange with that tier name', () => {
    const onChange = jest.fn();
    render(
      <TestTierFilter
        availableSubscriptionTypes={['Free', 'Basic', 'Pro']}
        onChange={onChange}
      />,
    );

    const select = screen.getByLabelText('Tier') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Pro' } });

    expect(onChange).toHaveBeenCalledWith('Pro');
    expect(select.value).toBe('Pro');
  });
});
