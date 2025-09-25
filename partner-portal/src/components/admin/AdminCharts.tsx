import React, { useEffect, useRef } from 'react';
import { Box, Paper } from '@mui/material';
import { Chart, ChartConfiguration, registerables } from 'chart.js';

// Register Chart.js components
Chart.register(...registerables);

interface UserGrowthChartProps {
  data: {
    totalUsers: number;
    newUsers: number;
    oauthUsers: number;
    newOauthUsers: number;
    adminUsers: number;
  };
  startDate: string;
  endDate: string;
}

interface TaskGrowthChartProps {
  data: {
    totalTasks: number;
    newTasks: number;
    totalExecutions: number;
    newExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
  };
  startDate: string;
  endDate: string;
}

interface ExecutionTrendsChartProps {
  data: {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    newExecutions: number;
  };
  startDate: string;
  endDate: string;
}

// Generate mock time-series data for demonstration
const generateTimeSeriesData = (startDate: string, endDate: string, total: number, newCount: number) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  
  const labels: string[] = [];
  const data: number[] = [];
  
  // Generate cumulative data over time
  let cumulative = total - newCount;
  const dailyIncrement = newCount / Math.max(days, 1);
  
  for (let i = 0; i <= days; i++) {
    const date = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    cumulative += dailyIncrement;
    data.push(Math.round(cumulative));
  }
  
  return { labels, data };
};

export const UserGrowthChart: React.FC<UserGrowthChartProps> = ({ data, startDate, endDate }) => {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (chartRef.current) {
      // Destroy existing chart
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }

      const timeSeriesData = generateTimeSeriesData(startDate, endDate, data.totalUsers, data.newUsers);
      
      const config: ChartConfiguration = {
        type: 'line',
        data: {
          labels: timeSeriesData.labels,
          datasets: [
            {
              label: 'Total Users',
              data: timeSeriesData.data,
              borderColor: '#1976d2',
              backgroundColor: 'rgba(25, 118, 210, 0.1)',
              fill: true,
              tension: 0.4,
            },
            {
              label: 'OAuth Users',
              data: generateTimeSeriesData(startDate, endDate, data.oauthUsers, data.newOauthUsers).data,
              borderColor: '#4caf50',
              backgroundColor: 'rgba(76, 175, 80, 0.1)',
              fill: false,
              tension: 0.4,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: 'User Growth Over Time'
            },
            legend: {
              position: 'top' as const,
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1
              }
            },
            x: {
              ticks: {
                maxRotation: 45,
                minRotation: 45
              }
            }
          }
        }
      };

      chartInstance.current = new Chart(chartRef.current, config);
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data, startDate, endDate]);

  return (
    <Paper sx={{ p: 2, height: 300 }}>
      <Box sx={{ position: 'relative', height: '100%' }}>
        <canvas ref={chartRef} />
      </Box>
    </Paper>
  );
};

export const TaskGrowthChart: React.FC<TaskGrowthChartProps> = ({ data, startDate, endDate }) => {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (chartRef.current) {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }

      const timeSeriesData = generateTimeSeriesData(startDate, endDate, data.totalTasks, data.newTasks);
      
      const config: ChartConfiguration = {
        type: 'line',
        data: {
          labels: timeSeriesData.labels,
          datasets: [
            {
              label: 'Total Tasks',
              data: timeSeriesData.data,
              borderColor: '#ff9800',
              backgroundColor: 'rgba(255, 152, 0, 0.1)',
              fill: true,
              tension: 0.4,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: 'Task Growth Over Time'
            },
            legend: {
              position: 'top' as const,
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1
              }
            },
            x: {
              ticks: {
                maxRotation: 45,
                minRotation: 45
              }
            }
          }
        }
      };

      chartInstance.current = new Chart(chartRef.current, config);
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data, startDate, endDate]);

  return (
    <Paper sx={{ p: 2, height: 300 }}>
      <Box sx={{ position: 'relative', height: '100%' }}>
        <canvas ref={chartRef} />
      </Box>
    </Paper>
  );
};

export const ExecutionTrendsChart: React.FC<ExecutionTrendsChartProps> = ({ data, startDate, endDate }) => {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (chartRef.current) {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }

      const timeSeriesData = generateTimeSeriesData(startDate, endDate, data.totalExecutions, data.newExecutions);
      
      const config: ChartConfiguration = {
        type: 'line',
        data: {
          labels: timeSeriesData.labels,
          datasets: [
            {
              label: 'Total Executions',
              data: timeSeriesData.data,
              borderColor: '#9c27b0',
              backgroundColor: 'rgba(156, 39, 176, 0.1)',
              fill: true,
              tension: 0.4,
            },
            {
              label: 'Successful Executions',
              data: generateTimeSeriesData(startDate, endDate, data.successfulExecutions, Math.round(data.newExecutions * 0.8)).data,
              borderColor: '#4caf50',
              backgroundColor: 'rgba(76, 175, 80, 0.1)',
              fill: false,
              tension: 0.4,
            },
            {
              label: 'Failed Executions',
              data: generateTimeSeriesData(startDate, endDate, data.failedExecutions, Math.round(data.newExecutions * 0.2)).data,
              borderColor: '#f44336',
              backgroundColor: 'rgba(244, 67, 54, 0.1)',
              fill: false,
              tension: 0.4,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: 'Execution Trends Over Time'
            },
            legend: {
              position: 'top' as const,
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                stepSize: 1
              }
            },
            x: {
              ticks: {
                maxRotation: 45,
                minRotation: 45
              }
            }
          }
        }
      };

      chartInstance.current = new Chart(chartRef.current, config);
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data, startDate, endDate]);

  return (
    <Paper sx={{ p: 2, height: 300 }}>
      <Box sx={{ position: 'relative', height: '100%' }}>
        <canvas ref={chartRef} />
      </Box>
    </Paper>
  );
};

export const ExecutionStatusChart: React.FC<{ data: any }> = ({ data }) => {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (chartRef.current && data) {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }

      const totalExecutions = data.totalExecutions || 0;
      const successfulExecutions = data.successfulExecutions || 0;
      const failedExecutions = data.failedExecutions || 0;
      const pendingExecutions = totalExecutions - successfulExecutions - failedExecutions;

      const config: ChartConfiguration = {
        type: 'doughnut',
        data: {
          labels: ['Successful', 'Failed', 'Pending/Running'],
          datasets: [
            {
              data: [successfulExecutions, failedExecutions, pendingExecutions],
              backgroundColor: ['#4caf50', '#f44336', '#ff9800'],
              borderWidth: 2,
              borderColor: '#fff'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: 'Execution Status Distribution'
            },
            legend: {
              position: 'bottom' as const,
            }
          }
        }
      };

      chartInstance.current = new Chart(chartRef.current, config);
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data]);

  return (
    <Paper sx={{ p: 2, height: 300 }}>
      <Box sx={{ position: 'relative', height: '100%' }}>
        <canvas ref={chartRef} />
      </Box>
    </Paper>
  );
};

export const UserTypeChart: React.FC<{ data: any }> = ({ data }) => {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  useEffect(() => {
    if (chartRef.current && data) {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }

      const totalUsers = data.totalUsers || 0;
      const oauthUsers = data.oauthUsers || 0;
      const regularUsers = totalUsers - oauthUsers;
      const adminUsers = data.adminUsers || 0;

      const config: ChartConfiguration = {
        type: 'pie',
        data: {
          labels: ['Regular Users', 'OAuth Users', 'Admin Users'],
          datasets: [
            {
              data: [regularUsers, oauthUsers, adminUsers],
              backgroundColor: ['#2196f3', '#4caf50', '#ff9800'],
              borderWidth: 2,
              borderColor: '#fff'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: 'User Type Distribution'
            },
            legend: {
              position: 'bottom' as const,
            }
          }
        }
      };

      chartInstance.current = new Chart(chartRef.current, config);
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data]);

  return (
    <Paper sx={{ p: 2, height: 300 }}>
      <Box sx={{ position: 'relative', height: '100%' }}>
        <canvas ref={chartRef} />
      </Box>
    </Paper>
  );
};
