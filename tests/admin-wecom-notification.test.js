import test from 'node:test';
import assert from 'node:assert/strict';

import { renderAdminPage } from '../server/src/admin/pages.ts';
import { ADMIN_SCRIPT } from '../server/src/admin/assets.ts';

test('case detail provides a one-shot WeCom form for salesperson and assistant mentions', () => {
  const html = renderAdminPage('case-detail', 'admin', 'synthetic-case-id');
  assert.match(html, /id="wecom-notification-form"/);
  assert.match(html, />业务员手机号</);
  assert.match(html, />助理手机号</);
  assert.match(html, /手机号仅用于本次推送，不保存/);
  assert.match(ADMIN_SCRIPT, /wecom-notifications/);
  assert.match(ADMIN_SCRIPT, /form\.reset\(\)/);
});
