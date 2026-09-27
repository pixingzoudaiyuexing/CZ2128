import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderProductionConfig } from '../scripts/release/render-production-config.mjs';
import {
  collectWorkerSecrets,
  REQUIRED_WORKER_SECRET_NAMES
} from '../scripts/release/build-worker-secrets.mjs';
import {
  appliedMigrationNamesFromWranglerJson,
  assertExpandOnlySql,
  checkPendingMigrations
} from '../scripts/release/check-update-migrations.mjs';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cz2128-release-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('release automation helpers', () => {
  it('renders exactly one Production D1 UUID into the reviewed template', async () => {
    const dir = await tempDir();
    const template = join(dir, 'template.jsonc');
    const output = join(dir, 'production.jsonc');
    await writeFile(template, '{"database_id":"REPLACE_WITH_CZ2128_PRODUCTION_D1_UUID"}');
    await renderProductionConfig({
      d1Id: '12345678-1234-4123-8123-123456789abc',
      templatePath: template,
      outputPath: output
    });
    expect(await readFile(output, 'utf8')).toContain('12345678-1234-4123-8123-123456789abc');
  });

  it('refuses invalid D1 identity and ambiguous template placeholders', async () => {
    const dir = await tempDir();
    const template = join(dir, 'template.jsonc');
    await writeFile(template, 'REPLACE_WITH_CZ2128_PRODUCTION_D1_UUID REPLACE_WITH_CZ2128_PRODUCTION_D1_UUID');
    await expect(renderProductionConfig({
      d1Id: '12345678-1234-4123-8123-123456789abc',
      templatePath: template,
      outputPath: join(dir, 'out')
    })).rejects.toThrow(/exactly one/);
    await expect(renderProductionConfig({
      d1Id: 'not-a-uuid',
      templatePath: template,
      outputPath: join(dir, 'out')
    })).rejects.toThrow(/UUID/);
  });

  it('requires all GitHub-provided Worker secrets without exposing values', () => {
    const env = Object.fromEntries(REQUIRED_WORKER_SECRET_NAMES.map(name => [name, `value-for-${name}`]));
    expect(Object.keys(collectWorkerSecrets(env))).toEqual([...REQUIRED_WORKER_SECRET_NAMES]);
    delete env.NOTION_API_TOKEN;
    expect(() => collectWorkerSecrets(env)).toThrow(/NOTION_API_TOKEN/);
  });

  it('parses applied migration names from Wrangler JSON', () => {
    const payload = [{ results: [{ name: '0001_initial.sql' }, { name: '0002_more.sql' }] }];
    expect(appliedMigrationNamesFromWranglerJson(payload)).toEqual(['0001_initial.sql', '0002_more.sql']);
  });

  it('permits expand-only SQL and blocks destructive schema changes', () => {
    expect(() => assertExpandOnlySql('CREATE TABLE new_table (id TEXT);', '0011_new.sql')).not.toThrow();
    expect(() => assertExpandOnlySql('-- DROP TABLE ignored\nALTER TABLE x ADD COLUMN y TEXT;', '0011_new.sql')).not.toThrow();
    expect(() => assertExpandOnlySql('DROP TABLE messages;', '0011_bad.sql')).toThrow(/DROP_TABLE/);
    expect(() => assertExpandOnlySql('ALTER TABLE messages RENAME TO messages_old;', '0011_bad.sql'))
      .toThrow(/RENAME_TABLE_OR_COLUMN/);
  });

  it('checks only pending migrations and rejects unknown applied history', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '0001_initial.sql'), 'CREATE TABLE a (id TEXT);');
    await writeFile(join(dir, '0002_expand.sql'), 'ALTER TABLE a ADD COLUMN value TEXT;');
    expect(await checkPendingMigrations({
      appliedNames: ['0001_initial.sql'],
      migrationsDir: dir
    })).toEqual(['0002_expand.sql']);

    await expect(checkPendingMigrations({
      appliedNames: ['9999_unknown.sql'],
      migrationsDir: dir
    })).rejects.toThrow(/not present/);
  });
});