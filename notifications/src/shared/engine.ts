import {
  Body,
  Equator,
  Horizon,
  Observer,
  Illumination,
  MoonPhase,
  Rotation_EQJ_HOR,
  RotateVector,
  VectorFromSphere,
  SphereFromVector,
} from 'astronomy-engine';

export const ENGINE_VERSION = '1.0.0';
export type Profile = 'general' | 'deep-sky' | 'moon-planets';
export type Equipment = 'eyes' | 'binoculars' | 'telescope';
export interface Place {
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}
export interface Preferences {
  profile: Profile;
  equipment: Equipment;
  startMinute: number;
  endMinute: number;
  notifyMinute: number;
  days: number[];
  minMinutes: number;
  maxCloud: number;
  maxWindKmh: number;
  maxPrecipitationProbability: number;
  maxMoonIllumination: number;
}
export const DEFAULT_PREFERENCES: Preferences = {
  profile: 'general',
  equipment: 'binoculars',
  startMinute: 1200,
  endMinute: 120,
  notifyMinute: 960,
  days: [0, 1, 2, 3, 4, 5, 6],
  minMinutes: 90,
  maxCloud: 30,
  maxWindKmh: 25,
  maxPrecipitationProbability: 20,
  maxMoonIllumination: 25,
};
export interface WeatherHour {
  time: number;
  cloud: number | null;
  low: number | null;
  mid: number | null;
  high: number | null;
  temperature: number | null;
  dewPoint: number | null;
  humidity: number | null;
  windKmh: number | null;
  windDirection: number | null;
  visibility: number | null;
  precipitationProbability: number | null;
  precipitation: number | null;
  wind500Kmh: number | null;
}
export interface WeatherSnapshot {
  fetchedAt: number;
  timeZone: string;
  latitude: number;
  longitude: number;
  hours: WeatherHour[];
}
export interface Slot {
  start: number;
  end: number;
  cloud: number | null;
  windKmh: number | null;
  temperature: number | null;
  sunAltitude: number;
  moonAltitude: number;
  moonIllumination: number;
  suitable: boolean;
  reasons: string[];
  score: number | null;
  dewRisk: boolean;
}
export interface Window {
  start: number;
  end: number;
  score: number;
}
export interface Target {
  name: string;
  url: string;
  altitude: number;
  azimuth: number;
  time: number;
}
export interface Advice {
  version: string;
  night: string;
  place: Place;
  preferences: Preferences;
  generatedAt: number;
  fetchedAt: number;
  stale: boolean;
  slots: Slot[];
  windows: Window[];
  best: Window | null;
  targets: Target[];
  reasons: string[];
}
export const HOURLY_VARIABLES = [
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'visibility',
  'precipitation_probability',
  'precipitation',
  'wind_speed_500hPa',
].join(',');
export function weatherUrl(latitude: number, longitude: number): string {
  const q = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: HOURLY_VARIABLES,
    timezone: 'auto',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
    forecast_days: '7',
  });
  return 'https://api.open-meteo.com/v1/forecast?' + q;
}
export function normalizeWeather(api: any, fetchedAt: number): WeatherSnapshot {
  if (!api?.hourly || !Array.isArray(api.hourly.time) || typeof api.timezone !== 'string')
    throw new Error('Invalid weather response');
  const take = (i: number, names: string[], min = -Infinity, max = Infinity): number | null => {
    for (const name of names) {
      const v = api.hourly[name]?.[i];
      if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v;
    }
    return null;
  };
  const hours: WeatherHour[] = api.hourly.time
    .map((value: unknown, i: number): WeatherHour => {
      // Only epoch timestamps are accepted: a location's local ISO string is ambiguous at DST.
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('Weather timestamps must be Unix seconds');
      return {
        time: value * 1000,
        cloud: take(i, ['cloud_cover', 'cloudcover'], 0, 100),
        low: take(i, ['cloud_cover_low', 'cloudcover_low'], 0, 100),
        mid: take(i, ['cloud_cover_mid', 'cloudcover_mid'], 0, 100),
        high: take(i, ['cloud_cover_high', 'cloudcover_high'], 0, 100),
        temperature: take(i, ['temperature_2m'], -100, 70),
        dewPoint: take(i, ['dew_point_2m', 'dewpoint_2m'], -100, 70),
        humidity: take(i, ['relative_humidity_2m', 'relativehumidity_2m'], 0, 100),
        windKmh: take(i, ['wind_speed_10m', 'windspeed_10m'], 0, 400),
        windDirection: take(i, ['wind_direction_10m', 'winddirection_10m'], 0, 360),
        visibility: take(i, ['visibility'], 0), // Open-Meteo labels precipitation with the END of its preceding hour.
        // Our WeatherHour covers [time,time+1h), so use the following timestamp.
        precipitationProbability:
          api.hourly.time[i + 1] === value + 3600
            ? take(i + 1, ['precipitation_probability'], 0, 100)
            : null,
        precipitation:
          api.hourly.time[i + 1] === value + 3600 ? take(i + 1, ['precipitation'], 0) : null,
        wind500Kmh: take(i, ['wind_speed_500hPa'], 0, 600),
      };
    })
    .sort((a: WeatherHour, b: WeatherHour) => a.time - b.time);
  return {
    fetchedAt,
    timeZone: api.timezone,
    latitude: api.latitude,
    longitude: api.longitude,
    hours,
  };
}
export function cloudIndex(value: number | null): number | null {
  return value === null ? null : Math.min(9, Math.max(1, 1 + Math.round((value / 100) * 8)));
}
export function weatherMetrics(w: WeatherHour) {
  // Cloud layers overlap; a weighted average can make an overcast layer look clear.
  const effectiveCloud =
    w.cloud === null ? null : Math.max(w.cloud, w.low ?? 0, w.mid ?? 0, w.high ?? 0);
  const transparency =
    w.visibility === null || w.humidity === null || w.high === null
      ? null
      : Math.max(
          1,
          3 -
            Number(w.visibility < 8000) -
            Number(w.visibility < 4000) -
            Number(w.humidity > 85) -
            Number(w.high > 60),
        );
  // An indicative wind-based stability proxy, not measured astronomical seeing.
  const seeing =
    w.windKmh === null || w.wind500Kmh === null
      ? null
      : Math.max(1, Math.min(8, 8 - Math.floor(w.windKmh / 10) - Math.floor(w.wind500Kmh / 40)));
  const score =
    effectiveCloud === null || transparency === null || seeing === null
      ? null
      : Math.round(
          (100 - effectiveCloud) * 0.7 + ((transparency - 1) / 2) * 15 + ((seeing - 1) / 7) * 15,
        );
  return { effectiveCloud, transparency, seeing, score };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(time: number, zone: string) {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(zone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(time)).map((p) => [p.type, p.value]));
  return {
    date: parts['year'] + '-' + parts['month'] + '-' + parts['day'],
    minute: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}
export function addDate(date: string, days: number): string {
  return new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

// Convert a local wall-clock value without depending on the machine's time zone.
// Ambiguous autumn times choose the earlier instant; missing spring times return null.
export function localTimeToUtc(date: string, minute: number, zone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(minute) || minute < 0 || minute > 1439)
    return null;
  const wall = Date.parse(date + 'T00:00:00Z') + minute * 60000;
  if (!Number.isFinite(wall)) return null;
  const candidates = new Set<number>();
  for (let delta = -24; delta <= 24; delta += 3) {
    const sample = wall + delta * 3600000,
      p = localParts(sample, zone);
    const local = Date.parse(p.date + 'T00:00:00Z') + p.minute * 60000;
    const candidate = wall - (local - sample),
      check = localParts(candidate, zone);
    if (check.date === date && check.minute === minute) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : null;
}
export function localDayBounds(
  time: number,
  zone: string,
): { start: number; end: number; date: string } {
  const date = localParts(time, zone).date;
  // Some regions advance clocks at midnight; their civil day begins at 01:00.
  const firstInstant = (day: string): number | null => {
    for (let m = 0; m < 1440; m += 30) {
      const t = localTimeToUtc(day, m, zone);
      if (t !== null) return t;
    }
    return null;
  };
  const start = firstInstant(date);
  let end = firstInstant(addDate(date, 1));
  if (end === null) end = firstInstant(addDate(date, 2)); // A whole civil date can be skipped.
  if (start === null || end === null) throw new Error('Unable to determine local day boundaries');
  return { start, end, date };
}

export function observingNight(now: number, zone: string): string {
  const p = localParts(now, zone);
  return p.minute < 720 ? addDate(p.date, -1) : p.date;
}
export function altitude(body: Body, time: number, latitude: number, longitude: number) {
  const observer = new Observer(latitude, longitude, 0),
    date = new Date(time);
  const eq = Equator(body, date, observer, true, true);
  return Horizon(date, observer, eq.ra, eq.dec, 'normal');
}
export function phaseName(time: number): string {
  const phase = MoonPhase(new Date(time));
  if (phase < 2 || phase > 358) return 'New Moon';
  if (Math.abs(phase - 90) < 2) return 'First Quarter';
  if (Math.abs(phase - 180) < 2) return 'Full Moon';
  if (Math.abs(phase - 270) < 2) return 'Last Quarter';
  return phase < 90
    ? 'Waxing Crescent'
    : phase < 180
      ? 'Waxing Gibbous'
      : phase < 270
        ? 'Waning Gibbous'
        : 'Waning Crescent';
}
export function validatePreferences(p: Preferences): void {
  if (
    !['general', 'deep-sky', 'moon-planets'].includes(p.profile) ||
    !['eyes', 'binoculars', 'telescope'].includes(p.equipment)
  )
    throw new Error('Invalid observing profile');
  for (const key of ['startMinute', 'endMinute', 'notifyMinute'] as const)
    if (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > 1439)
      throw new Error('Invalid local time');
  if (p.notifyMinute < 720 || p.notifyMinute > 1380)
    throw new Error('Choose a notification time between noon and 23:00.');
  if (p.startMinute === p.endMinute) throw new Error('Choose a non-empty observing period');
  if (
    !Array.isArray(p.days) ||
    p.days.length === 0 ||
    p.days.length > 7 ||
    p.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  )
    throw new Error('Choose valid days');
  for (const [v, min, max] of [
    [p.minMinutes, 30, 480],
    [p.maxCloud, 0, 100],
    [p.maxWindKmh, 0, 100],
    [p.maxPrecipitationProbability, 0, 100],
    [p.maxMoonIllumination, 0, 100],
  ])
    if (!Number.isFinite(v) || v < min || v > max) throw new Error('Invalid observing limits');
}
export function validatePlace(p: Place): void {
  if (
    !p ||
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    p.name.length > 160 ||
    !Number.isFinite(p.latitude) ||
    Math.abs(p.latitude) > 90 ||
    !Number.isFinite(p.longitude) ||
    Math.abs(p.longitude) > 180
  )
    throw new Error('Invalid location');
  if (typeof p.timeZone !== 'string' || p.timeZone.length > 80)
    throw new Error('Invalid time zone');
  localParts(Date.now(), p.timeZone);
}
function available(minute: number, p: Preferences) {
  return p.startMinute < p.endMinute
    ? minute >= p.startMinute && minute < p.endMinute
    : minute >= p.startMinute || minute < p.endMinute;
}
export function buildAdvice(
  snapshot: WeatherSnapshot,
  place: Place,
  p: Preferences,
  now: number,
  night = observingNight(now, place.timeZone),
): Advice {
  validatePlace(place);
  validatePreferences(p);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) throw new Error('Invalid observing night');
  const stale = now - snapshot.fetchedAt > 3 * 3600000 || snapshot.fetchedAt > now + 300000;
  const allowedDay = p.days.includes(new Date(night + 'T12:00:00Z').getUTCDay());
  const slots: Slot[] = [];
  for (const w of snapshot.hours)
    for (const half of [0, 1800000]) {
      const start = w.time + half,
        end = start + 1800000,
        centre = start + 900000;
      const local = localParts(centre, place.timeZone);
      const slotNight = local.minute < 720 ? addDate(local.date, -1) : local.date;
      if (slotNight !== night || end <= now) continue;
      const sun = altitude(Body.Sun, centre, place.latitude, place.longitude).altitude;
      const moon = altitude(Body.Moon, centre, place.latitude, place.longitude).altitude;
      const illumination = Illumination(Body.Moon, new Date(centre)).phase_fraction * 100;
      const metrics = weatherMetrics(w),
        reasons: string[] = [];
      if (stale) reasons.push('Forecast is out of date');
      if (!allowedDay) reasons.push('Outside selected observing days');
      if (
        !available(local.minute, p) ||
        !available(localParts(Math.max(start, now), place.timeZone).minute, p) ||
        !available(localParts(end - 1, place.timeZone).minute, p)
      )
        reasons.push('Outside your observing hours');
      if (
        metrics.effectiveCloud === null ||
        w.windKmh === null ||
        w.precipitationProbability === null ||
        w.precipitation === null
      )
        reasons.push('Weather data incomplete');
      if ((metrics.effectiveCloud ?? 101) > p.maxCloud) reasons.push('Too much cloud');
      if ((w.windKmh ?? 101) > p.maxWindKmh) reasons.push('Wind above your limit');
      if (
        (w.precipitationProbability ?? 101) > p.maxPrecipitationProbability ||
        (w.precipitation ?? 1) > 0
      )
        reasons.push('Rain expected or possible');
      const sunLimit = p.profile === 'deep-sky' ? -18 : p.profile === 'moon-planets' ? -6 : -12;
      if (
        Math.max(
          sun,
          altitude(Body.Sun, start, place.latitude, place.longitude).altitude,
          altitude(Body.Sun, end, place.latitude, place.longitude).altitude,
        ) > sunLimit
      )
        reasons.push(p.profile === 'deep-sky' ? 'Not astronomically dark' : 'Sky too bright');
      if (
        p.profile === 'deep-sky' &&
        Math.max(
          moon,
          altitude(Body.Moon, start, place.latitude, place.longitude).altitude,
          altitude(Body.Moon, end, place.latitude, place.longitude).altitude,
        ) > 0 &&
        illumination > p.maxMoonIllumination
      )
        reasons.push('Moonlight above your limit');
      if (
        p.profile === 'moon-planets' &&
        moon < 20 &&
        ![Body.Venus, Body.Mars, Body.Jupiter, Body.Saturn].some(
          (b) => altitude(b, centre, place.latitude, place.longitude).altitude >= 20,
        )
      )
        reasons.push('Moon and planets too low');
      slots.push({
        start: Math.max(start, now),
        end,
        cloud: metrics.effectiveCloud,
        windKmh: w.windKmh,
        temperature: w.temperature,
        sunAltitude: Math.round(sun * 10) / 10,
        moonAltitude: Math.round(moon * 10) / 10,
        moonIllumination: Math.round(illumination),
        suitable: reasons.length === 0,
        reasons,
        score: metrics.score,
        dewRisk: w.temperature !== null && w.dewPoint !== null && w.temperature - w.dewPoint <= 2,
      });
    }
  const windows: Window[] = [];
  let run: Slot[] = [];
  const flush = () => {
    if (run.length) {
      const start = run[0].start,
        end = run[run.length - 1].end;
      if (end - start >= p.minMinutes * 60000)
        windows.push({
          start,
          end,
          score: Math.round(
            run.reduce((sum, s) => sum + (s.score ?? 100 - (s.cloud ?? 100)), 0) / run.length,
          ),
        });
      run = [];
    }
  };
  for (const slot of slots) {
    if (!slot.suitable) {
      flush();
      continue;
    }
    if (run.length && slot.start !== run[run.length - 1].end) flush();
    run.push(slot);
  }
  flush();
  windows.sort((a, b) => b.end - b.start - (a.end - a.start) || b.score - a.score);
  const best = windows[0] ?? null;
  const reasons = best
    ? ['At least ' + p.minMinutes + ' minutes within your weather and darkness limits']
    : [...new Set(slots.flatMap((s) => s.reasons))].slice(0, 5);
  if (!slots.length) reasons.push('No forecast available for this observing night');
  else if (!best && !reasons.length)
    reasons.push('Clear intervals are shorter than your minimum duration');
  return {
    version: ENGINE_VERSION,
    night,
    place,
    preferences: p,
    generatedAt: now,
    fetchedAt: snapshot.fetchedAt,
    stale,
    slots,
    windows,
    best,
    targets: best ? recommendTargets(best, place, p) : [],
    reasons,
  };
}
// Curated bright targets; J2000 coordinates. Detailed records remain in the existing catalogue.
const DSO = [
  { name: 'Andromeda Galaxy (M31)', ra: 0.7123, dec: 41.269, equipment: 'eyes', id: 'M31' },
  { name: 'Pleiades (M45)', ra: 3.79, dec: 24.117, equipment: 'eyes', id: 'M45' },
  { name: 'Orion Nebula (M42)', ra: 5.588, dec: -5.391, equipment: 'binoculars', id: 'M42' },
  { name: 'Beehive Cluster (M44)', ra: 8.667, dec: 19.667, equipment: 'binoculars', id: 'M44' },
  { name: 'Hercules Cluster (M13)', ra: 16.695, dec: 36.467, equipment: 'telescope', id: 'M13' },
  { name: 'Lagoon Nebula (M8)', ra: 18.063, dec: -24.383, equipment: 'binoculars', id: 'M8' },
  { name: 'Ring Nebula (M57)', ra: 18.893, dec: 33.029, equipment: 'telescope', id: 'M57' },
];
function recommendTargets(window: Window, place: Place, p: Preferences): Target[] {
  const observer = new Observer(place.latitude, place.longitude, 0),
    targets: Target[] = [];
  const samples: number[] = [];
  for (let t = window.start; t < window.end; t += 1800000) samples.push(t);
  for (const body of p.profile === 'deep-sky'
    ? []
    : [Body.Moon, Body.Jupiter, Body.Saturn, Body.Venus, Body.Mars]) {
    const points = samples
      .map((time) => ({ time, ...altitude(body, time, place.latitude, place.longitude) }))
      .sort((a, b) => b.altitude - a.altitude);
    if (points[0]?.altitude >= 20)
      targets.push({
        name: body,
        url: body === Body.Moon ? '/moon-atlas' : '/solar-system/planets/' + body.toLowerCase(),
        ...points[0],
      });
  }
  if (p.profile !== 'moon-planets')
    for (const d of DSO) {
      if (
        ['eyes', 'binoculars', 'telescope'].indexOf(d.equipment) >
        ['eyes', 'binoculars', 'telescope'].indexOf(p.equipment)
      )
        continue;
      const points = samples
        .map((time) => {
          const date = new Date(time),
            v = VectorFromSphere({ lon: d.ra * 15, lat: d.dec, dist: 1 }, date);
          const hor = SphereFromVector(RotateVector(Rotation_EQJ_HOR(date, observer), v));
          return { time, altitude: hor.lat, azimuth: (360 - hor.lon) % 360 };
        })
        .sort((a, b) => b.altitude - a.altitude);
      if (points[0]?.altitude >= 25)
        targets.push({ name: d.name, url: '/dso/' + d.id.toLowerCase(), ...points[0] });
    }
  return targets
    .sort((a, b) => b.altitude - a.altitude)
    .slice(0, 5)
    .map((t) => ({
      name: t.name,
      url: t.url,
      time: t.time,
      altitude: Math.round(t.altitude * 10) / 10,
      azimuth: Math.round(t.azimuth * 10) / 10,
    }));
}
