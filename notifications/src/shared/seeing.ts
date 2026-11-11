/** Pressure surfaces, ordered from lower to upper atmosphere. */
export const SEEING_LEVELS = [500, 300, 250, 200] as const;

export interface SeeingLevel {
  pressureHpa: number;
  windKmh: number | null;
  windDirection: number | null;
  temperatureC: number | null;
  heightM: number | null;
}

interface SeeingWeather {
  windKmh: number | null;
  wind500Kmh: number | null;
  // Optional for backwards compatibility with stored weather/report snapshots.
  upperAir?: SeeingLevel[];
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
const valid = (value: number | null | undefined, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/**
 * Conservative ordinal seeing estimate, not an arcsecond/Cn² prediction.
 * Uses jet speed, vector wind shear and thermal stability (gradient Richardson
 * number), plus surface/mid-level wind. The 1–8 scale remains unchanged.
 * See docs/seeing-calculation.md for units, coefficients and limitations.
 */
export function seeingIndex(weather: SeeingWeather): number | null {
  if (!valid(weather.windKmh, 0, 400) || !valid(weather.wind500Kmh, 0, 600)) return null;
  const layers = SEEING_LEVELS.map((p) =>
    weather.upperAir?.find((layer) => layer.pressureHpa === p),
  );
  if (
    layers.some(
      (layer) =>
        !layer ||
        !valid(layer.windKmh, 0, 600) ||
        !valid(layer.windDirection, 0, 360) ||
        !valid(layer.temperatureC, -120, 60) ||
        !valid(layer.heightM, -500, 30000),
    )
  )
    return null;

  const profile = layers.map((layer) => {
    const l = layer!;
    const angle = (l.windDirection! * Math.PI) / 180;
    const speed = l.windKmh! / 3.6; // km/h -> m/s
    return {
      height: l.heightM!,
      speedKmh: l.windKmh!,
      u: -speed * Math.sin(angle),
      v: -speed * Math.cos(angle),
      theta: (l.temperatureC! + 273.15) * (1000 / l.pressureHpa) ** 0.286,
    };
  });
  let maxShear = 0,
    instability = 0;
  for (let i = 1; i < profile.length; i++) {
    const lower = profile[i - 1],
      upper = profile[i];
    const dz = upper.height - lower.height;
    // A malformed/reversed profile must not yield an excellent score.
    if (dz < 100) return null;
    const shear = Math.hypot(upper.u - lower.u, upper.v - lower.v) / dz; // s^-1
    maxShear = Math.max(maxShear, shear * 1000); // (m/s)/km
    const buoyancy =
      ((9.80665 / ((lower.theta + upper.theta) / 2)) * (upper.theta - lower.theta)) / dz; // N², s^-2
    const ri = shear > 1e-8 ? buoyancy / (shear * shear) : Infinity;
    // Ri < 0.25 permits shear instability; negative N² is convectively unstable
    // even if the winds happen to have identical speed and direction.
    instability = Math.max(instability, buoyancy < 0 ? 1 : clamp(1 - ri / 0.25, 1));
  }
  const jetKmh = Math.max(...profile.slice(1).map((layer) => layer.speedKmh));
  const surfacePenalty = clamp((weather.windKmh - 5) / 10, 2);
  const midPenalty = clamp(weather.wind500Kmh / 100, 1);
  const jetPenalty = clamp((jetKmh - 20) / 35, 3.5);
  const shearPenalty = clamp((maxShear - 4) / 5, 2.5);
  return Math.max(
    1,
    Math.min(
      8,
      Math.round(8 - surfacePenalty - midPenalty - jetPenalty - shearPenalty - 1.5 * instability),
    ),
  );
}
