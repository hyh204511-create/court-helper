import { randomUUID } from 'node:crypto';

import type {
  AuthRepository,
  ExtensionDeviceRecord,
  ExtensionPairingRecord,
  ExtensionPairingStatus,
  NewExtensionDevice,
  ExtensionPairingExchangeInput,
  ExtensionPairingExchangeResult,
  NewExtensionPairing,
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

function copyDevice(device: ExtensionDeviceRecord): ExtensionDeviceRecord {
  return {
    ...device,
    revokedAt: device.revokedAt ? new Date(device.revokedAt) : null,
    lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt) : null,
    createdAt: new Date(device.createdAt),
    updatedAt: new Date(device.updatedAt),
  };
}

function copyPairing(pairing: ExtensionPairingRecord): ExtensionPairingRecord {
  return {
    ...pairing,
    approvedAt: pairing.approvedAt ? new Date(pairing.approvedAt) : null,
    consumedAt: pairing.consumedAt ? new Date(pairing.consumedAt) : null,
    expiresAt: new Date(pairing.expiresAt),
    createdAt: new Date(pairing.createdAt),
    updatedAt: new Date(pairing.updatedAt),
  };
}

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly extensionDevices = new Map<string, ExtensionDeviceRecord>();
  private readonly extensionPairings = new Map<string, ExtensionPairingRecord>();

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
      extensionDeviceId: input.extensionDeviceId ?? null,
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

  async createExtensionPairing(input: NewExtensionPairing): Promise<ExtensionPairingRecord> {
    const now = new Date();
    for (const current of this.extensionPairings.values()) {
      if (current.deviceId === input.deviceId && (current.status === 'pending' || current.status === 'approved')) {
        current.status = 'cancelled';
        current.updatedAt = new Date(now);
      }
    }
    const pairing: ExtensionPairingRecord = {
      id: input.id,
      deviceId: input.deviceId,
      label: input.label ?? null,
      exchangeSecretHash: input.exchangeSecretHash,
      verificationCodeHash: input.verificationCodeHash,
      status: 'pending',
      approvedBy: null,
      approvedAt: null,
      consumedAt: null,
      expiresAt: new Date(input.expiresAt),
      createdAt: now,
      updatedAt: now,
    };
    this.extensionPairings.set(pairing.id, pairing);
    return copyPairing(pairing);
  }

  async getExtensionPairing(id: string): Promise<ExtensionPairingRecord | null> {
    const pairing = this.extensionPairings.get(id);
    return pairing ? copyPairing(pairing) : null;
  }

  async listExtensionPairings(status?: ExtensionPairingStatus): Promise<ExtensionPairingRecord[]> {
    return [...this.extensionPairings.values()]
      .filter((pairing) => status === undefined || pairing.status === status)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(copyPairing);
  }

  async approveExtensionPairing(id: string, verificationCodeHash: string, approvedBy: string, now: Date): Promise<ExtensionPairingRecord | null> {
    const pairing = this.extensionPairings.get(id);
    if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= now || pairing.verificationCodeHash !== verificationCodeHash) return null;
    pairing.status = 'approved';
    pairing.approvedBy = approvedBy;
    pairing.approvedAt = new Date(now);
    pairing.updatedAt = new Date(now);
    return copyPairing(pairing);
  }

  async consumeExtensionPairing(id: string, exchangeSecretHash: string, now: Date): Promise<ExtensionPairingRecord | null> {
    const pairing = this.extensionPairings.get(id);
    if (!pairing || pairing.status !== 'approved' || pairing.expiresAt <= now || pairing.exchangeSecretHash !== exchangeSecretHash) return null;
    pairing.status = 'consumed';
    pairing.consumedAt = new Date(now);
    pairing.updatedAt = new Date(now);
    return copyPairing(pairing);
  }

  async exchangeExtensionPairing(input: ExtensionPairingExchangeInput): Promise<ExtensionPairingExchangeResult | null> {
    const pairing = this.extensionPairings.get(input.pairingId);
    if (!pairing || pairing.status !== 'approved' || pairing.expiresAt <= input.now || pairing.exchangeSecretHash !== input.exchangeSecretHash) {
      return null;
    }
    let device = [...this.extensionDevices.values()].find((candidate) => candidate.deviceId === pairing.deviceId);
    if (device && (!device.enabled || device.revokedAt !== null)) return null;
    if (!device) {
      const createdAt = new Date(input.now);
      device = {
        id: input.device.id,
        deviceId: pairing.deviceId,
        label: pairing.label,
        pairedBy: pairing.approvedBy as string,
        enabled: true,
        revokedAt: null,
        lastSeenAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      this.extensionDevices.set(device.id, device);
    }
    const session: SessionRecord = {
      ...input.session,
      extensionDeviceId: device.id,
      revokedAt: null,
      createdAt: new Date(input.now),
    };
    this.sessions.set(session.id, session);
    pairing.status = 'consumed';
    pairing.consumedAt = new Date(input.now);
    pairing.updatedAt = new Date(input.now);
    return { device: copyDevice(device), session: copySession(session) };
  }

  async getExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null> {
    const device = this.extensionDevices.get(id);
    return device ? copyDevice(device) : null;
  }

  async getExtensionDeviceByDeviceId(deviceId: string): Promise<ExtensionDeviceRecord | null> {
    const device = [...this.extensionDevices.values()].find((candidate) => candidate.deviceId === deviceId);
    return device ? copyDevice(device) : null;
  }

  async createExtensionDevice(input: NewExtensionDevice): Promise<ExtensionDeviceRecord> {
    if ([...this.extensionDevices.values()].some((device) => device.deviceId === input.deviceId)) throw duplicateError();
    const now = new Date();
    const device: ExtensionDeviceRecord = {
      id: input.id,
      deviceId: input.deviceId,
      label: input.label ?? null,
      pairedBy: input.pairedBy,
      enabled: true,
      revokedAt: null,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.extensionDevices.set(device.id, device);
    return copyDevice(device);
  }

  async listExtensionDevices(): Promise<ExtensionDeviceRecord[]> {
    return [...this.extensionDevices.values()]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(copyDevice);
  }

  async revokeExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null> {
    const device = this.extensionDevices.get(id);
    if (!device) return null;
    if (!device.revokedAt) device.revokedAt = new Date();
    device.enabled = false;
    device.updatedAt = new Date();
    for (const session of this.sessions.values()) {
      if (session.extensionDeviceId === id && !session.revokedAt) session.revokedAt = new Date();
    }
    return copyDevice(device);
  }

  async deleteExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null> {
    const device = this.extensionDevices.get(id);
    if (!device) return null;
    for (const session of this.sessions.values()) {
      if (session.extensionDeviceId === id) session.revokedAt = session.revokedAt ?? new Date();
    }
    for (const [pairingId, pairing] of this.extensionPairings) {
      if (pairing.deviceId === device.deviceId && (pairing.status === 'pending' || pairing.status === 'approved')) {
        pairing.status = 'cancelled';
        pairing.updatedAt = new Date();
        this.extensionPairings.set(pairingId, pairing);
      }
    }
    this.extensionDevices.delete(id);
    return copyDevice(device);
  }

  async deleteExtensionDevices(): Promise<number> {
    const ids = [...this.extensionDevices.keys()];
    let deleted = 0;
    for (const id of ids) {
      if (await this.deleteExtensionDevice(id)) deleted += 1;
    }
    return deleted;
  }

  async touchExtensionDevice(id: string, now: Date): Promise<void> {
    const device = this.extensionDevices.get(id);
    if (!device) return;
    device.lastSeenAt = new Date(now);
    device.updatedAt = new Date(now);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].map(copySession);
  }
}

export type { Role };
