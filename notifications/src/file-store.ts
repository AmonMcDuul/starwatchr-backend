import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore, RecordValue, Stored } from './store';

// Single-process development storage. Production uses Azure Tables and ETags.
export class FileStore extends MemoryStore {
  constructor(private readonly file: string) {
    super();
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        version: number;
        rows: [string, Stored<unknown>][];
      };
      this.version = saved.version;
      this.rows = new Map(saved.rows);
    }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(
      this.file + '.tmp',
      JSON.stringify({
        version: this.version,
        rows: [...this.rows],
      }),
      { mode: 0o600 },
    );
    renameSync(this.file + '.tmp', this.file);
  }

  override async create<T extends RecordValue>(kind: string, value: T) {
    const changed = await super.create(kind, value);
    if (changed) this.persist();
    return changed;
  }

  override async replace<T extends RecordValue>(kind: string, value: T, etag: string) {
    const changed = await super.replace(kind, value, etag);
    if (changed) this.persist();
    return changed;
  }

  override async remove(kind: string, id: string, etag: string) {
    await super.remove(kind, id, etag);
    this.persist();
  }
}
