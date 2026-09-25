// Azure Table string properties are limited to 64 KiB of UTF-16 text.
// Keep all chunks in one entity so conditional writes remain atomic.
const CHUNK_CHARACTERS = 30_000;
const MAX_JSON_CHARACTERS = 450_000;
const MAX_CHUNKS = 16;

export interface TableJson {
  json: string;
  jsonChunks?: number;
  [property: string]: unknown;
}

export function encodeTableJson(value: unknown): TableJson {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || json.length > MAX_JSON_CHARACTERS) {
    throw new Error('Record exceeds the supported Azure Table entity size');
  }
  if (json.length <= CHUNK_CHARACTERS) return { json };

  const chunks: string[] = [];
  for (let start = 0; start < json.length; ) {
    let end = Math.min(start + CHUNK_CHARACTERS, json.length);
    const last = json.charCodeAt(end - 1);
    // A surrogate pair must remain in the same property when sent as UTF-8.
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(json.slice(start, end));
    start = end;
  }

  const fields: TableJson = { json: chunks[0], jsonChunks: chunks.length };
  for (let i = 1; i < chunks.length; i++) fields['json' + i] = chunks[i];
  return fields;
}

export function decodeTableJson<T>(entity: TableJson): T {
  const count = entity.jsonChunks ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) {
    throw new Error('Invalid Azure Table JSON chunk count');
  }
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = entity[i === 0 ? 'json' : 'json' + i];
    if (typeof chunk !== 'string') throw new Error('Missing Azure Table JSON chunk');
    chunks.push(chunk);
  }
  return JSON.parse(chunks.join('')) as T;
}
