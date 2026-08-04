export const RETENTION_DAYS = 30;
export const RETENTION_WINDOW_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type Clock = () => Date;

export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - RETENTION_WINDOW_MS);
}

export function isBeforeRetentionCutoff(value: Date | null, cutoff: Date): boolean {
  return value !== null && value.getTime() < cutoff.getTime();
}
