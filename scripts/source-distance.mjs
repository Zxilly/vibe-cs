import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

const supportedExtensions = new Set([
  '.css', '.html', '.js', '.jsx', '.json', '.md', '.py', '.rs', '.sql',
  '.toml', '.ts', '.tsx', '.yaml', '.yml',
]);
const ignoredDirectories = new Set([
  '.git', '.venv', '__pycache__', 'asset', 'build', 'data', 'dist',
  'node_modules', 'packaging', 'target', 'vendor', 'venv',
]);
const ignoredFiles = new Set(['Cargo.lock', 'package-lock.json', 'pnpm-lock.yaml', 'uv.lock']);
const maximumFileBytes = 2_000_000;
const tokenWindow = 12;
const lineWindow = 5;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sourceRoot = resolve(argument('--source', '.'));
const referenceArgument = argument('--reference');
if (!referenceArgument) {
  console.error('Usage: node scripts/source-distance.mjs --reference <directory> [--source <directory>]');
  process.exit(2);
}
const referenceRoot = resolve(referenceArgument);

async function collectFiles(root) {
  const collected = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) return;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        return;
      }
      if (!entry.isFile() || ignoredFiles.has(entry.name) || !supportedExtensions.has(extname(entry.name).toLowerCase())) return;
      const metadata = await stat(path);
      if (metadata.size > maximumFileBytes) return;
      collected.push({
        path: relative(root, path).split(sep).join('/'),
        text: await readFile(path, 'utf8'),
      });
    }));
  }
  await visit(root);
  return collected;
}

function normalizedLines(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter((line) => line.length >= 24 && !/^(?:#|\/\/|\/\*|\*)/u.test(line));
}

function tokens(text) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/.*$/gmu, ' ')
    .replace(/#.*$/gmu, ' ');
  return withoutComments.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\s]/gu) ?? [];
}

function windows(values, size) {
  const result = new Set();
  for (let index = 0; index + size <= values.length; index += 1) {
    result.add(values.slice(index, index + size).join('\n'));
  }
  return result;
}

function routeSet(files) {
  const routes = new Set();
  const routePattern = /["'](\/api\/[^"']+)["']/gu;
  for (const file of files) {
    for (const match of file.text.matchAll(routePattern)) {
      routes.add(match[1]
        .replace(/\{(?:asset|backup|clip|demo|export|job|plan|preset|project|snapshot)_id\}/gu, '{id}')
        .replace(/\/$/u, ''));
    }
  }
  return routes;
}

function cjkPhrases(files) {
  const phrases = new Set();
  const phrasePattern = /[\u3400-\u9fff][\u3400-\u9fffA-Za-z0-9，。！？：；、“”‘’（）【】《》·—… /-]{3,119}/gu;
  for (const file of files) {
    for (const match of file.text.matchAll(phrasePattern)) {
      const phrase = match[0].trim().replace(/\s+/gu, ' ');
      if (phrase.length >= 4) phrases.add(phrase);
    }
  }
  return phrases;
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function percentage(numerator, denominator) {
  return Number(((numerator / Math.max(1, denominator)) * 100).toFixed(4));
}

const [sourceFiles, referenceFiles] = await Promise.all([
  collectFiles(sourceRoot),
  collectFiles(referenceRoot),
]);

const referenceHashes = new Map();
const referenceLineWindows = new Set();
const referenceTokenWindows = new Set();
for (const file of referenceFiles) {
  const hash = createHash('sha256').update(file.text).digest('hex');
  const matches = referenceHashes.get(hash) ?? [];
  matches.push(file.path);
  referenceHashes.set(hash, matches);
  for (const value of windows(normalizedLines(file.text), lineWindow)) referenceLineWindows.add(value);
  for (const value of windows(tokens(file.text), tokenWindow)) referenceTokenWindows.add(value);
}

let sourceLineWindowCount = 0;
let sharedLineWindowCount = 0;
let sourceTokenWindowCount = 0;
let sharedTokenWindowCount = 0;
const exactDuplicates = [];
for (const file of sourceFiles) {
  const hash = createHash('sha256').update(file.text).digest('hex');
  if (referenceHashes.has(hash)) {
    exactDuplicates.push({ source: file.path, reference: referenceHashes.get(hash) });
  }
  const lineWindows = windows(normalizedLines(file.text), lineWindow);
  sourceLineWindowCount += lineWindows.size;
  sharedLineWindowCount += intersection(lineWindows, referenceLineWindows).size;
  const tokenWindows = windows(tokens(file.text), tokenWindow);
  sourceTokenWindowCount += tokenWindows.size;
  sharedTokenWindowCount += intersection(tokenWindows, referenceTokenWindows).size;
}

const sourceNames = new Set(sourceFiles.map((file) => basename(file.path).toLowerCase()));
const referenceNames = new Set(referenceFiles.map((file) => basename(file.path).toLowerCase()));
const sharedNames = [...intersection(sourceNames, referenceNames)].sort();
const sourcePaths = new Set(sourceFiles.map((file) => file.path.toLowerCase()));
const referencePaths = new Set(referenceFiles.map((file) => file.path.toLowerCase()));
const sharedPaths = [...intersection(sourcePaths, referencePaths)].sort();
const sourceRoutes = routeSet(sourceFiles);
const referenceRoutes = routeSet(referenceFiles);
const sharedRoutes = [...intersection(sourceRoutes, referenceRoutes)].sort();
const sourcePhrases = cjkPhrases(sourceFiles);
const referencePhrases = cjkPhrases(referenceFiles);
const sharedPhrases = [...intersection(sourcePhrases, referencePhrases)].sort();

console.log(JSON.stringify({
  scope: {
    source: sourceRoot,
    reference: referenceRoot,
    source_files: sourceFiles.length,
    reference_files: referenceFiles.length,
    excludes: [...ignoredDirectories].sort(),
  },
  exact_duplicate_files: exactDuplicates,
  basename_overlap: {
    count: sharedNames.length,
    source_percentage: percentage(sharedNames.length, sourceNames.size),
    names: sharedNames,
  },
  relative_path_overlap: {
    count: sharedPaths.length,
    source_percentage: percentage(sharedPaths.length, sourcePaths.size),
    paths: sharedPaths,
  },
  five_line_window_overlap: {
    shared: sharedLineWindowCount,
    source_total: sourceLineWindowCount,
    source_percentage: percentage(sharedLineWindowCount, sourceLineWindowCount),
  },
  twelve_token_window_overlap: {
    shared: sharedTokenWindowCount,
    source_total: sourceTokenWindowCount,
    source_percentage: percentage(sharedTokenWindowCount, sourceTokenWindowCount),
  },
  api_route_overlap: {
    shared: sharedRoutes.length,
    source_total: sourceRoutes.size,
    source_percentage: percentage(sharedRoutes.length, sourceRoutes.size),
    routes: sharedRoutes,
  },
  cjk_phrase_overlap: {
    shared: sharedPhrases.length,
    source_total: sourcePhrases.size,
    source_percentage: percentage(sharedPhrases.length, sourcePhrases.size),
    phrases: sharedPhrases,
  },
}, null, 2));
