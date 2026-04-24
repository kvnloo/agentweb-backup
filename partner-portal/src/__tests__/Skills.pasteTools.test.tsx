import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { BrowserRouter } from 'react-router-dom';
import Skills from '../pages/Skills';
import '@testing-library/jest-dom';

// Mock config
jest.mock('../config', () => ({
  buildApiUrl: (path: string) => path,
  API_URL: 'http://localhost:3001',
  DEBUG: false,
}));

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock useAuth
jest.mock('../contexts/AuthContext', () => {
  const actual = jest.requireActual('../contexts/AuthContext');
  return {
    ...actual,
    useAuth: () => ({
      token: 'mock-token',
      user: { userId: 'admin-123', isAdmin: true },
      login: jest.fn(),
      logout: jest.fn(),
      isAuthenticated: true,
    }),
  };
});

// Mock skillService
jest.mock('../services/skillService', () => ({
  __esModule: true,
  default: {
    getAllSkills: jest.fn().mockResolvedValue([]),
    createSkill: jest.fn().mockResolvedValue({}),
    updateSkill: jest.fn().mockResolvedValue({}),
    deleteSkill: jest.fn().mockResolvedValue({}),
    getSyncStatus: jest.fn().mockResolvedValue({ skills: {}, environment: 'production' }),
    getSkillAssignments: jest.fn().mockResolvedValue([]),
    syncSkill: jest.fn().mockResolvedValue({}),
  },
}));

const mockAvailableTools = [
  { name: 'list_gtm_plans', description: 'List all GTM plans' },
  { name: 'read_gtm_plan', description: 'Read a GTM plan' },
  { name: 'create_gtm_plan', description: 'Create a GTM plan' },
  { name: 'update_gtm_plan', description: 'Update a GTM plan' },
  { name: 'add_gtm_phase', description: 'Add a phase to a GTM plan' },
  { name: 'add_gtm_work_items', description: 'Add work items' },
  { name: 'send_email', description: 'Send an email' },
];

function renderSkills() {
  return render(
    <BrowserRouter>
      <Skills />
    </BrowserRouter>
  );
}

describe('Skills - Paste Tools Feature', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock the axios.create instance and direct axios.get
    const mockAxiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    };
    (axios.create as jest.Mock).mockReturnValue(mockAxiosInstance);

    // Mock the direct axios.get calls
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes('subscription-types')) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes('public-skills')) {
        return Promise.resolve({ data: { allowedSkills: [] } });
      }
      // Default: function-calls endpoint
      return Promise.resolve({ data: { functionCalls: mockAvailableTools } });
    });
  });

  it('should render the Paste Tools button in the create skill dialog', async () => {
    renderSkills();

    // Wait for loading to finish
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    // Open create skill dialog
    fireEvent.click(screen.getByText('Create Skill'));

    // Check for the Paste Tools button
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });
  });

  it('should open paste dialog when Paste Tools button is clicked', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));

    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));

    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });
  });

  it('should show recognition feedback as user types tool names', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    // Type comma-separated tool names (2 valid, 1 invalid)
    const textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    fireEvent.change(textarea, { target: { value: 'list_gtm_plans, read_gtm_plan, fake_tool' } });

    // Should show recognition feedback
    await waitFor(() => {
      expect(screen.getByText(/2 of 3 tool name\(s\) recognized/)).toBeInTheDocument();
    });

    // Should show unrecognized warning
    expect(screen.getByText(/Unrecognized: fake_tool/)).toBeInTheDocument();
  });

  it('should add recognized tools when confirmed', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    fireEvent.change(textarea, { target: { value: 'list_gtm_plans, create_gtm_plan' } });

    // Click the Add button
    const addButton = screen.getByText(/Add 2 Tool\(s\)/);
    expect(addButton).not.toBeDisabled();
    fireEvent.click(addButton);

    // Paste dialog should close and tool count should update
    await waitFor(() => {
      expect(screen.queryByText('Paste Tool Names')).not.toBeInTheDocument();
    });

    // The tool counter should reflect the 2 selected tools
    await waitFor(() => {
      expect(screen.getByText(/2 of 7 tools selected/)).toBeInTheDocument();
    });
  });

  it('should disable Add button when no tools are recognized', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    fireEvent.change(textarea, { target: { value: 'fake_tool_1, fake_tool_2' } });

    const addButton = screen.getByText(/Add 0 Tool\(s\)/);
    expect(addButton).toBeDisabled();
  });

  it('should close paste dialog on Cancel', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    // Click Cancel
    const cancelButtons = screen.getAllByText('Cancel');
    // The last Cancel is from the paste dialog
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText('Paste Tool Names')).not.toBeInTheDocument();
    });
  });

  it('should handle case-insensitive tool name matching', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    fireEvent.change(textarea, { target: { value: 'LIST_GTM_PLANS, SEND_EMAIL' } });

    await waitFor(() => {
      expect(screen.getByText(/2 of 2 tool name\(s\) recognized/)).toBeInTheDocument();
    });
  });

  it('should handle newline-separated tool names', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    // Simulate newline-separated input
    fireEvent.change(textarea, { target: { value: 'list_gtm_plans\nread_gtm_plan\nadd_gtm_phase' } });

    await waitFor(() => {
      expect(screen.getByText(/3 of 3 tool name\(s\) recognized/)).toBeInTheDocument();
    });
  });

  it('should deduplicate tools when pasting names that are already selected', async () => {
    renderSkills();

    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Skill'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tools')).toBeInTheDocument();
    });

    // First paste: add 2 tools
    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    let textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    fireEvent.change(textarea, { target: { value: 'list_gtm_plans, create_gtm_plan' } });
    fireEvent.click(screen.getByText(/Add 2 Tool\(s\)/));

    await waitFor(() => {
      expect(screen.queryByText('Paste Tool Names')).not.toBeInTheDocument();
    });

    // Second paste: add overlapping + new tool
    fireEvent.click(screen.getByText('Paste Tools'));
    await waitFor(() => {
      expect(screen.getByText('Paste Tool Names')).toBeInTheDocument();
    });

    textarea = screen.getByPlaceholderText('Paste tool names, one per line or comma-separated...');
    fireEvent.change(textarea, { target: { value: 'list_gtm_plans, send_email' } });

    // Should show that 2 are recognized but 1 is already selected
    await waitFor(() => {
      expect(screen.getByText(/2 of 2 tool name\(s\) recognized/)).toBeInTheDocument();
      expect(screen.getByText(/1 new, 1 already selected/)).toBeInTheDocument();
    });
  });
});
