import { startBoundLocalLoginHelper, type LocalLoginHelper } from './local-login-helper.ts';

export interface BoundBackendStartupOptions {
  migrate(): Promise<void>;
  listen(): Promise<void>;
  helper?: LocalLoginHelper;
}

/**
 * Complete mandatory backend startup work before exposing the listener, then
 * trigger optional OCR availability without making the listener wait for it.
 */
export async function startBoundBackend(options: BoundBackendStartupOptions): Promise<void> {
  await options.migrate();
  await options.listen();
  void startBoundLocalLoginHelper(options.helper);
}
