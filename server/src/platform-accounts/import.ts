import ExcelJS from 'exceljs';

export const MAX_PLATFORM_ACCOUNT_IMPORT_ROWS = 2000;

export interface PlatformAccountImportRow {
  rowNumber: number;
  label: string;
  account: string;
  password: string;
}

export interface PlatformAccountImportReason {
  rowNumber: number;
  code: 'REQUIRED_FIELD' | 'DUPLICATE_LABEL';
}

export interface PlatformAccountWorkbookResult {
  rows: PlatformAccountImportRow[];
  reasons: PlatformAccountImportReason[];
}

export class PlatformAccountImportError extends Error {
  readonly code: 'INVALID_HEADER' | 'ROW_LIMIT_EXCEEDED' | 'SHEET_REQUIRED';

  constructor(code: PlatformAccountImportError['code']) {
    super(code);
    this.name = 'PlatformAccountImportError';
    this.code = code;
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text?: unknown }).text ?? '').trim();
  }
  return String(value).trim();
}

export async function parsePlatformAccountWorkbook(input: Buffer | Uint8Array): Promise<PlatformAccountWorkbookResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as unknown as any);
  const sheet = workbook.getWorksheet('Sheet1');
  if (!sheet) throw new PlatformAccountImportError('SHEET_REQUIRED');

  const headers = [1, 2, 3, 4].map((column) => cellText(sheet.getCell(1, column).value));
  if (headers.join('\u0000') !== ['原告', '被告', '账号', '密码'].join('\u0000')) {
    throw new PlatformAccountImportError('INVALID_HEADER');
  }

  const rows: PlatformAccountImportRow[] = [];
  const reasons: PlatformAccountImportReason[] = [];
  let nonEmptyRows = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = [1, 2, 3, 4].map((column) => cellText(row.getCell(column).value));
    if (values.every((value) => value === '')) return;
    nonEmptyRows += 1;
    if (nonEmptyRows > MAX_PLATFORM_ACCOUNT_IMPORT_ROWS) {
      throw new PlatformAccountImportError('ROW_LIMIT_EXCEEDED');
    }
    if (values.some((value) => value === '')) {
      reasons.push({ rowNumber, code: 'REQUIRED_FIELD' });
      return;
    }
    rows.push({ rowNumber, label: values[0], account: values[2], password: values[3] });
  });
  return { rows, reasons };
}
