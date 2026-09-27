/**
 * Project selection shared by the sidebar switcher, the page shell and every
 * project-scoped page. The active project comes from the URL so a reload or a
 * shared link lands on the same view.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '../api/hooks';
import { projectApi } from '../api/repo';
import type { Project, ProjectId } from '../api/types';

export interface ProjectContextValue {
  projects: Project[];
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  /** Project matching the current route, when the route is project-scoped. */
  activeProject: Project | null;
  setActiveProjectId: (projectId: ProjectId | null) => void;
  /** Human label for a project id, falling back to the numeric id. */
  labelFor: (projectId: ProjectId) => string;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({
  children,
  activeProjectId,
}: {
  children: ReactNode;
  activeProjectId: ProjectId | null;
}): JSX.Element {
  const [overrideId, setOverrideId] = useState<ProjectId | null>(null);
  const query = useQuery<Project[]>((signal) => projectApi.list(signal), []);

  const projects = query.data ?? [];
  const setActiveProjectId = useCallback((projectId: ProjectId | null) => {
    setOverrideId(projectId);
  }, []);

  const activeProject = useMemo(() => {
    const wanted = overrideId ?? activeProjectId;
    if (wanted === null) return projects[0] ?? null;
    return projects.find((project) => project.id === wanted) ?? null;
  }, [projects, activeProjectId, overrideId]);

  const labelFor = useCallback(
    (projectId: ProjectId) => {
      const match = projects.find((project) => project.id === projectId);
      return match === undefined ? `Project ${projectId}` : `${match.key} · ${match.name}`;
    },
    [projects],
  );

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      isLoading: query.isLoading,
      error: query.error,
      refetch: query.refetch,
      activeProject,
      setActiveProjectId,
      labelFor,
    }),
    [
      projects,
      query.isLoading,
      query.error,
      query.refetch,
      activeProject,
      setActiveProjectId,
      labelFor,
    ],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjects(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (context === null) throw new Error('useProjects must be used inside a ProjectProvider');
  return context;
}
