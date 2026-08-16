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

const CONTACT_HEADERS = [
  '原告', '被告', '账号', '密码',
  ...Array.from({ length: 16 }, (_, index) => `兼容列${index + 5}`),
  '业务员', '助理',
];

test('平台账号导入解析原告、账号、密码并跳过空行', async () => {
  const result = await parsePlatformAccountWorkbook(await workbookBuffer([
    ['原告甲', '被告甲', 'account-a', 'password-a'],
    ['', '', '', ''],
    ['原告乙', '被告乙', 'account-b', 'password-b'],
  ]));
  assert.deepEqual(result.rows, [
    { rowNumber: 2, label: '原告甲', account: 'account-a', password: 'password-a', salespersonName: null, assistantName: null },
    { rowNumber: 4, label: '原告乙', account: 'account-b', password: 'password-b', salespersonName: null, assistantName: null },
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

test('平台账号导入读取 22 列报表的业务员和助理并清理空白', async () => {
  const row = [
    '原告甲', '被告甲', 'account-a', 'password-a',
    ...Array(16).fill(null),
    ' 业务员甲 ', ' 助理甲 ',
  ];
  const result = await parsePlatformAccountWorkbook(await workbookBuffer([row], CONTACT_HEADERS));
  assert.deepEqual(result, {
    rows: [{
      rowNumber: 2,
      label: '原告甲',
      account: 'account-a',
      password: 'password-a',
      salespersonName: '业务员甲',
      assistantName: '助理甲',
    }],
    reasons: [],
  });
});

test('平台账号导入拒绝不完整联系人表头并安全跳过不合法联系人行', async () => {
  const incompleteHeaders = CONTACT_HEADERS.slice(0, 21);
  const incompleteWorkbook = await workbookBuffer([], incompleteHeaders);
  await assert.rejects(
    () => parsePlatformAccountWorkbook(incompleteWorkbook),
    (error) => error?.code === 'INVALID_HEADER',
  );

  const rows = [
    ['原告甲', '被告甲', 'account-a', 'password-a', ...Array(16).fill(null), '业务员甲', ''],
    ['原告乙', '被告乙', 'account-b', 'password-b', ...Array(16).fill(null), 'x'.repeat(65), '助理乙'],
  ];
  const result = await parsePlatformAccountWorkbook(await workbookBuffer(rows, CONTACT_HEADERS));
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.reasons, [
    { rowNumber: 2, code: 'CONTACT_PAIR_REQUIRED' },
    { rowNumber: 3, code: 'INVALID_CONTACT_NAME' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /业务员甲|助理乙/);
});
