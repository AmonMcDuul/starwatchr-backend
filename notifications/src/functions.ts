import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { QueueClient } from '@azure/storage-queue';
import { AzureStore } from './store';
import { NotificationApp } from './application';
import { ProviderSender } from './delivery';
import { weatherLoader } from './weather';
import { Config } from './model';
let instance: Promise<NotificationApp> | undefined;
function getApp() {
  return (instance ??= (async () => {
    const storage = process.env['AzureWebJobsStorage'];
    if (!storage) throw new Error('Storage is not configured');
    const config: Config = {
      siteUrl: (process.env['SITE_URL'] ?? 'https://starwatchr.com').replace(/\/$/, ''),
      apiUrl: (process.env['NOTIFICATIONS_API_URL'] ?? '').replace(/\/$/, ''),
      tokenSecret: process.env['TOKEN_SECRET'] ?? '',
      mode: process.env['NOTIFICATION_MODE'] === 'live' ? 'live' : 'dry-run',
      vapidPublicKey: process.env['VAPID_PUBLIC_KEY'] ?? '',
      emailEnabled: !!process.env['MAIL_SERVICE_URL'] && !!process.env['MAIL_SERVICE_KEY'],
      pushEnabled:
        !!process.env['VAPID_PUBLIC_KEY'] &&
        !!process.env['VAPID_PRIVATE_KEY'] &&
        !!process.env['VAPID_SUBJECT'],
      adminKey: process.env['NOTIFICATIONS_ADMIN_KEY'] ?? '',
      analyticsKey: process.env['NOTIFICATIONS_ANALYTICS_KEY'] ?? '',
    };
    if (!config.apiUrl.startsWith('https://') && !config.apiUrl.startsWith('http://localhost'))
      throw new Error('Set NOTIFICATIONS_API_URL to the public /api endpoint');
    const store = new AzureStore(storage);
    await store.initialize();
    const queue = new QueueClient(storage, 'notification-jobs');
    await queue.createIfNotExists();
    return new NotificationApp(
      store,
      config,
      weatherLoader(store),
      new ProviderSender(config),
      async (id) => {
        await queue.sendMessage(Buffer.from(id).toString('base64'));
      },
    );
  })().catch((e) => {
    instance = undefined;
    throw e;
  }));
}
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
async function http(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const service = await getApp();
    const path = request.params['path'] ?? 'config';
    if (path === 'unsubscribe' && request.method === 'GET') {
      const token = request.query.get('token') ?? '';
      try {
        service.tokens.verify(token, 'unsubscribe', Date.now());
      } catch {
        return { status: 400, headers, body: 'This link is invalid.' };
      }
      return {
        status: 200,
        headers: {
          ...headers,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        },
        body: '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Stop StarWatchr alerts</title><h1>Stop these notifications?</h1><p>No sign-in is needed.</p><form method="post"><button type="submit">Unsubscribe</button></form></html>',
      };
    }
    const text = request.method === 'GET' ? '' : await request.text();
    if (text.length > 20000) return { status: 413, headers };
    let body: any = {};
    if (path === 'unsubscribe') body = { token: request.query.get('token') };
    else if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return { status: 400, headers, jsonBody: { error: 'Invalid JSON' } };
      }
    }
    if (request.method === 'POST' && ['push', 'email/start', 'email/link'].includes(path)) {
      // Do not trust a caller-supplied forwarded IP; retain global and address limits.
      await service.rate('registrations-global', 200, 3600000, Date.now());
    }
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const result = await service.handle(request.method, path, body, bearer);
    return { status: result.status, headers, jsonBody: result.body };
  } catch {
    context.error('Notification request failed; inspect configuration and storage availability.');
    return {
      status: 503,
      headers,
      jsonBody: { error: 'Notification service temporarily unavailable.' },
    };
  }
}
app.http('notifications', {
  route: '{*path}',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  authLevel: 'anonymous',
  handler: http,
});
app.timer('notificationSchedule', {
  schedule: '0 */10 * * * *',
  handler: async () => {
    await (await getApp()).tick(Date.now());
  },
});
app.timer('notificationCleanup', {
  schedule: '0 20 4 * * *',
  handler: async () => {
    await (await getApp()).cleanup(Date.now());
  },
});
app.storageQueue('notificationDelivery', {
  queueName: 'notification-jobs',
  connection: 'AzureWebJobsStorage',
  handler: async (id: unknown, context) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
      context.error('Invalid notification job');
      return;
    }
    await (await getApp()).process(id, Date.now());
  },
});
