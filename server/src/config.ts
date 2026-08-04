export interface ServerConfig {
  port: number;
  databaseUrl: string;
  credentialMasterKey: Buffer;
  cors: {
    adminOrigins: string[];
    extensionOrigins: string[];
    allowedOrigins: string[];
  };
  objectStorage: {
    endpoint: string;
    bucket: string;
    accessKeyId?: string;
    accessKeySecret?: string;
    localDir?: string;
  };
  auth: {
    adminInitialPassword: string;
    sessionTtlSeconds: number;
  };
}

export type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(env: Environment, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function positiveInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  return value;
}

function origins(raw: string | undefined, name: string, requiredValue: boolean): string[] {
  if (raw === undefined || raw.trim() === '') {
    if (requiredValue) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return [];
  }

  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.includes('*')) {
    throw new Error(`Invalid environment variable: ${name}`);
  }

  for (const value of values) {
    if (!value.includes('://')) {
      throw new Error(`Invalid environment variable: ${name}`);
    }
  }
  return [...new Set(values)];
}

function credentialMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('Invalid environment variable: CREDENTIAL_MASTER_KEY');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) {
    throw new Error('Invalid environment variable: CREDENTIAL_MASTER_KEY');
  }
  return decoded;
}

export function loadConfig(env: Environment = process.env): ServerConfig {
  const port = positiveInteger(env, 'PORT', 3000);
  if (port > 65535) {
    throw new Error('Invalid environment variable: PORT');
  }

  const adminOrigins = origins(env.CORS_ADMIN_ORIGINS, 'CORS_ADMIN_ORIGINS', false);
  const extensionOrigins = origins(
    env.CORS_EXTENSION_ORIGINS ?? env.CORS_EXTENSION_ORIGIN,
    env.CORS_EXTENSION_ORIGINS !== undefined ? 'CORS_EXTENSION_ORIGINS' : 'CORS_EXTENSION_ORIGIN',
    true,
  );

  const localStorageDir = optional(env, ['LOCAL_STORAGE_DIR']);
  const objectStorageEndpoint = (localStorageDir
    ? optional(env, ['OBJECT_STORAGE_ENDPOINT']) ?? 'local://private'
    : required(env, 'OBJECT_STORAGE_ENDPOINT')).replace(/\/$/, '');
  const objectStorageBucket = localStorageDir
    ? optional(env, ['OBJECT_STORAGE_BUCKET']) ?? 'local'
    : required(env, 'OBJECT_STORAGE_BUCKET');
  const objectStorageAccessKeyId = optional(env, [
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_ACCESS_KEY',
    'OBJECT_STORAGE_SECRET_ID',
    'COS_SECRET_ID',
    'OSS_ACCESS_KEY_ID',
  ]);
  const objectStorageAccessKeySecret = optional(env, [
    'OBJECT_STORAGE_ACCESS_KEY_SECRET',
    'OBJECT_STORAGE_SECRET_KEY',
    'OBJECT_STORAGE_SECRET',
    'COS_SECRET_KEY',
    'OSS_ACCESS_KEY_SECRET',
  ]);
  const adminInitialPassword = required(env, 'ADMIN_INITIAL_PASSWORD');

  const sessionTtlSeconds = positiveInteger(env, 'SESSION_TTL_SECONDS', 8 * 60 * 60);

  return {
    port,
    databaseUrl: required(env, 'DATABASE_URL'),
    credentialMasterKey: credentialMasterKey(required(env, 'CREDENTIAL_MASTER_KEY')),
    cors: {
      adminOrigins,
      extensionOrigins,
      allowedOrigins: [...new Set([...adminOrigins, ...extensionOrigins])],
    },
    objectStorage: {
      endpoint: objectStorageEndpoint,
      bucket: objectStorageBucket,
      accessKeyId: objectStorageAccessKeyId,
      accessKeySecret: objectStorageAccessKeySecret,
      localDir: localStorageDir,
    },
    auth: {
      adminInitialPassword,
      sessionTtlSeconds,
    },
  };
}
