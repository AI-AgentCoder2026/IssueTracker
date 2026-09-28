/**
 * Instance-wide user administration.
 *
 * Distinct from project membership: this is the list of people who exist,
 * gated on `instance.settings`. It is also the only place an account can be
 * deactivated, and it deliberately shows the instance role alongside the
 * project ones, because "is this person an admin" is not answerable from any
 * project page.
 *
 * Deactivating is reversible and is not deletion: the user keeps their history
 * and their audit entries, and can be reactivated. The server refuses to let
 * an administrator deactivate their own account, which is the one action here
 * that could lock everyone out.
 */

import { useState } from 'react';
import { useMutation, useQuery } from '../api/hooks';
import { userApi } from '../api/repo';
import type { PublicUser } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Field, Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import { formatDate, formatRelative } from '../lib/format';

const INSTANCE_ROLES = ['user', 'staff', 'admin'] as const;

const NEW_USER = {
  username: '',
  email: '',
  displayName: '',
  password: '',
  instanceRole: 'user' as (typeof INSTANCE_ROLES)[number],
};

export function AdminUsers(): JSX.Element {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [draft, setDraft] = useState({ ...NEW_USER });

  const usersQuery = useQuery<PublicUser[]>(
    (signal) => userApi.list({ search, includeInactive, limit: 200, signal }),
    [search, includeInactive],
  );

  const create = useMutation<typeof NEW_USER, PublicUser>(
    (input) => userApi.createUser(input),
    {
      onSuccess: (user) => {
        setDraft({ ...NEW_USER });
        usersQuery.refetch();
        toast.success(`${user.displayName} added`);
      },
      onError: (error) => toast.apiError(error),
    },
  );

  if (usersQuery.error !== null) {
    return <ErrorState error={usersQuery.error} onRetry={usersQuery.refetch} />;
  }

  const users = usersQuery.data ?? [];
  const ready =
    draft.username.trim() !== '' &&
    draft.email.trim() !== '' &&
    draft.displayName.trim() !== '' &&
    draft.password.length >= 12;

  const columns: Column<PublicUser>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <span>
          {row.displayName}
          <span className="subtle"> · {row.username}</span>
        </span>
      ),
    },
    { key: 'email', header: 'Email', render: (row) => row.email },
    {
      key: 'role',
      header: 'Instance role',
      render: (row) => (
        <Select
          label=""
          value={row.instanceRole ?? 'user'}
          options={INSTANCE_ROLES.map((value) => ({ value, label: value }))}
          onChange={(value) => {
            void userApi
              .updateUser(row.id, { instanceRole: value, isActive: row.isActive })
              .then(() => {
                usersQuery.refetch();
                toast.success(`${row.displayName} is now ${value}`);
              })
              .catch((error: unknown) => toast.apiError(error as never));
          }}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? (
          <Badge tone="success">active</Badge>
        ) : (
          <Badge tone="neutral">deactivated</Badge>
        ),
    },
    {
      key: 'last',
      header: 'Last seen',
      render: (row) =>
        row.lastLoginAt === null ? (
          <span className="subtle">never</span>
        ) : (
          <span className="nowrap" title={row.lastLoginAt}>
            {formatRelative(row.lastLoginAt)}
          </span>
        ),
    },
    {
      key: 'since',
      header: 'Added',
      render: (row) => (
        <span className="nowrap" title={row.createdAt}>
          {formatDate(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const turningOff = row.isActive;
            const agreed = await confirm({
              title: turningOff
                ? `Deactivate ${row.displayName}?`
                : `Reactivate ${row.displayName}?`,
              message: turningOff
                ? 'They lose access immediately. Their history and audit entries are kept, and this can be undone.'
                : 'They regain access immediately.',
              confirmLabel: turningOff ? 'Deactivate' : 'Reactivate',
              destructive: turningOff,
            });
            if (!agreed) return;
            try {
              if (turningOff) await userApi.deactivate(row.id);
              else await userApi.updateUser(row.id, { isActive: true } as never);
              usersQuery.refetch();
              toast.success(turningOff ? 'Account deactivated' : 'Account reactivated');
            } catch (error) {
              toast.apiError(error as never);
            }
          }}
        >
          {row.isActive ? 'Deactivate' : 'Reactivate'}
        </Button>
      ),
    },
  ];

  return (
    <div className="stack">
      <header>
        <h1>People</h1>
        <p className="subtle">
          Everyone with an account on this instance. Deactivating removes access but keeps
          their history; it is reversible.
        </p>
      </header>

      <section className="card card-pad stack" aria-label="Add a person">
        <h2>Add a person</h2>
        <div className="row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Field label="Username" htmlFor="nu-username">
            <input
              id="nu-username"
              className="input"
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            />
          </Field>
          <Field label="Display name" htmlFor="nu-display">
            <input
              id="nu-display"
              className="input"
              value={draft.displayName}
              onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            />
          </Field>
          <Field label="Email" htmlFor="nu-email">
            <input
              id="nu-email"
              className="input"
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </Field>
          <Field
            label="Initial password"
            htmlFor="nu-password"
            hint="At least 12 characters, with upper case, lower case and a digit."
          >
            <input
              id="nu-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </Field>
          <Field label="Instance role" htmlFor="nu-role">
            <select
              id="nu-role"
              className="input"
              value={draft.instanceRole}
              onChange={(e) =>
                setDraft({ ...draft, instanceRole: e.target.value as (typeof INSTANCE_ROLES)[number] })
              }
            >
              {INSTANCE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <Button
            onClick={() => create.mutate(draft)}
            disabled={!ready}
            loading={create.isPending}
          >
            Add person
          </Button>
        </div>
      </section>

      <div className="filter-bar">
        <div className="grow" style={{ minWidth: 220 }}>
          <Field label="Search" htmlFor="people-search" hint="Matches username, email or name.">
            <input
              id="people-search"
              className="input"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show deactivated
        </label>
      </div>

      {usersQuery.isLoading ? (
        <SkeletonRows rows={6} height="40px" />
      ) : users.length === 0 ? (
        <EmptyState
          icon="👥"
          title="No people match"
          description="Try a different search, or include deactivated accounts."
        />
      ) : (
        <DataTable
          caption="Instance users"
          columns={columns}
          rows={users}
          rowKey={(row) => row.id}
        />
      )}

      {dialog}
    </div>
  );
}
