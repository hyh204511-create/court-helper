export type Role = 'admin' | 'user';
export type ClientType = 'admin_ui' | 'extension';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  enabled: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  clientType: ClientType;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface NewUser {
  id?: string;
  username: string;
  passwordHash: string;
  role: Role;
  enabled?: boolean;
}

export interface UserPatch {
  username?: string;
  role?: Role;
  enabled?: boolean;
}

export interface NewSession {
  id: string;
  userId: string;
  tokenHash: string;
  clientType: ClientType;
  expiresAt: Date;
}

export interface AuthRepository {
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  createUser(input: NewUser): Promise<UserRecord>;
  updateUser(id: string, patch: UserPatch): Promise<UserRecord | null>;
  softDeleteUser(id: string): Promise<UserRecord | null>;
  updatePassword(id: string, passwordHash: string): Promise<UserRecord | null>;
  countEnabledAdmins(): Promise<number>;
  createSession(input: NewSession): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(id: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
}
