import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mirror of the inline "LLM Cost" quota cell in AdminDashboard's Users tab
// (deducted spend vs cost cap). The per-model burn breakdown modal is covered
// directly against the real component in CostBreakdownBody.test.tsx.

interface User {
  userId: string;
  email: string;
  roles?: string[];
  subscriptionType?: string;
  tokenUsage?: { month: string; totalTokens: number; totalCost: number; resetDate: string };
  tokenUsageHistory?: Array<{ month: string; totalTokens: number; totalCost: number }>;
}

// --- Mirror of the inline "LLM Cost" quota cell ---
const CostQuotaCell: React.FC<{ user: User; costAllowanceMap: Record<string, number | null>; currentMonth: string }> = ({
  user,
  costAllowanceMap,
  currentMonth,
}) => {
  if (!user.roles?.includes('customer')) return <span>—</span>;
  const costUsed = user.tokenUsage?.month === currentMonth ? user.tokenUsage?.totalCost ?? 0 : 0;
  const costAllowance = costAllowanceMap[user.subscriptionType || 'Basic'] ?? null;
  return (
    <span>
      ${costUsed.toFixed(2)} / {costAllowance != null ? `$${costAllowance.toFixed(2)}` : '∞'} deducted
    </span>
  );
};

describe('AdminDashboard LLM cost quota (isolated)', () => {
  const currentMonth = '2026-07';

  it('shows dollar spend against the cost cap for a customer with a cap', () => {
    const user: User = {
      userId: 'u1',
      email: 'c1@example.com',
      roles: ['customer'],
      subscriptionType: 'Pro',
      tokenUsage: { month: currentMonth, totalTokens: 1000, totalCost: 3.5, resetDate: '' },
    };
    render(<CostQuotaCell user={user} costAllowanceMap={{ Pro: 10 }} currentMonth={currentMonth} />);
    expect(screen.getByText('$3.50 / $10.00 deducted')).toBeInTheDocument();
  });

  it('shows ∞ when the tier has no cost cap configured', () => {
    const user: User = {
      userId: 'u2',
      email: 'c2@example.com',
      roles: ['customer'],
      subscriptionType: 'Basic',
      tokenUsage: { month: currentMonth, totalTokens: 1000, totalCost: 2, resetDate: '' },
    };
    render(<CostQuotaCell user={user} costAllowanceMap={{ Basic: null }} currentMonth={currentMonth} />);
    expect(screen.getByText('$2.00 / ∞ deducted')).toBeInTheDocument();
  });

  it('treats a stale (previous-month) tokenUsage as $0 spent this month', () => {
    const user: User = {
      userId: 'u3',
      email: 'c3@example.com',
      roles: ['customer'],
      subscriptionType: 'Pro',
      tokenUsage: { month: '2026-06', totalTokens: 1000, totalCost: 9, resetDate: '' },
    };
    render(<CostQuotaCell user={user} costAllowanceMap={{ Pro: 10 }} currentMonth={currentMonth} />);
    expect(screen.getByText('$0.00 / $10.00 deducted')).toBeInTheDocument();
  });

  it('renders — for non-customer users', () => {
    const user: User = { userId: 'u4', email: 'partner@example.com', roles: ['partner'] };
    render(<CostQuotaCell user={user} costAllowanceMap={{}} currentMonth={currentMonth} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
