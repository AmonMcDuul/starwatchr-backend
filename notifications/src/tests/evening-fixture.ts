import { buildAdvice, DEFAULT_PREFERENCES } from '../shared/engine';
export function eveningFixture() {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const place = {
    name: 'Halsteren',
    latitude: 51.53,
    longitude: 4.27,
    timeZone: 'Europe/Amsterdam',
  };
  return buildAdvice(
    {
      fetchedAt: now,
      ...place,
      hours: Array.from({ length: 48 }, (_, i) => ({
        time: now - 12 * 3600000 + i * 3600000,
        cloud: 5,
        low: 0,
        mid: 0,
        high: 5,
        temperature: 12,
        dewPoint: 6,
        humidity: 60,
        windKmh: 8,
        windDirection: 180,
        visibility: 30000,
        precipitationProbability: 0,
        precipitation: 0,
        wind500Kmh: 30,
      })),
    },
    place,
    { ...DEFAULT_PREFERENCES, equipment: 'telescope' },
    now,
    '2026-09-18',
  );
}
