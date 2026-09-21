import { Store } from './store';
import { Place, WeatherSnapshot, normalizeWeather, weatherUrl } from './shared/engine';
export function weatherLoader(store: Store) {
  return async (place: Place, now: number): Promise<WeatherSnapshot> => {
    const id = place.latitude.toFixed(5) + ',' + place.longitude.toFixed(5);
    const cached = await store.get<{ id: string; snapshot: WeatherSnapshot; expires: number }>(
      'weather',
      id,
    );
    if (cached && now - cached.value.snapshot.fetchedAt < 45 * 60000) return cached.value.snapshot;
    const response = await fetch(weatherUrl(place.latitude, place.longitude), {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Weather provider unavailable');
    const snapshot = normalizeWeather(await response.json(), now);
    const value = { id, snapshot, expires: now + 86400000 };
    if (cached) await store.replace('weather', value, cached.etag);
    else await store.create('weather', value);
    return snapshot;
  };
}
