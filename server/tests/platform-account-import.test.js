import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { parsePlatformAccountWorkbook } from '../src/platform-accounts/import.ts';

async function workbookBuffer(rows, headers = ['原告', '被告', '账号', '密码']) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

test('平台账号导入解析原告、账号、密码并跳过空行', async () => {
  const result = await parsePlatformAccountWorkbook(await workbookBuffer([
    ['原告甲', '被告甲', 'account-a', 'password-a'],
    ['', '', '', ''],
    ['原告乙', '被告乙', 'account-b', 'password-b'],
  ]));
  assert.deepEqual(result.rows, [
    { rowNumber: 2, label: '原告甲', account: 'account-a', password: 'password-a' },
    { rowNumber: 4, label: '原告乙', account: 'account-b', password: 'password-b' },
  ]);
  assert.deepEqual(result.reasons, []);
});

test('平台账号导入拒绝错误表头并标记缺字段行且不返回敏感值', async () => {
  const invalidHeader = await workbookBuffer([['原告甲', '', 'a', 'p']], ['姓名', '被告', '账号', '密码']);
  await assert.rejects(
    () => parsePlatformAccountWorkbook(invalidHeader),
    (error) => error?.code === 'INVALID_HEADER',
  );
  const result = await parsePlatformAccountWorkbook(await workbookBuffer([
    ['原告甲', '', 'a', ''],
  ]));
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.reasons, [{ rowNumber: 2, code: 'REQUIRED_FIELD' }]);
  assert.doesNotMatch(JSON.stringify(result), /原告甲|\"account\"/);
});
