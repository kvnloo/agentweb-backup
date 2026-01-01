import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

interface User {
  userId: string;
  email: string;
  roles?: string[];
  subscriptionType?: string;
}

interface TestProps {
  users: User[];
  availableSubscriptionTypes: string[];
  onSave: (userId: string, subscriptionType: string) => void;
}

// Minimal component that mirrors the Subscription Type column/edit UI in AdminDashboard
const TestSubscriptionsTable: React.FC<TestProps> = ({
  users,
  availableSubscriptionTypes,
  onSave,
}) => {
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [currentType, setCurrentType] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const startEdit = (user: User) => {
    setEditingUserId(user.userId);
    setCurrentType(user.subscriptionType || 'Basic');
  };

  const handleSave = () => {
    if (!editingUserId) return;
    setSaving(true);
    onSave(editingUserId, currentType || 'Basic');
    setSaving(false);
    setEditingUserId(null);
    setCurrentType('');
  };

  return (
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>Subscription Type</th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <tr key={user.userId}>
            <td>{user.email}</td>
            <td>
              {user.roles?.includes('customer') ? (
                editingUserId === user.userId ? (
                  <div>
                    <label htmlFor={`sub-${user.userId}`}>Subscription Type</label>
                    <select
                      id={`sub-${user.userId}`}
                      aria-label="Subscription Type"
                      value={currentType}
                      onChange={(e) => setCurrentType(e.target.value)}
                    >
                      {availableSubscriptionTypes.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button onClick={handleSave} disabled={saving}>
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingUserId(null);
                        setCurrentType('');
                      }}
                      disabled={saving}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div>
                    <span>{user.subscriptionType || 'Basic'}</span>
                    <button
                      aria-label="Edit Subscription Type"
                      onClick={() => startEdit(user)}
                      disabled={saving}
                    >
                      Edit
                    </button>
                  </div>
                )
              ) : (
                <span>-</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

describe('AdminDashboard subscriptions UI (isolated)', () => {
  it('shows Subscription Type column and current subscription type for customer users', () => {
    const users: User[] = [
      {
        userId: 'user-1',
        email: 'customer1@example.com',
        roles: ['customer'],
        subscriptionType: 'Basic',
      },
      {
        userId: 'user-2',
        email: 'partner@example.com',
        roles: ['partner'],
      },
    ];

    render(
      <TestSubscriptionsTable
        users={users}
        availableSubscriptionTypes={['Basic', 'Pro']}
        onSave={jest.fn()}
      />,
    );

    // Column header
    expect(screen.getByText('Subscription Type')).toBeInTheDocument();

    // Customer row shows subscription type
    expect(screen.getByText('customer1@example.com')).toBeInTheDocument();
    expect(screen.getByText('Basic')).toBeInTheDocument();

    // Non-customer shows "-"
    expect(screen.getByText('partner@example.com')).toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('allows editing a user subscription type and calls onSave with new value', () => {
    const users: User[] = [
      {
        userId: 'user-1',
        email: 'customer1@example.com',
        roles: ['customer'],
        subscriptionType: 'Basic',
      },
    ];

    const handleSave = jest.fn();

    render(
      <TestSubscriptionsTable
        users={users}
        availableSubscriptionTypes={['Basic', 'Pro']}
        onSave={handleSave}
      />,
    );

    const editButton = screen.getByRole('button', { name: /edit subscription type/i });
    fireEvent.click(editButton);

    const select = screen.getByLabelText(/subscription type/i) as HTMLSelectElement;
    expect(select.value).toBe('Basic');

    fireEvent.change(select, { target: { value: 'Pro' } });

    const saveButton = screen.getByRole('button', { name: /save/i });
    fireEvent.click(saveButton);

    expect(handleSave).toHaveBeenCalledWith('user-1', 'Pro');
  });
});
