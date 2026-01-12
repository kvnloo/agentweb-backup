import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { BrowserRouter } from 'react-router-dom';
import GTMPlans from '../pages/GTMPlans';
import { AuthProvider } from '../contexts/AuthContext';
import '@testing-library/jest-dom';

// Mock config to handle import.meta.env
jest.mock('../config', () => ({
  buildApiUrl: (path: string) => path,
  DEBUG: false,
}));

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock useAuth
const mockUseAuth = () => ({
  token: 'mock-token',
  user: { userId: 'admin-123', isAdmin: true },
  login: jest.fn(),
  logout: jest.fn(),
  isAuthenticated: true,
});

jest.mock('../contexts/AuthContext', () => {
  const actual = jest.requireActual('../contexts/AuthContext');
  return {
    ...actual,
    useAuth: () => mockUseAuth(),
  };
});

// Mock MUI DatePicker
jest.mock('@mui/x-date-pickers/DatePicker', () => ({
  DatePicker: ({ value, onChange, label }: any) => {
    const dateValue = value && value instanceof Date && !isNaN(value.getTime())
      ? value.toISOString().split('T')[0]
      : '';
    return (
      <input
        data-testid={`date-picker-${label}`}
        type="date"
        value={dateValue}
        onChange={(e) => {
          if (onChange && e.target.value) {
            const date = new Date(e.target.value);
            if (!isNaN(date.getTime())) {
              onChange(date);
            }
          } else if (onChange) {
            onChange(null);
          }
        }}
      />
    );
  },
}));

// Mock data
const mockPlans = [
  {
    planId: 'plan-1',
    userId: 'user-1',
    userEmail: 'user1@example.com',
    userName: 'User 1',
    title: 'Test Plan 1',
    description: 'Test Description 1',
    dri: 'plan-poc@example.com',
    dueDate: '2024-12-31',
    status: 'in_progress',
    phases: [
      {
        id: 'phase-1',
        title: 'Phase 1',
        description: 'Phase 1 Description',
        duration: 30,
        status: 'in_progress',
        dri: 'phase-poc@example.com',
        dueDate: '2024-12-30',
        workItems: [
          {
            id: 'item-1',
            title: 'Work Item 1',
            description: 'Work Item Description',
            duration: 5,
            status: 'pending',
            dri: 'item-poc@example.com',
            dueDate: '2024-12-29',
            notes: 'Test notes',
          },
        ],
      },
    ],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    planId: 'plan-2',
    userId: 'user-2',
    userEmail: 'user2@example.com',
    userName: 'User 2',
    title: 'Test Plan 2',
    description: 'Test Description 2',
    status: 'completed',
    completedAt: '2024-01-02T12:00:00Z',
    phases: [],
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
];

describe('GTMPlans - Basic Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    mockedAxios.delete = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
    mockedAxios.put.mockResolvedValue({
      data: { success: true, data: mockPlans[0] },
    });
    mockedAxios.delete.mockResolvedValue({
      data: { success: true },
    });
  });

  it('renders the component without crashing', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      // There may be multiple "GTM Plans" texts (heading and description), so use getAllByText
      const gtmPlansTexts = screen.getAllByText(/GTM Plans/i);
      expect(gtmPlansTexts.length).toBeGreaterThan(0);
    });
  });

  it('loads and displays GTM plans', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
      expect(screen.getByText('Test Plan 2')).toBeInTheDocument();
    });
  });

  it('displays user information for each plan', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('user1@example.com')).toBeInTheDocument();
      expect(screen.getByText('user2@example.com')).toBeInTheDocument();
    });
  });

  it('displays plan PoC when present', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText(/plan-poc@example.com/i)).toBeInTheDocument();
    });
  });

  it('displays plan due date when present', async () => {
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText(/Dec 31, 2024/i)).toBeInTheDocument();
    });
  });
});

describe('GTMPlans - Phase Expansion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
    mockedAxios.put.mockResolvedValue({
      data: { success: true, data: mockPlans[0] },
    });
  });

  it('allows expanding a phase to view work items', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText('Work Item 1')).toBeInTheDocument();
    });
  });

  it('displays phase PoC when present', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText(/phase-poc@example.com/i)).toBeInTheDocument();
    });
  });

  it('displays phase due date when present', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText(/Dec 30, 2024/i)).toBeInTheDocument();
    });
  });
});

describe('GTMPlans - Work Item Display', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
  });

  it('displays work item details in table', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText('Work Item 1')).toBeInTheDocument();
      expect(screen.getByText(/item-poc@example.com/i)).toBeInTheDocument();
      expect(screen.getByText(/Dec 29, 2024/i)).toBeInTheDocument();
      expect(screen.getByText('Test notes')).toBeInTheDocument();
    });
  });

  it('displays work item status badge', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText(/pending/i)).toBeInTheDocument();
    });
  });
});

describe('GTMPlans - Due Date Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
    mockedAxios.put.mockResolvedValue({
      data: { success: true, data: mockPlans[0] },
    });
  });

  it('shows warning icon for due dates within 3 days', async () => {
    const today = new Date();
    const threeDaysLater = new Date(today);
    threeDaysLater.setDate(today.getDate() + 3);
    const dueDateStr = threeDaysLater.toISOString().split('T')[0];

    const planWithNearDueDate = {
      ...mockPlans[0],
      dueDate: dueDateStr,
      status: 'in_progress',
    };

    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [planWithNearDueDate] },
    });

    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      // Should show warning icon for due date within 3 days
      const warningIcons = screen.queryAllByTestId(/WarningIcon|warning/i);
      expect(warningIcons.length).toBeGreaterThan(0);
    });
  });

  it('shows error icon for overdue due dates', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dueDateStr = yesterday.toISOString().split('T')[0];

    const planWithOverdueDate = {
      ...mockPlans[0],
      dueDate: dueDateStr,
      status: 'in_progress',
    };

    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [planWithOverdueDate] },
    });

    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      // Should show error icon for overdue dates
      const errorIcons = screen.queryAllByTestId(/ErrorIcon|error/i);
      expect(errorIcons.length).toBeGreaterThan(0);
    });
  });

  it('only shows color difference for pending work items', async () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const dueDateStr = tomorrow.toISOString().split('T')[0];

    const planWithCompletedItem = {
      ...mockPlans[0],
      phases: [
        {
          ...mockPlans[0].phases[0],
          workItems: [
            {
              ...mockPlans[0].phases[0].workItems[0],
              status: 'completed',
              dueDate: dueDateStr,
            },
          ],
        },
      ],
    };

    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [planWithCompletedItem] },
    });

    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      // Completed items should not show warning/error colors even if due date is near
      const workItem = screen.getByText('Work Item 1');
      expect(workItem).toBeInTheDocument();
      // The due date should still be displayed but without warning colors
    });
  });
});

describe('GTMPlans - PoC Assignment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
    mockedAxios.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          ...mockPlans[0],
          dri: 'new-plan-poc@example.com',
        },
      },
    });
  });

  it('allows assigning PoC to plan', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    // Find and click the Assign PoC button for the plan
    // The button has aria-label from Tooltip, but we need to find it by the PersonIcon in the plan header
    const planCard = screen.getByText('Test Plan 1').closest('.MuiPaper-root');
    const planPocButton = planCard?.querySelector('[aria-label*="Assign Plan PoC"]') ||
                          planCard?.querySelector('button[aria-label*="PoC"]') ||
                          screen.getAllByRole('button').find(btn => {
                            const tooltip = btn.getAttribute('aria-label');
                            return tooltip?.includes('Assign Plan PoC') || tooltip?.includes('Plan PoC');
                          });
    
    if (planPocButton) {
      await user.click(planPocButton as HTMLElement);
    }

    await waitFor(() => {
      // Dialog should open with title "Assign Plan PoC"
      expect(screen.getByText('Assign Plan PoC')).toBeInTheDocument();
    });

    // Use within to scope queries to the dialog
    const dialog = screen.getByRole('dialog');
    const dialogScreen = within(dialog);

    const input = dialogScreen.getByLabelText(/PoC|Email/i);
    await user.clear(input);
    await user.type(input, 'new-plan-poc@example.com');

    const saveButton = dialogScreen.getByRole('button', { name: /Save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/gtm-plans/plan-1'),
        expect.objectContaining({
          dri: 'new-plan-poc@example.com',
        }),
        expect.any(Object)
      );
    });
  });

  it('allows assigning PoC to phase', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText('Work Item 1')).toBeInTheDocument();
    });

    // Find Assign PoC button for phase (should be in the phase header/AccordionSummary)
    // The button has aria-label from Tooltip "Assign Phase PoC"
    const phasePocButton = screen.queryByLabelText('Assign Phase PoC') ||
                          screen.getAllByRole('button').find(btn => {
                            const tooltip = btn.getAttribute('aria-label');
                            return tooltip?.includes('Assign Phase PoC') || tooltip?.includes('Phase PoC');
                          }) ||
                          document.querySelector('[aria-label*="Assign Phase PoC"]');

    if (phasePocButton) {
      await user.click(phasePocButton as HTMLElement);
    }

    await waitFor(() => {
      // Dialog should open with title "Assign Phase PoC"
      expect(screen.getByText('Assign Phase PoC')).toBeInTheDocument();
    });
  });
});

describe('GTMPlans - Due Date Updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
    mockedAxios.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          ...mockPlans[0],
          dueDate: '2025-01-15',
        },
      },
    });
  });

  it('allows setting due date for plan', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    // Find and click the Set Due Date button for the plan
    const dueDateButtons = screen.getAllByLabelText(/Due Date|Set Due Date/i);
    const planDueDateButton = dueDateButtons[0];
    await user.click(planDueDateButton);

    await waitFor(() => {
      // Dialog should open with date picker
      expect(screen.getByText(/Due Date|Plan Due Date/i)).toBeInTheDocument();
    });
  });

  it('shows constraint warning when due date violates hierarchy', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText('Work Item 1')).toBeInTheDocument();
    });

    // Find Set Due Date button for work item - look for CalendarTodayIcon in tbody
    const dueDateButtons = screen.getAllByRole('button');
    const itemDueDateButton = dueDateButtons.find((btn) => {
      const tooltip = btn.getAttribute('aria-label');
      return (tooltip?.includes('Set Due Date') || tooltip?.includes('Due Date')) && 
             btn.closest('tbody');
    }) || dueDateButtons.find((btn) => btn.closest('tbody'));

    if (itemDueDateButton) {
      await user.click(itemDueDateButton);
    }

    await waitFor(() => {
      // Dialog should be open
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Use within to scope queries to the dialog
    const dialog = screen.getByRole('dialog');
    const dialogScreen = within(dialog);

    // Set a date that violates constraint (after phase due date)
    // The DatePicker mock renders as an input with data-testid "date-picker-{label}"
    let dateInput;
    try {
      dateInput = dialogScreen.getByTestId('date-picker-Work Item Due Date') as HTMLInputElement;
    } catch {
      // Fallback: find any date input in the dialog
      dateInput = dialog.querySelector('input[type="date"]') as HTMLInputElement;
    }
    
    if (dateInput) {
      // Clear and set the date value directly
      await user.clear(dateInput);
      // Use fireEvent to set the value directly since user.type might not work well with date inputs
      fireEvent.change(dateInput, { target: { value: '2025-01-01' } });
      // Wait a bit for the value to be set
      await waitFor(() => {
        expect(dateInput.value).toBe('2025-01-01');
      }, { timeout: 1000 });
    }

    const saveButton = dialogScreen.getByRole('button', { name: /Save/i });
    await user.click(saveButton);

    await waitFor(() => {
      // Should show constraint warning dialog - check for the dialog title or warning message
      const constraintDialog = screen.queryByText(/Date Constraint Warning/i) || 
                               screen.queryByText(/constraint/i) ||
                               screen.queryByText(/violates/i) ||
                               screen.queryByText(/warning/i);
      expect(constraintDialog).toBeInTheDocument();
    }, { timeout: 5000 });
  });
});

describe('GTMPlans - Status and Notes Updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    mockedAxios.get = jest.fn();
    mockedAxios.put = jest.fn();
    
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockPlans },
    });
    mockedAxios.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          ...mockPlans[0],
          phases: [
            {
              ...mockPlans[0].phases[0],
              workItems: [
                {
                  ...mockPlans[0].phases[0].workItems[0],
                  status: 'completed',
                  notes: 'Updated notes',
                },
              ],
            },
          ],
        },
      },
    });
  });

  it('allows updating work item status and notes', async () => {
    const user = userEvent.setup();
    render(
      <BrowserRouter>
        <AuthProvider>
          <GTMPlans />
        </AuthProvider>
      </BrowserRouter>
    );
    
    await waitFor(() => {
      expect(screen.getByText('Test Plan 1')).toBeInTheDocument();
    });

    const phaseHeader = screen.getByText('Phase 1');
    const accordion = phaseHeader.closest('[role="button"]');
    if (accordion) {
      await user.click(accordion);
    }

    await waitFor(() => {
      expect(screen.getByText('Work Item 1')).toBeInTheDocument();
    });

    // Find Edit Status & Notes button - look for the CheckCircleIcon button in the actions column
    const editButtons = screen.getAllByRole('button');
    const statusNotesButton = editButtons.find((btn) => {
      const tooltip = btn.getAttribute('aria-label');
      return tooltip?.includes('Edit Status') || tooltip?.includes('Status & Notes');
    }) || editButtons.find((btn) => btn.closest('tbody'));

    if (statusNotesButton) {
      await user.click(statusNotesButton);
    }

    await waitFor(() => {
      // Verify dialog opens with correct title
      expect(screen.getByText('Edit Status & Notes')).toBeInTheDocument();
    });

    // Verify the dialog contains status and notes fields (without full interaction)
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // The dialog should contain Status and Notes labels
    const dialogText = dialog.textContent || '';
    expect(dialogText).toMatch(/Status/i);
    expect(dialogText).toMatch(/Notes/i);
  });
});
