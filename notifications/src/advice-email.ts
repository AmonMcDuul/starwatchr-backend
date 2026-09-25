import { Advice } from './shared/engine';
import { eveningHours, eveningSummary } from './shared/evening-summary';
import { decorateSavedTargets } from './shared/evening-targets';
import {
  adviceTime,
  compassDirection,
  durationLabel,
  hourLabel,
  hourStatus,
  valueRange,
} from './shared/presentation';

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

// Object destinations must stay on the configured site and use HTTPS.
function objectLink(value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function renderAdvice(a: Advice, link: string, unsubscribe: string, manage: string) {
  const summary = eveningSummary(a),
    hours = eveningHours(a);
  const zone = a.place.timeZone;
  const when = a.best
    ? adviceTime(a.best.start, zone) + '–' + adviceTime(a.best.end, zone)
    : 'No suitable window';
  const title = 'Your observing evening in ' + a.place.name;
  const labels: Record<string, string> = {
    eyes: 'Naked eye',
    binoculars: 'Binoculars',
    telescope: 'Telescope',
    general: 'All-round',
    'deep-sky': 'Deep sky',
    'moon-planets': 'Moon & planets',
  };
  const context =
    a.night + ' · ' + labels[a.preferences.equipment] + ' · ' + labels[a.preferences.profile];
  const conditions = [
    'Cloud ' + valueRange(summary.cloudMin, summary.cloudMax, '%'),
    'Wind up to ' + valueRange(summary.windMax, summary.windMax, ' km/h'),
    'Temperature ' + valueRange(summary.temperatureMin, summary.temperatureMax, ' °C'),
    'Moon ' +
      valueRange(summary.moonIllumination, summary.moonIllumination, '% illuminated') +
      ' · ' +
      (summary.moonUp ? 'Up during these hours' : 'Below the horizon'),
  ];
  const warning = summary.dewRisk ? 'Dew may form on equipment during this window.' : '';
  const hourly = hours.map((hour) => ({
    heading: hourLabel(hour, hours, a) + ' · ' + hour.sky + ' · ' + hourStatus(hour),
    detail:
      'Cloud ' +
      valueRange(hour.cloud, hour.cloud, '%') +
      ' · Wind ' +
      valueRange(hour.windKmh, hour.windKmh, ' km/h') +
      ' · Temperature ' +
      valueRange(hour.temperature, hour.temperature, ' °C'),
    recommended: hour.inBest,
  }));
  const origin = new URL(link).origin;
  const targets = decorateSavedTargets(a).map((t) => ({
    name: t.name,
    url: objectLink(t.url, origin),
    metadata: [t.kind, t.difficulty].filter(Boolean).join(' · '),
    position:
      adviceTime(t.time, zone) +
      ' · ' +
      compassDirection(t.azimuth) +
      ' · ' +
      Math.round(t.altitude) +
      '° high',
    description: t.description,
    tip: t.tip,
  }));
  const window = when + (a.best ? ' · ' + durationLabel(summary.durationMinutes) : '');
  const lines = [
    title,
    context,
    summary.title + ': ' + window,
    ...conditions,
    warning,
    'Your evening, hour by hour',
    ...hourly.flatMap((h) => [h.heading, h.detail]),
    'What to look for',
    ...targets.flatMap((t) => [t.name, t.metadata, t.position, t.description, t.tip, t.url ?? '']),
    ...(!targets.length ? ['No matching targets for these hours.'] : []),
    'View your evening: ' + link,
    'Settings: ' + manage,
    'Unsubscribe: ' + unsubscribe,
  ].filter(Boolean);
  const p = (text: string, style = '') =>
    '<p style="margin:8px 0;line-height:1.6;' + style + '">' + escape(text) + '</p>';
  const card = (content: string, recommended = false) =>
    '<tr><td style="padding:14px 16px;border-bottom:1px solid #343747;' +
    (recommended ? 'border-left:3px solid #ebd785;background:#292a32;' : '') +
    '">' +
    content +
    '</td></tr>';
  const table = (rows: string) =>
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">' +
    rows +
    '</table>';
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#14151e;color:#f2f0e9;font-family:Arial,sans-serif;font-size:16px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14151e"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px"><tr><td style="padding:24px 16px;overflow-wrap:anywhere">' +
    p('✦ STARWATCHR', 'color:#ebd785;font-size:13px;letter-spacing:2px') +
    '<h1 style="font-size:28px;line-height:1.2;margin:20px 0 12px">' +
    escape(title) +
    '</h1>' +
    p(context, 'color:#c2c2ce') +
    table(
      card(
        p(summary.title, 'color:#ebd785') +
          p(window, 'font-size:26px;font-weight:bold') +
          conditions.map((c) => p(c)).join('') +
          (warning ? p(warning, 'color:#ebd785') : ''),
        true,
      ),
    ) +
    '<h2 style="font-size:21px;margin:28px 0 12px">Your evening, hour by hour</h2>' +
    table(
      hourly
        .map((h) =>
          card(p(h.heading, 'font-weight:bold') + p(h.detail, 'color:#c2c2ce'), h.recommended),
        )
        .join(''),
    ) +
    '<h2 style="font-size:21px;margin:28px 0 12px">What to look for</h2>' +
    table(
      targets
        .map((t) =>
          card(
            '<h3 style="font-size:18px;margin:4px 0">' +
              (t.url
                ? '<a style="color:#ebd785" href="' + escape(t.url) + '">' + escape(t.name) + '</a>'
                : escape(t.name)) +
              '</h3>' +
              p(t.metadata, 'color:#c2c2ce') +
              p(t.position, 'font-weight:bold') +
              (t.description ? p(t.description) : '') +
              (t.tip ? p(t.tip) : ''),
          ),
        )
        .join(''),
    ) +
    (!targets.length ? p('No matching targets for these hours.') : '') +
    '<p style="margin:28px 0"><a href="' +
    escape(link) +
    '" style="display:inline-block;background:#ebd785;color:#1b1b24;padding:14px 20px;border-radius:8px;font-weight:bold;text-decoration:none">View your evening</a></p>' +
    '<p style="font-size:13px;line-height:1.6"><a style="color:#c2c2ce" href="' +
    escape(manage) +
    '">Settings</a> · <a style="color:#c2c2ce" href="' +
    escape(unsubscribe) +
    '">Unsubscribe</a></p>' +
    '</td></tr></table></td></tr></table></body></html>';
  return { subject: title + ' · ' + when, text: lines.join('\n'), html };
}
