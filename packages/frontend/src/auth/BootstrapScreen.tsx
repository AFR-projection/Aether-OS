import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Banner } from '../components/ui/Feedback.js';
import { Field, TextInput } from '../components/ui/Input.js';
import { useAuthStore } from '../stores/auth.store.js';

/**
 * First-run screen: creates the owner account.
 *
 * This is reachable only while the instance has zero users; the backend refuses
 * the request otherwise, so reloading this screen later cannot create a second
 * owner.
 */
export function BootstrapScreen() {
  const submitting = useAuthStore((state) => state.submitting);
  const formError = useAuthStore((state) => state.formError);
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const clearFormError = useAuthStore((state) => state.clearFormError);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');

  return (
    <div className="flex h-full items-center justify-center bg-surface-900 p-4">
      <form
        className="w-full max-w-sm rounded-lg border border-white/10 bg-surface-800 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void bootstrap(username, password, email === '' ? undefined : email);
        }}
      >
        <h1 className="text-lg font-semibold text-slate-100">Welcome to Aether</h1>
        <p className="mb-4 mt-1 text-sm text-slate-400">
          This instance has no users yet. Create the owner account to get started.
        </p>

        {formError !== null ? (
          <div className="mb-3">
            <Banner tone="danger" onDismiss={clearFormError}>
              {formError}
            </Banner>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          <Field label="Username">
            {(field) => (
              <TextInput
                {...field}
                value={username}
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            )}
          </Field>

          <Field label="Password" hint="At least 12 characters.">
            {(field) => (
              <TextInput
                {...field}
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            )}
          </Field>

          <Field label="Email" hint="Optional.">
            {(field) => (
              <TextInput
                {...field}
                type="email"
                value={email}
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>

          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={username === '' || password.length < 12}
          >
            Create owner account
          </Button>
        </div>
      </form>
    </div>
  );
}
