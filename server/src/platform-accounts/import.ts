import ExcelJS from 'exceljs';

export const MAX_PLATFORM_ACCOUNT_IMPORT_ROWS = 2000;

export interface PlatformAccountImportRow {
  rowNumber: number;
  label: string;
  account: string;
  password: string;
  salespersonName: string | null;
  assistantName: string | null;
}

export interface PlatformAccountImportReason {
  rowNumber: number;
  code: 'REQUIRED_FIELD' | 'CONTACT_PAIR_REQUIRED' | 'INVALID_CONTACT_NAME' | 'DUPLICATE_LABEL';
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

const SALESPERSON_COLUMN = 21;
const ASSISTANT_COLUMN = 22;
const CONTACT_NAME_LIMIT = 64;

function validContactName(value: string): boolean {
  return Array.from(value).length <= CONTACT_NAME_LIMIT
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
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
  const hasContactColumns = sheet.columnCount >= SALESPERSON_COLUMN;
  if (hasContactColumns && (
    cellText(sheet.getCell(1, SALESPERSON_COLUMN).value) !== '业务员'
    || cellText(sheet.getCell(1, ASSISTANT_COLUMN).value) !== '助理'
  )) {
    throw new PlatformAccountImportError('INVALID_HEADER');
  }

  const rows: PlatformAccountImportRow[] = [];
  const reasons: PlatformAccountImportReason[] = [];
  let nonEmptyRows = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = [1, 2, 3, 4].map((column) => cellText(row.getCell(column).value));
    const salespersonName = hasContactColumns ? cellText(row.getCell(SALESPERSON_COLUMN).value) : '';
    const assistantName = hasContactColumns ? cellText(row.getCell(ASSISTANT_COLUMN).value) : '';
    if (values.every((value) => value === '') && !salespersonName && !assistantName) return;
    nonEmptyRows += 1;
    if (nonEmptyRows > MAX_PLATFORM_ACCOUNT_IMPORT_ROWS) {
      throw new PlatformAccountImportError('ROW_LIMIT_EXCEEDED');
    }
    if (values.some((value) => value === '')) {
      reasons.push({ rowNumber, code: 'REQUIRED_FIELD' });
      return;
    }
    if (Boolean(salespersonName) !== Boolean(assistantName)) {
      reasons.push({ rowNumber, code: 'CONTACT_PAIR_REQUIRED' });
      return;
    }
    if ((salespersonName && !validContactName(salespersonName)) || (assistantName && !validContactName(assistantName))) {
      reasons.push({ rowNumber, code: 'INVALID_CONTACT_NAME' });
      return;
    }
    rows.push({
      rowNumber,
      label: values[0],
      account: values[2],
      password: values[3],
      salespersonName: salespersonName || null,
      assistantName: assistantName || null,
    });
  });
  return { rows, reasons };
}
