import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src');
const catalogPath = path.join(root, 'shared/i18n/literals.ts');
const han = /\p{Script=Han}/u;
const messageCall = /\bmsgf?\("(m\d{4})"/gu;
const productionFiles = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (target !== path.join(root, 'shared/i18n')) walk(target);
      continue;
    }
    if (/\.(ts|tsx)$/u.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/u.test(entry.name)) {
      productionFiles.push(target);
    }
  }
}

walk(root);
const failures = [];
const usedIds = new Set();
for (const file of productionFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (han.test(source)) failures.push(`${path.relative(root, file)} contains a Han literal`);
  for (const match of source.matchAll(messageCall)) usedIds.add(match[1]);
}

const catalogSource = fs.readFileSync(catalogPath, 'utf8');
const semanticSource = fs.readFileSync(path.join(root, 'shared/i18n/index.ts'), 'utf8');
const semanticEn = semanticSource.match(/const enUS: Catalog = \{([\s\S]*?)\n\};\n\nconst catalogs/u)?.[1] ?? '';
const zhMatch = catalogSource.match(/export const literalZhCN = ([\s\S]*?) as const;/u);
const enMatch = catalogSource.match(/export const literalEnUS:[^=]+ = ([\s\S]*?);\s*$/u);
if (!zhMatch || !enMatch) {
  failures.push('typed literal catalog has an unexpected shape');
} else {
  const zh = JSON.parse(zhMatch[1]);
  const en = JSON.parse(enMatch[1]);
  const zhIds = Object.keys(zh);
  const enIds = Object.keys(en);
  if (JSON.stringify(zhIds) !== JSON.stringify(enIds)) failures.push('locale catalogs do not have identical ordered IDs');
  for (const id of usedIds) if (!(id in zh)) failures.push(`production source uses missing message ID ${id}`);
  for (const [id, value] of Object.entries(en)) {
    if (!value.trim()) failures.push(`${id} has an empty en-US value`);
    if (han.test(value)) failures.push(`${id} leaves Han text in en-US`);
  }

  const terminology = [
    [/\bplayback\b/iu, 'use replay, not playback'],
    [/\b(?:accessory|accessories|jewelry|trinkets?)\b/iu, 'use cosmetic'],
    [/\b(?:unpacking|demolition)\b/iu, 'use defuse'],
    [/\bpre-check(?:ed)?\b/iu, 'use preflight'],
    [/\bdemos?\b/u, 'capitalize the Demo product term'],
  ];
  for (const [pattern, guidance] of terminology) {
    for (const [id, value] of Object.entries(en)) {
      if (pattern.test(value)) failures.push(`${id}: ${guidance}`);
    }
    if (pattern.test(semanticEn)) failures.push(`semantic en-US catalog: ${guidance}`);
  }
  if (han.test(semanticEn)) failures.push('semantic en-US catalog leaves Han text');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`i18n check passed: ${productionFiles.length} production modules, ${usedIds.size} referenced typed messages`);
}
