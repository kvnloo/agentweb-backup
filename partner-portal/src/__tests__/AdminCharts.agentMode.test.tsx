import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { AgentModeSessionGrowthChart, AgentModeSessionTypesChart } from '../components/admin/AdminCharts';

// Mock Chart.js
jest.mock('chart.js', () => {
  const mockChart = {
    destroy: jest.fn(),
    update: jest.fn(),
  };
  
  const MockChart: any = jest.fn().mockImplementation(() => mockChart);
  MockChart.register = jest.fn();
  MockChart.getChart = jest.fn(() => mockChart);
  
  return {
    Chart: MockChart,
    registerables: [],
  };
});

describe('AgentModeSessionGrowthChart', () => {
  const mockData = {
    totalSessions: 100,
    newSessions: 20,
    totalScheduledSessions: 10,
    totalNonScheduledSessions: 90,
    newScheduledSessions: 2,
    newNonScheduledSessions: 18,
    dailyGrowth: [
      { date: '2024-01-01', scheduled: 1, nonScheduled: 5 },
      { date: '2024-01-02', scheduled: 1, nonScheduled: 6 },
      { date: '2024-01-03', scheduled: 0, nonScheduled: 7 },
    ],
  };

  it('should render without crashing', () => {
    const { container } = render(
      <AgentModeSessionGrowthChart
        data={mockData}
        startDate="2024-01-01"
        endDate="2024-01-03"
      />
    );
    // Check that canvas element is rendered
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('should handle empty dailyGrowth data', () => {
    const emptyData = {
      ...mockData,
      dailyGrowth: [],
    };
    const { container } = render(
      <AgentModeSessionGrowthChart
        data={emptyData}
        startDate="2024-01-01"
        endDate="2024-01-03"
      />
    );
    // Check that canvas element is rendered
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('should handle missing optional fields', () => {
    const minimalData = {
      totalSessions: 50,
      newSessions: 10,
      dailyGrowth: [],
    };
    const { container } = render(
      <AgentModeSessionGrowthChart
        data={minimalData}
        startDate="2024-01-01"
        endDate="2024-01-03"
      />
    );
    // Check that canvas element is rendered
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });
});

describe('AgentModeSessionTypesChart', () => {
  const mockData = {
    sessionTypes: {
      regular: 50,
      scheduled: 20,
      'predefined-work-plan': 15,
      'image-generation': 10,
      'video-generation': 5,
    },
    sessionTypesInRange: {
      regular: 10,
      scheduled: 5,
      'predefined-work-plan': 3,
      'image-generation': 2,
      'video-generation': 1,
    },
  };

  it('should render without crashing', () => {
    const { container } = render(<AgentModeSessionTypesChart data={mockData} />);
    // Check that canvas element is rendered
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('should handle empty sessionTypes', () => {
    const emptyData = {
      sessionTypes: {},
      sessionTypesInRange: {},
    };
    const { container } = render(<AgentModeSessionTypesChart data={emptyData} />);
    // Check that canvas element is rendered
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('should handle all session types including video-generation', () => {
    const allTypesData = {
      sessionTypes: {
        regular: 30,
        scheduled: 20,
        'predefined-work-plan': 15,
        'image-generation': 10,
        'video-generation': 5,
      },
      sessionTypesInRange: {
        regular: 10,
        scheduled: 5,
        'predefined-work-plan': 3,
        'image-generation': 2,
        'video-generation': 1,
      },
    };
    const { container } = render(<AgentModeSessionTypesChart data={allTypesData} />);
    // Check that canvas element is rendered
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });
});

