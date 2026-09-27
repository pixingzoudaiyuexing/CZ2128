import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SqliteD1 } from './helpers/sqlite-d1';

describe('0010 human learning migration', () => {
  it('applies cleanly after 0001-0009 without destructive changes', () => {
    const db = new SqliteD1();
    try {
      db.migrateThroughHumanLearning();
      const tables = db.database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'learning_%' ORDER BY name"
      ).all();
      expect(tables).toEqual([
        { name: 'learning_candidate_history' },
        { name: 'learning_candidates' }
      ]);
    } finally {
      db.close();
    }
  });

  it('preserves existing knowledge rows and FTS search across the 0009 -> 0010 upgrade', () => {
    const db = new SqliteD1();
    try {
      db.migrateThroughKnowledge();
      db.exec(`
        INSERT INTO knowledge_entries
        (id, title, body, search_terms, enabled, version, created_by, updated_by, created_at, updated_at)
        VALUES ('kb_existing', 'Refund policy', 'Three business days', 'refund policy', 1, 1, 'u', 'u', 1, 1);
      `);
      db.exec(readFileSync('migrations/0010_human_learning.sql', 'utf8'));
      expect(db.database.prepare("SELECT id, version FROM knowledge_entries WHERE id='kb_existing'").get())
        .toEqual({ id: 'kb_existing', version: 1 });
      const fts = db.database.prepare(
        `SELECT k.id FROM knowledge_entries_fts
          JOIN knowledge_entries k ON k.rowid = knowledge_entries_fts.rowid
         WHERE knowledge_entries_fts MATCH 'refund'`
      ).all();
      expect(fts).toEqual([{ id: 'kb_existing' }]);
    } finally {
      db.close();
    }
  });
});
