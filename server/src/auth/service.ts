import type { ServerConfig } from '../config.ts';
import {
  AuthenticationRequiredError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
} from '../errors.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.ts';
import { hashToken, newCsrfToken, newOpaqueToken, newSessionId } from './token.ts';
import type {
  AuthRepository,
  ClientType,
  Role,
  SessionRecord,
  UserPatch,
  UserRecord,
} from './types.ts';

export type AuthMechanism = 'cookie' | 'bearer';

export const LOGIN_ATTEMPT_LIMIT = 5;
export const LOGIN_ATTEMPT_WINDOW_MS = 60 * 1000;

type PasswordVerifier = (passwordHash: string, password: string) => Promise<boolean>;

interface LoginAttemptBucket {
  count: number;
  resetAt: number;
}

class LoginAttemptLimiter {
  private readonly byIp = new Map<string, LoginAttemptBucket>();
  private readonly byUsername = new Map<string, LoginAttemptBucket>();

  private bucket(map: Map<string, LoginAttemptBucket>, key: string, now: number): LoginAttemptBucket {
    const current = map.get(key);
    if (current && current.resetAt > now) return current;
    const created = { count: 0, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS };
    map.set(key, created);
    return created;
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.byIp) {
      if (bucket.resetAt <= now) this.byIp.delete(key);
    }
    for (const [key, bucket] of this.byUsername) {
      if (bucket.resetAt <= now) this.byUsername.delete(key);
    }
  }

  consume(ip: string, username: string, now: number): number | null {
    this.pruneExpired(now);
    const ipBucket = this.bucket(this.byIp, ip, now);
    const usernameBucket = this.bucket(this.byUsername, username, now);
    if (ipBucket.count >= LOGIN_ATTEMPT_LIMIT || usernameBucket.count >= LOGIN_ATTEMPT_LIMIT) {
      return Math.max(
        1,
        Math.ceil((Math.max(ipBucket.resetAt, usernameBucket.resetAt) - now) / 1000),
      );
    }
    ipBucket.count += 1;
    usernameBucket.count += 1;
    return null;
  }
}

export interface AuthContext {
  user: UserRecord;
  session: SessionRecord;
  mechanism: AuthMechanism;
}

export interface AuthServiceOptions {
  verifyPassword?: PasswordVerifier;
  now?: () => number;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function publicUser(user: UserRecord) {
  return { id: user.id, username: user.username, role: user.role };
}

export function adminUser(user: UserRecord) {
  return {
    ...publicUser(user),
    enabled: user.enabled,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export class AuthService {
  private readonly csrfTokens = new Map<string, string>();
  public readonly repository: AuthRepository;
  private readonly config: ServerConfig;
  private readonly verifyPassword: PasswordVerifier;
  private readonly now: () => number;
  private readonly loginAttemptLimiter = new LoginAttemptLimiter();

  constructor(repository: AuthRepository, config: ServerConfig, options: AuthServiceOptions = {}) {
    this.repository = repository;
    this.config = config;
    this.verifyPassword = options.verifyPassword ?? verifyPassword;
    this.now = options.now ?? (() => Date.now());
  }

  async seedInitialAdmin(): Promise<UserRecord> {
    const existing = await this.repository.findUserByUsername('admin');
    if (existing) return existing;
    return this.repository.createUser({
      username: 'admin',
      passwordHash: await hashPassword(this.config.auth.adminInitialPassword),
      role: 'admin',
      enabled: true,
    });
  }

  async login(username: string, password: string, clientType: ClientType, ip = 'unknown') {
    const normalizedUsername = normalizeUsername(username);
    const retryAfterSeconds = this.loginAttemptLimiter.consume(ip, normalizedUsername, this.now());
    if (retryAfterSeconds !== null) {
      throw new TooManyRequestsError(retryAfterSeconds);
    }

    const user = await this.repository.findUserByUsername(normalizedUsername);
    if (!user || user.deletedAt !== null) {
      await this.verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw new AuthenticationRequiredError('Invalid credentials');
    }
    if (!user.enabled) {
      throw new ConflictError('Account disabled', 'ACCOUNT_DISABLED');
    }
    if (!(await this.verifyPassword(user.passwordHash, password))) {
      throw new AuthenticationRequiredError('Invalid credentials');
    }

    const token = newOpaqueToken();
    const session = await this.repository.createSession({
      id: newSessionId(),
      userId: user.id,
      tokenHash: hashToken(token),
      clientType,
      expiresAt: new Date(this.now() + this.config.auth.sessionTtlSeconds * 1000),
    });
    return {
      user,
      session,
      token,
      csrfToken: clientType === 'admin_ui' ? this.issueCsrfToken(session.id) : undefined,
    };
  }

  async authenticate(token: string, mechanism: AuthMechanism): Promise<AuthContext> {
    const session = await this.repository.findSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      throw new AuthenticationRequiredError();
    }
    const user = await this.repository.findUserById(session.userId);
    if (!user || user.deletedAt !== null || !user.enabled) {
      await this.repository.revokeSession(session.id);
      throw new AuthenticationRequiredError();
    }
    return { user, session, mechanism };
  }

  issueCsrfToken(sessionId: string): string {
    const token = newCsrfToken();
    this.csrfTokens.set(sessionId, token);
    return token;
  }

  getCsrfToken(sessionId: string): string {
    return this.csrfTokens.get(sessionId) ?? this.issueCsrfToken(sessionId);
  }

  isCsrfTokenValid(sessionId: string, token: string | undefined): boolean {
    return token !== undefined && this.csrfTokens.get(sessionId) === token;
  }

  async logout(context: AuthContext): Promise<void> {
    this.csrfTokens.delete(context.session.id);
    await this.repository.revokeSession(context.session.id);
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.repository.listUsers();
  }

  async getUser(id: string): Promise<UserRecord> {
    const user = await this.repository.findUserById(id);
    if (!user) throw new NotFoundError('User not found');
    return user;
  }

  async createUser(username: string, password: string, role: Role, enabled = true): Promise<UserRecord> {
    return this.repository.createUser({
      username: normalizeUsername(username),
      passwordHash: await hashPassword(password),
      role,
      enabled,
    });
  }

  async updateUser(id: string, patch: UserPatch): Promise<UserRecord> {
    const user = await this.repository.updateUser(id, {
      ...patch,
      username: patch.username === undefined ? undefined : normalizeUsername(patch.username),
    });
    if (!user) throw new NotFoundError('User not found');
    if (patch.enabled === false) {
      await this.repository.revokeUserSessions(id);
    }
    return user;
  }

  async deleteUser(id: string): Promise<UserRecord> {
    const user = await this.repository.softDeleteUser(id);
    if (!user) throw new NotFoundError('User not found');
    await this.repository.revokeUserSessions(id);
    this.csrfTokens.delete(id);
    return user;
  }

  async resetPassword(id: string, password: string): Promise<UserRecord> {
    const user = await this.repository.updatePassword(id, await hashPassword(password));
    if (!user) throw new NotFoundError('User not found');
    await this.repository.revokeUserSessions(id);
    this.csrfTokens.delete(id);
    return user;
  }
}
