import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAdminPage } from '../server/src/admin/pages.ts';
import { ADMIN_SCRIPT } from '../server/src/admin/assets.ts';

test('platform accounts bind contacts and case detail exposes automatic status with manual retry', () => {
  const platformHtml = renderAdminPage('platform-accounts', 'admin');
  assert.match(platformHtml, /id="platform-salesperson-name"/);
  assert.match(platformHtml, /id="platform-assistant-name"/);
  assert.doesNotMatch(platformHtml, /platform-salesperson-mobile|platform-assistant-mobile|platform-salesperson-wecom-userid|platform-assistant-wecom-userid/);
  const html = renderAdminPage('case-detail', 'admin', 'synthetic-case-id');
  assert.match(html, /id="wecom-notification-list"/);
  assert.match(html, /终态截图入库后自动推送一次/);
  assert.match(ADMIN_SCRIPT, /wecom-notifications/);
  assert.match(ADMIN_SCRIPT, /retry-wecom/);
});

test('后台 API 为 PUT 写请求携带 CSRF 令牌', () => {
  assert.match(ADMIN_SCRIPT, /\['POST', 'PUT', 'PATCH', 'DELETE'\]/);
});
