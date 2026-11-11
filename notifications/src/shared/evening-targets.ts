import {
  Body,
  Illumination,
  Observer,
  RotateVector,
  Rotation_EQJ_HOR,
  SphereFromVector,
  VectorFromSphere,
} from 'astronomy-engine';
import messierCatalog from './data/messier.json';
import caldwellCatalog from './data/caldwell.json';
import {
  Advice,
  Target,
  altitude,
  localParts,
  observingNight,
  phaseName,
  validatePreferences,
} from './core';

const DIFFICULTIES = ['Very Easy', 'Easy', 'Moderate', 'Hard', 'Very Hard'] as const;
import { TargetDifficulty } from './core';
export type { TargetDifficulty } from './core';

export function difficultyLevel(difficulty: TargetDifficulty | null): number {
  const index = DIFFICULTIES.indexOf(difficulty as TargetDifficulty);
  return index < 0 ? 6 : index + 1;
}

export interface EveningTarget extends Target {
  id: string;
  kind: string;
  image: string;
  description: string;
  tip: string;
  difficulty: TargetDifficulty | null;
}

interface CatalogTarget {
  name: string;
  type: string;
  constellation: string;
  rightAscension: string;
  declination: string;
  image: string;
  viewingDifficulty: string;
}

const CATALOG = new Map<string, CatalogTarget>([
  ...Object.entries(messierCatalog.data),
  ...caldwellCatalog.data.map((record) => [`C${record.messierNumber}`, record] as const),
]);

// Website and notifications share full-catalogue recommendations.
const MAX_TARGETS = 12;
/**
 * Hand-picked adjustment on top of the catalogue difficulty: well-known showpieces that reward
 * any telescope rise a little, objects that usually disappoint (an asterism, a double star,
 * sparse clusters) sink. Small values; altitude, Moon and darkness still decide.
 */
const QUALITY: Record<string, number> = {
  M31: 12,
  M42: 12,
  M45: 10,
  M13: 8,
  M57: 8,
  M27: 8,
  C14: 8,
  M44: 6,
  M51: 6,
  M8: 5,
  M11: 5,
  M22: 5,
  M81: 4,
  M82: 4,
  M92: 4,
  M17: 4,
  M35: 3,
  M3: 3,
  M5: 3,
  M40: -30,
  M73: -30,
  M102: -20,
  C37: -15,
  C16: -12,
  C11: -8,
};
/** Objects that share the eyepiece field of a brighter target: list only the parent. */
const COMPANION_OF: Record<string, string> = { m32: 'm31', m110: 'm31', m43: 'm42' };
/** 0 at astronomical darkness (-18 degrees), 1 at the end of nautical twilight (-12 degrees). */
function twilight(sunAltitude: number): number {
  return Math.max(0, Math.min(1, (sunAltitude + 18) / 6));
}
/** Earliest point that is nearly as good as the best: a practical time, not the small hours. */
function practicalPoint<T extends { time: number; score: number }>(points: T[]): T | undefined {
  const top = points[0]?.score;
  if (top === undefined) return undefined;
  return points.filter((p) => p.score >= top - 3).sort((a, b) => a.time - b.time)[0];
}
const SOLAR_SYSTEM = [
  Body.Moon,
  Body.Mercury,
  Body.Venus,
  Body.Mars,
  Body.Jupiter,
  Body.Saturn,
  Body.Uranus,
  Body.Neptune,
];
interface Sample {
  time: number;
  sunAltitude: number;
  moonAltitude: number;
  moonIllumination: number;
  moonAzimuth: number;
}
interface Candidate {
  target: EveningTarget;
  score: number;
  group: string;
}

function selectedMinute(minute: number, advice: Advice): boolean {
  const { startMinute, endMinute } = advice.preferences;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

function samplesFor(advice: Advice): Sample[] {
  const { place, preferences, generatedAt, best } = advice;
  // Do not use the browser clock or the currently selected location: these belong to one advice.
  if (
    advice.stale ||
    !Number.isFinite(generatedAt) ||
    !Number.isFinite(place.latitude) ||
    Math.abs(place.latitude) > 90 ||
    !Number.isFinite(place.longitude) ||
    Math.abs(place.longitude) > 180 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(advice.night)
  )
    return [];
  try {
    validatePreferences(preferences);
    localParts(generatedAt, place.timeZone);
  } catch {
    return [];
  }
  if (!preferences.days.includes(new Date(advice.night + 'T12:00:00Z').getUTCDay())) return [];
  const sunLimit =
    preferences.profile === 'deep-sky' ? -18 : preferences.profile === 'moon-planets' ? -6 : -12;
  const times = new Map<number, number>();
  for (const slot of advice.slots) {
    const start = Math.max(slot.start, generatedAt, best?.start ?? -Infinity);
    const end = Math.min(slot.end, best?.end ?? Infinity);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // Include the start and midpoint, never the exclusive end of an observing window.
    for (const time of [start, start + (end - start) / 2]) {
      if (
        observingNight(time, place.timeZone) !== advice.night ||
        !selectedMinute(localParts(time, place.timeZone).minute, advice)
      )
        continue;
      const sun = altitude(Body.Sun, time, place.latitude, place.longitude).altitude;
      if (sun <= sunLimit) times.set(time, sun);
    }
  }
  return [...times]
    .sort(([a], [b]) => a - b)
    .map(([time, sunAltitude]) => {
      const moon = altitude(Body.Moon, time, place.latitude, place.longitude);
      return {
        time,
        sunAltitude,
        moonAltitude: moon.altitude,
        moonAzimuth: moon.azimuth,
        moonIllumination: Illumination(Body.Moon, new Date(time)).phase_fraction * 100,
      };
    });
}

function catalogDifficulty(record: CatalogTarget): TargetDifficulty | null {
  return DIFFICULTIES.includes(record.viewingDifficulty as TargetDifficulty)
    ? (record.viewingDifficulty as TargetDifficulty)
    : null;
}

function moonSeparation(altitude: number, azimuth: number, sample: Sample): number {
  const radians = Math.PI / 180;
  const separation =
    Math.sin(altitude * radians) * Math.sin(sample.moonAltitude * radians) +
    Math.cos(altitude * radians) *
      Math.cos(sample.moonAltitude * radians) *
      Math.cos((azimuth - sample.moonAzimuth) * radians);
  return Math.acos(Math.max(-1, Math.min(1, separation))) / radians;
}

function coordinate(value: string): number {
  const [degrees, minutes, seconds] = value.replace(/^[+-]/, '').split(':').map(Number);
  return (value.startsWith('-') ? -1 : 1) * (degrees + minutes / 60 + seconds / 3600);
}

function deepSkyTip(type: string): string {
  if (type === 'Open Cluster')
    return 'Start with a wide field and low magnification to keep the surrounding stars in view.';
  if (type === 'Globular Cluster')
    return 'Start at low power, then increase magnification if the air is steady; look around the edge.';
  if (type === 'Planetary Nebula')
    return 'Locate the field at low power, then try more magnification to separate the nebula from stars.';
  return 'Use low magnification and averted vision; expect a faint glow rather than photographic colour.';
}
function observingTip(id: string, record: CatalogTarget, low: boolean, moonlight: boolean): string {
  const wide = ['M45', 'M44', 'M7', 'C14', 'C41', 'C85', 'C102'].includes(id);
  return (
    (wide
      ? 'This is a wide star field: use low magnification to keep the whole cluster in view.'
      : deepSkyTip(record.type)) +
    (moonlight ? ' Moonlight will reduce contrast.' : '') +
    (low ? ' Low in the sky: choose an unobstructed horizon.' : '')
  );
}
function solarTip(body: Body, moonIllumination?: number): string {
  if (body === Body.Moon && !Number.isFinite(moonIllumination))
    return 'Explore the lunar seas, bright highlands and crater markings.';
  if (body === Body.Moon)
    return moonIllumination !== undefined && moonIllumination >= 95
      ? 'Near full Moon, explore bright crater rays and dark lunar seas; shadows are short.'
      : 'Explore crater edges near the boundary between light and shadow.';
  if (body === Body.Jupiter)
    return 'Look for the Galilean moons and cloud bands when the air is steady.';
  if (body === Body.Saturn)
    return 'Start at low power, then increase magnification to explore the ringed outline.';
  if (body === Body.Venus || body === Body.Mercury)
    return 'Look for the shape of the illuminated disc after sunset; keep the Sun below the horizon.';
  if (body === Body.Uranus || body === Body.Neptune)
    return 'Use the finder chart to identify the faint planet among the surrounding stars.';
  return 'Look for the reddish disc; visible detail depends on apparent size and steady air.';
}
function solarDescription(body: Body): string {
  if (body === Body.Moon)
    return "Earth's natural satellite, with dark lunar seas and bright highlands.";
  if (body === Body.Jupiter) return 'A gas giant with cloud bands and a family of moons.';
  if (body === Body.Saturn) return 'The ringed gas giant.';
  if (body === Body.Venus) return 'A bright planet with changing phases.';
  if (body === Body.Mercury) return 'The innermost planet, with changing phases.';
  if (body === Body.Uranus || body === Body.Neptune) return 'A distant ice giant.';
  return 'The Red Planet.';
}

/** Enrich a saved email report without changing any of its original recommendations. */
export function decorateSavedTargets(advice: Advice): EveningTarget[] {
  const decorated = advice.targets.map((target, index): EveningTarget => {
    const body = SOLAR_SYSTEM.find((candidate) =>
      candidate === Body.Moon
        ? target.url === '/moon-atlas' || target.url === '/solar-system/moons/moon'
        : target.url === '/solar-system/planets/' + candidate.toLowerCase(),
    );
    if (body) {
      const id = body.toLowerCase();
      return {
        ...target,
        id,
        kind: body === Body.Moon ? 'Moon' : 'Planet',
        image:
          '/assets/solar-system/' + (body === Body.Moon ? 'moons/' : 'planets/') + id + '.webp',
        description: solarDescription(body),
        difficulty: null,
        tip: solarTip(
          body,
          advice.slots.find((slot) => target.time >= slot.start && target.time < slot.end)
            ?.moonIllumination,
        ),
      };
    }
    const match = /^\/dso\/([mc]\d+)\/?$/i.exec(target.url);
    const id = match?.[1].toUpperCase();
    const record = id ? CATALOG.get(id) : undefined;
    if (record) {
      return {
        ...target,
        id: id!.toLowerCase(),
        kind: record.type,
        image: record.image,
        description: record.type + ' in ' + record.constellation + '.',
        difficulty: catalogDifficulty(record),
        tip: deepSkyTip(record.type),
      };
    }
    // Keep unrecognised future report targets intact rather than guessing their identity.
    return {
      ...target,
      id: 'saved-target-' + index,
      kind: 'Object',
      image: '/assets/img/starwatchricon.png',
      description: '',
      tip: '',
      difficulty: null,
    };
  });
  return decorated.map((target, index) => ({
    ...target,
    ...Object.fromEntries(
      Object.entries(advice.targets[index]).filter(([, value]) => value !== undefined),
    ),
  }));
}

/** Astronomical possibilities for the advice window; weather suitability remains on Advice.best. */
export function buildEveningTargets(
  advice: Advice,
  maxDifficulty: TargetDifficulty = 'Moderate',
): EveningTarget[] {
  const samples = samplesFor(advice);
  if (!samples.length) return [];
  const { place, preferences } = advice;
  const observer = new Observer(place.latitude, place.longitude, 0);
  const candidates: Candidate[] = [];
  if (preferences.profile !== 'deep-sky') {
    for (const body of SOLAR_SYSTEM) {
      const points = samples
        .filter((sample) => body !== Body.Moon || sample.moonIllumination >= 3)
        .map((sample) => ({
          ...sample,
          ...altitude(body, sample.time, place.latitude, place.longitude),
        }))
        .filter((point) => point.altitude >= 20)
        .map((point) => ({ ...point, score: Math.min(point.altitude, 65) * 0.5 }))
        .sort((a, b) => b.score - a.score);
      const point = practicalPoint(points);
      if (!point) continue;
      const id = body.toLowerCase();
      // Faint planets (Uranus, Neptune) are a finder exercise, not a showpiece.
      const magnitude = body === Body.Moon ? -12 : Illumination(body, new Date(point.time)).mag;
      candidates.push({
        score: 105 + point.score - Math.max(0, magnitude - 1) * 4,
        group: body === Body.Moon ? 'Moon' : 'Planet',
        target: {
          id,
          name: body,
          kind: body === Body.Moon ? 'Moon' : 'Planet',
          url: body === Body.Moon ? '/moon-atlas' : '/solar-system/planets/' + id,
          image:
            '/assets/solar-system/' + (body === Body.Moon ? 'moons/' : 'planets/') + id + '.webp',
          description:
            body === Body.Moon
              ? phaseName(point.time) + ' · ' + Math.round(point.moonIllumination) + '% illuminated'
              : solarDescription(body),
          difficulty: null,
          tip: solarTip(body, point.moonIllumination),
          time: point.time,
          altitude: point.altitude,
          azimuth: point.azimuth,
        },
      });
    }
  }
  if (preferences.profile !== 'moon-planets') {
    for (const [catalogId, record] of CATALOG) {
      const difficulty = catalogDifficulty(record);
      // Apply the user's ceiling before ranking or limiting the list; never fill with harder objects.
      if (difficultyLevel(difficulty) > difficultyLevel(maxDifficulty)) continue;
      const ra = coordinate(record.rightAscension) * 15,
        dec = coordinate(record.declination);
      if (!Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90) continue;
      const compactPlanetary = record.type === 'Planetary Nebula' && catalogId !== 'C63';
      const diffuse =
        record.type.includes('Galaxy') ||
        (record.type.includes('Nebula') && !compactPlanetary) ||
        record.type === 'Supernova Remnant';
      const needsDarkSky = ['M33', 'C33', 'C63'].includes(catalogId);
      const points = samples
        .map((sample) => {
          const date = new Date(sample.time);
          const vector = VectorFromSphere(
            {
              lon: ra,
              lat: dec,
              dist: 1,
            },
            date,
          );
          const horizon = SphereFromVector(RotateVector(Rotation_EQJ_HOR(date, observer), vector));
          const azimuth = (360 - horizon.lon) % 360;
          const brightMoon = sample.moonAltitude > 0 && sample.moonIllumination >= 50;
          const separation = moonSeparation(horizon.lat, azimuth, sample);
          // Conservative planning cutoffs, not measured visibility probabilities: avoid glare close
          // to a bright Moon and reserve especially low-contrast objects for less moonlit hours.
          const obscuredByMoon = brightMoon && (needsDarkSky || separation < (diffuse ? 45 : 20));
          const moonStrength =
            sample.moonAltitude > 0
              ? (sample.moonIllumination / 100) * Math.min(1, sample.moonAltitude / 30)
              : 0;
          const moonPenalty =
            moonStrength *
            (diffuse ? 28 : compactPlanetary ? 8 : record.type === 'Open Cluster' ? 3 : 10);
          return {
            ...sample,
            altitude: horizon.lat,
            azimuth,
            brightMoon,
            obscuredByMoon,
            // Above 65° there is little practical reason to prefer altitude over easier finding.
            // Moonlight and twilight only subtract: they never move the time into worse conditions.
            score:
              Math.min(horizon.lat, 65) * 0.5 -
              moonPenalty -
              twilight(sample.sunAltitude) * (diffuse ? 20 : compactPlanetary ? 8 : 3),
          };
        })
        .filter((point) => point.altitude >= 25 && !point.obscuredByMoon)
        .sort((a, b) => b.score - a.score);
      const point = practicalPoint(points);
      if (!point) continue;
      const id = catalogId.toLowerCase();
      // A wide difficulty ceiling is a wish to see harder objects, so difficulty weighs less.
      const step = difficultyLevel(maxDifficulty) >= 4 ? 5 : 12;
      candidates.push({
        score:
          100 - (difficultyLevel(difficulty) - 1) * step + point.score + (QUALITY[catalogId] ?? 0),
        group: record.type.includes('Galaxy') ? 'Galaxy' : record.type,
        target: {
          id,
          name: catalogId + ' · ' + record.name,
          kind: record.type,
          url: '/dso/' + id,
          image: record.image,
          description: record.type + ' in ' + record.constellation + '.',
          difficulty,
          tip: observingTip(catalogId, record, point.altitude < 35, diffuse && point.brightMoon),
          time: point.time,
          altitude: point.altitude,
          azimuth: point.azimuth,
        },
      });
    }
  }
  const chosen: Candidate[] = [];
  const counts = new Map<string, number>();
  // Variety costs 5 points per earlier pick of the same kind (at most 15): enough to stop one type
  // filling the list, never a quota that forces difficult objects in.
  while (candidates.length && chosen.length < MAX_TARGETS) {
    const adjusted = (candidate: Candidate) =>
      candidate.score - Math.min(3, counts.get(candidate.group) ?? 0) * 5;
    candidates.sort((a, b) => adjusted(b) - adjusted(a) || a.target.id.localeCompare(b.target.id));
    const candidate = candidates.shift()!;
    const parent = COMPANION_OF[candidate.target.id];
    if (parent && chosen.some((c) => c.target.id === parent)) continue;
    chosen.push(candidate);
    counts.set(candidate.group, (counts.get(candidate.group) ?? 0) + 1);
  }
  return chosen.map(({ target }, index) => ({
    rank: index + 1,
    ...target,
    altitude: Math.round(target.altitude * 10) / 10,
    azimuth: Math.round(target.azimuth * 10) / 10,
  }));
}
