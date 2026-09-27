/** Members and roles: invite, change role, remove. */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '../api/hooks';
import { projectApi } from '../api/repo';
import { ROLES, ROLE_RANK, asProjectId, type MemberView, type Role } from '../api/types';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState, ErrorState } from '../components/EmptyState';
import { useConfirm } from '../components/Modal';
import { Select } from '../components/Select';
import { SkeletonRows } from '../components/Skeleton';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';

export function SettingsMembers(): JSX.Element {
  const params = useParams();
  const projectId = asProjectId(Number(params.projectId));
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [invite, setInvite] = useState({ usernameOrEmail: '', role: 'developer' as Role });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const membersQuery = useQuery<MemberView[]>((signal) => projectApi.members(projectId, signal), [projectId]);

  const addMember = useMutation<{ usernameOrEmail: string; role: Role }, unknown>(
    (input) => projectApi.addMember(projectId, input),
    {
      onSuccess: () => {
        setInvite({ usernameOrEmail: '', role: 'developer' });
        setFieldErrors({});
        toast.success('Member added');
        membersQuery.refetch();
      },
      onError: (error) => {
        toast.apiError(error);
        setFieldErrors({ usernameOrEmail: error instanceof Error ? error.message : 'Could not add member' });
      },
    },
  );

  const setRole = useMutation<{ userId: number; role: Role }, unknown>(
    ({ userId, role }) => projectApi.updateMember(projectId, userId, { role }),
    {
      onSuccess: () => {
        toast.success('Role updated');
        membersQuery.refetch();
      },
      onError: (error) => toast.apiError(error),
    },
  );

  const members = membersQuery.data ?? [];

  const columns: ReadonlyArray<Column<MemberView>> = [
    {
      key: 'member',
      header: 'Member',
      render: (member) => (
        <span className="row" style={{ gap: 8 }}>
          <Avatar name={member.user.displayName} src={member.user.avatarUrl} />
          <span>
            <span className="truncate" style={{ display: 'block', fontWeight: 500 }}>
              {member.user.displayName}
            </span>
            <span className="subtle">
              {member.user.email} · @{member.user.username}
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: '190px',
      render: (member) => (
        <Select
          label={`Role for ${member.user.displayName}`}
          hideLabel
          value={member.role}
          options={ROLES.map((role) => ({ value: role, label: role }))}
          onChange={(role) => void setRole.mutate({ userId: member.userId as number, role })}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (member) => (
        <Badge tone={member.user.isActive ? 'success' : 'neutral'}>
          {member.user.isActive ? 'active' : 'inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      width: '110px',
      render: (member) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${member.user.displayName} from the project`}
          onClick={async () => {
            const ok = await confirm({
              title: 'Remove member',
              message: `Remove ${member.user.displayName} from this project? They will lose access immediately.`,
              confirmLabel: 'Remove',
              destructive: true,
            });
            if (!ok) return;
            try {
              await projectApi.removeMember(projectId, member.userId as number);
              toast.success('Member removed');
              membersQuery.refetch();
            } catch (error) {
              toast.apiError(error);
            }
          }}
        >
          Remove
        </Button>
      ),
    },
  ];

  return (
    <section className="card card-pad stack" aria-label="Members">
      <h2>Members</h2>
      <p className="subtle">
        Roles are ordered: owner &gt; admin &gt; maintainer &gt; developer &gt; reporter &gt; viewer.
      </p>

      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: 'var(--space-3)' }}
        onSubmit={(event) => {
          event.preventDefault();
          setFieldErrors({});
          if (invite.usernameOrEmail.trim() === '') {
            setFieldErrors({ usernameOrEmail: 'Enter a username or email address.' });
            return;
          }
          void addMember.mutate({ usernameOrEmail: invite.usernameOrEmail.trim(), role: invite.role });
        }}
        noValidate
      >
        <div className="grow" style={{ minWidth: 220 }}>
          <label className="field-label" htmlFor="invite-user">
            Username or email
          </label>
          <input
            id="invite-user"
            className="input"
            value={invite.usernameOrEmail}
            aria-invalid={fieldErrors.usernameOrEmail !== undefined}
            onChange={(event) => setInvite({ ...invite, usernameOrEmail: event.target.value })}
          />
          {fieldErrors.usernameOrEmail !== undefined ? (
            <span className="field-error">{fieldErrors.usernameOrEmail}</span>
          ) : null}
        </div>
        <Select
          label="Role"
          value={invite.role}
          options={ROLES.map((role) => ({ value: role, label: `${role} (${ROLE_RANK[role]})` }))}
          onChange={(role) => setInvite({ ...invite, role })}
        />
        <Button type="submit" variant="primary" loading={addMember.isPending}>
          Add member
        </Button>
      </form>

      {membersQuery.error !== null ? (
        <ErrorState error={membersQuery.error} onRetry={membersQuery.refetch} />
      ) : membersQuery.isLoading ? (
        <SkeletonRows rows={4} height="48px" />
      ) : members.length === 0 ? (
        <EmptyState icon="👥" title="No members yet" description="Invite a teammate to get started." />
      ) : (
        <DataTable
          caption="Project members and their roles"
          columns={columns}
          rows={members}
          rowKey={(member) => member.id}
          emptyMessage="No members"
        />
      )}
      {dialog}
    </section>
  );
}
