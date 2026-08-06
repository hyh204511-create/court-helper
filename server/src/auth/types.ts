export type Role = 'admin' | 'user';
export type ClientType = 'admin_ui' | 'extension';
export type ExtensionPairingStatus = 'pending' | 'approved' | 'consumed' | 'expired' | 'cancelled';

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
  extensionDeviceId: string | null;
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
  extensionDeviceId?: string | null;
  expiresAt: Date;
}

export interface ExtensionDeviceRecord {
  id: string;
  deviceId: string;
  label: string | null;
  pairedBy: string;
  enabled: boolean;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewExtensionDevice {
  id: string;
  deviceId: string;
  label?: string | null;
  pairedBy: string;
}

export interface ExtensionPairingRecord {
  id: string;
  deviceId: string;
  label: string | null;
  exchangeSecretHash: string;
  verificationCodeHash: string;
  status: ExtensionPairingStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewExtensionPairing {
  id: string;
  deviceId: string;
  label?: string | null;
  exchangeSecretHash: string;
  verificationCodeHash: string;
  expiresAt: Date;
}

export interface ExtensionPairingExchangeInput {
  pairingId: string;
  exchangeSecretHash: string;
  now: Date;
  device: NewExtensionDevice;
  session: NewSession;
}

export interface ExtensionPairingExchangeResult {
  device: ExtensionDeviceRecord;
  session: SessionRecord;
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
  deleteExpiredOrRevokedSessions(now: Date): Promise<number>;
  createExtensionPairing(input: NewExtensionPairing): Promise<ExtensionPairingRecord>;
  getExtensionPairing(id: string): Promise<ExtensionPairingRecord | null>;
  listExtensionPairings(status?: ExtensionPairingStatus): Promise<ExtensionPairingRecord[]>;
  approveExtensionPairing(
    id: string,
    verificationCodeHash: string,
    approvedBy: string,
    now: Date,
  ): Promise<ExtensionPairingRecord | null>;
  consumeExtensionPairing(
    id: string,
    exchangeSecretHash: string,
    now: Date,
  ): Promise<ExtensionPairingRecord | null>;
  exchangeExtensionPairing(input: ExtensionPairingExchangeInput): Promise<ExtensionPairingExchangeResult | null>;
  getExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null>;
  getExtensionDeviceByDeviceId(deviceId: string): Promise<ExtensionDeviceRecord | null>;
  createExtensionDevice(input: NewExtensionDevice): Promise<ExtensionDeviceRecord>;
  listExtensionDevices(): Promise<ExtensionDeviceRecord[]>;
  revokeExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null>;
  touchExtensionDevice(id: string, now: Date): Promise<void>;
}
