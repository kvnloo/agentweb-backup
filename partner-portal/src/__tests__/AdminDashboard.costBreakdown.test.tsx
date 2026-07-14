import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// These minimal components mirror the LLM-cost UI added to AdminDashboard's Users
// tab: the inline cost quota (deducted spend vs cost cap) and the per-model burn
// breakdown modal. They replicate the exact display/aggregation logic so the math
// (by-model rollup, burn vs deducted vs absorbed) is covered without mounting the
// full AdminDashboard (which requires many contexts).

interface User {
  userId: string;
  email: string;
  roles?: string[];
  subscriptionType?: string;
  tokenUsage?: { month: string; totalTokens: number; totalCost: number; resetDate: string };
  tokenUsageHistory?: Array<{ month: string; totalTokens: number; totalCost: number }>;
}

interface UsageRow {
  date: string;
  model: string;
  feature: string;
  totalTokens: number;
  callCount: number;
  costUsd: number;
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

// --- Mirror of the deduction lookup used by the modal header ---
const deductedCostForMonth = (user: User, month: string): number => {
  if (user.tokenUsage?.month === month) return user.tokenUsage?.totalCost ?? 0;
  const hist = user.tokenUsageHistory?.find((h) => h.month === month);
  return hist?.totalCost ?? 0;
};

// --- Mirror of the per-model burn breakdown modal body (table + bars views) ---
const BreakdownBody: React.FC<{
  user: User;
  month: string;
  rows: UsageRow[];
  view?: 'table' | 'bars';
  costAllowanceMap?: Record<string, number | null>;
}> = ({ user, month, rows, view = 'table', costAllowanceMap = {} }) => {
  const burn = rows.reduce((acc, r) => acc + r.costUsd, 0);
  const deducted = deductedCostForMonth(user, month);
  const absorbed = Math.max(0, burn - deducted);
  const byModel: Record<string, { model: string; callCount: number; totalTokens: number; costUsd: number }> = {};
  rows.forEach((r) => {
    const m = byModel[r.model] || (byModel[r.model] = { model: r.model, callCount: 0, totalTokens: 0, costUsd: 0 });
    m.callCount += r.callCount;
    m.totalTokens += r.totalTokens;
    m.costUsd += r.costUsd;
  });
  const modelRows = Object.values(byModel).sort((a, b) => b.costUsd - a.costUsd);
  const earliestTracked = rows.length ? rows[0].date : null;
  const burnLagsDeducted = modelRows.length > 0 && burn + 0.005 < deducted;
  // Overall cost quota (bars view): deducted spend vs the tier cap, colored by threshold.
  const costAllowance = costAllowanceMap[user.subscriptionType || 'Basic'] ?? null;
  const quotaPct = costAllowance != null && costAllowance > 0 ? (deducted / costAllowance) * 100 : null;
  const quotaColor = quotaPct == null ? 'none' : quotaPct >= 100 ? 'over' : quotaPct >= 80 ? 'warn' : 'ok';
  return (
    <div>
      <div>Burned (gross) ${burn.toFixed(2)}</div>
      <div>Counted to quota ${deducted.toFixed(2)}</div>
      <div>Absorbed by platform ${absorbed.toFixed(2)}</div>
      {view === 'bars' && (
        costAllowance != null ? (
          <div data-testid="quota-bar" data-color={quotaColor} data-pct={String(Math.min(100, Math.round(quotaPct ?? 0)))}>
            Monthly cost quota ${deducted.toFixed(2)} / ${costAllowance.toFixed(2)} ({Math.round(quotaPct ?? 0)}%)
          </div>
        ) : (
          <div role="alert">This user's tier has no cost cap (unlimited) — no quota bar.</div>
        )
      )}
      {modelRows.length === 0 && <div role="alert">No per-model burn has been recorded for this month yet.</div>}
      {burnLagsDeducted && <div role="alert">Recorded burn (tracked from {earliestTracked}) is lower than the amount counted to this user's quota.</div>}
      {view === 'bars' ? (
        <div data-testid="cost-breakdown-bars">
          {modelRows.map((m) => {
            const share = burn > 0 ? (m.costUsd / burn) * 100 : 0;
            return (
              <div key={m.model} data-testid={`bar-${m.model}`} data-share={share.toFixed(1)}>
                {m.model} ${m.costUsd.toFixed(4)} ({share.toFixed(1)}%)
              </div>
            );
          })}
        </div>
      ) : (
        <table>
          <tbody>
            {modelRows.map((m) => (
              <tr key={m.model}>
                <td>{m.model}</td>
                <td>{m.callCount.toLocaleString()}</td>
                <td>{m.totalTokens.toLocaleString()}</td>
                <td data-testid={`burn-${m.model}`}>${m.costUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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

describe('AdminDashboard per-model burn breakdown (isolated)', () => {
  const month = '2026-07';
  const user: User = {
    userId: 'u1',
    email: 'c1@example.com',
    roles: ['customer'],
    tokenUsage: { month, totalTokens: 5000, totalCost: 4, resetDate: '' },
  };

  it('rolls up per-day/feature rows into per-model totals sorted by burn desc', () => {
    const rows: UsageRow[] = [
      { date: '2026-07-01', model: 'claude-fable-5', feature: 'agent_mode', totalTokens: 1000, callCount: 2, costUsd: 6 },
      { date: '2026-07-02', model: 'claude-fable-5', feature: 'chatbot', totalTokens: 500, callCount: 1, costUsd: 4 },
      { date: '2026-07-01', model: 'gpt-5.2-chat', feature: 'agent_mode', totalTokens: 2000, callCount: 3, costUsd: 1.5 },
    ];
    render(<BreakdownBody user={user} month={month} rows={rows} />);

    // fable aggregated: 6 + 4 = 10; sorted first (desc)
    expect(screen.getByTestId('burn-claude-fable-5')).toHaveTextContent('$10.0000');
    expect(screen.getByTestId('burn-gpt-5.2-chat')).toHaveTextContent('$1.5000');

    const rowsRendered = screen.getAllByRole('row');
    expect(rowsRendered[0]).toHaveTextContent('claude-fable-5');
    expect(rowsRendered[1]).toHaveTextContent('gpt-5.2-chat');
  });

  it('shows gross burn, quota deduction, and platform-absorbed amounts distinctly', () => {
    const rows: UsageRow[] = [
      { date: '2026-07-01', model: 'claude-fable-5', feature: 'agent_mode', totalTokens: 1000, callCount: 2, costUsd: 10 },
    ];
    // burn = 10, deducted (tokenUsage.totalCost) = 4, absorbed = 6
    render(<BreakdownBody user={user} month={month} rows={rows} />);
    expect(screen.getByText('Burned (gross) $10.00')).toBeInTheDocument();
    expect(screen.getByText('Counted to quota $4.00')).toBeInTheDocument();
    expect(screen.getByText('Absorbed by platform $6.00')).toBeInTheDocument();
  });

  it('shows an explanatory empty-state alert (not a broken view) when no burn is recorded', () => {
    render(<BreakdownBody user={user} month={month} rows={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('No per-model burn has been recorded for this month yet.');
    // Deducted counter can still be non-zero even with empty burn.
    expect(screen.getByText('Counted to quota $4.00')).toBeInTheDocument();
  });

  it('flags the ramp-up case where recorded burn is lower than the quota deduction', () => {
    // burn = 1, deducted = 4 → burn lags; absorbed clamps to $0 and an alert explains it.
    const rows: UsageRow[] = [
      { date: '2026-07-05', model: 'gpt-5.2-chat', feature: 'agent_mode', totalTokens: 200, callCount: 1, costUsd: 1 },
    ];
    render(<BreakdownBody user={user} month={month} rows={rows} />);
    expect(screen.getByRole('alert')).toHaveTextContent('tracked from 2026-07-05');
    expect(screen.getByText('Absorbed by platform $0.00')).toBeInTheDocument();
  });

  it('does NOT flag lag when burn meets or exceeds the deduction', () => {
    const rows: UsageRow[] = [
      { date: '2026-07-05', model: 'gpt-5.2-chat', feature: 'agent_mode', totalTokens: 200, callCount: 1, costUsd: 5 },
    ];
    render(<BreakdownBody user={user} month={month} rows={rows} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads deduction from tokenUsageHistory for a past month', () => {
    const histUser: User = {
      ...user,
      tokenUsage: { month, totalTokens: 5000, totalCost: 4, resetDate: '' },
      tokenUsageHistory: [{ month: '2026-06', totalTokens: 3000, totalCost: 2.25 }],
    };
    const rows: UsageRow[] = [
      { date: '2026-06-10', model: 'gpt-5.2-chat', feature: 'agent_mode', totalTokens: 2000, callCount: 1, costUsd: 5 },
    ];
    render(<BreakdownBody user={histUser} month="2026-06" rows={rows} />);
    expect(screen.getByText('Counted to quota $2.25')).toBeInTheDocument();
    expect(screen.getByText('Absorbed by platform $2.75')).toBeInTheDocument();
  });
});

describe('AdminDashboard cost breakdown — bars view (isolated)', () => {
  const month = '2026-07';
  const mkUser = (totalCost: number, tier = 'Starter'): User => ({
    userId: 'u1',
    email: 'c1@example.com',
    roles: ['customer'],
    subscriptionType: tier,
    tokenUsage: { month, totalTokens: 5000, totalCost, resetDate: '' },
  });
  const rows: UsageRow[] = [
    { date: '2026-07-01', model: 'claude-opus-4-8', feature: 'agent_mode', totalTokens: 1000, callCount: 2, costUsd: 9 },
    { date: '2026-07-02', model: 'gpt-4o', feature: 'chatbot', totalTokens: 500, callCount: 1, costUsd: 1 },
  ];

  it('renders the quota bar with deducted / cap and percent', () => {
    render(<BreakdownBody user={mkUser(300)} month={month} rows={rows} view="bars" costAllowanceMap={{ Starter: 360 }} />);
    const bar = screen.getByTestId('quota-bar');
    expect(bar).toHaveTextContent('Monthly cost quota $300.00 / $360.00 (83%)');
    expect(bar).toHaveAttribute('data-pct', '83');
  });

  it('colors the quota bar green < 80%, amber 80–99%, red ≥ 100%', () => {
    const { rerender } = render(<BreakdownBody user={mkUser(180)} month={month} rows={rows} view="bars" costAllowanceMap={{ Starter: 360 }} />);
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-color', 'ok'); // 50%
    rerender(<BreakdownBody user={mkUser(324)} month={month} rows={rows} view="bars" costAllowanceMap={{ Starter: 360 }} />);
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-color', 'warn'); // 90%
    rerender(<BreakdownBody user={mkUser(400)} month={month} rows={rows} view="bars" costAllowanceMap={{ Starter: 360 }} />);
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-color', 'over'); // 111%
  });

  it('shows an unlimited-tier notice instead of a quota bar when no cap', () => {
    // deducted (5) <= burn (10) so the burn-lags-deducted alert doesn't also fire.
    render(<BreakdownBody user={mkUser(5, 'Basic')} month={month} rows={rows} view="bars" costAllowanceMap={{ Basic: null }} />);
    expect(screen.queryByTestId('quota-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('no cost cap (unlimited)');
  });

  it('renders per-model bars sized by share of total burn', () => {
    render(<BreakdownBody user={mkUser(300)} month={month} rows={rows} view="bars" costAllowanceMap={{ Starter: 360 }} />);
    // total burn = 10 → opus 90%, gpt-4o 10%
    expect(screen.getByTestId('bar-claude-opus-4-8')).toHaveAttribute('data-share', '90.0');
    expect(screen.getByTestId('bar-gpt-4o')).toHaveAttribute('data-share', '10.0');
    // bars view shows no table
    expect(screen.queryByRole('row')).not.toBeInTheDocument();
  });

  it('table view (default) shows the table and no bars', () => {
    render(<BreakdownBody user={mkUser(300)} month={month} rows={rows} costAllowanceMap={{ Starter: 360 }} />);
    expect(screen.queryByTestId('cost-breakdown-bars')).not.toBeInTheDocument();
    expect(screen.getByTestId('burn-claude-opus-4-8')).toHaveTextContent('$9.0000');
  });
});
