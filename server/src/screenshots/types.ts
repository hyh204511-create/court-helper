export const SCREENSHOT_TYPES = ['success', 'reject', 'enforcement_success'] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];

export const SCREENSHOT_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;
export type ScreenshotContentType = (typeof SCREENSHOT_CONTENT_TYPES)[number];

export interface ScreenshotRecord {
  id: string;
  caseId: string;
  type: ScreenshotType;
  objectKey: string;
  contentType: ScreenshotContentType;
  byteSize: number;
  sha256: string;
  capturedAt: Date;
  createdAt: Date;
}

export interface NewScreenshot {
  id?: string;
  caseId: string;
  type: ScreenshotType;
  objectKey: string;
  contentType: ScreenshotContentType;
  byteSize: number;
  sha256: string;
  capturedAt: Date;
}

export interface ScreenshotUpdate {
  objectKey: string;
  contentType: ScreenshotContentType;
  byteSize: number;
  sha256: string;
  capturedAt: Date;
}

export interface ScreenshotRepository {
  findById(id: string): Promise<ScreenshotRecord | null>;
  findByCaseIdAndType(caseId: string, type: ScreenshotType): Promise<ScreenshotRecord | null>;
  listByCaseId(caseId: string): Promise<ScreenshotRecord[]>;
  create(input: NewScreenshot): Promise<ScreenshotRecord>;
  update(id: string, input: ScreenshotUpdate): Promise<ScreenshotRecord | null>;
  delete(id: string): Promise<void>;
}
