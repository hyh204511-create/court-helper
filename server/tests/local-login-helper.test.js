import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createLocalLoginHelper, startBoundLocalLoginHelper } from '../src/local-login-helper.ts';
import { startBoundBackend } from '../src/backend-startup.ts';

test('backend startup migrates, listens, then detaches OCR startup', async () => {
  const events = [];
  let helperStarts = 0;
  let releaseHelper;
  const started = startBoundBackend({
    migrate: async () => { events.push('migrate'); },
    listen: async () => { events.push('listen'); },
    helper: {
      ensureRunning: async () => {
        helperStarts += 1;
        events.push('helper');
        await new Promise((resolve) => { releaseHelper = resolve; });
      },
      stop: async () => {},
    },
  });

  await started;
  assert.deepEqual(events, ['migrate', 'listen', 'helper']);
  assert.equal(helperStarts, 1);
  releaseHelper();
});

test('backend startup does not start OCR when migrations or listening fail', async () => {
  let helperStarts = 0;
  const helper = {
    ensureRunning: async () => { helperStarts += 1; },
    stop: async () => {},
  };

  await assert.rejects(
    startBoundBackend({
      migrate: async () => { throw new Error('migration failed'); },
      listen: async () => {},
      helper,
    }),
    /migration failed/,
  );
  assert.equal(helperStarts, 0);

  await assert.rejects(
    startBoundBackend({
      migrate: async () => {},
      listen: async () => { throw new Error('listen failed'); },
      helper,
    }),
    /listen failed/,
  );
  assert.equal(helperStarts, 0);
});

test('OCR startup rejection does not block a listening backend', async () => {
  await startBoundBackend({
    migrate: async () => {},
    listen: async () => {},
    helper: {
      ensureRunning: async () => { throw new Error('python unavailable'); },
      stop: async () => {},
    },
  });
});

test('backend startup starts the bound OCR helper before any admin UI login', async () => {
  let starts = 0;
  await startBoundLocalLoginHelper({
    ensureRunning: async () => { starts += 1; },
    stop: async () => {},
  });
  assert.equal(starts, 1);
});

test('backend startup without an OCR helper remains supported', async () => {
  await startBoundLocalLoginHelper(undefined);
});

test('OCR startup failure does not prevent the backend from listening', async () => {
  await startBoundLocalLoginHelper({
    ensureRunning: async () => { throw new Error('python unavailable'); },
    stop: async () => {},
  });
});

test('local login helper leaves a healthy OCR service alone', async () => {
  let spawns = 0;
  const helper = createLocalLoginHelper({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
  });

  await helper.ensureRunning();
  assert.equal(spawns, 0);
});

test('local login helper starts only the fixed Python helper when health is unavailable', async () => {
  const calls = [];
  let unrefCalls = 0;
  const helper = createLocalLoginHelper({
    helperPath: 'C:/fixture/login-helper-server.py',
    pythonCommand: 'python',
    environment: {},
    fetchImpl: async () => { throw new Error('offline'); },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.unref = () => { unrefCalls += 1; };
      child.kill = () => true;
      return child;
    },
  });

  await helper.ensureRunning();
  assert.deepEqual(calls, [{
    command: 'python',
    args: ['C:/fixture/login-helper-server.py', '--ocr-only'],
    options: { stdio: 'ignore', windowsHide: true, env: {} },
  }]);
  assert.equal(unrefCalls, 1);
});

test('local login helper observes asynchronous spawn errors without throwing into the server', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.unref = () => {};
  const helper = createLocalLoginHelper({
    fetchImpl: async () => { throw new Error('offline'); },
    spawnImpl: () => child,
  });

  await helper.ensureRunning();
  assert.equal(child.listenerCount('error'), 1);
  assert.equal(child.emit('error', new Error('python unavailable')), true);
});

test('stopping during an outstanding health check prevents a late helper spawn', async () => {
  let releaseHealth;
  let spawns = 0;
  const helper = createLocalLoginHelper({
    fetchImpl: () => new Promise((resolve) => { releaseHealth = resolve; }),
    spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
  });

  const starting = helper.ensureRunning();
  const stopping = helper.stop();
  releaseHealth({ ok: false, json: async () => ({ ok: false }) });
  await Promise.all([starting, stopping]);
  assert.equal(spawns, 0);
});

test('stopping waits for the child exit event even after kill marks it as killed', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.unref = () => {};
  child.kill = () => { child.killed = true; return true; };
  const helper = createLocalLoginHelper({
    fetchImpl: async () => { throw new Error('offline'); },
    spawnImpl: () => child,
  });

  await helper.ensureRunning();
  let finished = false;
  const stopping = helper.stop().then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await stopping;
  assert.equal(finished, true);
});
