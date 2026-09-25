// Synthetic previews only. Never calls a mail or push provider.
const fs = require('node:fs'),
  path = require('node:path');
const { eveningFixture } = require('../dist/tests/evening-fixture');
const { renderAdvice } = require('../dist/advice-email');
const { renderTransactional } = require('../dist/transactional-email');
const output = path.resolve(__dirname, '../previews');
fs.mkdirSync(output, { recursive: true });
const advice = eveningFixture();
const messages = {
  evening: renderAdvice(
    advice,
    'https://starwatchr.com/evening#report=example',
    'https://example.test/unsubscribe',
    'https://starwatchr.com/alerts',
  ),
  confirm: renderTransactional('confirm', 'https://starwatchr.com/alerts#confirm=example'),
  manage: renderTransactional('manage', 'https://starwatchr.com/alerts#manage=example'),
};
for (const [name, message] of Object.entries(messages))
  for (const ext of ['html', 'text'])
    fs.writeFileSync(path.join(output, name + '.' + (ext === 'text' ? 'txt' : ext)), message[ext]);
fs.writeFileSync(path.join(output, 'advice.json'), JSON.stringify(advice));
console.log(output);
