import { Advice, Slot, localParts } from './core';

export interface EveningHour {
  start: number;
  end: number;
  slots: Slot[];
  cloud: number | null;
  windKmh: number | null;
  temperature: number | null;
  suitable: boolean;
  partial: boolean;
  inBest: boolean;
  sky: string;
  status: string;
  reasons: string[];
  dewRisk: boolean;
}

export interface EveningSummary {
  title: string;
  description: string;
  cloudMin: number | null;
  cloudMax: number | null;
  windMax: number | null;
  temperatureMin: number | null;
  temperatureMax: number | null;
  moonIllumination: number | null;
  moonUp: boolean;
  dewRisk: boolean;
  durationMinutes: number;
}

const reasonLabels: [string, string][] = [
  ['Forecast is out of date', 'Refresh forecast'],
  ['Weather data incomplete', 'Incomplete forecast'],
  ['Rain expected or possible', 'Rain risk'],
  ['Wind above your limit', 'Wind above limit'],
  ['Too much cloud', 'Cloud above limit'],
  ['Moonlight above your limit', 'Too much moonlight'],
  ['Moon and planets too low', 'Targets too low'],
  ['Not astronomically dark', 'Sky too bright'],
  ['Sky too bright', 'Sky too bright'],
  ['Outside your observing hours', 'Outside selected hours'],
  ['Outside selected observing days', 'Not a selected evening'],
];

function skyLabel(cloud: number | null): string {
  if (cloud === null) return 'Unknown';
  if (cloud <= 10) return 'Clear';
  if (cloud <= 30) return 'Mostly clear';
  if (cloud <= 60) return 'Partly cloudy';
  if (cloud <= 85) return 'Cloudy';
  return 'Overcast';
}

function completeValues(slots: Slot[], key: 'cloud' | 'windKmh' | 'temperature'): number[] {
  const values = slots.map((slot) => slot[key]);
  return values.every((value): value is number => value !== null && Number.isFinite(value))
    ? values
    : [];
}

function range(values: number[]): [number | null, number | null] {
  return values.length ? [Math.min(...values), Math.max(...values)] : [null, null];
}

function withinHours(minute: number, advice: Advice): boolean {
  const { startMinute, endMinute } = advice.preferences;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/** Display-only intervals; the saved suitability decisions and reasons stay unchanged. */
function hourGroups(advice: Advice, selectedOnly: boolean): Map<string, Slot[]> {
  const groups = new Map<string, Slot[]>();
  const zone = advice.place.timeZone;
  for (const slot of [...advice.slots].sort((a, b) => a.start - b.start)) {
    let previous: Slot | undefined;
    let previousKey = '';
    // Minute boundaries also cover quarter-hour zones, non-rounded preferences and DST changes.
    for (let cursor = slot.start; cursor < slot.end; ) {
      const end = Math.min(slot.end, (Math.floor(cursor / 60000) + 1) * 60000);
      const local = localParts(cursor, zone);
      const offset =
        Date.parse(local.date + 'T00:00:00Z') / 60000 + local.minute - Math.floor(cursor / 60000);
      const key = `${local.date}/${Math.floor(local.minute / 60)}/${offset}`;
      if (!selectedOnly || withinHours(local.minute, advice)) {
        if (previous && previousKey === key && previous.end === cursor) {
          previous.end = end;
        } else {
          previous = { ...slot, start: cursor, end };
          previousKey = key;
          const group = groups.get(key);
          if (group) group.push(previous);
          else groups.set(key, [previous]);
        }
      } else {
        previous = undefined;
      }
      cursor = end;
    }
  }
  return groups;
}

export function eveningHours(advice: Advice): EveningHour[] {
  let groups = hourGroups(advice, true);
  if (!groups.size) groups = hourGroups(advice, false);
  return [...groups.values()].map((slots) => {
    const start = slots[0].start;
    const end = slots[slots.length - 1].end;
    const reasons = [...new Set(slots.flatMap((slot) => slot.reasons))];
    const cloud = range(completeValues(slots, 'cloud'))[1];
    const windKmh = range(completeValues(slots, 'windKmh'))[1];
    const temperatures = completeValues(slots, 'temperature');
    const duration = slots.reduce((total, slot) => total + slot.end - slot.start, 0);
    const temperature = temperatures.length
      ? slots.reduce((sum, slot) => sum + slot.temperature! * (slot.end - slot.start), 0) / duration
      : null;
    const suitable = slots.every((slot) => slot.suitable);
    return {
      start,
      end,
      slots,
      cloud,
      windKmh,
      temperature,
      suitable,
      partial: !suitable && slots.some((slot) => slot.suitable),
      inBest:
        !!advice.best &&
        slots.some((slot) => slot.start < advice.best!.end && slot.end > advice.best!.start),
      sky: skyLabel(cloud),
      status: suitable
        ? 'Within limits'
        : (reasonLabels.find(([reason]) => reasons.includes(reason))?.[1] ?? 'Outside limits'),
      reasons,
      dewRisk: slots.some((slot) => slot.dewRisk),
    };
  });
}

export function eveningSummary(advice: Advice): EveningSummary {
  const slots = advice.best
    ? advice.slots
        .filter((slot) => slot.start < advice.best!.end && slot.end > advice.best!.start)
        .map((slot) => ({
          ...slot,
          start: Math.max(slot.start, advice.best!.start),
          end: Math.min(slot.end, advice.best!.end),
        }))
    : eveningHours(advice).flatMap((hour) => hour.slots);
  const [cloudMin, cloudMax] = range(completeValues(slots, 'cloud'));
  const [, windMax] = range(completeValues(slots, 'windKmh'));
  const [temperatureMin, temperatureMax] = range(completeValues(slots, 'temperature'));
  const duration = slots.reduce((total, slot) => total + slot.end - slot.start, 0);
  const moonIllumination =
    duration && slots.every((slot) => Number.isFinite(slot.moonIllumination))
      ? Math.round(
          slots.reduce((sum, slot) => sum + slot.moonIllumination * (slot.end - slot.start), 0) /
            duration,
        )
      : null;
  const reasons = [...new Set(slots.flatMap((slot) => slot.reasons))];
  const has = (reason: string) => reasons.includes(reason);
  const minimum = advice.preferences.minMinutes;
  let title = 'Your observing window';
  let description = `Within your selected weather and darkness limits for ${Math.round(duration / 60000)} minutes.`;

  if (!slots.length) {
    title = 'No forecast for this night';
    description = 'Choose another date within the available forecast.';
  } else if (advice.stale || has('Forecast is out of date')) {
    title = 'This forecast needs a refresh';
    description = 'Refresh the forecast before planning your session.';
  } else if (!advice.best) {
    if (slots.some((slot) => slot.suitable)) {
      title = has('Too much cloud') ? 'Short breaks in the cloud' : 'Short observing breaks';
      description = `No continuous interval meets your ${minimum}-minute minimum. Try a shorter session.`;
    } else {
      const reasonDurations = reasonLabels.map(([reason]) => ({
        reason,
        duration: slots.reduce(
          (sum, slot) => sum + (slot.reasons.includes(reason) ? slot.end - slot.start : 0),
          0,
        ),
      }));
      // Prefer the most persistent constraint; ties use the factual priority above.
      const main = reasonDurations.sort((a, b) => b.duration - a.duration)[0]?.reason;
      switch (main) {
        case 'Weather data incomplete':
          title = 'Forecast data is incomplete';
          description =
            'Some weather values are missing. Refresh before choosing an observing time.';
          break;
        case 'Rain expected or possible':
          title = 'Rain risk limits this evening';
          description = 'Rain is forecast or its probability exceeds your selected limit.';
          break;
        case 'Wind above your limit':
          title = 'A windy evening';
          description = `Wind exceeds your ${advice.preferences.maxWindKmh} km/h limit. Check another night.`;
          break;
        case 'Too much cloud':
          title =
            cloudMin !== null && cloudMin > 60
              ? 'A cloudy evening'
              : 'Cloud above your selected limit';
          description = `Cloud cover exceeds your ${advice.preferences.maxCloud}% limit. Check another night.`;
          break;
        case 'Moonlight above your limit':
          title = 'Moonlight limits deep-sky viewing';
          description = 'Try Moon and planets, or choose a night with less moonlight.';
          break;
        case 'Moon and planets too low':
          title = 'The Moon and planets are low';
          description = 'Try different observing hours or another observing interest.';
          break;
        case 'Not astronomically dark':
        case 'Sky too bright':
          title = 'The sky is too bright for your plan';
          description = 'Try different hours or an observing interest that needs less darkness.';
          break;
        case 'Outside your observing hours':
          title = 'No forecast within your selected hours';
          description =
            'Available hours are shown below. Adjust your observing times or choose another night.';
          break;
        case 'Outside selected observing days':
          title = 'This evening is outside your schedule';
          description = 'Include this day in your observing evenings or choose another date.';
          break;
        default:
          title = 'Conditions do not meet your limits';
          description = 'Check the hourly conditions or try another evening.';
      }
    }
  }

  return {
    title,
    description,
    cloudMin,
    cloudMax,
    windMax,
    temperatureMin,
    temperatureMax,
    moonIllumination,
    moonUp: slots.some((slot) => slot.moonAltitude > 0),
    dewRisk: slots.some((slot) => slot.dewRisk),
    durationMinutes: Math.round(duration / 60000),
  };
}
