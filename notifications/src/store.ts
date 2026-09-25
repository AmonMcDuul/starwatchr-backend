import { TableClient } from '@azure/data-tables';
import { TableJson, encodeTableJson, decodeTableJson } from './table-json';
export interface RecordValue {
  id: string;
  expires?: number;
}
export interface Stored<T> {
  value: T;
  etag: string;
}
export interface Store {
  get<T>(kind: string, id: string): Promise<Stored<T> | null>;
  create<T extends RecordValue>(kind: string, value: T): Promise<boolean>;
  replace<T extends RecordValue>(kind: string, value: T, etag: string): Promise<boolean>;
  list<T>(kind: string): AsyncIterable<Stored<T>>;
  remove(kind: string, id: string, etag: string): Promise<void>;
}
export class AzureStore implements Store {
  private client: TableClient;
  constructor(connection: string) {
    this.client = TableClient.fromConnectionString(connection, 'StarWatchrNotifications');
  }
  async initialize() {
    await this.client.createTable();
  }
  async get<T>(kind: string, id: string): Promise<Stored<T> | null> {
    try {
      const e = await this.client.getEntity<TableJson>(kind, id);
      return { value: decodeTableJson<T>(e), etag: e.etag! };
    } catch (e: any) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }
  async create<T extends RecordValue>(kind: string, value: T) {
    try {
      await this.client.createEntity({
        partitionKey: kind,
        rowKey: value.id,
        ...encodeTableJson(value),
      });
      return true;
    } catch (e: any) {
      if (e.statusCode === 409) return false;
      throw e;
    }
  }
  async replace<T extends RecordValue>(kind: string, value: T, etag: string) {
    try {
      await this.client.updateEntity(
        { partitionKey: kind, rowKey: value.id, ...encodeTableJson(value) },
        'Replace',
        { etag },
      );
      return true;
    } catch (e: any) {
      if (e.statusCode === 412 || e.statusCode === 404) return false;
      throw e;
    }
  }
  async *list<T>(kind: string) {
    for await (const e of this.client.listEntities<TableJson>({
      queryOptions: { filter: "PartitionKey eq '" + kind + "'" },
    }))
      yield { value: decodeTableJson<T>(e), etag: e.etag! };
  }
  async remove(kind: string, id: string, etag: string) {
    await this.client.deleteEntity(kind, id, { etag });
  }
}
export class MemoryStore implements Store {
  protected rows = new Map<string, Stored<any>>();
  protected version = 0;
  async get<T>(kind: string, id: string): Promise<Stored<T> | null> {
    return structuredClone(this.rows.get(kind + ':' + id) ?? null);
  }
  async create<T extends RecordValue>(kind: string, value: T) {
    const key = kind + ':' + value.id;
    if (this.rows.has(key)) return false;
    this.rows.set(key, { value: structuredClone(value), etag: String(++this.version) });
    return true;
  }
  async replace<T extends RecordValue>(kind: string, value: T, etag: string) {
    const key = kind + ':' + value.id;
    if (this.rows.get(key)?.etag !== etag) return false;
    this.rows.set(key, { value: structuredClone(value), etag: String(++this.version) });
    return true;
  }
  async *list<T>(kind: string) {
    for (const [key, row] of [...this.rows])
      if (key.startsWith(kind + ':')) yield structuredClone(row) as Stored<T>;
  }
  async remove(kind: string, id: string, etag: string) {
    if (this.rows.get(kind + ':' + id)?.etag === etag) this.rows.delete(kind + ':' + id);
  }
}
