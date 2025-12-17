import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminDashboard from "../AdminDashboard";
import axios from "axios";

jest.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { isAdmin: true },
  }),
}));

jest.mock("../contexts/AdminContext", () => ({
  useAdmin: () => ({
    users: [],
    waitlist: [],
    taskAnalytics: {},
    userAnalytics: {},
    agentModeAnalytics: {},
    loadUsers: jest.fn(),
    loadWaitlist: jest.fn(),
    loadAnalytics: jest.fn(),
    updateWaitlistStatus: jest.fn(),
    updateWaitlistSupportNote: jest.fn(),
    deleteWaitlistEntry: jest.fn(),
    deleteUser: jest.fn(),
    addToWaitlist: jest.fn(),
    createUserFromWaitlist: jest.fn(),
    setUsers: jest.fn(),
  }),
}));

jest.mock("../components/admin/ImageModelsSettings", () => () => <div data-testid="mock-image-models" />);
jest.mock("../components/admin/DefaultPromptsSettings", () => () => <div data-testid="mock-default-prompts" />);
jest.mock("../components/admin/BenchmarksTab", () => () => <div data-testid="mock-benchmarks" />);
jest.mock("../components/admin/SubscriptionTypesTab", () => () => <div data-testid="mock-subscriptions" />);
jest.mock("../components/admin/AdminCharts", () => ({
  UserGrowthChart: () => <div data-testid="mock-chart" />,
  TaskGrowthChart: () => <div data-testid="mock-chart" />,
  ExecutionTrendsChart: () => <div data-testid="mock-chart" />,
  ExecutionStatusChart: () => <div data-testid="mock-chart" />,
  UserTypeChart: () => <div data-testid="mock-chart" />,
  AgentModeSessionGrowthChart: () => <div data-testid="mock-chart" />,
  AgentModeSessionTypesChart: () => <div data-testid="mock-chart" />,
}));

jest.mock("react-router-dom", () => {
  const actual = jest.requireActual("react-router-dom");
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams("tab=knowledge-base"), jest.fn()],
    useNavigate: () => jest.fn(),
  };
});

jest.mock("../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
  CUSTOMER_FRONTEND_URL: "https://customer.test",
}));

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("AdminDashboard Knowledge Base metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders uploaded file metrics for knowledge base overview and tasks", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        totalTasks: 3,
        tasksWithKnowledgeBase: 2,
        totalKnowledgeBaseSize: 6144,
        averageKnowledgeBaseSize: 3072,
        uploadedFiles: {
          totalFiles: 4,
          totalSize: 4096,
          tasksWithUploadedFiles: 2,
          averageFilesPerTask: 2,
          averageSizePerTask: 2048,
        },
        public: {
          tasks: 2,
          tasksWithKnowledgeBase: 1,
          totalSize: 4096,
          averageSize: 4096,
          uploadedFiles: {
            totalFiles: 3,
            totalSize: 3072,
            tasksWithUploadedFiles: 1,
            averageFilesPerTask: 3,
            averageSizePerTask: 3072,
          },
        },
        private: {
          tasks: 1,
          tasksWithKnowledgeBase: 1,
          totalSize: 2048,
          averageSize: 2048,
          uploadedFiles: {
            totalFiles: 1,
            totalSize: 1024,
            tasksWithUploadedFiles: 1,
            averageFilesPerTask: 1,
            averageSizePerTask: 1024,
          },
        },
        tasks: [
          {
            taskId: "task-1",
            name: "Task One",
            knowledgeBaseSize: 4096,
            owner: "user1",
            type: "public",
            uploadedFilesCount: 3,
            uploadedFilesSize: 3072,
          },
          {
            taskId: "task-2",
            name: "Task Two",
            knowledgeBaseSize: 2048,
            owner: "user2",
            type: "private",
            uploadedFilesCount: 1,
            uploadedFilesSize: 1024,
          },
        ],
      },
    });

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.test/api/admin/knowledge-base-metrics',
        expect.any(Object)
      );
      expect(screen.getAllByText(/Uploaded Files/i).length).toBeGreaterThan(0);
    });

    expect(screen.getByText('4 files (2 tasks)')).toBeInTheDocument();
    expect(screen.getByText('3 files (1 tasks)')).toBeInTheDocument();
    expect(screen.getByText('1 files (1 tasks)')).toBeInTheDocument();

    // Task rows include uploaded file counts
    expect(screen.getByText('Task One')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // uploadedFilesCount for task-1
    expect(screen.getByText('Task Two')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // uploadedFilesCount for task-2
  });
});
