const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const dir = path.resolve(__dirname, process.argv[2] || '../src/shared');
const source = fs.readFileSync(path.join(dir, 'engine.ts'));
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (fs.readFileSync(path.join(dir, 'engine.sha256'), 'utf8').trim() !== hash)
  throw new Error(
    'Engine changed without synchronization. Run the frontend sync-notification-engine script.',
  );
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
if (pkg.dependencies['astronomy-engine'] !== '2.1.19')
  throw new Error('Keep Astronomy Engine pinned in both repositories.');
console.log('Observing engine verified: ' + hash);
