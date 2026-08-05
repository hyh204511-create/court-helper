import argon2 from 'argon2';

// A public, valid Argon2id hash used only to equalize the unknown-user path.
export const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,p=4,t=3$6MoSTrmayIksxJlofQUSKg$9TRUAKM9ZmnMEMZuxwo4vKX1IlPTWV9H8jLWVuVJ+OI';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}
