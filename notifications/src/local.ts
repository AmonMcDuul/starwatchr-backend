import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationApp } from './application';
import { MemoryStore } from './store';
import { FileStore } from './file-store';
import { weatherLoader } from './weather';
import { ProviderSender } from './delivery';
import { secret } from './security';
import { Job, Config, Sender } from './model';

if (existsSync('.env')) process.loadEnvFile('.env');
const capture = process.argv.includes('--capture');
const stateDirectory = resolve('.local');
let localSecrets = { tokenSecret: 'local-test-only-not-a-production-key-12345', mailKey: '' };

if (!capture) {
  mkdirSync(stateDirectory, { recursive: true });
  const secretsFile = resolve(stateDirectory, 'secrets.json');
  localSecrets = existsSync(secretsFile)
    ? JSON.parse(readFileSync(secretsFile, 'utf8'))
    : { tokenSecret: secret(), mailKey: secret() };
  writeFileSync(secretsFile, JSON.stringify(localSecrets), { mode: 0o600 });
  const mailKey = process.env['MAIL_SERVICE_KEY'] || localSecrets.mailKey;
  writeFileSync(
    resolve(stateDirectory, 'api-settings.json'),
    JSON.stringify({ NotificationDelivery: { ApiKey: mailKey } }),
    { mode: 0o600 },
  );
  process.env['MAIL_SERVICE_KEY'] = mailKey;
  process.env['MAIL_SERVICE_URL'] ??= 'http://localhost:5016/internal/notification-mail';
}

const store = capture ? new MemoryStore() : new FileStore(resolve(stateDirectory, 'store.json'));
const queue: string[] = [];
const deliveries: Job[] = [];
const config: Config = {
  siteUrl: process.env['SITE_URL'] ?? 'http://localhost:4200',
  apiUrl: process.env['NOTIFICATIONS_API_URL'] ?? 'http://localhost:4200/notifications-api',
  tokenSecret: process.env['TOKEN_SECRET'] ?? localSecrets.tokenSecret,
  mode: capture || process.env['NOTIFICATION_MODE'] === 'dry-run' ? 'dry-run' : 'live',
  vapidPublicKey: process.env['VAPID_PUBLIC_KEY'] ?? '',
  emailEnabled: true,
  pushEnabled:
    !capture &&
    !!process.env['VAPID_PUBLIC_KEY'] &&
    !!process.env['VAPID_PRIVATE_KEY'] &&
    !!process.env['VAPID_SUBJECT'],
  analyticsKey: process.env['NOTIFICATIONS_ANALYTICS_KEY'] ?? '',
  adminKey:
    process.env['NOTIFICATIONS_ADMIN_KEY'] ??
    (capture ? 'local-review-only' : localSecrets.mailKey),
};
const sender: Sender = capture
  ? {
      send: async (_subscription, job) => {
        deliveries.push(job);
        return { providerId: 'local-capture' };
      },
    }
  : new ProviderSender(config);
const service = new NotificationApp(store, config, weatherLoader(store), sender, async (id) => {
  queue.push(id);
});

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) await service.process(queue.shift()!, Date.now());
  } catch {
    console.error('Notification job failed. Pending work will be retried.');
  } finally {
    draining = false;
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const origin = request.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1):420[0-9]$/.test(origin))
    response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (capture && url.pathname === '/__test/deliveries') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(deliveries));
    return;
  }

  const path = url.pathname.replace(/^\/api\//, '');
  if (path === 'unsubscribe' && request.method === 'GET') {
    try {
      service.tokens.verify(url.searchParams.get('token') ?? '', 'unsubscribe', Date.now());
    } catch {
      response.writeHead(400);
      response.end('This link is invalid.');
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(
      '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><h1>Stop observing alerts?</h1><form method="post"><button>Unsubscribe</button></form></html>',
    );
    return;
  }

  let raw = '';
  for await (const part of request) {
    raw += part;
    if (raw.length > 20000) {
      response.writeHead(413);
      response.end();
      return;
    }
  }
  try {
    const body =
      path === 'unsubscribe'
        ? { token: url.searchParams.get('token') }
        : raw
          ? JSON.parse(raw)
          : {};
    const result = await service.handle(
      request.method ?? 'GET',
      path,
      body,
      (request.headers.authorization ?? '').replace(/^Bearer /, ''),
    );
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
    await drain();
  } catch {
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
}).listen(7071, '127.0.0.1', () => {
  console.log(
    capture
      ? 'Notification test capture: http://127.0.0.1:7071/api (no external delivery)'
      : 'Notifications: http://127.0.0.1:7071/api — real SMTP delivery through the existing .NET API',
  );
});

if (!capture) {
  // Polling also repairs persisted work after a restart, without requiring a Functions host.
  const tick = async () => {
    try {
      await service.tick(Date.now());
      await drain();
    } catch {
      console.error('Notification scheduling failed; retrying next minute.');
    }
  };
  void tick();
  setInterval(() => void tick(), 60000);
  setInterval(
    () =>
      void service.cleanup(Date.now()).catch(() => {
        console.error('Notification cleanup failed.');
      }),
    3600000,
  );
}
