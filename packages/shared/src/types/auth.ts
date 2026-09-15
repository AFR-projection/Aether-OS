import type { PublicUser } from './user.js';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface LoginResponse extends TokenPair {
  user: PublicUser;
}

export interface RefreshRequest {
  refreshToken: string;
}

/** A logged-in device/session, as listed in the Settings app. */
export interface AuthSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** True for the session that issued the current request. */
  current: boolean;
}

/** What the auth middleware attaches to `request.user`. */
export interface AuthenticatedPrincipal {
  user: PublicUser;
  sessionId: string;
}

/** First-run bootstrap: create the owner account. Only allowed while zero users exist. */
export interface BootstrapRequest {
  username: string;
  password: string;
  email?: string;
}
