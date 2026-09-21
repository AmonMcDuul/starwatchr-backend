import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendReadiness, MailServiceError } from '../backend-readiness';
import { NotificationApp } from '../application';
import { MemoryStore } from '../store';
import { Config, Subscription, Job } from '../model';
import { DEFAULT_PREFERENCES } from '../shared/engine';

test('concurrent sends share a wake request, cache readiness and recheck after five minutes', async () => {
  let calls = 0;
  let time = 1000;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readiness = new BackendReadiness(
    async (_url, options) => {
      calls++;
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      assert.equal((options?.headers as Record<string, string>)['X-Notification-Key'], 'secret');
      await ready;
      return new Response(null, { status: 204 });
    },
    async () => {},
    () => time,
  );
  const a = readiness.ensure('https://api.test/internal/notification-mail', 'secret');
  const b = readiness.ensure('https://api.test/internal/notification-mail', 'secret');
  assert.equal(calls, 1);
  time += 2000;
  release();
  assert.deepEqual(await Promise.all([a, b]), [2000, 2000]);
  assert.equal(await readiness.ensure('https://api.test/internal/notification-mail', 'secret'), 0);
  assert.equal(calls, 1);
  time += 300001;
  await readiness.ensure('https://api.test/internal/notification-mail', 'secret');
  assert.equal(calls, 2);
});

test('cold-start failures retry with bounded delays and never POST mail', async () => {
  const delays: number[] = [];
  let calls = 0;
  const readiness = new BackendReadiness(
    async (_url, options) => {
      assert.equal(options?.method, 'GET');
      return new Response(null, { status: ++calls === 3 ? 204 : 503 });
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  await readiness.ensure('https://api.test/mail', 'secret');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 4000]);
});

test('Free quota 403 stays retryable with cooldown; wrong key is a permanent configuration failure', async () => {
  for (const status of [403, 401]) {
    let calls = 0;
    const readiness = new BackendReadiness(
      async () => {
        calls++;
        return new Response(null, { status });
      },
      async () => {
        throw new Error('No immediate retries for quota or authentication');
      },
    );
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        readiness.ensure('https://api.test/mail', 'secret'),
        (error: unknown) =>
          error instanceof MailServiceError &&
          error.status === status &&
          error.retryable === (status === 403) &&
          error.stage === 'wake',
      );
    }
    assert.equal(calls, 1);
  }
});

const config: Config = {
  siteUrl: 'https://starwatchr.com',
  apiUrl: 'https://worker.test/api',
  tokenSecret: 'test-secret-with-at-least-32-characters',
  adminKey: '',
  emailEnabled: true,
  pushEnabled: false,
  vapidPublicKey: '',
  mode: 'live',
};
const now = Date.now();
function subscription(): Subscription {
  return {
    id: 's',
    channel: 'email',
    email: 'test@example.test',
    state: 'pending',
    place: { name: 'Amsterdam', latitude: 52.37, longitude: 4.89, timeZone: 'Europe/Amsterdam' },
    preferences: DEFAULT_PREFERENCES,
    manageHash: '',
    manageExpires: now + 86400000,
    createdAt: now,
    updatedAt: now,
  };
}
const job: Job = {
  id: 'j',
  kind: 'confirm',
  subscriptionId: 's',
  createdAt: now,
  state: 'pending',
  attempts: 0,
  nextAttempt: now,
  expires: now + 86400000,
};

test('subscription is rechecked after waking; a changed subscription never sends', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  await store.create('jobs', job);
  let sent = false;
  const app = new NotificationApp(
    store,
    config,
    async () => {
      throw new Error();
    },
    {
      prepare: async () => {
        const row = (await store.get<Subscription>('subscriptions', 's'))!;
        await store.replace('subscriptions', { ...row.value, state: 'suppressed' }, row.etag);
        return { backendWakeMs: 2000 };
      },
      send: async () => {
        sent = true;
        return {};
      },
    },
    async () => {},
  );
  await app.process('j', now);
  const saved = (await store.get<Job>('jobs', 'j'))!.value;
  assert.equal(sent, false);
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.backendWakeMs, 2000);
});

test('quota failures stay queued, record wake phase, and never attempt SMTP', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  await store.create('jobs', job);
  const app = new NotificationApp(
    store,
    config,
    async () => {
      throw new Error();
    },
    {
      prepare: async () => {
        throw new MailServiceError(403, 'wake', true);
      },
      send: async () => {
        throw new Error('Must not send');
      },
    },
    async () => {},
  );
  await app.process('j', now);
  const saved = (await store.get<Job>('jobs', 'j'))!.value;
  assert.equal(saved.state, 'pending');
  assert.equal(saved.errorStage, 'wake');
  assert.equal(saved.errorCode, 403);
  assert(saved.nextAttempt > now);
});

test('expired queued messages are retained as cancelled in the delivery log', async () => {
  const store = new MemoryStore();
  await store.create('jobs', { ...job, expires: now - 1 });
  const app = new NotificationApp(
    store,
    config,
    async () => {
      throw new Error();
    },
    { send: async () => ({}) },
    async () => {},
  );
  await app.tick(now);
  const saved = (await store.get<Job>('jobs', 'j'))!.value;
  assert.equal(saved.state, 'cancelled');
  assert(saved.expires > now);
});
