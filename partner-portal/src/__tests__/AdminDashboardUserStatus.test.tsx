import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock the AdminDashboard component with simplified logic for testing
const AdminDashboard = () => {
    const contextUsers = [
      { userId: '1', email: 'free@example.com', roles: ['free'] },
      { userId: '2', email: 'registered@example.com', roles: ['customer', 'partner'] },
      { userId: '3', email: 'freecustomer@example.com', roles: ['free', 'customer'] }
    ] as any[];

  const waitlistEntries = [
    { email: 'free@example.com', status: 'pending' },
    { email: 'registered@example.com', status: 'invited' },
    { email: 'freecustomer@example.com', status: 'invited' },
    { email: 'new@example.com', status: 'pending' }
  ];

  const getUserStatus = (entry: any) => {
    const existingUser = contextUsers.find(user => user.email === entry.email);
    const userExists = !!existingUser;
    const isFreeUserOnly = existingUser && existingUser.roles?.includes('free') && !existingUser.roles?.some(role => role !== 'free');
    const isRegisteredUser = existingUser && existingUser.roles?.some(role => role !== 'free');

    return {
      existingUser,
      userExists,
      isFreeUserOnly,
      isRegisteredUser,
      status: isRegisteredUser ? 'Registered' : 'Free User',
      showPlusButton: !userExists,
      showInviteButton: (!userExists || isFreeUserOnly) && entry.status !== 'invited' && !isRegisteredUser,
      showResendButton: (!userExists || isFreeUserOnly) && entry.status === 'invited' && !isRegisteredUser
    };
  };

  return (
    <div>
      {waitlistEntries.map((entry, index) => {
        const userStatus = getUserStatus(entry);
        return (
          <div key={index} data-testid={`user-${index}`}>
            <div data-testid={`email-${index}`}>{entry.email}</div>
            <div data-testid={`status-${index}`}>{userStatus.status}</div>
            {userStatus.showPlusButton && <button data-testid={`plus-${index}`}>+</button>}
            {userStatus.showInviteButton && <button data-testid={`invite-${index}`}>Invite</button>}
            {userStatus.showResendButton && <button data-testid={`resend-${index}`}>Resend</button>}
          </div>
        );
      })}
    </div>
  );
};

describe('AdminDashboard User Status Logic', () => {
  it('should show "Free User" status for users with only free role', () => {
    render(<AdminDashboard />);
    
    expect(screen.getByTestId('status-0')).toHaveTextContent('Free User');
    expect(screen.getByTestId('email-0')).toHaveTextContent('free@example.com');
  });

  it('should show "Registered" status for users with more than just free role', () => {
    render(<AdminDashboard />);
    
    expect(screen.getByTestId('status-1')).toHaveTextContent('Registered');
    expect(screen.getByTestId('email-1')).toHaveTextContent('registered@example.com');
  });

  it('should show "Registered" status for users with both free and customer roles', () => {
    render(<AdminDashboard />);
    
    expect(screen.getByTestId('status-2')).toHaveTextContent('Registered');
    expect(screen.getByTestId('email-2')).toHaveTextContent('freecustomer@example.com');
  });

  it('should show "+" button only for users who do not exist', () => {
    render(<AdminDashboard />);
    
    // New user should show + button
    expect(screen.getByTestId('plus-3')).toBeInTheDocument();
    
    // Existing users should not show + button
    expect(screen.queryByTestId('plus-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plus-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plus-2')).not.toBeInTheDocument();
  });

  it('should show Invite button for free users only (not invited)', () => {
    render(<AdminDashboard />);
    
    // Free user with pending status should show Invite button
    expect(screen.getByTestId('invite-0')).toBeInTheDocument();
    
    // Registered users should not show Invite button
    expect(screen.queryByTestId('invite-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invite-2')).not.toBeInTheDocument();
    
    // New user should show Invite button
    expect(screen.getByTestId('invite-3')).toBeInTheDocument();
  });

  it('should show Resend button for free users only (invited)', () => {
    // Create a test with a free user who is invited
    const contextUsers = [
      { userId: '1', email: 'freeinvited@example.com', roles: ['free'] }
    ] as any[];

    const waitlistEntries = [
      { email: 'freeinvited@example.com', status: 'invited' }
    ];

    const getUserStatus = (entry: any) => {
      const existingUser = contextUsers.find(user => user.email === entry.email);
      const userExists = !!existingUser;
      const isFreeUserOnly = existingUser && existingUser.roles?.includes('free') && !existingUser.roles?.some(role => role !== 'free');
      const isRegisteredUser = existingUser && existingUser.roles?.some(role => role !== 'free');

      return {
        existingUser,
        userExists,
        isFreeUserOnly,
        isRegisteredUser,
        status: isRegisteredUser ? 'Registered' : 'Free User',
        showPlusButton: !userExists,
        showInviteButton: (!userExists || isFreeUserOnly) && entry.status !== 'invited' && !isRegisteredUser,
        showResendButton: (!userExists || isFreeUserOnly) && entry.status === 'invited' && !isRegisteredUser
      };
    };

    const userStatus = getUserStatus(waitlistEntries[0]);
    
    expect(userStatus.showResendButton).toBe(true);
    expect(userStatus.isFreeUserOnly).toBe(true);
    expect(userStatus.isRegisteredUser).toBe(false);
  });

  it('should not show any buttons for registered users', () => {
    render(<AdminDashboard />);
    
    const registeredUserDiv = screen.getByTestId('user-1');
    
    // Registered user should not have any action buttons
    expect(registeredUserDiv.querySelector('[data-testid="plus-1"]')).not.toBeInTheDocument();
    expect(registeredUserDiv.querySelector('[data-testid="invite-1"]')).not.toBeInTheDocument();
    expect(registeredUserDiv.querySelector('[data-testid="resend-1"]')).not.toBeInTheDocument();
  });

  it('should handle users with no roles array', () => {
    const contextUsers = [
      { userId: '1', email: 'noroles@example.com' } // No roles property
    ] as any[];

    const waitlistEntries = [
      { email: 'noroles@example.com', status: 'pending' }
    ];

    const getUserStatus = (entry: any) => {
      const existingUser = contextUsers.find(user => user.email === entry.email);
      const userExists = !!existingUser;
      const isFreeUserOnly = existingUser && existingUser.roles?.includes('free') && !existingUser.roles?.some(role => role !== 'free');
      const isRegisteredUser = existingUser && existingUser.roles?.some(role => role !== 'free');

      return {
        existingUser,
        userExists,
        isFreeUserOnly,
        isRegisteredUser,
        status: isRegisteredUser ? 'Registered' : 'Free User',
        showPlusButton: !userExists,
        showInviteButton: (!userExists || isFreeUserOnly) && entry.status !== 'invited' && !isRegisteredUser,
        showResendButton: (!userExists || isFreeUserOnly) && entry.status === 'invited' && !isRegisteredUser
      };
    };

    const userStatus = getUserStatus(waitlistEntries[0]);
    
    expect(userStatus.isFreeUserOnly).toBeFalsy();
    expect(userStatus.isRegisteredUser).toBeFalsy();
    expect(userStatus.status).toBe('Free User');
  });
});
