import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTableJson, decodeTableJson } from '../table-json';

const forecast = {
  id: 'synthetic-weather',
  snapshot: {
    fetchedAt: Date.parse('2026-09-21T18:00:00Z'),
    timeZone: 'Europe/Amsterdam',
    latitude: 52.37,
    longitude: 4.89,
    hours: Array.from({ length: 168 }, (_, i) => ({
      time: Date.parse('2026-09-21T00:00:00Z') + i * 3_600_000,
      cloud: 10,
      low: 10,
      mid: 10,
      high: 10,
      temperature: 10,
      dewPoint: 10,
      humidity: 10,
      windKmh: 10,
      windDirection: 10,
      visibility: 10000,
      precipitationProbability: 10,
      precipitation: 0,
      wind500Kmh: 10,
    })),
  },
};

test('a full seven-day forecast round-trips without exceeding Azure property limits', () => {
  assert(Buffer.byteLength(JSON.stringify(forecast), 'utf16le') > 65_536);
  const entity = encodeTableJson(forecast);
  assert(entity.jsonChunks! > 1);
  for (const value of Object.values(entity)) {
    if (typeof value === 'string') assert(Buffer.byteLength(value, 'utf16le') <= 65_536);
  }
  assert.deepEqual(decodeTableJson(entity), forecast);
});

test('existing unchunked records remain readable and small records keep their format', () => {
  const value = { id: 'existing', state: 'active' };
  assert.deepEqual(decodeTableJson({ json: JSON.stringify(value) }), value);
  assert.deepEqual(encodeTableJson(value), { json: JSON.stringify(value) });
});

test('Unicode survives Azure UTF-8 transport at a chunk boundary', () => {
  const prefix = '{"text":"';
  const value = { text: 'x'.repeat(29_999 - prefix.length) + '🌙'.repeat(20_000) };
  const entity = encodeTableJson(value);
  for (const [key, text] of Object.entries(entity)) {
    if (typeof text === 'string') entity[key] = Buffer.from(text, 'utf8').toString('utf8');
  }
  assert.deepEqual(decodeTableJson(entity), value);
});

test('incomplete records and invalid chunk counts fail instead of returning partial data', () => {
  assert.throws(() => decodeTableJson({ json: '{}', jsonChunks: 2 }), /Missing/);
  for (const count of [0, -1, 1.5, 17]) {
    assert.throws(() => decodeTableJson({ json: '{}', jsonChunks: count }), /chunk count/);
  }
});

test('oversized entities are rejected before a storage request', () => {
  assert.throws(() => encodeTableJson({ text: 'x'.repeat(450_000) }), /entity size/);
});
