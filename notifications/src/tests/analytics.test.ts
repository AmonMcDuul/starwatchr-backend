import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationApp } from '../application';
import { notificationAnalytics } from '../analytics';
import { MemoryStore } from '../store';
import { Config, Job, Subscription } from '../model';
import { DEFAULT_PREFERENCES } from '../shared/engine';

const now = Date.now();
const day = 86_400_000;
const config: Config = {
  siteUrl: 'https://starwatchr.com',
  apiUrl: 'https://worker.example.test/api',
  tokenSecret: 'a-separate-signing-secret-at-least-32-characters',
  adminKey: 'a-separate-admin-secret-at-least-32-characters',
  analyticsKey: 'a-separate-read-only-key-at-least-32-characters',
  mode: 'live',
  emailEnabled: true,
  pushEnabled: true,
  vapidPublicKey: '',
};
function subscription(id = 'subscriber'): Subscription {
  return {
    id,
    channel: 'email',
    email: 'observer@example.test',
    place: { name: 'Amsterdam', latitude: 52.37, longitude: 4.89, timeZone: 'Europe/Amsterdam' },
    preferences: { ...DEFAULT_PREFERENCES },
    state: 'pending',
    manageHash: 'secret-management-hash',
    manageExpires: now + day,
    createdAt: now - 1000,
    updatedAt: now - 1000,
    push: {
      endpoint: 'https://secret-push-endpoint.test',
      keys: { auth: 'secret-auth', p256dh: 'secret-push-key' },
    },
  };
}
function job(id: string, changes: Partial<Job> = {}): Job {
  return {
    id,
    kind: 'confirm',
    subscriptionId: 'subscriber',
    createdAt: now - 100,
    state: 'pending',
    attempts: 0,
    nextAttempt: now - 100,
    expires: now + day,
    token: 'secret-confirm-token',
    ...changes,
  };
}
function app(store: MemoryStore, fail = false) {
  return new NotificationApp(
    store,
    config,
    async () => {
      throw new Error('No weather in this test');
    },
    {
      send: async () => {
        if (fail) throw Object.assign(new Error('secret-provider-message'), { status: 503 });
        return { providerId: 'private-provider-id' };
      },
    },
    async () => {},
  );
}
test('read key is required and cannot access operator mutations; response is explicitly redacted', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  await store.create('jobs', job('message'));
  const service = app(store);
  for (const key of ['', 'wrong', config.adminKey]) {
    assert.equal((await service.handle('GET', 'admin/analytics', {}, key, now)).status, 401);
  }
  const response = await service.handle('GET', 'admin/analytics', {}, config.analyticsKey!, now);
  assert.equal(response.status, 200);
  assert.equal(response.body.subscribers[0].email, 'observer@example.test');
  const json = JSON.stringify(response.body);
  for (const privateValue of [
    'secret-management-hash',
    'secret-confirm-token',
    'secret-push',
    'private-provider-id',
    'manageHash',
    'tokenSecret',
    'p256dh',
    'latitude',
    'longitude',
  ]) {
    assert(!json.includes(privateValue), privateValue);
  }
  assert.equal(
    (
      await service.handle(
        'POST',
        'admin/suppress',
        { email: 'observer@example.test' },
        config.analyticsKey!,
        now,
      )
    ).status,
    401,
  );
  assert.equal(
    (await service.handle('GET', 'admin/jobs', {}, config.analyticsKey!, now)).status,
    401,
  );
});

test('only actual deliveries count as messages; legacy sending times are never invented', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  await store.create('jobs', job('evaluation', { kind: 'evaluate', state: 'sent' }));
  await store.create('jobs', job('old-sent', { state: 'sent', attempts: 1 }));
  await store.create('jobs', job('expired', { expires: now - 1 }));
  const report = await notificationAnalytics(store, config, now);
  assert.equal(report.totals.deliveries, 2);
  assert.equal(report.totals.sentEmail, 1);
  assert.equal(report.totals.cancelled, 1);
  assert.equal(report.totals.pending, 0);
  assert.equal(report.totals.sentWithoutTimestamp, 1);
  assert.equal(report.deliveries.find((row) => row.id === 'old-sent')!.sentAt, null);
  assert.equal(
    report.daily.reduce((total, row) => total + row.email + row.push, 0),
    0,
  );
});

test('successful delivery records real sending time and recipient, clears retry error, survives removed subscriber', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  await store.create(
    'jobs',
    job('send', { attempts: 1, error: 'Provider unavailable', errorCode: 503 }),
  );
  const before = Date.now();
  await app(store).process('send', now);
  const saved = (await store.get<Job>('jobs', 'send'))!.value;
  assert.equal(saved.state, 'sent');
  assert(saved.sentAt! >= before && saved.sentAt! <= Date.now());
  assert.equal(saved.deliveryRecipient, 'observer@example.test');
  assert.equal(saved.error, undefined);
  assert.equal(saved.errorCode, undefined);
  const sub = (await store.get<Subscription>('subscriptions', 'subscriber'))!;
  await store.remove('subscriptions', 'subscriber', sub.etag);
  const report = await notificationAnalytics(store, config, Date.now());
  assert.equal(report.deliveries[0].recipient, 'observer@example.test');
  assert.equal(report.totals.sentEmail, 1);
  assert.equal(report.totals.retried, 1);
  assert(!JSON.stringify(report).includes('private-provider-id'));
});

test('failed attempt records safe provider status and leaves delivery retryable', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  await store.create('jobs', job('retry'));
  await app(store, true).process('retry', now);
  const report = await notificationAnalytics(store, config, now);
  const row = report.deliveries[0];
  assert.equal(row.state, 'pending');
  assert.equal(row.errorCode, 503);
  assert.equal(row.lastAttemptAt, now);
  assert.equal(row.sentAt, null);
  assert(row.nextAttempt! > now);
  assert(!JSON.stringify(report).includes('secret-provider-message'));
});

test('response caps do not truncate totals; old records are excluded and newest records retained', async () => {
  const store = new MemoryStore();
  await store.create('subscriptions', subscription());
  for (let index = 0; index < 503; index++) {
    await store.create('jobs', job(String(index), { createdAt: now - index * 1000 }));
  }
  await store.create('jobs', job('too-old', { createdAt: now - 15 * day, state: 'sent' }));
  const report = await notificationAnalytics(store, config, now);
  assert.equal(report.totals.deliveries, 503);
  assert.equal(report.deliveries.length, 500);
  assert.equal(report.deliveries[0].id, '0');
  assert.equal(report.deliveries[499].id, '499');
});

test('scheduler health is visible even with no subscriptions', async () => {
  const store = new MemoryStore();
  await app(store).tick(now);
  const report = await notificationAnalytics(store, config, Date.now());
  assert.equal(report.scheduler?.startedAt, now);
  assert(report.scheduler?.completedAt! >= now);
  assert.equal(report.totals.evaluations, 0);
});
