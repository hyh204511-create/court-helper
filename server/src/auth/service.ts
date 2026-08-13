import type { ServerConfig } from '../config.ts';
import { randomInt } from 'node:crypto';
import {
  AuthenticationRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from '../errors.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.ts';
import { hashToken, newCsrfToken, newOpaqueToken, newSessionId } from './token.ts';
import type {
  AuthRepository,
  ClientType,
  ExtensionDeviceRecord,
  ExtensionPairingRecord,
  Role,
  SessionRecord,
  UserPatch,
  UserRecord,
} from './types.ts';

export type AuthMechanism = 'cookie' | 'bearer';

export const LOGIN_ATTEMPT_LIMIT = 5;
export const LOGIN_ATTEMPT_WINDOW_MS = 60 * 1000;
export const EXTENSION_PAIRING_TTL_MS = 5 * 60 * 1000;
export const EXTENSION_PAIRING_ATTEMPT_LIMIT = 5;
export const EXTENSION_PAIRING_ATTEMPT_WINDOW_MS = 60 * 1000;

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isExchangeSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function safeDeviceLabel(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const label = value.trim();
  if (label.length > 80 || /[\r\n\t]/.test(label)) {
    throw new ConflictError('Invalid device label', 'INVALID_DEVICE_LABEL');
  }
  return label;
}

export function publicExtensionPairing(pairing: ExtensionPairingRecord) {
  return {
    id: pairing.id,
    deviceId: pairing.deviceId,
    label: pairing.label,
    status: pairing.status,
    expiresAt: pairing.expiresAt.toISOString(),
    createdAt: pairing.createdAt.toISOString(),
  };
}

export function publicExtensionDevice(device: ExtensionDeviceRecord) {
  return {
    id: device.id,
    deviceId: device.deviceId,
    label: device.label,
    enabled: device.enabled,
    revokedAt: device.revokedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    updatedAt: device.updatedAt.toISOString(),
  };
}

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

  clear(ip: string, username: string): void {
    this.byIp.delete(ip);
    this.byUsername.delete(username);
  }
}

class ExtensionPairingAttemptLimiter {
  private readonly byIp = new Map<string, LoginAttemptBucket>();
  private readonly byDeviceId = new Map<string, LoginAttemptBucket>();

  private bucket(map: Map<string, LoginAttemptBucket>, key: string, now: number): LoginAttemptBucket {
    const current = map.get(key);
    if (current && current.resetAt > now) return current;
    const created = { count: 0, resetAt: now + EXTENSION_PAIRING_ATTEMPT_WINDOW_MS };
    map.set(key, created);
    return created;
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.byIp) {
      if (bucket.resetAt <= now) this.byIp.delete(key);
    }
    for (const [key, bucket] of this.byDeviceId) {
      if (bucket.resetAt <= now) this.byDeviceId.delete(key);
    }
  }

  consume(ip: string, deviceId: string, now: number): number | null {
    this.pruneExpired(now);
    const ipBucket = this.bucket(this.byIp, ip, now);
    const deviceBucket = this.bucket(this.byDeviceId, deviceId, now);
    if (ipBucket.count >= EXTENSION_PAIRING_ATTEMPT_LIMIT || deviceBucket.count >= EXTENSION_PAIRING_ATTEMPT_LIMIT) {
      return Math.max(1, Math.ceil((Math.max(ipBucket.resetAt, deviceBucket.resetAt) - now) / 1000));
    }
    ipBucket.count += 1;
    deviceBucket.count += 1;
    return null;
  }
}

export interface AuthContext {
  user: UserRecord;
  session: SessionRecord;
  mechanism: AuthMechanism;
  extensionDevice: ExtensionDeviceRecord | null;
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
  private readonly extensionPairingAttemptLimiter = new ExtensionPairingAttemptLimiter();

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
    if (clientType !== 'admin_ui') {
      throw new ForbiddenError('Extension sessions require administrator pairing');
    }
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
    this.loginAttemptLimiter.clear(ip, normalizedUsername);

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
    let extensionDevice: ExtensionDeviceRecord | null = null;
    if (session.clientType === 'extension') {
      if (!session.extensionDeviceId) {
        await this.repository.revokeSession(session.id);
        throw new AuthenticationRequiredError();
      }
      const device = await this.repository.getExtensionDevice(session.extensionDeviceId);
      if (!device || !device.enabled || device.revokedAt !== null) {
        await this.repository.revokeSession(session.id);
        throw new AuthenticationRequiredError();
      }
      extensionDevice = device;
      await this.repository.touchExtensionDevice(device.id, new Date(this.now()));
    }
    const user = await this.repository.findUserById(session.userId);
    if (!user || user.deletedAt !== null || !user.enabled) {
      await this.repository.revokeSession(session.id);
      throw new AuthenticationRequiredError();
    }
    return { user, session, mechanism, extensionDevice };
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

  async createExtensionPairing(input: { deviceId: string; label?: string; exchangeSecret: string; ip?: string }) {
    if (!isUuid(input.deviceId) || !isExchangeSecret(input.exchangeSecret)) {
      throw new ConflictError('Invalid extension pairing request', 'INVALID_PAIRING_REQUEST');
    }
    const now = this.now();
    const retryAfterSeconds = this.extensionPairingAttemptLimiter.consume(input.ip ?? 'unknown', input.deviceId, now);
    if (retryAfterSeconds !== null) {
      throw new TooManyRequestsError(retryAfterSeconds, 'Too many extension pairing requests');
    }
    const existingDevice = await this.repository.getExtensionDeviceByDeviceId(input.deviceId);
    if (existingDevice && (!existingDevice.enabled || existingDevice.revokedAt !== null)) {
      throw new ConflictError('Extension device has been revoked', 'DEVICE_REVOKED');
    }
    const verificationCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const pairing = await this.repository.createExtensionPairing({
      id: newSessionId(),
      deviceId: input.deviceId,
      label: safeDeviceLabel(input.label),
      exchangeSecretHash: hashToken(input.exchangeSecret),
      verificationCodeHash: hashToken(verificationCode),
      expiresAt: new Date(now + EXTENSION_PAIRING_TTL_MS),
    });
    return { pairing, verificationCode };
  }

  async listPendingExtensionPairings(): Promise<ExtensionPairingRecord[]> {
    return this.repository.listExtensionPairings('pending');
  }

  async approveExtensionPairing(id: string, verificationCode: string, approvedBy: string): Promise<ExtensionPairingRecord> {
    const pairing = await this.repository.getExtensionPairing(id);
    if (!pairing) throw new NotFoundError('Extension pairing not found');
    const now = new Date(this.now());
    if (pairing.expiresAt <= now) throw new ConflictError('Extension pairing expired', 'PAIRING_EXPIRED');
    if (pairing.status !== 'pending') throw new ConflictError('Extension pairing is not pending', `PAIRING_${pairing.status.toUpperCase()}`);
    if (!/^\d{6}$/.test(verificationCode) || pairing.verificationCodeHash !== hashToken(verificationCode)) {
      throw new ForbiddenError('Verification code does not match');
    }
    const approved = await this.repository.approveExtensionPairing(
      id,
      hashToken(verificationCode),
      approvedBy,
      now,
    );
    if (!approved) throw new ConflictError('Extension pairing is no longer pending', 'PAIRING_NOT_PENDING');
    return approved;
  }

  async exchangeExtensionPairing(id: string, exchangeSecret: string) {
    if (!isExchangeSecret(exchangeSecret)) throw new ForbiddenError();
    const pairing = await this.repository.getExtensionPairing(id);
    if (!pairing) throw new NotFoundError('Extension pairing not found');
    if (pairing.exchangeSecretHash !== hashToken(exchangeSecret)) throw new ForbiddenError();
    const now = new Date(this.now());
    if (pairing.expiresAt <= now) throw new ConflictError('Extension pairing expired', 'PAIRING_EXPIRED');
    if (pairing.status === 'pending') throw new ConflictError('Extension pairing awaits approval', 'PAIRING_PENDING');
    if (pairing.status === 'consumed') throw new ConflictError('Extension pairing has been consumed', 'PAIRING_CONSUMED');
    if (pairing.status !== 'approved' || !pairing.approvedBy) {
      throw new ConflictError('Extension pairing is unavailable', `PAIRING_${pairing.status.toUpperCase()}`);
    }
    const token = newOpaqueToken();
    const expiresAt = new Date(this.now() + this.config.auth.extensionSessionTtlSeconds * 1000);
    const exchanged = await this.repository.exchangeExtensionPairing({
      pairingId: id,
      exchangeSecretHash: hashToken(exchangeSecret),
      now,
      device: {
        id: newSessionId(),
        deviceId: pairing.deviceId,
        label: pairing.label,
        pairedBy: pairing.approvedBy,
      },
      session: {
        id: newSessionId(),
        userId: pairing.approvedBy,
        tokenHash: hashToken(token),
        clientType: 'extension',
        expiresAt,
      },
    });
    if (!exchanged) {
      const device = await this.repository.getExtensionDeviceByDeviceId(pairing.deviceId);
      if (device && (!device.enabled || device.revokedAt !== null)) {
        throw new ConflictError('Extension device has been revoked', 'DEVICE_REVOKED');
      }
      throw new ConflictError('Extension pairing has been consumed', 'PAIRING_CONSUMED');
    }
    return { token, expiresAt, device: exchanged.device };
  }

  async listExtensionDevices(): Promise<ExtensionDeviceRecord[]> {
    return this.repository.listExtensionDevices();
  }

  async revokeExtensionDevice(id: string): Promise<ExtensionDeviceRecord> {
    const device = await this.repository.revokeExtensionDevice(id);
    if (!device) throw new NotFoundError('Extension device not found');
    return device;
  }

  async deleteExtensionDevice(id: string): Promise<number> {
    const device = await this.repository.deleteExtensionDevice(id);
    if (!device) throw new NotFoundError('Extension device not found');
    return 1;
  }

  async deleteExtensionDevices(): Promise<number> {
    return this.repository.deleteExtensionDevices();
  }
}
