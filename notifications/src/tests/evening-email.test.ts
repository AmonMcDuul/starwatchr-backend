import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eveningFixture } from './evening-fixture';
import { renderAdvice } from '../advice-email';
import { renderTransactional } from '../transactional-email';
import { buildEveningTargets, decorateSavedTargets } from '../shared/evening-targets';
import { eveningHours } from '../shared/evening-summary';
import { hourLabel, hourStatus } from '../shared/presentation';
const render = (a: ReturnType<typeof eveningFixture>) =>
  renderAdvice(
    a,
    'https://starwatchr.com/evening#report=fixture',
    'https://worker.example.test/unsubscribe?token=fixture',
    'https://starwatchr.com/alerts',
  );
test('new advice stores the same sorted selection and metadata used by the live planner', () => {
  const a = eveningFixture();
  assert.deepEqual(
    a.targets,
    buildEveningTargets(a).sort((a, b) => a.time - b.time || b.altitude - a.altitude),
  );
  assert(a.targets.length > 5 && a.targets.length <= 12);
  assert(
    a.targets.every(
      (t) => !t.difficulty || ['Very Easy', 'Easy', 'Moderate'].includes(t.difficulty),
    ),
  );
  assert.deepEqual(decorateSavedTargets(JSON.parse(JSON.stringify(a))), a.targets);
  const mail = render(a);
  for (const t of a.targets) {
    assert(mail.text.includes(t.name));
    assert(mail.text.includes(t.tip!));
    assert(mail.text.includes('https://starwatchr.com' + t.url));
  }
  const hours = eveningHours(a);
  for (const hour of hours)
    assert(
      mail.text.includes(hourLabel(hour, hours, a) + ' · ' + hour.sky + ' · ' + hourStatus(hour)),
    );
});
test('saved descriptions stay immutable; missing data and unsafe links stay safe', () => {
  const a = eveningFixture();
  a.targets = [
    {
      ...a.targets[0],
      name: '<script>unsafe</script>',
      tip: 'Original saved tip',
      url: 'javascript:alert(1)',
      difficulty: 'Hard',
    },
  ];
  a.slots = a.slots.map((s) => ({ ...s, temperature: null }));
  const mail = render(a);
  assert(!mail.html.includes('<script>'));
  assert(!mail.html.includes('javascript:'));
  assert(mail.html.includes('&lt;script&gt;'));
  assert(mail.text.includes('Original saved tip'));
  assert(mail.text.includes('Temperature —'));
  assert(mail.text.includes('Hard'));
  assert.deepEqual(decorateSavedTargets(a)[0].name, a.targets[0].name);
});
test('both transactional emails have matching text and HTML actions with escaped links', () => {
  for (const kind of ['confirm', 'manage'] as const) {
    const mail = renderTransactional(kind, 'https://starwatchr.com/alerts#' + kind + '=a&b');
    assert(mail.html.includes('a&amp;b'));
    assert(mail.text.includes('a&b'));
    assert(mail.html.includes('24 hours'));
    assert(mail.text.includes('24 hours'));
  }
});
