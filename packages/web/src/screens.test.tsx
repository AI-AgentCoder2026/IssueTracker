/**
 * Render smoke tests for every screen.
 *
 * Eight screens were added in one stretch and none of them was ever mounted.
 * Typechecking proves the imports resolve and the props type; it says nothing
 * about whether a component throws on its first render, and every area of this
 * codebase that had no tests turned out to have defects in it.
 *
 * `fetch` is stubbed rather than mocked per-module, because the failure mode
 * worth catching is a component that reads a field the API layer does not
 * produce -- a stub at the transport exercises the real normalisers too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

import { AdminUsers } from './pages/AdminUsers';
import { ArchiveSettings } from './pages/ArchiveSettings';
import { AuditViewer } from './pages/AuditViewer';
import { Duplicates } from './pages/Duplicates';
import { ProjectSla } from './pages/ProjectSla';
import { WebhookSettings } from './pages/WebhookSettings';
import { RealtimeProvider } from './realtime/useRealtime';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './auth/AuthContext';
import { ProjectProvider } from './projects/ProjectContext';

/** A response body for any GET, keyed loosely by the path that asked for it. */
const RESPONSES: Record<string, unknown> = {
  '/api/users': { users: [], total: 0 },
  '/api/dedupe/candidates': { candidates: [] },
  '/api/archive/policy': { projectId: 1, policy: null },
  '/api/archive/candidates': { candidates: [] },
  '/api/sla/at-risk': { clocks: [] },
  '/api/sla/breached': { clocks: [] },
  '/api/sla/policies': { policies: [] },
  '/api/projects/1/webhooks': { webhooks: [] },
  '/api/admin/audit': { entries: [], total: 0, nextCursor: null },
};

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input.toString());
      const path = url.split('?')[0] ?? url;
      const body = RESPONSES[path] ?? {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** Mount a page at a route, inside the providers it expects. */
async function mount(element: ReactElement, path = '/p/1/duplicates'): Promise<void> {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/p/:projectId/*"
          element={
            <RealtimeProvider enabled={false}>
              <AuthProvider>
                <ProjectProvider activeProjectId={1}>
                  <ToastProvider>{element}</ToastProvider>
                </ProjectProvider>
              </AuthProvider>
            </RealtimeProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  // One tick for the query effects to settle before asserting on content.
  await waitFor(() => expect(document.body).toBeTruthy());
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('screens mount', () => {
  it('duplicate review', async () => {
    await mount(<Duplicates />);
    expect(await screen.findByRole('heading', { name: /possible duplicates/i })).toBeTruthy();
    expect(screen.getByText(/no pending duplicate pairs/i)).toBeTruthy();
  });

  it('bulk editing bar and export control', async () => {
    const { IssueList } = await import('./pages/IssueList');
    await mount(<IssueList />, '/p/1/issues');
    expect(await screen.findByRole('heading', { name: /^issues$/i })).toBeTruthy();
    // The export control is on the list toolbar, and must be present even with
    // nothing selected.
    expect(screen.getByRole('button', { name: /^export$/i })).toBeTruthy();
  });

  it('stale issue archiving', async () => {
    await mount(<ArchiveSettings />, '/p/1/archive');
    expect(await screen.findByRole('heading', { name: /stale issue archiving/i })).toBeTruthy();
    expect(screen.getByText(/nothing to archive/i)).toBeTruthy();
  });

  it('SLA overview', async () => {
    await mount(<ProjectSla />, '/p/1/sla');
    expect(await screen.findByRole('heading', { name: /service levels/i })).toBeTruthy();
    expect(screen.getByText(/nothing breached/i)).toBeTruthy();
  });

  it('webhook settings', async () => {
    await mount(<WebhookSettings />, '/p/1/webhooks');
    expect(await screen.findByRole('heading', { name: /^webhooks$/i })).toBeTruthy();
    expect(screen.getByText(/no webhooks yet/i)).toBeTruthy();
  });

  it('audit trail viewer', async () => {
    await mount(<AuditViewer />, '/p/1/audit');
    expect(await screen.findByRole('heading', { name: /audit trail/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify chain/i })).toBeTruthy();
  });

  it('user administration', async () => {
    await mount(<AdminUsers />, '/p/1/people');
    expect(await screen.findByRole('heading', { name: /^people$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /add person/i })).toBeTruthy();
  });
});

/**
 * The same screens against realistic payloads.
 *
 * Mounting on empty responses only proves a component does not throw. The
 * defects worth catching are the ones where a field is read wrongly and the
 * screen still renders -- an empty box, a zero, a wrong badge -- which is
 * exactly how the rendered-widget bug survived every other check.
 */
describe('screens render real data', () => {
  const clock = (over: Record<string, unknown>): Record<string, unknown> => ({
    policyId: 1,
    issueId: 42,
    target: 'response',
    startsAt: '2026-09-01T09:00:00.000Z',
    dueAt: '2026-09-01T10:00:00.000Z',
    remainingMs: 3_600_000,
    metAt: null,
    breached: false,
    state: 'on_track',
    ...over,
  });

  beforeEach(() => {
    Object.assign(RESPONSES, {
      '/api/dedupe/candidates': {
        candidates: [
          {
            linkId: 7,
            sourceIssueId: 11,
            sourceKey: 'APP-1',
            sourceTitle: 'Checkout times out',
            targetIssueId: 12,
            targetKey: 'APP-2',
            targetTitle: 'Checkout hangs on discount',
            confidence: 0.91,
            createdAt: '2026-09-01T09:00:00.000Z',
          },
          {
            // An exact match carries no score at all.
            linkId: 8,
            sourceIssueId: 13,
            sourceKey: 'APP-3',
            sourceTitle: 'Same thing',
            targetIssueId: 14,
            targetKey: 'APP-4',
            targetTitle: 'Same thing',
            confidence: null,
            createdAt: '2026-09-01T09:00:00.000Z',
          },
        ],
      },
      '/api/sla/at-risk': { clocks: [clock({ remainingMs: 1_800_000, state: 'at_risk' })] },
      '/api/sla/breached': {
        clocks: [clock({ remainingMs: -7_200_000, state: 'breached', breached: true })],
      },
      '/api/projects/1/webhooks': {
        webhooks: [
          {
            id: 3,
            projectId: 1,
            name: 'Deploy hook',
            targetUrl: 'https://example.com/hook',
            events: ['issue.created', 'ping'],
            enabled: true,
            failureCount: 4,
            disabledAt: null,
            createdAt: '2026-09-01T09:00:00.000Z',
            updatedAt: '2026-09-02T09:00:00.000Z',
          },
        ],
      },
      '/api/admin/audit': {
        entries: [
          {
            id: 99,
            actorId: 1,
            actorName: 'Wren Halliday',
            actorEmail: 'wren@example.com',
            ipAddress: '127.0.0.1',
            userAgent: 'test',
            action: 'issue.deleted',
            entityType: 'issue',
            entityId: '42',
            projectId: 1,
            before: null,
            after: null,
            rowHash: 'abcdef0123456789',
            prevHash: '9876543210fedcba',
            createdAt: '2026-09-02T10:00:00.000Z',
          },
        ],
        total: 1,
        nextCursor: null,
      },
      '/api/users': {
        users: [
          {
            id: 5,
            username: 'wren',
            email: 'wren@example.com',
            displayName: 'Wren Halliday',
            avatarUrl: null,
            provider: 'local',
            isInstanceAdmin: false,
            isActive: true,
            timezone: 'UTC',
            locale: 'en',
            lastLoginAt: null,
            createdAt: '2026-09-01T09:00:00.000Z',
            updatedAt: '2026-09-01T09:00:00.000Z',
            instanceRole: 'staff',
          },
        ],
        total: 1,
      },
    });
  });

  it('shows a duplicate pair with its score, and an exact match as such', async () => {
    await mount(<Duplicates />);
    expect(await screen.findByText('91% similar')).toBeTruthy();
    expect(screen.getByText('exact match')).toBeTruthy();
    // Both sides of the pair, not just the count.
    expect(screen.getByText(/Checkout times out/)).toBeTruthy();
    expect(screen.getByText(/Checkout hangs on discount/)).toBeTruthy();
  });

  it('separates at-risk from breached, and shows a breach as overdue', async () => {
    await mount(<ProjectSla />, '/p/1/sla');
    // A regex, because the summary is one paragraph whose text continues past
    // the part that matters.
    expect(await screen.findByText(/1 breached · 1 at risk\./)).toBeTruthy();
    // A breached clock reads as time *overdue*, not time remaining.
    expect(screen.getByText('2h')).toBeTruthy();
    expect(screen.getByText('30m')).toBeTruthy();
    expect(screen.getAllByText('breached').length).toBeGreaterThan(0);
    expect(screen.getAllByText('at risk').length).toBeGreaterThan(0);
  });

  it('surfaces a failing webhook instead of showing it as healthy', async () => {
    await mount(<WebhookSettings />, '/p/1/webhooks');
    expect(await screen.findByText('Deploy hook')).toBeTruthy();
    expect(screen.getByText('4 failed')).toBeTruthy();
    expect(screen.getByText('enabled')).toBeTruthy();
    expect(screen.getByText('https://example.com/hook')).toBeTruthy();
  });

  it('shows an audit entry with its action and chain hash', async () => {
    await mount(<AuditViewer />, '/p/1/audit');
    expect(await screen.findByText('issue.deleted')).toBeTruthy();
    expect(screen.getByText(/Wren Halliday/)).toBeTruthy();
    expect(screen.getByText('abcdef0123…')).toBeTruthy();
    expect(screen.getByText(/^1 entries matching$/)).toBeTruthy();
  });

  it('shows a person with their instance role', async () => {
    await mount(<AdminUsers />, '/p/1/people');
    expect(await screen.findByText(/Wren Halliday/)).toBeTruthy();
    expect(screen.getByText(/wren@example.com/)).toBeTruthy();
    // The role comes from a field the shared type omits but the API returns.
    expect(screen.getByDisplayValue('staff')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
  });
});
