import { Advice } from './core';
import { EveningHour } from './evening-summary';

/** The best recommendations first, whatever order the list is displayed in. */
export function topTargets<T extends { rank?: number }>(targets: readonly T[], count: number): T[] {
  return targets
    .map((target, index) => ({ target, index }))
    .sort((a, b) => (a.target.rank ?? 1000 + a.index) - (b.target.rank ?? 1000 + b.index))
    .slice(0, count)
    .map(({ target }) => target);
}
export function adviceTime(time: number, zone: string, offset = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    ...(offset ? { timeZoneName: 'shortOffset' as const } : {}),
  }).format(time);
}
export function hourLabel(hour: EveningHour, hours: EveningHour[], advice: Advice): string {
  const zone = advice.place.timeZone;
  const label = adviceTime(hour.start, zone);
  return hours.filter((h) => adviceTime(h.start, zone) === label).length > 1
    ? adviceTime(hour.start, zone, true)
    : label;
}
export function hourStatus(hour: EveningHour): string {
  return hour.inBest && hour.suitable
    ? 'Recommended'
    : hour.partial
      ? 'Partly within limits'
      : hour.status;
}
export function valueRange(min: number | null, max: number | null, unit: string): string {
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return '—';
  const low = Math.round(min),
    high = Math.round(max);
  return (low === high ? String(low) : `${low}–${high}`) + unit;
}
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60),
    remainder = Math.round(minutes % 60);
  return (
    [hours ? `${hours}h` : '', remainder ? `${remainder}m` : ''].filter(Boolean).join(' ') || '0m'
  );
}
export function compassDirection(azimuth: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
    Math.round((((azimuth % 360) + 360) % 360) / 45) % 8
  ];
}
