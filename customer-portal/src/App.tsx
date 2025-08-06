import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "@/components/layout/Layout";
import Dashboard from "@/pages/Dashboard";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import OAuthCallback from "@/pages/OAuthCallback";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import { AuthProvider } from "@/contexts/AuthContext";
import { TemplateProvider } from "@/contexts/TemplateContext";
import TasksPage from "@/pages/Tasks.tsx";
import TaskDetailsPage from "@/pages/TaskDetails.tsx";
import GuidePage from "@/pages/GuidePage.tsx";
import ExecutionResultPage from "@/pages/ExecutionResultPage.tsx";
import ChangelogPage from "@/pages/ChangelogPage.tsx";
import BrandGuidelines from "@/pages/BrandGuidelines.tsx";
import MarketStrategy from "@/pages/MarketStrategy.tsx";
import ImagesPage from "@/pages/Images.tsx";
import VideosPage from "@/pages/Videos.tsx";
import ResearchReportsPage from "@/pages/ResearchReports.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <TemplateProvider>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/oauth-callback" element={<OAuthCallback />} />

              {/* Protected routes */}
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Dashboard />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/settings"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Settings />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/brand-guidelines"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <BrandGuidelines />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/market-strategy"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <MarketStrategy />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/research-reports"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <ResearchReportsPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tasks"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <TasksPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tasks/:taskId"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <TaskDetailsPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tasks/:taskId/executions/:executionId/result"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <ExecutionResultPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/guide"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <GuidePage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/changelog"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <ChangelogPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/images"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <ImagesPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/videos"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <VideosPage />
                    </Layout>
                  </ProtectedRoute>
                }
              />

              {/* 404 route */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </TemplateProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
