import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderSender } from '../delivery';
import { FileStore } from '../file-store';
import { Config, Job, Subscription } from '../model';
import { DEFAULT_PREFERENCES } from '../shared/engine';

test('SMTP relay receives the subscriber, alternatives and authentication; failures remain retryable', async () => {
  const previousUrl = process.env['MAIL_SERVICE_URL'];
  const previousKey = process.env['MAIL_SERVICE_KEY'];
  process.env['MAIL_SERVICE_URL'] = 'https://api.example.test/internal/notification-mail';
  process.env['MAIL_SERVICE_KEY'] = 'test-server-secret';
  let calledUrl: unknown;
  let calledOptions: RequestInit | undefined;
  const transport = mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options?: RequestInit) => {
      calledUrl = url;
      calledOptions = options;
      return new Response(JSON.stringify({ id: 'accepted' }), { status: 200 });
    },
  );
  try {
    const config: Config = {
      siteUrl: 'https://example.test',
      apiUrl: 'https://worker.example.test/api',
      tokenSecret: 'test-secret-with-at-least-32-characters',
      mode: 'live',
      emailEnabled: true,
      pushEnabled: false,
      vapidPublicKey: '',
      adminKey: '',
    };
    const subscription: Subscription = {
      id: 'a'.repeat(64),
      email: 'subscriber@example.test',
      channel: 'email',
      state: 'pending',
      preferences: DEFAULT_PREFERENCES,
      place: { name: 'Amsterdam', latitude: 52.37, longitude: 4.89, timeZone: 'Europe/Amsterdam' },
      manageHash: '',
      manageExpires: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const job: Job = {
      id: 'b'.repeat(64),
      kind: 'confirm',
      subscriptionId: subscription.id,
      token: 'confirmation-token',
      createdAt: Date.now(),
      expires: Date.now() + 3600000,
      state: 'sending',
      attempts: 1,
      nextAttempt: 0,
    };
    const sender = new ProviderSender(config);
    await sender.send(subscription, job);
    assert.equal(calledUrl, process.env['MAIL_SERVICE_URL']);
    assert.equal(
      (calledOptions!.headers as Record<string, string>)['X-Notification-Key'],
      'test-server-secret',
    );
    assert.equal(calledOptions!.redirect, 'error');
    const body = JSON.parse(calledOptions!.body as string);
    assert.equal(body.toEmail, subscription.email);
    assert.equal(body.deliveryId, job.id);
    assert(body.html.includes('confirmation-token'));
    assert(body.text.includes('confirmation-token'));
    transport.mock.mockImplementation(async () => new Response('', { status: 503 }));
    await assert.rejects(sender.send(subscription, job), (error: any) => error.status === 503);
  } finally {
    transport.mock.restore();
    if (previousUrl === undefined) delete process.env['MAIL_SERVICE_URL'];
    else process.env['MAIL_SERVICE_URL'] = previousUrl;
    if (previousKey === undefined) delete process.env['MAIL_SERVICE_KEY'];
    else process.env['MAIL_SERVICE_KEY'] = previousKey;
  }
});

test('development subscriptions and concurrency versions survive restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'starwatchr-store-')), 'store.json');
  const first = new FileStore(file);
  assert(await first.create('subscriptions', { id: 'test', state: 'pending' }));
  const second = new FileStore(file);
  const row = await second.get<{ id: string; state: string }>('subscriptions', 'test');
  assert.equal(row!.value.state, 'pending');
  assert(await second.replace('subscriptions', { id: 'test', state: 'active' }, row!.etag));
  assert.equal(
    await second.replace('subscriptions', { id: 'test', state: 'stale' }, row!.etag),
    false,
  );
  assert.equal(
    (await new FileStore(file).get<{ state: string }>('subscriptions', 'test'))!.value.state,
    'active',
  );
});
