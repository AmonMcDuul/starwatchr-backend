import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationApp } from '../application';
import { MemoryStore } from '../store';
import { Config, Subscription, Job, Evaluation } from '../model';
import { DEFAULT_PREFERENCES, WeatherSnapshot, WeatherHour } from '../shared/engine';
import { hash, validatePush } from '../security';
import { renderAdvice } from '../delivery';
const now = Date.parse('2026-09-18T14:10:00Z');
const place = { name: 'Amsterdam', latitude: 52.37, longitude: 4.89, timeZone: 'Europe/Amsterdam' };
const preferences = structuredClone(DEFAULT_PREFERENCES);
const weather: WeatherSnapshot = {
  latitude: 52.37,
  longitude: 4.89,
  timeZone: place.timeZone,
  fetchedAt: now,
  hours: Array.from(
    { length: 48 },
    (_, i): WeatherHour => ({
      time: Date.parse('2026-09-18T00:00:00Z') + i * 3600000,
      cloud: 5,
      low: 0,
      mid: 0,
      high: 5,
      windKmh: 5,
      windDirection: 180,
      temperature: 12,
      dewPoint: 6,
      humidity: 60,
      visibility: 30000,
      precipitation: 0,
      precipitationProbability: 0,
      wind500Kmh: 30,
    }),
  ),
};
function setup(mode: 'live' | 'dry-run' = 'live') {
  const store = new MemoryStore(),
    queue: string[] = [],
    sent: Job[] = [];
  const config: Config = {
    siteUrl: 'https://starwatchr.com',
    apiUrl: 'https://example.test/api',
    tokenSecret: 'test-secret-at-least-thirty-two-characters',
    mode,
    vapidPublicKey: 'public-test-key',
    emailEnabled: true,
    pushEnabled: true,
    adminKey: 'test-admin',
  };
  const app = new NotificationApp(
    store,
    config,
    async () => structuredClone(weather),
    {
      send: async (_s, j) => {
        sent.push(j);
        return { providerId: 'test-' + j.id };
      },
    },
    async (id) => {
      queue.push(id);
    },
  );
  return { app, store, queue, sent };
}
async function active(ctx: ReturnType<typeof setup>) {
  const id = ctx.app.tokens.addressId('test@example.test');
  const s: Subscription = {
    id,
    channel: 'email',
    email: 'test@example.test',
    place,
    preferences,
    state: 'active',
    manageHash: hash('credential'),
    manageExpires: now + 86400000,
    createdAt: now - 10000,
    updatedAt: now - 10000,
  };
  await ctx.store.create('subscriptions', s);
  return s;
}
async function drain(ctx: ReturnType<typeof setup>) {
  while (ctx.queue.length) await ctx.app.process(ctx.queue.shift()!, now);
}
test('double opt-in, single-use links and management authorization', async () => {
  const c = setup();
  const response = await c.app.handle(
    'POST',
    'email/start',
    { email: 'test@example.test', place, preferences },
    '',
    now,
  );
  assert.equal(response.status, 202);
  assert.equal(response.body.id, undefined);
  assert.equal(response.body.credential, undefined);
  await drain(c);
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].kind, 'confirm');
  const token = c.sent[0].token!;
  const confirmed = await c.app.handle('POST', 'confirm', { token }, '', now);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.subscription.state, 'active');
  assert.equal((await c.app.handle('POST', 'confirm', { token }, '', now)).status, 400);
  const id = confirmed.body.id;
  assert.equal((await c.app.handle('GET', 'subscriptions/' + id, {}, 'wrong', now)).status, 401);
  assert.equal(
    (await c.app.handle('GET', 'subscriptions/' + id, {}, confirmed.body.credential, now)).status,
    200,
  );
});
test('expired and wrong-purpose tokens cannot confirm or manage', async () => {
  const c = setup(),
    s = await active(c);
  const wrong = c.app.tokens.sign(s.id, 'unsubscribe', now + 10000);
  assert.equal((await c.app.handle('POST', 'confirm', { token: wrong }, '', now)).status, 400);
  const expired = c.app.tokens.sign(s.id, 'manage', now - 1);
  assert.equal((await c.app.handle('POST', 'manage', { token: expired }, '', now)).status, 400);
});
test('dry-run records decisions and sends no evening notifications', async () => {
  const c = setup('dry-run');
  await active(c);
  await c.app.tick(now);
  await drain(c);
  assert.equal(c.sent.length, 0);
  const evaluations = [];
  for await (const r of c.store.list<Evaluation>('evaluations')) evaluations.push(r.value);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].eligible, true);
  assert.equal(evaluations[0].mode, 'dry-run');
});
test('duplicate queue messages and concurrent workers send once per observing night', async () => {
  const c = setup();
  await active(c);
  await c.app.tick(now);
  const id = c.queue[0];
  await Promise.all([c.app.process(id, now), c.app.process(id, now)]);
  await drain(c);
  assert.equal(c.sent.length, 1);
  await c.app.tick(now + 600000);
  await drain(c);
  assert.equal(c.sent.length, 1);
});
test('unsubscribe without login blocks already queued messages', async () => {
  const c = setup(),
    s = await active(c);
  await c.app.tick(now);
  await c.app.process(c.queue.shift()!, now);
  await c.app.unsubscribe(c.app.tokens.sign(s.id, 'unsubscribe', now + 86400000), now);
  await drain(c);
  assert.equal(c.sent.length, 0);
  assert.equal(
    (await c.store.get<Subscription>('subscriptions', s.id))!.value.state,
    'unsubscribed',
  );
});
test('pause and preference changes invalidate old queued alerts', async () => {
  const c = setup(),
    s = await active(c);
  await c.app.tick(now);
  await c.app.process(c.queue.shift()!, now);
  await c.app.update(
    s.id,
    'credential',
    { ...s, state: 'paused', pausedUntil: now + 86400000 },
    now + 1,
  );
  await drain(c);
  assert.equal(c.sent.length, 0);
});
test('provider retries are persisted and recoverable', async () => {
  const c = setup(),
    s = await active(c);
  const app = new NotificationApp(
    c.store,
    c.app.config,
    async () => weather,
    {
      send: async () => {
        throw Object.assign(new Error('unavailable'), { status: 503 });
      },
    },
    async () => {},
  );
  const token = c.app.tokens.sign(s.id, 'manage', now + 86400000);
  const job: Job = {
    id: hash('retry'),
    kind: 'manage',
    subscriptionId: s.id,
    token,
    createdAt: now,
    state: 'pending',
    attempts: 0,
    nextAttempt: now,
    expires: now + 86400000,
  };
  await c.store.create('jobs', job);
  await app.process(job.id, now);
  const saved = (await c.store.get<Job>('jobs', job.id))!.value;
  assert.equal(saved.state, 'pending');
  assert.equal(saved.attempts, 1);
  assert(saved.nextAttempt > now);
});
test('missing or stale data cannot create a positive notification', async () => {
  const c = setup();
  await active(c);
  const app = new NotificationApp(
    c.store,
    c.app.config,
    async () => ({ ...weather, fetchedAt: now - 4 * 3600000 }),
    {
      send: async () => {
        throw new Error('Must not send');
      },
    },
    async (id) => {
      c.queue.push(id);
    },
  );
  await app.tick(now);
  while (c.queue.length) await app.process(c.queue.shift()!, now);
  const jobs = [];
  for await (const r of c.store.list<Job>('jobs')) jobs.push(r.value);
  assert.equal(jobs.filter((j) => j.kind === 'advice').length, 0);
});
test('notifications are scheduled by the location, not the server time zone', async () => {
  const c = setup();
  const s = await active(c);
  const row = (await c.store.get<Subscription>('subscriptions', s.id))!;
  await c.store.replace(
    'subscriptions',
    { ...s, place: { ...place, timeZone: 'America/New_York', latitude: 40.7, longitude: -74 } },
    row.etag,
  );
  await c.app.tick(now);
  assert.equal(c.queue.length, 0);
  await c.app.tick(Date.parse('2026-09-18T20:10:00Z'));
  assert(c.queue.length > 0);
});
test('bounce/complaint suppression blocks further delivery', async () => {
  const c = setup();
  await active(c);
  await c.app.suppress('test@example.test', now);
  await c.app.tick(now);
  await drain(c);
  assert.equal(c.sent.length, 0);
});
test('registration is rate limited without exposing whether an address exists', async () => {
  const c = setup();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await c.app.handle('POST', 'email/link', { email: 'nobody@example.test' }, '', now)).status,
      202,
    );
  assert.equal(
    (await c.app.handle('POST', 'email/link', { email: 'nobody@example.test' }, '', now)).status,
    429,
  );
});
test('private endpoints and malformed push subscriptions are rejected', () => {
  assert.throws(() =>
    validatePush({
      endpoint: 'https://127.0.0.1/private',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    }),
  );
  assert.throws(() =>
    validatePush({
      endpoint: 'https://fcm.googleapis.com.evil.test/push',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    }),
  );
  assert.doesNotThrow(() =>
    validatePush({
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    }),
  );
});
test('email renders escaped, accessible content and a real text alternative', async () => {
  const c = setup();
  await active(c);
  await c.app.tick(now);
  await drain(c);
  const a = c.sent[0].advice!;
  a.place.name = '<img src=x onerror=alert(1)>';
  const mail = renderAdvice(
    a,
    'https://example.test/report',
    'https://example.test/stop',
    'https://example.test/manage',
  );
  assert(!mail.html.includes('<img src=x'));
  assert(mail.html.includes('&lt;img'));
  assert(mail.text.includes('Best window:'));
});
test('expired reports, admin access and terminal jobs have bounded retention', async () => {
  const c = setup();
  await active(c);
  await c.app.tick(now);
  await drain(c);
  assert.equal((await c.app.handle('GET', 'admin/evaluations', {}, 'wrong', now)).status, 401);
  assert.equal((await c.app.handle('GET', 'admin/evaluations', {}, 'test-admin', now)).status, 200);
  const token = c.app.tokens.sign(c.sent[0].id, 'report', now - 1);
  assert.equal((await c.app.handle('POST', 'report', { token }, '', now)).status, 400);
  await c.app.cleanup(now + 40 * 86400000);
  assert.equal(await c.store.get('jobs', c.sent[0].id), null);
});

test('push subscriptions are device scoped and cannot be taken over with only an endpoint', async () => {
  const c = setup(),
    push = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test-device',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    };
  const created = await c.app.handle('POST', 'push', { place, preferences, push }, '', now);
  assert.equal(created.status, 201);
  assert.equal(created.body.subscription.channel, 'push');
  assert.equal(
    (await c.app.handle('POST', 'push', { place, preferences, push }, '', now)).status,
    409,
  );
  assert.equal(
    (
      await c.app.handle(
        'PATCH',
        'subscriptions/' + created.body.id,
        { ...created.body.subscription, state: 'paused', pausedUntil: now + 86400000 },
        'wrong',
        now,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await c.app.handle(
        'DELETE',
        'subscriptions/' + created.body.id,
        {},
        created.body.credential,
        now,
      )
    ).status,
    200,
  );
});
test('expired push gateway responses stop future delivery', async () => {
  const c = setup(),
    push = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/expired-device',
      keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) },
    };
  const created = await c.app.handle('POST', 'push', { place, preferences, push }, '', now - 1);
  const app = new NotificationApp(
    c.store,
    c.app.config,
    async () => weather,
    {
      send: async () => {
        throw Object.assign(new Error('Gone'), { statusCode: 410 });
      },
    },
    async (id) => {
      c.queue.push(id);
    },
  );
  await app.tick(now);
  while (c.queue.length) await app.process(c.queue.shift()!, now);
  assert.equal(
    (await c.store.get<Subscription>('subscriptions', created.body.id))!.value.state,
    'expired',
  );
});
test('delivery failures are visible to operators without exposing secrets', async () => {
  const c = setup();
  await active(c);
  await c.app.tick(now);
  await drain(c);
  const result = await c.app.handle('GET', 'admin/jobs', {}, 'test-admin', now);
  assert.equal(result.status, 200);
  assert(result.body.length > 0);
  assert(!JSON.stringify(result.body).includes('test@example.test'));
  assert(!JSON.stringify(result.body).includes('token'));
  assert.equal((await c.app.handle('GET', 'admin/jobs', {}, 'wrong', now)).status, 401);
});
