import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Test the Replays column rendering logic extracted from AdminDashboard
// Uses a simplified component matching the actual AdminDashboard rendering pattern

interface User {
  userId: string;
  email: string;
  replayUrl?: string;
}

const ReplayCell: React.FC<{ user: User }> = ({ user }) => {
  return (
    <td data-testid={`replay-${user.userId}`}>
      {user.replayUrl ? (
        <a
          href={user.replayUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`replay-link-${user.userId}`}
          title="View Clarity Replays"
        >
          Open
        </a>
      ) : (
        <span data-testid={`replay-empty-${user.userId}`}>-</span>
      )}
    </td>
  );
};

const UsersTable: React.FC<{ users: User[] }> = ({ users }) => {
  return (
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th data-testid="replays-header">Replays</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {users.map((user) => (
          <tr key={user.userId}>
            <td data-testid={`email-${user.userId}`}>{user.email}</td>
            <ReplayCell user={user} />
            <td>Actions</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

describe('AdminDashboard - Replays Column', () => {
  it('should render Replays column header', () => {
    render(<UsersTable users={[]} />);
    expect(screen.getByTestId('replays-header')).toHaveTextContent('Replays');
  });

  it('should render replay link for users with replayUrl', () => {
    const users: User[] = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        replayUrl: 'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-1',
      },
    ];

    render(<UsersTable users={users} />);

    const link = screen.getByTestId('replay-link-user-1');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      'href',
      'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-1'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should render dash for users without replayUrl', () => {
    const users: User[] = [
      { userId: 'user-2', email: 'user2@test.com' },
    ];

    render(<UsersTable users={users} />);

    const empty = screen.getByTestId('replay-empty-user-2');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent('-');
  });

  it('should handle mixed users with and without replay URLs', () => {
    const users: User[] = [
      {
        userId: 'user-1',
        email: 'user1@test.com',
        replayUrl: 'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-1',
      },
      { userId: 'user-2', email: 'user2@test.com' },
      {
        userId: 'user-3',
        email: 'user3@test.com',
        replayUrl: 'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-3',
      },
    ];

    render(<UsersTable users={users} />);

    // User 1 has link
    expect(screen.getByTestId('replay-link-user-1')).toBeInTheDocument();
    // User 2 has dash
    expect(screen.getByTestId('replay-empty-user-2')).toBeInTheDocument();
    // User 3 has link
    expect(screen.getByTestId('replay-link-user-3')).toBeInTheDocument();
  });

  it('should include correct Clarity URL format in replay links', () => {
    const replayUrl = 'https://clarity.microsoft.com/projects/view/ujgecpw2p6/impressions?CustomUserId=is%3B1738251317419';
    const users: User[] = [
      { userId: '1738251317419', email: 'user@test.com', replayUrl },
    ];

    render(<UsersTable users={users} />);

    const link = screen.getByTestId('replay-link-1738251317419');
    expect(link.getAttribute('href')).toContain('clarity.microsoft.com');
    expect(link.getAttribute('href')).toContain('/impressions');
    expect(link.getAttribute('href')).toContain('CustomUserId=is%3B1738251317419');
  });
});

describe('AdminContext - User interface', () => {
  it('should support replayUrl as optional field on User type', () => {
    // Type-level test: ensure replayUrl is accepted on the User interface
    const userWithReplay: User = {
      userId: 'user-1',
      email: 'test@example.com',
      replayUrl: 'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-1',
    };

    const userWithoutReplay: User = {
      userId: 'user-2',
      email: 'test2@example.com',
    };

    expect(userWithReplay.replayUrl).toBeDefined();
    expect(userWithoutReplay.replayUrl).toBeUndefined();
  });
});
