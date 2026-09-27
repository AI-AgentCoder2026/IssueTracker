/**
 * Application shell: sidebar (with the project switcher), top bar and the
 * routed content area. Also owns the manual theme toggle.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { asProjectId, type ProjectId } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProjectProvider, useProjects } from '../projects/ProjectContext';
import { useRealtime, type RealtimeStatus } from '../realtime/useRealtime';
import { Button } from './Button';
import { Menu, MenuItem, MenuSeparator } from './Menu';
import { NotificationBell } from './NotificationBell';
import { ProjectSwitcher } from './ProjectSwitcher';

type ThemeMode = 'system' | 'light' | 'dark';
const THEME_KEY = 'tracker.theme';

function readTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    if (mode === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Storage may be unavailable; the in-session choice still applies.
  }
}

const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function ThemeToggle(): JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(readTheme);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={`${THEME_LABEL[mode]}. Switch to ${THEME_NEXT[mode]} theme.`}
      title={THEME_LABEL[mode]}
      onClick={() => setMode(THEME_NEXT[mode])}
    >
      <span aria-hidden="true">{mode === 'dark' ? '🌙' : mode === 'light' ? '☀' : '🌗'}</span>
    </Button>
  );
}

export function AppShell({ projectId }: { projectId: ProjectId | null }): JSX.Element {
  const { user, logout } = useAuth();
  const { projects, activeProject } = useProjects();
  const { status, reconnect } = useRealtime();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [projectId]);

  const base = projectId === null ? '' : `/p/${projectId}`;
  const numericProjectId = projectId === null ? null : (projectId as number);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      {sidebarOpen ? (
        <div className="sidebar-scrim" role="presentation" onClick={() => setSidebarOpen(false)} />
      ) : null}

      <nav className={sidebarOpen ? 'sidebar is-open' : 'sidebar'} aria-label="Primary">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            IT
          </span>
          <span className="truncate">Issue Tracker</span>
        </div>

        <div className="sidebar-scroll">
          <div className="sidebar-section">
            <div className="sidebar-section-title">Project</div>
            <ProjectSwitcher />
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">Work</div>
            <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              <SideLink to={`${base}/board`} disabled={base === ''}>
                Board
              </SideLink>
              <SideLink to={`${base}/issues`} disabled={base === ''}>
                Issues
              </SideLink>
              <SideLink to={`${base}/issues/new`} disabled={base === ''}>
                New issue
              </SideLink>
              <SideLink to={`${base}/dashboards`} disabled={base === ''}>
                Dashboards
              </SideLink>
            </ul>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-title">Settings</div>
            <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              <SideLink to={`${base}/settings`} disabled={base === ''}>
                General
              </SideLink>
              <SideLink to={`${base}/settings/members`} disabled={base === ''}>
                Members
              </SideLink>
              <SideLink to={`${base}/settings/workflow`} disabled={base === ''}>
                Workflow
              </SideLink>
              <SideLink to={`${base}/settings/labels`} disabled={base === ''}>
                Labels
              </SideLink>
              <SideLink to={`${base}/settings/gitlab`} disabled={base === ''}>
                GitLab
              </SideLink>
              <SideLink to={`${base}/settings/guests`} disabled={base === ''}>
                Guest access
              </SideLink>
              {/* Account settings are user-scoped, not project-scoped, so
                  this link is deliberately outside the project section. */}
              <SideLink to="/account" disabled={false}>
                Account
              </SideLink>
            </ul>
          </div>
        </div>

        <div className="sidebar-footer">
          <ConnectionStatus status={status} onReconnect={reconnect} />
        </div>
      </nav>

      <div className="app-main">
        <header className="topbar">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="sidebar-toggle"
            aria-label="Toggle navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ☰
          </Button>
          <div className="breadcrumbs grow truncate">
            {activeProject === null ? (
              <span>All projects</span>
            ) : (
              <>
                <span>{activeProject.key}</span>
                <span aria-hidden="true">/</span>
                <span className="truncate">{activeProject.name}</span>
              </>
            )}
          </div>
          <NotificationBell projectId={numericProjectId} />
          <ThemeToggle />
          <Menu
            label="Account"
            align="right"
            renderTrigger={({ open, toggle, ref }) => (
              <button
                ref={ref}
                type="button"
                className="btn btn--ghost"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                onClick={toggle}
              >
                <span aria-hidden="true">👤</span>
                <span className="truncate" style={{ maxWidth: 120 }}>
                  {user?.displayName ?? 'Account'}
                </span>
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    close();
                    void navigate('/notifications');
                  }}
                >
                  Notifications
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    close();
                    void navigate('/projects');
                  }}
                >
                  All projects ({projects.length})
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onSelect={() => {
                    close();
                    void logout().then(() => navigate('/login'));
                  }}
                >
                  Sign out
                </MenuItem>
              </>
            )}
          </Menu>
        </header>

        <main
          className={location.pathname.endsWith('/board') ? 'app-content app-content--flush' : 'app-content'}
          id="main-content"
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SideLink({
  to,
  children,
  disabled,
}: {
  to: string;
  children: ReactNode;
  disabled: boolean;
}): JSX.Element {
  if (disabled) {
    return (
      <li>
        <span className="nav-link" aria-disabled="true" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
          {children}
        </span>
      </li>
    );
  }
  return (
    <li>
      <NavLink to={to} className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}>
        {children}
      </NavLink>
    </li>
  );
}

function ConnectionStatus({
  status,
  onReconnect,
}: {
  status: RealtimeStatus;
  onReconnect: () => void;
}): JSX.Element {
  if (status === 'open') {
    return (
      <p className="subtle" role="status">
        <span className="presence-dot" aria-hidden="true" /> Live updates connected
      </p>
    );
  }
  return (
    <p className="subtle">
      Live updates {status === 'closed' ? 'off' : status} ·{' '}
      <button type="button" className="inline-link" onClick={onReconnect}>
        Reconnect
      </button>
    </p>
  );
}

/** Resolves `:projectId` from the route and mounts the shell + project context. */
export function ProjectLayout(): JSX.Element {
  const params = useParams();
  const raw = params.projectId;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const projectId: ProjectId | null = Number.isFinite(parsed) ? asProjectId(parsed) : null;

  return (
    <ProjectProvider activeProjectId={projectId}>
      <AppShell projectId={projectId} />
    </ProjectProvider>
  );
}
