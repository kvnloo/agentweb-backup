import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import App from "../App";

jest.mock("../contexts/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../contexts/AdminContext", () => ({
  AdminProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../components/Layout", () => {
  const { Outlet } = require("react-router-dom");
  return function MockLayout() {
    return (
      <div>
        <div>Layout Shell</div>
        <Outlet />
      </div>
    );
  };
});

jest.mock("../components/PartnerRoute", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div>
      <div>Partner Gate</div>
      {children}
    </div>
  ),
}));

jest.mock("../components/AdminRoute", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../components/PrivateRoute", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../components/CustomerRoute", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("../pages/Login", () => () => <div>Login</div>);
jest.mock("../pages/Register", () => () => <div>Register</div>);
jest.mock("../pages/Tasks", () => () => <div>Tasks</div>);
jest.mock("../pages/CreateTask", () => () => <div>CreateTask</div>);
jest.mock("../pages/TaskDetails", () => () => <div>TaskDetails</div>);
jest.mock("../pages/ExecutionDetails", () => () => <div>ExecutionDetails</div>);
jest.mock("../pages/SharedExecution", () => () => <div>SharedExecution</div>);
jest.mock("../pages/OAuthCallback", () => () => <div>OAuthCallback</div>);
jest.mock("../pages/AdminDashboard", () => () => <div>AdminDashboard</div>);
jest.mock("../pages/GTMPlans", () => () => <div>GTMPlans</div>);
jest.mock("../pages/Profile", () => () => <div>Profile</div>);
jest.mock("../pages/Config", () => () => <div>Config</div>);
jest.mock("../pages/Workflows", () => () => <div>Workflows</div>);
jest.mock("../pages/WorkflowBuilder", () => () => <div>WorkflowBuilder</div>);
jest.mock("../pages/WorkflowDetails", () => () => <div>WorkflowDetails</div>);
jest.mock("../pages/WorkflowRun", () => () => <div>WorkflowRun</div>);
jest.mock("../pages/WorkflowExecutionDetails", () => () => <div>WorkflowExecutionDetails</div>);
jest.mock("../pages/Release", () => () => <div>Release</div>);
jest.mock("../pages/Templates", () => () => <div>Templates</div>);
jest.mock("../pages/HtmlTemplates", () => () => <div>HTML Templates Page</div>);
jest.mock("../pages/Skills", () => () => <div>Skills</div>);
jest.mock("../pages/WorkPlans", () => () => <div>WorkPlans</div>);
jest.mock("../pages/ScheduleTemplates", () => () => <div>ScheduleTemplates</div>);
jest.mock("../pages/ClientHealth", () => () => <div>ClientHealth</div>);
jest.mock("../pages/PromptTemplates", () => () => <div>PromptTemplates</div>);
jest.mock("../pages/Api", () => () => <div>Api</div>);
jest.mock("../pages/marketing", () => () => <div>Marketing</div>);

describe("App html-templates route", () => {
  it("renders HtmlTemplates at /html-templates through PartnerRoute", () => {
    window.history.pushState({}, "", "/html-templates");

    render(<App />);

    expect(screen.getByText("Layout Shell")).toBeInTheDocument();
    expect(screen.getByText("Partner Gate")).toBeInTheDocument();
    expect(screen.getByText("HTML Templates Page")).toBeInTheDocument();
  });
});
