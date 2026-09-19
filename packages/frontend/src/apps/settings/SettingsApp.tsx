import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '../../components/ui/Button.js';
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog.js';
import { Banner, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.js';
import { Checkbox, Field, Select, TextInput } from '../../components/ui/Input.js';
import { fetchAgents, pairAgent, revokeAgent } from '../../lib/agent-api.js';
import { formatDateTime, formatRelative, truncateMiddle } from '../../lib/format.js';
import { queryKeys } from '../../lib/query-client.js';
import {
  ASSIGNABLE_ROLES,
  changePassword,
  createUser,
  deleteUser,
  fetchInstance,
  fetchSessions,
  fetchUsers,
  revokeSession,
  updateUser,
} from '../../lib/system-api.js';
import { THEME_IDS, THEMES, type ThemeId } from '../../lib/themes.js';
import { useCurrentUser } from '../../stores/auth.store.js';
import { useDesktopStore } from '../../stores/desktop.store.js';
import { useThemeStore } from '../../stores/theme.store.js';

import type { AppProps } from '../registry.js';
import type { AgentPairResult, AuthSession, HostAgent, PublicUser } from '@aether/shared';

/**
 * Settings — account, sessions, user administration, host agents, and instance
 * information.
 *
 * The tabs a user can reach are decided by their permissions, and every request
 * behind them is separately authorised on the server. Hiding a tab is a
 * convenience; it is not the control.
 */

type Tab = 'account' | 'appearance' | 'sessions' | 'users' | 'agents' | 'about';

export function SettingsApp({ windowId }: AppProps) {
  const user = useCurrentUser();
  const setWindowTitle = useDesktopStore((state) => state.setWindowTitle);
  const [tab, setTab] = useState<Tab>('account');

  useEffect(() => {
    setWindowTitle(windowId, 'Settings');
  }, [setWindowTitle, windowId]);

  if (user === null) {
    return <ErrorState error={new Error('No signed-in user.')} />;
  }

  const canManageUsers = user.permissions.includes('users:manage');
  const canManageSettings = user.permissions.includes('settings:manage');

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'account', label: 'Account' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'sessions', label: 'Sessions' },
    ...(canManageUsers ? [{ id: 'users' as Tab, label: 'Users' }] : []),
    ...(canManageSettings ? [{ id: 'agents' as Tab, label: 'Host agents' }] : []),
    { id: 'about', label: 'About' },
  ];

  return (
    <div className="flex h-full flex-col bg-surface-800">
      <nav
        className="flex gap-1 border-b border-white/10 px-2 py-1.5"
        aria-label="Settings sections"
      >
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? 'page' : undefined}
            className={[
              'rounded px-3 py-1 text-xs',
              tab === entry.id ? 'bg-accent/20 text-slate-100' : 'text-slate-400 hover:bg-white/5',
            ].join(' ')}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'account' ? <AccountSection user={user} /> : null}
        {tab === 'appearance' ? <AppearanceSection /> : null}
        {tab === 'sessions' ? <SessionsSection /> : null}
        {tab === 'users' && canManageUsers ? <UsersSection currentUser={user} /> : null}
        {tab === 'agents' && canManageSettings ? <AgentsSection /> : null}
        {tab === 'about' ? <AboutSection canManageSettings={canManageSettings} /> : null}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-lg border border-white/10 bg-surface-900/40 p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
      {children}
    </section>
  );
}

function AccountSection({ user }: { user: PublicUser }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => changePassword({ currentPassword, newPassword }),
    onSuccess: (result) => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      // The server revokes every other session and issues this one a new token
      // pair, so the user stays signed in here and is signed out everywhere else.
      setNotice(
        result.sessionsRevoked === 0
          ? 'Password changed.'
          : `Password changed. ${result.sessionsRevoked} other ${
              result.sessionsRevoked === 1 ? 'session was' : 'sessions were'
            } signed out.`
      );
    },
    onError: (thrown: unknown) => {
      setNotice(null);
      setError(thrown instanceof Error ? thrown.message : 'Could not change the password.');
    },
  });

  const mismatch = confirmPassword !== '' && newPassword !== confirmPassword;
  const tooShort = newPassword !== '' && newPassword.length < 12;

  return (
    <>
      <Section title="Signed in as">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <Row label="Username" value={user.username} />
          <Row label="Role" value={user.role} />
          <Row label="Email" value={user.email ?? '—'} />
          <Row label="Account created" value={formatDateTime(user.createdAt)} />
          <Row
            label="Last sign-in"
            value={user.lastLoginAt === null ? 'never' : formatDateTime(user.lastLoginAt)}
          />
          <Row label="Permissions" value={`${user.permissions.length}`} />
        </dl>

        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-slate-500">
            Permission list
          </summary>
          <ul className="mt-1 flex flex-wrap gap-1">
            {user.permissions.map((permission) => (
              <li
                key={permission}
                className="rounded bg-surface-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
              >
                {permission}
              </li>
            ))}
          </ul>
        </details>
      </Section>

      <Section title="Change password">
        {notice !== null ? (
          <div className="mb-2">
            <Banner tone="info" onDismiss={() => setNotice(null)}>
              {notice}
            </Banner>
          </div>
        ) : null}

        {error !== null ? (
          <div className="mb-2">
            <Banner tone="danger" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </div>
        ) : null}

        <form
          className="grid max-w-md grid-cols-1 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (mismatch || tooShort) return;
            mutation.mutate();
          }}
        >
          <Field label="Current password">
            {(field) => (
              <TextInput
                {...field}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            )}
          </Field>

          <Field
            label="New password"
            hint="At least 12 characters."
            error={tooShort ? 'Use at least 12 characters.' : null}
          >
            {(field) => (
              <TextInput
                {...field}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            )}
          </Field>

          <Field
            label="Confirm new password"
            error={mismatch ? 'The two entries do not match.' : null}
          >
            {(field) => (
              <TextInput
                {...field}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            )}
          </Field>

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              loading={mutation.isPending}
              disabled={currentPassword === '' || newPassword === '' || mismatch || tooShort}
            >
              Change password
            </Button>
            <span className="text-[11px] text-slate-500">
              All other sessions are signed out. This one keeps working.
            </span>
          </div>
        </form>
      </Section>
    </>
  );
}

function AppearanceSection() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return (
    <Section title="Desktop theme">
      <p className="mb-3 text-xs text-slate-400">
        Choose the look of the whole desktop. Each theme restyles the window frames, the shell, the
        colours, and the system font to match that operating system. The choice is saved in this
        browser.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {THEME_IDS.map((id) => (
          <ThemeCard key={id} id={id} selected={theme === id} onSelect={() => setTheme(id)} />
        ))}
      </div>
    </Section>
  );
}

/** A selectable theme card with a small, accurate preview of its window chrome. */
function ThemeCard({
  id,
  selected,
  onSelect,
}: {
  id: ThemeId;
  selected: boolean;
  onSelect: () => void;
}) {
  const definition = THEMES[id];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        'flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors',
        selected
          ? 'border-accent bg-accent/10'
          : 'border-white/10 bg-surface-900/40 hover:border-white/20',
      ].join(' ')}
    >
      <ThemePreview id={id} />
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-100">{definition.label}</span>
          {selected ? (
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
              Active
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{definition.description}</p>
      </div>
    </button>
  );
}

/**
 * A miniature, data-theme-scoped mock of the desktop for the given theme.
 *
 * The `data-theme` attribute on this subtree makes the CSS variables resolve to
 * that theme's palette regardless of the active theme, so all three previews
 * show their true colours side by side.
 */
function ThemePreview({ id }: { id: ThemeId }) {
  const { chrome } = THEMES[id];
  const controlsLeft = chrome.controlSide === 'left';

  const controls =
    chrome.controlStyle === 'traffic' ? (
      <span className="flex gap-1">
        <span className="h-2 w-2 rounded-full" style={{ background: '#ff5f57' }} />
        <span className="h-2 w-2 rounded-full" style={{ background: '#febc2e' }} />
        <span className="h-2 w-2 rounded-full" style={{ background: '#28c840' }} />
      </span>
    ) : chrome.controlStyle === 'gnome' ? (
      <span className="flex gap-1">
        <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/25" />
      </span>
    ) : (
      <svg width="26" height="6" viewBox="0 0 26 6" className="text-slate-300" aria-hidden="true">
        <line x1="0" y1="3" x2="5" y2="3" stroke="currentColor" strokeWidth="1" />
        <rect
          x="10"
          y="0.5"
          width="5"
          height="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <line x1="21" y1="0.5" x2="26" y2="5.5" stroke="currentColor" strokeWidth="1" />
        <line x1="26" y1="0.5" x2="21" y2="5.5" stroke="currentColor" strokeWidth="1" />
      </svg>
    );

  return (
    <div
      data-theme={id}
      className="relative flex h-24 flex-col overflow-hidden rounded-md"
      style={{
        background:
          id === 'macos'
            ? 'linear-gradient(150deg, #3d2a6b, #b5527a)'
            : id === 'gnome'
              ? 'linear-gradient(140deg, #3a3f9e, #1a1c3d)'
              : 'linear-gradient(140deg, #123a7a, #060f26)',
      }}
    >
      {/* Top shell bar for dock/topbar themes. */}
      {chrome.shell !== 'taskbar' ? (
        <div className="flex h-3 items-center bg-black/40 px-1">
          <span className="h-1 w-6 rounded-full bg-white/40" />
        </div>
      ) : null}

      {/* A little window. */}
      <div className="mx-auto mt-3 w-3/4 overflow-hidden rounded border border-white/10 bg-surface-800 shadow">
        <div
          className={[
            'flex items-center gap-1 bg-surface-900 px-1.5 py-1',
            controlsLeft ? 'flex-row' : 'flex-row-reverse',
          ].join(' ')}
        >
          {controls}
          <span className="h-1 flex-1 rounded-full bg-white/15" />
        </div>
        <div className="space-y-1 p-1.5">
          <span className="block h-1 w-full rounded-full bg-white/10" />
          <span
            className="block h-1 w-2/3 rounded-full"
            style={{ background: 'rgb(var(--accent))' }}
          />
        </div>
      </div>

      {/* Bottom shell for taskbar/dock themes. */}
      {chrome.shell === 'taskbar' ? (
        <div className="mt-auto flex h-3 items-center justify-center bg-black/40">
          <span className="h-1.5 w-1.5 rounded-sm" style={{ background: 'rgb(var(--accent))' }} />
        </div>
      ) : chrome.shell === 'dock' ? (
        <div className="mt-auto mb-1 flex justify-center gap-1">
          <span className="h-3 w-3 rounded-md bg-white/25" />
          <span className="h-3 w-3 rounded-md bg-white/25" />
          <span className="h-3 w-3 rounded-md bg-white/25" />
        </div>
      ) : null}
    </div>
  );
}

function SessionsSection() {
  const queryClient = useQueryClient();
  const [pendingRevoke, setPendingRevoke] = useState<AuthSession | null>(null);

  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: fetchSessions });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => revokeSession(sessionId),
    onSettled: () => {
      setPendingRevoke(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });

  if (sessions.isPending) return <LoadingState label="Listing sessions…" />;
  if (sessions.isError) {
    return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />;
  }

  const rows = sessions.data;

  return (
    <Section title="Active sessions">
      {rows.length === 0 ? (
        <EmptyState title="No sessions" />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 font-medium">Device</th>
              <th className="py-1 font-medium">Source</th>
              <th className="py-1 font-medium">Started</th>
              <th className="py-1 font-medium">Last seen</th>
              <th className="py-1 font-medium">Expires</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((session) => (
              <tr key={session.id} className="border-t border-white/5">
                <td
                  className="max-w-0 truncate py-1 text-slate-300"
                  title={session.userAgent ?? ''}
                >
                  {session.userAgent === null
                    ? 'Unknown client'
                    : truncateMiddle(session.userAgent, 40)}
                  {session.current ? (
                    <span className="ml-2 rounded bg-accent/20 px-1 text-[10px] text-accent">
                      this device
                    </span>
                  ) : null}
                </td>
                <td className="py-1 font-mono text-slate-500">{session.ipAddress ?? '—'}</td>
                <td className="py-1 text-slate-400">{formatDateTime(session.createdAt)}</td>
                <td className="py-1 text-slate-400">{formatRelative(session.lastSeenAt)}</td>
                <td className="py-1 text-slate-500">{formatDateTime(session.expiresAt)}</td>
                <td className="py-1 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-300"
                    onClick={() => setPendingRevoke(session)}
                  >
                    Sign out
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={pendingRevoke?.current === true ? 'Sign out this device?' : 'Sign out that device?'}
        destructive
        busy={revokeMutation.isPending}
        confirmLabel="Sign out"
        message={
          pendingRevoke?.current === true
            ? 'This is the session you are using. Signing it out returns you to the login screen immediately.'
            : 'That device is signed out at once. Anyone using it loses access.'
        }
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke !== null) revokeMutation.mutate(pendingRevoke.id);
        }}
      />
    </Section>
  );
}

function UsersSection({ currentUser }: { currentUser: PublicUser }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PublicUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const users = useQuery({ queryKey: queryKeys.users, queryFn: fetchUsers });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users });
  };

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => deleteUser(userId),
    onSuccess: () => {
      setError(null);
      setPendingDelete(null);
      invalidate();
    },
    onError: (thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : 'Could not delete the user.');
      setPendingDelete(null);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (params: {
      userId: string;
      changes: { role?: PublicUser['role']; isActive?: boolean };
    }) => updateUser(params.userId, params.changes),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : 'Could not update the user.');
    },
  });

  return (
    <Section title="Users">
      {error !== null ? (
        <div className="mb-2">
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      <div className="mb-2 flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
          Add user
        </Button>
        <span className="text-[11px] text-slate-500">
          The owner account is created at install time and cannot be changed here.
        </span>
      </div>

      {users.isPending ? (
        <LoadingState label="Listing users…" />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 font-medium">Username</th>
              <th className="py-1 font-medium">Role</th>
              <th className="py-1 font-medium">Email</th>
              <th className="py-1 font-medium">Last sign-in</th>
              <th className="py-1 font-medium">Active</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {users.data.users.map((entry) => {
              const isSelf = entry.id === currentUser.id;
              const isOwner = entry.role === 'owner';

              return (
                <tr key={entry.id} className="border-t border-white/5">
                  <td className="py-1 text-slate-300">
                    {entry.username}
                    {isSelf ? <span className="ml-2 text-[10px] text-slate-500">you</span> : null}
                  </td>
                  <td className="py-1 text-slate-400">
                    {isOwner ? (
                      entry.role
                    ) : (
                      <Select
                        value={entry.role}
                        aria-label={`Role for ${entry.username}`}
                        className="h-6 text-xs"
                        disabled={updateMutation.isPending}
                        onChange={(event) =>
                          updateMutation.mutate({
                            userId: entry.id,
                            changes: { role: event.target.value as PublicUser['role'] },
                          })
                        }
                      >
                        {ASSIGNABLE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className="py-1 text-slate-500">{entry.email ?? '—'}</td>
                  <td className="py-1 text-slate-500">
                    {entry.lastLoginAt === null ? 'never' : formatRelative(entry.lastLoginAt)}
                  </td>
                  <td className="py-1">
                    <Checkbox
                      label=""
                      aria-label={`Account active for ${entry.username}`}
                      checked={entry.isActive}
                      disabled={isOwner || isSelf || updateMutation.isPending}
                      onChange={(event) =>
                        updateMutation.mutate({
                          userId: entry.id,
                          changes: { isActive: event.target.checked },
                        })
                      }
                    />
                  </td>
                  <td className="py-1 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-300"
                      disabled={isOwner || isSelf}
                      title={
                        isOwner
                          ? 'The owner account cannot be deleted'
                          : isSelf
                            ? 'You cannot delete your own account'
                            : undefined
                      }
                      onClick={() => setPendingDelete(entry)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          invalidate();
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.username ?? 'user'}?`}
        destructive
        busy={deleteMutation.isPending}
        confirmLabel="Delete user"
        message="The account and its sessions are removed. This cannot be undone."
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) deleteMutation.mutate(pendingDelete.id);
        }}
      />
    </Section>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ASSIGNABLE_ROLES)[number]>('viewer');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createUser({
        username,
        password,
        role,
        ...(email !== '' ? { email } : {}),
      }),
    onSuccess: () => {
      setUsername('');
      setPassword('');
      setEmail('');
      setRole('viewer');
      setError(null);
      onCreated();
    },
    onError: (thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : 'Could not create the user.');
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a user"
      description="The new account can sign in immediately with the password you set here."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={mutation.isPending}
            disabled={username === '' || password.length < 12}
            onClick={() => mutation.mutate()}
          >
            Create user
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error !== null ? (
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}

        <Field label="Username">
          {(field) => (
            <TextInput
              {...field}
              value={username}
              autoComplete="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>

        <Field label="Password" hint="At least 12 characters.">
          {(field) => (
            <TextInput
              {...field}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        <Field label="Email" hint="Optional.">
          {(field) => (
            <TextInput
              {...field}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>

        <Field label="Role">
          {(field) => (
            <Select
              {...field}
              value={role}
              onChange={(event) => setRole(event.target.value as (typeof ASSIGNABLE_ROLES)[number])}
            >
              {ASSIGNABLE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function AgentsSection() {
  const queryClient = useQueryClient();
  const [pairOpen, setPairOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<HostAgent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agents = useQuery({ queryKey: queryKeys.agents, queryFn: fetchAgents });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents });
  };

  const revokeMutation = useMutation({
    mutationFn: (agentId: string) => revokeAgent(agentId),
    onSuccess: () => {
      setError(null);
      setPendingRevoke(null);
      invalidate();
    },
    onError: (thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : 'Could not revoke the agent.');
      setPendingRevoke(null);
    },
  });

  return (
    <Section title="Host agents">
      {error !== null ? (
        <div className="mb-2">
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      <div className="mb-2 flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => setPairOpen(true)}>
          Pair an agent
        </Button>
        <span className="text-[11px] text-slate-500">
          Agents run on other machines and connect back over a WebSocket to serve this
          instance&apos;s files, processes, and terminals.
        </span>
      </div>

      {agents.isPending ? (
        <LoadingState label="Listing host agents…" />
      ) : agents.isError ? (
        <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />
      ) : agents.data.length === 0 ? (
        <EmptyState
          title="No agents paired"
          description="Pair an agent to let this instance manage another machine. You will get a token that is shown exactly once."
        />
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 font-medium">Label</th>
              <th className="py-1 font-medium">Status</th>
              <th className="py-1 font-medium">Agent id</th>
              <th className="py-1 font-medium">Paired</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {agents.data.map((agent) => (
              <tr key={agent.agentId} className="border-t border-white/5">
                <td className="py-1 text-slate-300">{agent.label}</td>
                <td className="py-1">
                  <AgentStatus agent={agent} />
                </td>
                <td className="py-1 font-mono text-[11px] text-slate-500" title={agent.agentId}>
                  {truncateMiddle(agent.agentId, 26)}
                </td>
                <td className="py-1 text-slate-500">{formatRelative(agent.createdAt)}</td>
                <td className="py-1 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-300"
                    onClick={() => setPendingRevoke(agent)}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <PairAgentDialog open={pairOpen} onClose={() => setPairOpen(false)} onPaired={invalidate} />

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={`Revoke ${pendingRevoke?.label ?? 'agent'}?`}
        destructive
        busy={revokeMutation.isPending}
        confirmLabel="Revoke agent"
        message="The agent's token stops authenticating immediately and the pairing disappears from this list. This cannot be undone."
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke !== null) revokeMutation.mutate(pendingRevoke.agentId);
        }}
      />
    </Section>
  );
}

/**
 * Online/offline indicator.
 *
 * Connection state is reported by the backend replica that answered the list
 * request, so behind more than one replica it reflects that replica's view.
 */
function AgentStatus({ agent }: { agent: HostAgent }) {
  const label = agent.connected ? 'online' : 'offline';
  const title =
    agent.connected && agent.connectedAt !== null
      ? `Connected since ${formatDateTime(agent.connectedAt)}`
      : 'No open WebSocket connection to the backend';

  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span
        aria-hidden="true"
        className={[
          'inline-block h-1.5 w-1.5 rounded-full',
          agent.connected ? 'bg-emerald-400' : 'bg-slate-600',
        ].join(' ')}
      />
      <span className={agent.connected ? 'text-emerald-300' : 'text-slate-500'}>{label}</span>
    </span>
  );
}

/**
 * Pairs an agent and reveals the token once.
 *
 * The token is the only copy that will ever exist — the backend stores a hash —
 * so the success state replaces the form entirely and cannot be dismissed by
 * accident before the operator has copied it.
 */
function PairAgentDialog({
  open,
  onClose,
  onPaired,
}: {
  open: boolean;
  onClose: () => void;
  onPaired: () => void;
}) {
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<AgentPairResult | null>(null);

  const reset = () => {
    setLabel('');
    setError(null);
    setPaired(null);
  };

  const mutation = useMutation({
    mutationFn: () => pairAgent(label.trim()),
    onSuccess: (result) => {
      setError(null);
      setPaired(result);
      onPaired();
    },
    onError: (thrown: unknown) => {
      setError(thrown instanceof Error ? thrown.message : 'Could not pair the agent.');
    },
  });

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={paired === null ? 'Pair a host agent' : 'Agent paired'}
      description={
        paired === null
          ? 'The label identifies this agent in the list. A token is generated when you pair.'
          : 'Copy the values below now. The token is not stored in a readable form and cannot be shown again.'
      }
      footer={
        paired === null ? (
          <>
            <Button size="sm" variant="ghost" onClick={close} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={mutation.isPending}
              disabled={label.trim() === ''}
              onClick={() => mutation.mutate()}
            >
              Pair agent
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" onClick={close}>
            Done
          </Button>
        )
      }
    >
      {error !== null ? (
        <div className="mb-3">
          <Banner tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      ) : null}

      {paired === null ? (
        <Field label="Label" hint="Shown in this list and in the audit log.">
          {(field) => (
            <TextInput
              {...field}
              value={label}
              autoComplete="off"
              placeholder="web-01"
              onChange={(event) => setLabel(event.target.value)}
            />
          )}
        </Field>
      ) : (
        <AgentCredentials result={paired} />
      )}
    </Dialog>
  );
}

/** The one-time token hand-off, with the exact environment the agent needs. */
function AgentCredentials({ result }: { result: AgentPairResult }) {
  const [copied, setCopied] = useState<string | null>(null);

  const backendUrl =
    typeof window === 'undefined'
      ? 'wss://your-aether-host'
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

  const entries: Array<{ name: string; value: string }> = [
    { name: 'AETHER_BACKEND_URL', value: backendUrl },
    { name: 'AETHER_AGENT_ID', value: result.agentId },
    { name: 'AETHER_PAIRING_TOKEN', value: result.token },
  ];

  const copy = (name: string, value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(name);
      })
      .catch(() => {
        setCopied(null);
      });
  };

  return (
    <div className="flex flex-col gap-3">
      <Banner tone="warning">
        This token is shown once and is never retrievable. Store it in the agent&apos;s environment
        before closing this dialog.
      </Banner>

      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <div key={entry.name} className="rounded border border-white/10 bg-surface-900/60 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-slate-400">{entry.name}</span>
              <Button size="sm" variant="ghost" onClick={() => copy(entry.name, entry.value)}>
                {copied === entry.name ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <code className="block break-all font-mono text-[11px] text-slate-200">
              {entry.value}
            </code>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-slate-500">
        Set these in the agent&apos;s environment, then start it with{' '}
        <code className="font-mono text-slate-400">aether-agent start</code>.
      </p>
    </div>
  );
}

function AboutSection({ canManageSettings }: { canManageSettings: boolean }) {
  const instance = useQuery({
    queryKey: queryKeys.instance,
    queryFn: fetchInstance,
    staleTime: Infinity,
  });

  return (
    <>
      <Section title="Instance">
        {instance.isPending ? (
          <LoadingState label="Reading instance information…" />
        ) : instance.isError ? (
          <ErrorState error={instance.error} onRetry={() => void instance.refetch()} />
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row label="Instance id" value={instance.data.instanceId} />
            <Row
              label="Provisioned by installer"
              value={instance.data.configured ? 'yes' : 'no — AETHER_INSTANCE_ID is not set'}
            />
          </dl>
        )}
      </Section>

      <Section title="About Aether">
        <p className="text-xs text-slate-400">
          Aether Cloud OS serves this desktop from the host it is installed on. Everything you see
          in the window manager runs in this browser; every file, terminal, and process reading
          comes from the backend over the API.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          {canManageSettings
            ? 'You can change instance settings.'
            : 'Changing instance-wide settings requires the settings:manage permission.'}
        </p>
      </Section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-white/5 py-1">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-300" title={value}>
        {value}
      </dd>
    </div>
  );
}
