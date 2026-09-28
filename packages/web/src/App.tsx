/** Route table, providers and the auth guard. */

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthGate, useAuth } from './auth/AuthContext';
import { ProjectLayout } from './components/AppShell';
import { ToastProvider } from './components/Toast';
import { RealtimeProvider } from './realtime/useRealtime';
import { Board } from './pages/Board';
import { Dashboard } from './pages/Dashboard';
import { GuestAccess } from './pages/GuestAccess';
import { IssueDetail } from './pages/IssueDetail';
import { Duplicates } from './pages/Duplicates';
import { IssueList } from './pages/IssueList';
import { Login } from './pages/Login';
import { NewIssue } from './pages/NewIssue';
import { Notifications } from './pages/Notifications';
import { Projects } from './pages/Projects';
import { Settings, SettingsGeneral, SettingsLabels } from './pages/Settings';
import { SettingsGitLab } from './pages/SettingsGitLab';
import { AccountSettings } from './pages/AccountSettings';
import { SettingsMembers } from './pages/SettingsMembers';
import { SettingsWorkflow } from './pages/SettingsWorkflow';

/** Sends unauthenticated visitors to `/login`, remembering where they wanted to go. */
function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/** Signed-in users skip the login screen. */
function RedirectIfAuthenticated({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/projects" replace />;
  return <>{children}</>;
}

/** Keeps the document title in step with the route. */
function useDocumentTitle(): void {
  const location = useLocation();
  useEffect(() => {
    document.title = `Issue Tracker · ${titleFor(location.pathname)}`;
  }, [location.pathname]);
}

function titleFor(pathname: string): string {
  if (pathname.startsWith('/login')) return 'Sign in';
  if (pathname.includes('/board')) return 'Board';
  if (pathname.includes('/dashboards')) return 'Dashboards';
  if (pathname.includes('/settings')) return 'Settings';
  if (pathname.includes('/notifications')) return 'Notifications';
  if (pathname.endsWith('/new')) return 'New issue';
  if (/\/issues\/\d+$/.test(pathname)) return 'Issue';
  if (pathname.includes('/issues')) return 'Issues';
  return 'Projects';
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AuthGate>
        <ToastProvider>
          <AuthAwareRealtime>
            <TitleSync />
            <Routes>
              <Route
                path="/login"
                element={
                  <RedirectIfAuthenticated>
                    <Login />
                  </RedirectIfAuthenticated>
                }
              />
              <Route
                path="/projects"
                element={
                  <RequireAuth>
                    <ProjectLayout />
                  </RequireAuth>
                }
              >
                <Route index element={<Projects />} />
              </Route>
              <Route
                path="/notifications"
                element={
                  <RequireAuth>
                    <ProjectLayout />
                  </RequireAuth>
                }
              >
                <Route index element={<Notifications />} />
                <Route path="account" element={<AccountSettings />} />
              </Route>
              <Route
                path="/p/:projectId"
                element={
                  <RequireAuth>
                    <ProjectLayout />
                  </RequireAuth>
                }
              >
                <Route index element={<Navigate to="board" replace />} />
                <Route path="board" element={<Board />} />
                <Route path="issues" element={<IssueList />} />
                <Route path="issues/new" element={<NewIssue />} />
                <Route path="issues/:issueId" element={<IssueDetail />} />
                <Route path="duplicates" element={<Duplicates />} />
                <Route path="dashboards" element={<Dashboard />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="settings" element={<Settings />}>
                  <Route index element={<SettingsGeneral />} />
                  <Route path="members" element={<SettingsMembers />} />
                  <Route path="workflow" element={<SettingsWorkflow />} />
                  <Route path="labels" element={<SettingsLabels />} />
                  <Route path="gitlab" element={<SettingsGitLab />} />
                  <Route path="guests" element={<GuestAccess />} />
                </Route>
              </Route>
              <Route path="*" element={<Navigate to="/projects" replace />} />
            </Routes>
          </AuthAwareRealtime>
        </ToastProvider>
      </AuthGate>
    </BrowserRouter>
  );
}

/** The socket only opens once a session exists, and closes again on sign-out. */
function AuthAwareRealtime({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated } = useAuth();
  return (
    <RealtimeProvider enabled={isAuthenticated}>
      <div className="app-root">{children}</div>
    </RealtimeProvider>
  );
}

function TitleSync(): JSX.Element {
  useDocumentTitle();
  return <></>;
}
