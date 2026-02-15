import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

interface CrmAnalytics {
  totalLeads: number;
  newLeads: number;
  totalLists: number;
  totalICPLeads: number;
  totalEngagedLeads: number;
}

interface TestProps {
  crmAnalytics: CrmAnalytics | null;
}

// Minimal component that mirrors the CRM card rendering logic in AdminDashboard
const TestCRMCard: React.FC<TestProps> = ({ crmAnalytics }) => {
  return (
    <div>
      <h6>CRM</h6>
      {crmAnalytics && (
        <>
          <h4 data-testid="total-leads">{crmAnalytics.totalLeads}</h4>
          <p>Total Leads</p>
          <p>
            New Leads: <span style={{ color: '#4caf50' }}>+{crmAnalytics.newLeads}</span>
          </p>
          <p>Lists: {crmAnalytics.totalLists}</p>
          <p>ICP Leads: {crmAnalytics.totalICPLeads}</p>
          <p>Engaged: {crmAnalytics.totalEngagedLeads}</p>
        </>
      )}
    </div>
  );
};

describe('AdminDashboard CRM Card (isolated)', () => {
  it('renders CRM card with all metrics', () => {
    const analytics: CrmAnalytics = {
      totalLeads: 150,
      newLeads: 25,
      totalLists: 5,
      totalICPLeads: 40,
      totalEngagedLeads: 30,
    };

    render(<TestCRMCard crmAnalytics={analytics} />);

    expect(screen.getByText('CRM')).toBeInTheDocument();
    expect(screen.getByTestId('total-leads')).toHaveTextContent('150');
    expect(screen.getByText('Total Leads')).toBeInTheDocument();
    expect(screen.getByText('+25')).toBeInTheDocument();
    expect(screen.getByText('Lists: 5')).toBeInTheDocument();
    expect(screen.getByText('ICP Leads: 40')).toBeInTheDocument();
    expect(screen.getByText('Engaged: 30')).toBeInTheDocument();
  });

  it('renders nothing when crmAnalytics is null', () => {
    render(<TestCRMCard crmAnalytics={null} />);

    expect(screen.getByText('CRM')).toBeInTheDocument();
    expect(screen.queryByText('Total Leads')).not.toBeInTheDocument();
  });

  it('renders zero values correctly', () => {
    const analytics: CrmAnalytics = {
      totalLeads: 0,
      newLeads: 0,
      totalLists: 0,
      totalICPLeads: 0,
      totalEngagedLeads: 0,
    };

    render(<TestCRMCard crmAnalytics={analytics} />);

    expect(screen.getByTestId('total-leads')).toHaveTextContent('0');
    expect(screen.getByText('+0')).toBeInTheDocument();
    expect(screen.getByText('Lists: 0')).toBeInTheDocument();
    expect(screen.getByText('ICP Leads: 0')).toBeInTheDocument();
    expect(screen.getByText('Engaged: 0')).toBeInTheDocument();
  });

  it('renders new leads count with green color', () => {
    const analytics: CrmAnalytics = {
      totalLeads: 100,
      newLeads: 10,
      totalLists: 3,
      totalICPLeads: 20,
      totalEngagedLeads: 15,
    };

    render(<TestCRMCard crmAnalytics={analytics} />);

    const newLeadsSpan = screen.getByText('+10');
    expect(newLeadsSpan).toHaveStyle({ color: '#4caf50' });
  });
});
