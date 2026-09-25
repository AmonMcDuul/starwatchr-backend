import { renderTransactional } from './transactional-email';
import { renderAdvice } from './advice-email';
export { renderAdvice } from './advice-email';
import webpush from 'web-push';
import { BackendReadiness, MailServiceError } from './backend-readiness';
import { Advice } from './shared/engine';
import { Config, Job, Sender, Subscription } from './model';
import { Tokens } from './security';
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function clock(time: number, zone: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(time);
}
export class ProviderSender implements Sender {
  private tokens: Tokens;
  private readonly readiness = new BackendReadiness();

  private mailConnection() {
    const relay = process.env['MAIL_SERVICE_URL'];
    const key = process.env['MAIL_SERVICE_KEY'];
    if (!relay || !key) throw new MailServiceError(503, 'wake', true);
    const address = new URL(relay);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
    if (
      (address.protocol !== 'https:' && !(address.protocol === 'http:' && local)) ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    ) {
      throw new MailServiceError(400, 'wake', false);
    }
    return { relay, key };
  }

  async prepare(subscription: Subscription) {
    if (subscription.channel !== 'email' || process.env['MAIL_SERVICE_WAKE_ENABLED'] === 'false') {
      return {};
    }
    const { relay, key } = this.mailConnection();
    return { backendWakeMs: await this.readiness.ensure(relay, key) };
  }
  constructor(private config: Config) {
    this.tokens = new Tokens(config.tokenSecret);
  }
  async send(s: Subscription, j: Job) {
    if (s.channel === 'push') {
      if (!this.config.pushEnabled || !s.push)
        throw Object.assign(new Error('Push disabled'), { status: 400 });
      const a = j.advice!,
        best = a.best!;
      const token = this.tokens.sign(j.id, 'report', j.createdAt + 7 * 86400000);
      const url = this.config.siteUrl + '/evening#report=' + token;
      const result = await webpush.sendNotification(
        s.push,
        JSON.stringify({
          notification: {
            title: 'Tonight in ' + a.place.name,
            body:
              clock(best.start, a.place.timeZone) +
              '–' +
              clock(best.end, a.place.timeZone) +
              ': a suitable observing window. ' +
              a.targets
                .slice(0, 2)
                .map((t) => t.name)
                .join(', '),
            icon: this.config.siteUrl + '/assets/img/pwa-icon-192.png',
            tag: 'starwatchr-' + a.night,
            renotify: false,
            data: { url, onActionClick: { default: { operation: 'openWindow', url } } },
          },
        }),
        {
          TTL: Math.max(0, Math.min(3600, Math.floor((best.end - Date.now()) / 1000))),
          urgency: 'high',
          timeout: 15000,
          vapidDetails: {
            subject: process.env['VAPID_SUBJECT']!,
            publicKey: this.config.vapidPublicKey,
            privateKey: process.env['VAPID_PRIVATE_KEY']!,
          },
        },
      );
      return { providerId: String(result.statusCode) };
    }
    if (!this.config.emailEnabled || !s.email)
      throw Object.assign(new Error('Email disabled'), { status: 400 });
    const unsubscribe =
      this.config.apiUrl +
      '/unsubscribe?token=' +
      this.tokens.sign(s.id, 'unsubscribe', j.createdAt + 3650 * 86400000);
    const manage = this.config.siteUrl + '/alerts';
    let message: { subject: string; text: string; html: string };
    if (j.kind === 'advice') {
      const link =
        this.config.siteUrl +
        '/evening#report=' +
        this.tokens.sign(j.id, 'report', j.createdAt + 7 * 86400000);
      message = renderAdvice(j.advice!, link, unsubscribe, manage);
    } else {
      const link = this.config.siteUrl + '/alerts#' + j.kind + '=' + j.token;
      message = renderTransactional(j.kind === 'confirm' ? 'confirm' : 'manage', link);
    }
    const { relay, key } = this.mailConnection();
    const response = await fetch(relay, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
      headers: { 'X-Notification-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveryId: j.id,
        toEmail: s.email,
        ...message,
        ...(j.kind === 'advice' ? { unsubscribeUrl: unsubscribe } : {}),
      }),
    });
    if (!response.ok) {
      this.readiness.invalidate();
      // Azure Free quota exhaustion returns 403; the API itself uses 401 for invalid keys.
      throw new MailServiceError(
        response.status,
        'delivery',
        response.status === 403 ||
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      );
    }
    const result = (await response.json()) as { id: string };
    return { providerId: result.id };
  }
}
