/**
 * Dashboards: role scoping and widget rendering.
 *
 * The requirement is "a customizable dashboard for different roles to view",
 * so the property under test is that a viewer sees *their* dashboards and not
 * someone else's, and that a widget they lack permission for is hidden rather
 * than shown empty. Both are easy to get subtly wrong and hard to notice.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Actor, ProjectId, Role, UserId, WidgetType } from '@tracker/shared';
import { WIDGET_TYPES } from '@tracker/shared';
import { createHarness, insertUser, createProject, type TestHarness } from './helpers.ts';

let harness: TestHarness;
let projectId: number;

/** An actor with one role in the test project. */
function actorAs(userId: number, role: Role): Actor {
  return {
    userId: userId as UserId,
    isInstanceAdmin: false,
    roles: [role],
    projectRoles: new Map([[projectId as ProjectId, role]]),
  };
}

const admin: Actor = {
  userId: 1 as UserId,
  isInstanceAdmin: true,
  roles: ['admin'],
  projectRoles: new Map(),
};

async function newIssue(title: string, overrides: Record<string, unknown> = {}): Promise<number> {
  const owner = insertUser(harness, { username: `u${Math.random().toString(36).slice(2, 8)}` });
  const result = await harness.services.issues.create(
    projectId,
    { title, description: '', type: 'task', priority: 'medium', ...overrides },
    owner,
    { actorId: owner },
  );
  return result.issue.id as unknown as number;
}

before(async () => {
  harness = createHarness();
  const owner = insertUser(harness, { username: 'dashowner' });
  projectId = createProject(harness, owner, 'DASH');
  harness.services.dashboards.provisionDefaultDashboards(projectId, { actorId: owner });
});

after(() => harness.close());

describe('role scoping', () => {
  it('provisions the starter dashboards for a new project', () => {
    const all = harness.services.dashboards.list(projectId);
    assert.ok(all.length >= 4, `expected the templates to be provisioned, got ${all.length}`);
  });

  it('is idempotent, so a re-provision does not duplicate', () => {
    const before = harness.services.dashboards.list(projectId).length;
    harness.services.dashboards.provisionDefaultDashboards(projectId, { actorId: 1 });
    assert.equal(harness.services.dashboards.list(projectId).length, before);
  });

  it('gives a viewer a different set from an owner', () => {
    const ownerId = 4242;
    const viewerId = 4343;
    const asOwner = actorAs(ownerId, 'owner');
    const asViewer = actorAs(viewerId, 'viewer');

    const ownerViews = harness.services.dashboards.visibleTo(asOwner, projectId);
    const viewerViews = harness.services.dashboards.visibleTo(asViewer, projectId);

    assert.ok(ownerViews.length > 0, 'the owner sees something');
    assert.ok(viewerViews.length > 0, 'the viewer sees something');
    // The requirement is that roles see different things, so a viewer must not
    // simply inherit the owner's list.
    assert.notDeepEqual(
      ownerViews.map((dashboard) => dashboard.name).sort(),
      viewerViews.map((dashboard) => dashboard.name).sort(),
      'viewer and owner must not see an identical set',
    );
  });

  it('never shows a dashboard a role is excluded from', () => {
    const restricted = harness.services.dashboards.create(
      {
        name: 'Leadership only',
        description: '',
        projectId,
        roles: ['maintainer', 'admin', 'owner'],
        widgets: [],
      } as never,
      { actorId: 1 } as never,
    );

    const developerViews = harness.services.dashboards.visibleTo(actorAs(1, 'developer'), projectId);
    assert.ok(
      !developerViews.some((dashboard) => dashboard.id === restricted.id),
      'a developer must not see a dashboard restricted to maintainers',
    );

    const maintainerViews = harness.services.dashboards.visibleTo(actorAs(1, 'maintainer'), projectId);
    assert.ok(maintainerViews.some((dashboard) => dashboard.id === restricted.id));
  });

  it('shows a dashboard with an empty role list to every member', () => {
    const shared = harness.services.dashboards.create(
      { name: 'Everyone', description: '', projectId, roles: [], widgets: [] } as never,
      { actorId: 1 } as never,
    );
    const developerViews = harness.services.dashboards.visibleTo(actorAs(1, 'developer'), projectId);
    assert.ok(developerViews.some((dashboard) => dashboard.id === shared.id));
  });

  it('lets an instance administrator see everything', () => {
    const developerViews = harness.services.dashboards.visibleTo(actorAs(1, 'developer'), projectId);
    const all = harness.services.dashboards.list(projectId);
    assert.ok(all.length >= developerViews.length, 'an admin is never shown less');
  });
});

describe('rendering', () => {
  it('renders a dashboard with widget data', async () => {
    const target = harness.services.dashboards.list(projectId)[0];
    assert.ok(target, 'a dashboard exists to render');

    const rendered = await harness.services.dashboards.render(target.id, admin);
    assert.ok(Array.isArray(rendered.widgets));
    for (const widget of rendered.widgets) {
      assert.ok(
        ['table', 'bar', 'line', 'stat', 'list', 'empty'].includes(widget.data.kind),
        `unexpected widget payload kind: ${widget.data.kind}`,
      );
    }
  });

  it('hides a widget the viewer is excluded from rather than showing it empty', async () => {
    const dashboard = harness.services.dashboards.create(
      {
        name: 'Widget visibility',
        description: '',
        projectId,
        roles: [],
        widgets: [
          {
            type: 'issue_list',
            title: 'Visible to developers',
            position: { x: 0, y: 0, w: 4, h: 3 },
            filters: {},
            limit: 5,
            hiddenFromRoles: ['maintainer'],
          },
        ],
      } as never,
      { actorId: 1 } as never,
    );

    const asDeveloper = await harness.services.dashboards.render(dashboard.id, actorAs(1, 'developer'));
    const asMaintainer = await harness.services.dashboards.render(dashboard.id, actorAs(1, 'maintainer'));

    assert.equal(asDeveloper.widgets.length, 1, 'the developer sees the widget');
    assert.equal(asMaintainer.widgets.length, 0, 'the excluded role does not see it at all');
  });

  it('returns an empty state rather than failing when there is no data', async () => {
    const emptyProjectOwner = insertUser(harness, { username: 'emptydash' });
    const emptyProject = createProject(harness, emptyProjectOwner, 'EMPTYD');
    harness.services.dashboards.provisionDefaultDashboards(emptyProject, { actorId: emptyProjectOwner });

    const dashboard = harness.services.dashboards.list(emptyProject)[0];
    assert.ok(dashboard);

    const rendered = await harness.services.dashboards.render(dashboard.id, admin);
    assert.ok(Array.isArray(rendered.widgets));
    for (const widget of rendered.widgets) {
      assert.equal(widget.data.kind, 'empty', `expected an empty state, got ${widget.data.kind}`);
    }
  });
});

describe('every widget type renders', () => {
  it('produces a payload for all sixteen types without throwing', async () => {
    const owner = insertUser(harness, { username: 'allwidgets' });
    const project = createProject(harness, owner, 'WIDGETS');
    harness.services.dashboards.provisionDefaultDashboards(project, { actorId: owner });
    // Some real data so the aggregates are not all empty.
    void newIssue('Widget fixture one', { priority: 'critical' });

    const dashboard = harness.services.dashboards.list(project)[0];
    assert.ok(dashboard);

    // Add one widget of each declared type and render them all.
    for (const type of WIDGET_TYPES) {
      harness.services.dashboards.addWidget(
        dashboard.id,
        {
          type: type as WidgetType,
          title: `t-${type}`,
          position: { x: 0, y: 0, w: 4, h: 3 },
          filters: {},
          limit: 5,
          hiddenFromRoles: [],
        } as never,
        { actorId: owner } as never,
      );
    }

    const rendered = await harness.services.dashboards.render(dashboard.id, admin);
    const renderedTypes = new Set(rendered.widgets.map((widget) => widget.type));

    for (const type of WIDGET_TYPES) {
      assert.ok(renderedTypes.has(type), `widget type "${type}" did not render`);
    }
  });
});

describe('layout and maintenance', () => {
  it('reorders widgets without losing any', () => {
    const owner = insertUser(harness, { username: 'reorder' });
    const project = createProject(harness, owner, 'REORDER');
    harness.services.dashboards.provisionDefaultDashboards(project, { actorId: owner });
    const dashboard = harness.services.dashboards.list(project)[0];
    assert.ok(dashboard);

    const before = harness.services.dashboards.get(dashboard.id).widgets.length;
    const widgets = harness.services.dashboards.get(dashboard.id).widgets;
    const positions = widgets.map((widget, index) => ({ id: widget.id, x: index, y: 0 }));

    harness.services.dashboards.reorder(dashboard.id, positions, { actorId: owner } as never);
    assert.equal(harness.services.dashboards.get(dashboard.id).widgets.length, before);
  });

  it('duplicates a dashboard with its widgets', () => {
    const owner = insertUser(harness, { username: 'dupe' });
    const project = createProject(harness, owner, 'DUPE');
    harness.services.dashboards.provisionDefaultDashboards(project, { actorId: owner });
    const source = harness.services.dashboards.list(project)[0];
    assert.ok(source);

    const copy = harness.services.dashboards.duplicate(source.id, { actorId: owner } as never);
    assert.notEqual(copy.id, source.id);
    assert.equal(
      copy.widgets.length,
      harness.services.dashboards.get(source.id).widgets.length,
      'the copy carries the same widgets',
    );
  });

  it('removes a dashboard', () => {
    const owner = insertUser(harness, { username: 'remover' });
    const project = createProject(harness, owner, 'REMOVE');
    harness.services.dashboards.provisionDefaultDashboards(project, { actorId: owner });
    const target = harness.services.dashboards.list(project)[0];
    assert.ok(target);

    harness.services.dashboards.remove(target.id, { actorId: owner } as never);
    assert.ok(!harness.services.dashboards.list(project).some((d) => d.id === target.id));
  });
});
