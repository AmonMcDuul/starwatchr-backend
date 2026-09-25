export * from './core';
import { buildConditions } from './core';
import { buildEveningTargets } from './evening-targets';
export function buildAdvice(...args: Parameters<typeof buildConditions>) {
  const advice = buildConditions(...args);
  advice.targets = advice.best
    ? buildEveningTargets(advice).sort((a, b) => a.time - b.time || b.altitude - a.altitude)
    : [];
  return advice;
}
