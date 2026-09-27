import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER = 'REPLACE_WITH_CZ2128_PRODUCTION_D1_UUID';

export async function renderProductionConfig({
  d1Id,
  templatePath = 'wrangler.production.template.jsonc',
  outputPath = 'wrangler.production.jsonc'
}) {
  if (!UUID_PATTERN.test(d1Id || '')) {
    throw new Error('Production D1 ID must be a UUID');
  }
  const source = await readFile(resolve(templatePath), 'utf8');
  const occurrences = source.split(PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error('Production template must contain exactly one D1 placeholder');
  }
  const rendered = source.replace(PLACEHOLDER, d1Id);
  await writeFile(resolve(outputPath), rendered, { mode: 0o600 });
  return resolve(outputPath);
}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--d1-id' && argv[i + 1]) options.d1Id = argv[++i];
    else if (arg === '--template' && argv[i + 1]) options.templatePath = argv[++i];
    else if (arg === '--output' && argv[i + 1]) options.outputPath = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  renderProductionConfig(parseArguments(process.argv.slice(2)))
    .then(path => process.stdout.write(`Rendered production config at ${path}\n`))
    .catch(error => {
      process.stderr.write(`Production config render failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
}