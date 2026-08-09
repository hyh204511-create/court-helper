export const REPORT_EXPORT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

export interface ReportExportRecord {
  id: string;
  fileName: string;
  objectKey: string;
  contentType: typeof REPORT_EXPORT_CONTENT_TYPE;
  byteSize: number;
  sha256: string;
  platformAccountId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewReportExport {
  id?: string;
  fileName: string;
  objectKey: string;
  contentType: typeof REPORT_EXPORT_CONTENT_TYPE;
  byteSize: number;
  sha256: string;
  platformAccountId: string;
  createdBy: string;
}

export interface ReportExportCursor {
  createdAt: Date;
  id: string;
}

export interface ReportExportListOptions {
  createdBy?: string;
  platformAccountId?: string;
  limit: number;
  cursor?: ReportExportCursor;
}

export interface ReportExportPage {
  items: ReportExportRecord[];
  nextCursor: ReportExportCursor | null;
}

export interface ReportExportRepository {
  findById(id: string, createdBy?: string): Promise<ReportExportRecord | null>;
  findBySha256AndCreatedBy(sha256: string, createdBy: string, platformAccountId: string): Promise<ReportExportRecord | null>;
  list(options: ReportExportListOptions): Promise<ReportExportPage>;
  create(input: NewReportExport): Promise<ReportExportRecord>;
  delete(id: string): Promise<void>;
}

export interface ReportExportAccess {
  userId: string;
  role: 'admin' | 'user';
}
