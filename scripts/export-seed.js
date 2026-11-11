'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { serializeSeed } = require('../src/seed');

const file = path.join(__dirname, '..', 'data', 'seed.json');
const text = serializeSeed();
if (process.argv.includes('--check')) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current !== text) {
    console.error('data/seed.json is out of date. Run: npm run seed:export');
    process.exit(1);
  }
  console.log('data/seed.json matches the seed code.');
} else {
  fs.writeFileSync(file, text);
  console.log(`Wrote ${file} (${text.length} bytes)`);
}
