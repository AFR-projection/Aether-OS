import type { Permission, Role } from '../constants.js';

/** A user record as stored in the database, minus any credential material. */
export interface User {
  id: string;
  username: string;
  email: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/** A user record as sent to the client, including the resolved permission set. */
export interface PublicUser extends User {
  permissions: Permission[];
}
