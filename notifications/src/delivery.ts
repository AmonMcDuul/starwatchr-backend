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
export function renderAdvice(a: Advice, link: string, unsubscribe: string, manage: string) {
  const best = a.best!,
    zone = a.place.timeZone;
  const detailedClock = (t: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).format(t);
  const when = detailedClock(best.start) + '–' + detailedClock(best.end);
  const title = 'Your observing evening in ' + a.place.name;
  const lines = [
    title,
    a.night + ' · ' + zone,
    'Best window: ' + when,
    ...a.targets.map(
      (t) => t.name + ' — ' + Math.round(t.altitude) + '° high, ' + clock(t.time, zone),
    ),
    ...a.reasons,
    'Forecast retrieved ' + new Date(a.fetchedAt).toISOString(),
    'View evening: ' + link,
    'Settings: ' + manage,
    'Unsubscribe: ' + unsubscribe,
  ];
  const slots = a.slots.filter(
    (s) => s.start >= best.start - 3 * 3600000 && s.end <= best.end + 3 * 3600000,
  );
  const timeline = slots
    .map(
      (s, i) =>
        (i % 6 === 0 ? '<tr>' : '') +
        '<td style="padding:8px 3px;text-align:center;background:' +
        (s.suitable ? '#d5e8d8' : '#e6e8ed') +
        ';color:#182b24;font-size:11px">' +
        clock(s.start, zone) +
        '<br>' +
        (s.cloud === null ? '?' : Math.round(s.cloud) + '%') +
        '</td>' +
        (i % 6 === 5 || i === slots.length - 1 ? '</tr>' : ''),
    )
    .join('');
  const html =
    '<html><body style="font-family:Arial,sans-serif;color:#253047"><main style="max-width:640px;margin:auto;padding:24px"><h1>' +
    escape(title) +
    '</h1><p>' +
    escape(a.night + ' · ' + zone) +
    '</p><h2>' +
    escape(when) +
    '</h2><p>Best continuous window within your observing limits.</p><table role="presentation" style="width:100%;border-spacing:2px">' +
    timeline +
    '</table><p style="font-size:12px">Cloud cover per half hour. Green cells meet your selected conditions; weather is an hourly forecast, not a guarantee.</p><ul>' +
    a.targets
      .map(
        (t) =>
          '<li>' +
          escape(t.name) +
          ' — ' +
          Math.round(t.altitude) +
          '° high, ' +
          clock(t.time, zone) +
          '</li>',
      )
      .join('') +
    '</ul>' +
    (a.slots.some((s) => s.suitable && s.dewRisk)
      ? '<p>Temperature approaches the dew point during this window. Dew may form on equipment.</p>'
      : '') +
    '<p><a href="' +
    escape(link) +
    '">View your evening</a></p><p style="font-size:12px">Forecast retrieved ' +
    escape(new Date(a.fetchedAt).toISOString()) +
    '. Stability and transparency are estimates.</p><hr><p><a href="' +
    escape(manage) +
    '">Settings</a> · <a href="' +
    escape(unsubscribe) +
    '">Unsubscribe</a></p></main></body></html>';
  return { subject: title + ' · ' + when, text: lines.join('\n'), html };
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
            title: 'Tonight in ' + s.place.name,
            body:
              clock(best.start, s.place.timeZone) +
              '–' +
              clock(best.end, s.place.timeZone) +
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
          TTL: Math.max(0, Math.min(3600, Math.floor((j.expires - Date.now()) / 1000))),
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
      const label =
        j.kind === 'confirm' ? 'Confirm your observing alerts' : 'Manage your observing alerts';
      message = {
        subject: label,
        text:
          label +
          '\n' +
          link +
          '\nThis link expires in 24 hours. If you did not request it, ignore this email.',
        html:
          '<p>' +
          label +
          '</p><p><a href="' +
          escape(link) +
          '">' +
          label +
          '</a></p><p>This link expires in 24 hours. If you did not request it, ignore this email.</p>',
      };
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
