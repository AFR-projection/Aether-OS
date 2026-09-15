import { useEffect } from 'react';

import { BootstrapScreen } from './auth/BootstrapScreen.js';
import { LoginScreen } from './auth/LoginScreen.js';
import { ErrorState, LoadingState } from './components/ui/Feedback.js';
import { Desktop } from './desktop/Desktop.js';
import { useAuthStore } from './stores/auth.store.js';

/**
 * Root shell.
 *
 * `initialise` resolves exactly which of the four states the app is in: still
 * checking, brand-new instance (needs its owner account), anonymous, or
 * authenticated. Nothing renders the desktop before that answer arrives.
 */
export function App() {
  const status = useAuthStore((state) => state.status);
  const requiresBootstrap = useAuthStore((state) => state.requiresBootstrap);
  const bootError = useAuthStore((state) => state.bootError);
  const initialise = useAuthStore((state) => state.initialise);

  useEffect(() => {
    void initialise();
  }, [initialise]);

  if (status === 'initialising') {
    return (
      <div className="h-full bg-surface-900">
        <LoadingState label="Connecting to Aether…" />
      </div>
    );
  }

  if (bootError !== null) {
    return (
      <div className="h-full bg-surface-900">
        <ErrorState error={new Error(bootError)} onRetry={() => void initialise()} />
      </div>
    );
  }

  if (requiresBootstrap) return <BootstrapScreen />;
  if (status === 'anonymous') return <LoginScreen />;

  return <Desktop />;
}
