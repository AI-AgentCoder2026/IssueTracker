/** Sidebar project switcher: keyboard-navigable list of the user's projects. */

import { useNavigate } from 'react-router-dom';
import { useProjects } from '../projects/ProjectContext';
import { Skeleton } from './Skeleton';
import { Menu, MenuItem, MenuSeparator } from './Menu';

export function ProjectSwitcher(): JSX.Element {
  const { projects, activeProject, isLoading, error } = useProjects();
  const navigate = useNavigate();

  return (
    <Menu
      label="Switch project"
      placement="below"
      renderTrigger={({ open, toggle, ref }) => (
        <button
          ref={ref}
          type="button"
          className="switcher-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="switcher-key">{activeProject?.key ?? '—'}</span>
          <span className="grow truncate" style={{ textAlign: 'left' }}>
            {activeProject?.name ?? 'Select a project'}
          </span>
          <span aria-hidden="true" className="subtle">
            â–¾
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          {isLoading ? (
            <div style={{ padding: 8 }}>
              <Skeleton height="16px" />
              <div style={{ height: 6 }} />
              <Skeleton height="16px" />
            </div>
          ) : error !== null ? (
            <p className="muted" style={{ padding: 8 }}>
              Could not load projects.
            </p>
          ) : projects.length === 0 ? (
            <p className="muted" style={{ padding: 8 }}>
              You are not a member of any project yet.
            </p>
          ) : (
            projects.map((project) => (
              <MenuItem
                key={project.id}
                current={project.id === activeProject?.id}
                onSelect={() => {
                  close();
                  void navigate(`/p/${project.id}/board`);
                }}
              >
                <span className="switcher-key">{project.key}</span>
                <span className="grow truncate">{project.name}</span>
              </MenuItem>
            ))
          )}
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              close();
              void navigate('/projects');
            }}
          >
            All projects…
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
