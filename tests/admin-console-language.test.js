import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAdminPage } from '../server/src/admin/pages.ts';
import { ADMIN_SCRIPT, ADMIN_STYLES } from '../server/src/admin/assets.ts';

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('后台控制台用户可见文案全部使用中文', () => {
  for (const page of ['login', 'users', 'platform-accounts', 'cases', 'case-detail', 'report-exports', 'browser-control', 'forbidden']) {
    const text = visibleText(renderAdminPage(page, 'admin', '示例案件'));
    assert.doesNotMatch(text, /Court Helper|Registry|Access|Sources|Cases|Case|Exports|Browser|Commands|Restricted|Read Only|Retained|People|Credentials|Files/i, page);
    assert.doesNotMatch(renderAdminPage(page, 'admin', '示例案件'), /class="(?:brand-mark|eyebrow)"/);
  }
});

test('左侧菜单使用浅蓝白背景、黑色大字号', () => {
  assert.match(ADMIN_STYLES, /\.sidebar\s*\{[^}]*color:\s*#111827;[^}]*background:\s*(?:linear-gradient\([^;]+\)|#(?:[0-9a-f]{3,8}))/is);
  assert.match(ADMIN_STYLES, /\.nav a\s*\{[^}]*color:\s*#111827;[^}]*font-size:\s*17px;/is);
});

test('任务表不直接展示英文命令类型或结果码', () => {
  assert.match(ADMIN_SCRIPT, /function browserCommandTypeLabel\(type\)/);
  assert.match(ADMIN_SCRIPT, /browserCommandTypeLabel\(command\.type\)/);
  assert.doesNotMatch(ADMIN_SCRIPT, /element\('td', command\.type\)/);
});
