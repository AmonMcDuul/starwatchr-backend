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
  Equipment,
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

// A varied observing list from both hemispheres, using the app's catalogue records and images.
const DEEP_SKY: { id: string; equipment: Equipment }[] = [
  { id: 'M31', equipment: 'eyes' },
  { id: 'M45', equipment: 'eyes' },
  { id: 'M44', equipment: 'eyes' },
  { id: 'M7', equipment: 'eyes' },
  { id: 'M42', equipment: 'binoculars' },
  { id: 'M8', equipment: 'binoculars' },
  { id: 'M35', equipment: 'binoculars' },
  { id: 'M36', equipment: 'binoculars' },
  { id: 'M37', equipment: 'binoculars' },
  { id: 'M38', equipment: 'binoculars' },
  { id: 'M41', equipment: 'binoculars' },
  { id: 'M47', equipment: 'binoculars' },
  { id: 'M13', equipment: 'telescope' },
  { id: 'M3', equipment: 'telescope' },
  { id: 'M5', equipment: 'telescope' },
  { id: 'M15', equipment: 'telescope' },
  { id: 'M57', equipment: 'telescope' },
  { id: 'M27', equipment: 'telescope' },
  { id: 'M81', equipment: 'telescope' },
  { id: 'M82', equipment: 'telescope' },
  { id: 'M2', equipment: 'telescope' },
  { id: 'M6', equipment: 'binoculars' },
  { id: 'M10', equipment: 'telescope' },
  { id: 'M11', equipment: 'binoculars' },
  { id: 'M12', equipment: 'telescope' },
  { id: 'M17', equipment: 'binoculars' },
  { id: 'M20', equipment: 'telescope' },
  { id: 'M22', equipment: 'binoculars' },
  { id: 'M29', equipment: 'binoculars' },
  { id: 'M34', equipment: 'binoculars' },
  { id: 'M39', equipment: 'binoculars' },
  { id: 'M46', equipment: 'binoculars' },
  { id: 'M48', equipment: 'binoculars' },
  { id: 'M52', equipment: 'binoculars' },
  { id: 'M67', equipment: 'telescope' },
  { id: 'M92', equipment: 'telescope' },
  { id: 'M33', equipment: 'telescope' },
  { id: 'M51', equipment: 'telescope' },
  { id: 'M63', equipment: 'telescope' },
  { id: 'M64', equipment: 'telescope' },
  { id: 'M94', equipment: 'telescope' },
  { id: 'M104', equipment: 'telescope' },
  { id: 'C6', equipment: 'telescope' },
  { id: 'C10', equipment: 'binoculars' },
  { id: 'C13', equipment: 'binoculars' },
  { id: 'C14', equipment: 'binoculars' },
  { id: 'C15', equipment: 'telescope' },
  { id: 'C16', equipment: 'binoculars' },
  { id: 'C22', equipment: 'telescope' },
  { id: 'C28', equipment: 'binoculars' },
  { id: 'C30', equipment: 'telescope' },
  { id: 'C33', equipment: 'telescope' },
  { id: 'C37', equipment: 'binoculars' },
  { id: 'C39', equipment: 'telescope' },
  { id: 'C41', equipment: 'eyes' },
  { id: 'C50', equipment: 'binoculars' },
  { id: 'C55', equipment: 'telescope' },
  { id: 'C58', equipment: 'binoculars' },
  { id: 'C59', equipment: 'telescope' },
  { id: 'C63', equipment: 'telescope' },
  { id: 'C65', equipment: 'telescope' },
  { id: 'C76', equipment: 'binoculars' },
  { id: 'C77', equipment: 'telescope' },
  { id: 'C80', equipment: 'eyes' },
  { id: 'C85', equipment: 'eyes' },
  { id: 'C91', equipment: 'binoculars' },
  { id: 'C92', equipment: 'binoculars' },
  { id: 'C94', equipment: 'binoculars' },
  { id: 'C96', equipment: 'binoculars' },
  { id: 'C102', equipment: 'eyes' },
  { id: 'C103', equipment: 'telescope' },
  { id: 'C106', equipment: 'binoculars' },
];
const MAX_TARGETS = 12;
const EQUIPMENT: Equipment[] = ['eyes', 'binoculars', 'telescope'];
const SOLAR_SYSTEM = [Body.Moon, Body.Jupiter, Body.Saturn, Body.Venus, Body.Mars];
interface Sample {
  time: number;
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
  const times = new Set<number>();
  for (const slot of advice.slots) {
    const start = Math.max(slot.start, generatedAt, best?.start ?? -Infinity);
    const end = Math.min(slot.end, best?.end ?? Infinity);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // Include the start and midpoint, never the exclusive end of an observing window.
    for (const time of [start, start + (end - start) / 2]) {
      if (
        observingNight(time, place.timeZone) === advice.night &&
        selectedMinute(localParts(time, place.timeZone).minute, advice) &&
        altitude(Body.Sun, time, place.latitude, place.longitude).altitude <= sunLimit
      )
        times.add(time);
    }
  }
  return [...times]
    .sort((a, b) => a - b)
    .map((time) => {
      const moon = altitude(Body.Moon, time, place.latitude, place.longitude);
      return {
        time,
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

function deepSkyTip(type: string, equipment: Equipment): string {
  if (equipment === 'eyes')
    return type.includes('Galaxy')
      ? 'Find a dark spot, let your eyes adapt and look for a faint patch rather than spiral detail.'
      : 'Let your eyes adapt and look for the cluster as a small gathering of stars or a hazy patch.';
  if (equipment === 'binoculars')
    return type.includes('Cluster')
      ? 'Rest your elbows or mount the binoculars, then sweep slowly across the surrounding stars.'
      : 'Use a steady support and look slightly to one side to pick out the faint glow.';
  if (type === 'Open Cluster')
    return 'Start with your widest field and low magnification to keep the surrounding stars in view.';
  if (type === 'Globular Cluster')
    return 'Start at low power, then increase magnification if the air is steady; look around the edge.';
  if (type === 'Planetary Nebula')
    return 'Locate the field at low power, then try more magnification to separate the nebula from stars.';
  return 'Use low magnification and averted vision; expect a faint glow rather than photographic colour.';
}

function observingTip(
  id: string,
  record: CatalogTarget,
  equipment: Equipment,
  low: boolean,
  moonlight: boolean,
): string {
  const wideCluster = ['M45', 'M44', 'M7', 'C14', 'C41', 'C85', 'C102'].includes(id);
  const tip =
    equipment === 'telescope' && wideCluster
      ? 'This is a wide star field: use your lowest power, or explore the whole cluster with binoculars.'
      : equipment === 'binoculars' && record.type === 'Globular Cluster'
        ? 'Steady the binoculars and look for a compact, hazy patch; resolving individual stars takes a telescope.'
        : deepSkyTip(record.type, equipment);
  return (
    tip +
    (moonlight ? ' Moonlight will reduce contrast.' : '') +
    (low ? ' Low in the sky: choose an unobstructed horizon.' : '')
  );
}

function solarTip(body: Body, equipment: Equipment, moonIllumination?: number): string {
  if (body === Body.Moon) {
    if (equipment === 'eyes') return 'Compare the dark lunar seas with the brighter highlands.';
    if (moonIllumination !== undefined && moonIllumination >= 95)
      return equipment === 'binoculars'
        ? 'With the Moon nearly full, steady the binoculars and compare the dark seas and bright ray patterns.'
        : 'Near full Moon, explore bright crater rays and dark lunar seas; shadows are short.';
    if (!Number.isFinite(moonIllumination))
      return equipment === 'binoculars'
        ? 'Steady the binoculars and compare the dark lunar seas with the brighter highlands.'
        : 'Start at low power and explore the lunar seas, bright highlands and crater markings.';
    if (equipment === 'binoculars')
      return 'Steady the binoculars and follow the boundary between the sunlit and dark surface.';
    return 'Start at low power and explore crater edges near the boundary between light and shadow.';
  }
  if (equipment === 'eyes')
    return body === Body.Mars
      ? 'Look for a warm, reddish point among the surrounding stars.'
      : 'Find the planet among the stars, then compare its brightness and steadiness.';
  if (equipment === 'binoculars')
    return body === Body.Jupiter
      ? 'With steady binoculars, try to pick out the brightest moons beside Jupiter.'
      : 'Use a steady support to locate the planet; fine planetary detail needs a telescope.';
  if (body === Body.Jupiter)
    return 'Look for the Galilean moons, then try more magnification for the cloud bands if the air is steady.';
  if (body === Body.Saturn)
    return 'Start at low power, then increase magnification to explore the ringed outline.';
  if (body === Body.Venus)
    return 'Look for the shape of the illuminated disc; its cloud-covered surface hides fine detail.';
  return 'Try higher magnification only when the image is steady; visible detail depends on its apparent size.';
}

function solarDescription(body: Body): string {
  if (body === Body.Moon)
    return "Earth's natural satellite, with dark lunar seas and bright highlands.";
  if (body === Body.Jupiter) return 'A gas giant with cloud bands and a family of moons.';
  if (body === Body.Saturn) return 'The ringed gas giant.';
  if (body === Body.Venus) return 'A bright planet with changing phases.';
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
          advice.preferences.equipment,
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
        tip: deepSkyTip(record.type, advice.preferences.equipment),
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
        .sort((a, b) => b.altitude - a.altitude);
      const point = points[0];
      if (!point) continue;
      const id = body.toLowerCase();
      candidates.push({
        score: 105 + Math.min(point.altitude, 65) * 0.5,
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
          tip: solarTip(body, preferences.equipment, point.moonIllumination),
          time: point.time,
          altitude: point.altitude,
          azimuth: point.azimuth,
        },
      });
    }
  }
  if (preferences.profile !== 'moon-planets') {
    for (const entry of DEEP_SKY) {
      if (EQUIPMENT.indexOf(entry.equipment) > EQUIPMENT.indexOf(preferences.equipment)) continue;
      const record = CATALOG.get(entry.id);
      if (!record) continue;
      const difficulty = catalogDifficulty(record);
      // Apply the user's ceiling before ranking or limiting the list; never fill with harder objects.
      if (difficultyLevel(difficulty) > difficultyLevel(maxDifficulty)) continue;
      const compactPlanetary = record.type === 'Planetary Nebula' && entry.id !== 'C63';
      const diffuse =
        record.type.includes('Galaxy') ||
        (record.type.includes('Nebula') && !compactPlanetary) ||
        record.type === 'Supernova Remnant';
      const needsDarkSky = ['M33', 'C33', 'C63'].includes(entry.id);
      const points = samples
        .map((sample) => {
          const date = new Date(sample.time);
          const vector = VectorFromSphere(
            {
              lon: coordinate(record.rightAscension) * 15,
              lat: coordinate(record.declination),
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
          const obscuredByMoon =
            brightMoon &&
            (needsDarkSky ||
              (diffuse && preferences.equipment === 'eyes') ||
              separation < (diffuse ? 45 : 20));
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
            // Moonlight only subtracts: it must never move the suggested time into worse conditions.
            score: Math.min(horizon.lat, 65) * 0.5 - moonPenalty,
          };
        })
        .filter((point) => point.altitude >= 25 && !point.obscuredByMoon)
        .sort((a, b) => b.score - a.score);
      const point = points[0];
      if (!point) continue;
      const id = entry.id.toLowerCase();
      candidates.push({
        score: 100 - (difficultyLevel(difficulty) - 1) * 12 + point.score,
        group: record.type.includes('Galaxy') ? 'Galaxy' : record.type,
        target: {
          id,
          name: entry.id + ' · ' + record.name,
          kind: record.type,
          url: '/dso/' + id,
          image: record.image,
          description: record.type + ' in ' + record.constellation + '.',
          difficulty,
          tip: observingTip(
            entry.id,
            record,
            preferences.equipment,
            point.altitude < 35,
            diffuse && point.brightMoon,
          ),
          time: point.time,
          altitude: point.altitude,
          azimuth: point.azimuth,
        },
      });
    }
  }
  const chosen: Candidate[] = [];
  const counts = new Map<string, number>();
  // Variety is a small tie-break (at most 4 points), never a quota that forces difficult objects in.
  while (candidates.length && chosen.length < MAX_TARGETS) {
    const adjusted = (candidate: Candidate) =>
      candidate.score - Math.min(2, counts.get(candidate.group) ?? 0) * 2;
    candidates.sort((a, b) => adjusted(b) - adjusted(a) || a.target.id.localeCompare(b.target.id));
    const candidate = candidates.shift()!;
    chosen.push(candidate);
    counts.set(candidate.group, (counts.get(candidate.group) ?? 0) + 1);
  }
  return chosen.map(({ target }) => ({
    ...target,
    altitude: Math.round(target.altitude * 10) / 10,
    azimuth: Math.round(target.azimuth * 10) / 10,
  }));
}
