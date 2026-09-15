import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Banner } from '../components/ui/Feedback.js';
import { Field, TextInput } from '../components/ui/Input.js';
import { useAuthStore } from '../stores/auth.store.js';

/** Username/password sign-in. Tokens are stored by the API client, not here. */
export function LoginScreen() {
  const submitting = useAuthStore((state) => state.submitting);
  const formError = useAuthStore((state) => state.formError);
  const login = useAuthStore((state) => state.login);
  const clearFormError = useAuthStore((state) => state.clearFormError);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div className="flex h-full items-center justify-center bg-surface-900 p-4">
      <form
        className="w-full max-w-sm rounded-lg border border-white/10 bg-surface-800 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void login(username, password);
        }}
      >
        <h1 className="text-lg font-semibold text-slate-100">Aether Cloud OS</h1>
        <p className="mb-4 mt-1 text-sm text-slate-400">Sign in to your desktop.</p>

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

          <Field label="Password">
            {(field) => (
              <TextInput
                {...field}
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            )}
          </Field>

          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={username === '' || password === ''}
          >
            Sign in
          </Button>
        </div>
      </form>
    </div>
  );
}
