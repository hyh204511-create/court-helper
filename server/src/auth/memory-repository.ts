import { randomUUID } from 'node:crypto';

import type {
  AuthRepository,
  NewSession,
  NewUser,
  Role,
  SessionRecord,
  UserPatch,
  UserRecord,
} from './types.ts';

function duplicateError(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function copyUser(user: UserRecord): UserRecord {
  return { ...user, deletedAt: user.deletedAt ? new Date(user.deletedAt) : null, createdAt: new Date(user.createdAt), updatedAt: new Date(user.updatedAt) };
}

function copySession(session: SessionRecord): SessionRecord {
  return { ...session, expiresAt: new Date(session.expiresAt), revokedAt: session.revokedAt ? new Date(session.revokedAt) : null, createdAt: new Date(session.createdAt) };
}

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(users: UserRecord[] = [], sessions: SessionRecord[] = []) {
    for (const user of users) this.users.set(user.id, copyUser(user));
    for (const session of sessions) this.sessions.set(session.id, copySession(session));
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.username === username);
    return user ? copyUser(user) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    return user ? copyUser(user) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()]
      .sort((left, right) => left.username.localeCompare(right.username))
      .map(copyUser);
  }

  async createUser(input: NewUser): Promise<UserRecord> {
    if ([...this.users.values()].some((user) => user.username === input.username)) {
      throw duplicateError();
    }
    const now = new Date();
    const user: UserRecord = {
      id: input.id ?? randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      enabled: input.enabled ?? true,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return copyUser(user);
  }

  async updateUser(id: string, patch: UserPatch): Promise<UserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;
    if (patch.username && [...this.users.values()].some((candidate) => candidate.id !== id && candidate.username === patch.username)) {
      throw duplicateError();
    }
    if (patch.username !== undefined) user.username = patch.username;
    if (patch.role !== undefined) user.role = patch.role;
    if (patch.enabled !== undefined) user.enabled = patch.enabled;
    user.updatedAt = new Date();
    return copyUser(user);
  }

  async softDeleteUser(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;
    user.enabled = false;
    user.deletedAt = new Date();
    user.updatedAt = new Date();
    return copyUser(user);
  }

  async updatePassword(id: string, passwordHash: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;
    user.passwordHash = passwordHash;
    user.updatedAt = new Date();
    return copyUser(user);
  }

  async countEnabledAdmins(): Promise<number> {
    return [...this.users.values()].filter((user) => user.role === 'admin' && user.enabled && user.deletedAt === null).length;
  }

  async createSession(input: NewSession): Promise<SessionRecord> {
    const session: SessionRecord = {
      ...input,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return copySession(session);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const session = [...this.sessions.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return session ? copySession(session) : null;
  }

  async revokeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session && session.revokedAt === null) session.revokedAt = new Date();
  }

  async revokeUserSessions(userId: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) session.revokedAt = new Date();
    }
  }

  async deleteExpiredOrRevokedSessions(now: Date): Promise<number> {
    let deleted = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
        this.sessions.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].map(copySession);
  }
}

export type { Role };
