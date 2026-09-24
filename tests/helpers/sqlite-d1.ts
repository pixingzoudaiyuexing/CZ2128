import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class SqliteD1Statement {
  private params: Array<string | number | bigint | Uint8Array | null> = [];

  constructor(private readonly owner: SqliteD1, private readonly query: string) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.params = values as Array<string | number | bigint | Uint8Array | null>;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.owner.database.prepare(this.query).get(...this.params) as T | undefined) || null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: object }> {
    return {
      results: this.owner.database.prepare(this.query).all(...this.params) as T[],
      success: true,
      meta: {}
    };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number } } {
    const result = this.owner.database.prepare(this.query).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1 {
  readonly database = new DatabaseSync(':memory:');

  constructor() {
    this.database.exec('PRAGMA foreign_keys = ON');
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runSync());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  migrate(): void {
    for (const migration of [
      '0001_initial_schema.sql',
      '0002_ai_handoff.sql',
      '0003_attachments.sql',
      '0004_runtime_config.sql',
      '0005_reliability.sql',
      '0006_crisp_attachment_provider.sql',
      '0007_crisp_upload_invites.sql',
      '0008_crisp_legacy_ux.sql'
    ]) {
      this.exec(readFileSync(`migrations/${migration}`, 'utf8'));
    }
  }

  close(): void {
    this.database.close();
  }
}
