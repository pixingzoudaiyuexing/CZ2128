import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DESTRUCTIVE_PATTERNS = Object.freeze([
  { code: 'DROP_TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { code: 'DROP_COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { code: 'RENAME_TABLE_OR_COLUMN', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i },
  { code: 'TRUNCATE', pattern: /\bTRUNCATE\b/i },
  { code: 'WRITABLE_SCHEMA', pattern: /\bPRAGMA\s+writable_schema\b/i },
  { code: 'ATTACH_DATABASE', pattern: /\b(?:ATTACH|DETACH)\s+(?:DATABASE\s+)?/i },
  { code: 'VACUUM_INTO', pattern: /\bVACUUM\s+INTO\b/i }
]);

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

export function assertExpandOnlySql(sql, filename = 'migration.sql') {
  const normalized = stripSqlComments(sql);
  const finding = DESTRUCTIVE_PATTERNS.find(item => item.pattern.test(normalized));
  if (finding) {
    throw new Error(`${filename} is not eligible for one-click update: ${finding.code}`);
  }
}

export function appliedMigrationNamesFromWranglerJson(payload) {
  const rows = [];
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.results)) {
      for (const row of value.results) {
        if (row && typeof row.name === 'string') rows.push(row.name);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);
  return Array.from(new Set(rows));
}

export async function checkPendingMigrations({
  appliedNames,
  migrationsDir = 'migrations'
}) {
  const dir = resolve(migrationsDir);
  const localNames = (await readdir(dir))
    .filter(name => /^\d+_.+\.sql$/.test(name))
    .sort();
  const applied = new Set(appliedNames);
  const unknownApplied = [...applied].filter(name => !localNames.includes(name));
  if (unknownApplied.length > 0) {
    throw new Error(`Production D1 contains migration not present in this release: ${unknownApplied[0]}`);
  }
  const pending = localNames.filter(name => !applied.has(name));
  for (const name of pending) {
    assertExpandOnlySql(await readFile(resolve(dir, name), 'utf8'), name);
  }
  return pending;
}

function parseArguments(argv) {
  const options = { migrationsDir: 'migrations' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--applied-json' && argv[i + 1]) options.appliedJson = argv[++i];
    else if (arg === '--migrations-dir' && argv[i + 1]) options.migrationsDir = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!options.appliedJson) throw new Error('--applied-json is required');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const payload = JSON.parse(await readFile(resolve(options.appliedJson), 'utf8'));
  const appliedNames = appliedMigrationNamesFromWranglerJson(payload);
  const pending = await checkPendingMigrations({
    appliedNames,
    migrationsDir: options.migrationsDir
  });
  process.stdout.write(
    pending.length === 0
      ? 'No pending Production migrations\n'
      : `Expand-only pending migrations: ${pending.join(', ')}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => {
    process.stderr.write(`Production update migration check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}