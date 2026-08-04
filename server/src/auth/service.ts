import type { ServerConfig } from '../config.ts';
import { AuthenticationRequiredError, ConflictError, NotFoundError } from '../errors.ts';
import { hashPassword, verifyPassword } from './password.ts';
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

export interface AuthContext {
  user: UserRecord;
  session: SessionRecord;
  mechanism: AuthMechanism;
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

  constructor(repository: AuthRepository, config: ServerConfig) {
    this.repository = repository;
    this.config = config;
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

  async login(username: string, password: string, clientType: ClientType) {
    const user = await this.repository.findUserByUsername(normalizeUsername(username));
    if (!user || user.deletedAt !== null) {
      throw new AuthenticationRequiredError('Invalid credentials');
    }
    if (!user.enabled) {
      throw new ConflictError('Account disabled', 'ACCOUNT_DISABLED');
    }
    if (!(await verifyPassword(user.passwordHash, password))) {
      throw new AuthenticationRequiredError('Invalid credentials');
    }

    const token = newOpaqueToken();
    const session = await this.repository.createSession({
      id: newSessionId(),
      userId: user.id,
      tokenHash: hashToken(token),
      clientType,
      expiresAt: new Date(Date.now() + this.config.auth.sessionTtlSeconds * 1000),
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
