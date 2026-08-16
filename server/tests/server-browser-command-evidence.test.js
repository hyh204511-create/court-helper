import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserCommandEvidenceVerifier } from '../src/browser-commands/evidence-verifier.ts';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000111';
const USER_ID = '00000000-0000-4000-8000-000000000222';

function caseRecord(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000333',
    createdBy: USER_ID,
    clientUid: 'synthetic-client',
    platformAccountId: ACCOUNT_ID,
    kind: 'qz',
    plaintiff: 'SYNTHETIC-A',
    defendant: 'SYNTHETIC-B',
    status: '强执成功',
    filedTime: '2026-08-16',
    caseNumber: 'SYNTHETIC-NUMBER',
    rejectTime: null,
    rejectReason: null,
    queryTime: new Date('2026-08-16T00:00:00Z'),
    needsHuman: false,
    errorCode: null,
    sourceEventId: 'case-proof-current',
    sourceUpdatedAt: new Date('2026-08-16T00:00:00Z'),
    revision: 1,
    createdAt: new Date('2026-08-16T00:00:00Z'),
    updatedAt: new Date('2026-08-16T00:00:00Z'),
    ...overrides,
  };
}

function verifier({ value = caseRecord(), screenshot = null } = {}) {
  return createBrowserCommandEvidenceVerifier(
    { list: async () => value ? [value] : [] },
    { findByCaseIdAndType: async () => screenshot },
  );
}

const input = {
  platformAccountId: ACCOUNT_ID,
  requestedBy: USER_ID,
  evidenceEventIds: ['case-proof-current'],
};

test('server evidence verifier requires a terminal screenshot but does not block on notification delivery', async () => {
  assert.equal(await verifier()(input), false);
  const screenshot = { id: '00000000-0000-4000-8000-000000000444' };
  assert.equal(await verifier({ screenshot })(input), true);
});

test('server evidence verifier accepts non-terminal review evidence without a screenshot', async () => {
  assert.equal(await verifier({ value: caseRecord({ status: '审核中' }) })(input), true);
  assert.equal(await verifier({ value: caseRecord({ needsHuman: true }) })(input), false);
});
