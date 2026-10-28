/** Verify production chunk sizes and the features loaded before user intent. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const dist = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/dist');
const JS_FILE = /\.[cm]?js$/u;
const CHUNK_LIMIT_BYTES = 500_000;
const ENTRY_FEATURES = /\/node_modules\/(?:react-markdown|remark-gfm|three|flexlayout-react)\//u;
const EDITOR_FEATURES = /\/node_modules\/(?:react-markdown|remark-gfm|three)\/|\/ProjectAgentPanel\.tsx$/u;
const EDITOR_SOURCE = '/src/pages/editing/editor/ProjectWorkspacePage.tsx';

function checkBundle() {
  const manifestPath = path.join(dist, '.vite/manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Missing production manifest; build the web app with build.manifest enabled first.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const failures = [];
  const chunks = new Map();
  for (const file of fs.readdirSync(dist, { recursive: true }).filter((file) => JS_FILE.test(file))) {
    const relative = file.replaceAll('\\', '/');
    const bytes = fs.statSync(path.join(dist, file)).size;
    const mapPath = path.join(dist, `${file}.map`);
    // Generated runtime and re-export facades have no original sources or map.
    const sources = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')).sources : [];
    chunks.set(relative, { bytes, sources: sources.map((source) => source.replaceAll('\\', '/')) });
    if (bytes > CHUNK_LIMIT_BYTES) failures.push(`${relative}: ${bytes} bytes exceeds ${CHUNK_LIMIT_BYTES}.`);
  }

  const visited = new Set();
  const active = [];
  function checkImports(key) {
    const cycleStart = active.indexOf(key);
    if (cycleStart !== -1) {
      const cycle = [...active.slice(cycleStart), key].map((item) => manifest[item].file);
      failures.push(`Static chunk import cycle: ${cycle.join(' -> ')}`);
      return;
    }
    if (visited.has(key)) return;
    if (manifest[key] === undefined) throw new Error(`Missing manifest import: ${key}`);
    active.push(key);
    for (const dependency of manifest[key].imports ?? []) checkImports(dependency);
    active.pop();
    visited.add(key);
  }
  for (const key of Object.keys(manifest)) checkImports(key);

  function staticFiles(root) {
    const keys = new Set();
    const files = new Set();
    function collect(key) {
      if (keys.has(key)) return;
      keys.add(key);
      const chunk = manifest[key];
      if (JS_FILE.test(chunk.file)) files.add(chunk.file);
      // Dynamic imports are intentionally excluded: these are loaded on demand.
      for (const dependency of chunk.imports ?? []) collect(dependency);
    }
    collect(root);
    return files;
  }

  function checkSurface(label, root, forbidden) {
    const files = staticFiles(root);
    let bytes = 0;
    for (const file of files) {
      const chunk = chunks.get(file);
      if (chunk === undefined) throw new Error(`Missing JavaScript output: ${file}`);
      bytes += chunk.bytes;
      for (const source of chunk.sources.filter((source) => forbidden.test(source))) {
        failures.push(`${label} eagerly loads ${source} through ${file}.`);
      }
    }
    console.log(`${label} static JavaScript: ${bytes} bytes in ${files.size} chunks.`);
  }

  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry && JS_FILE.test(chunk.file));
  if (entries.length === 0) throw new Error('No JavaScript entry found in the production manifest.');
  for (const [key] of entries) checkSurface(`Entry ${key}`, key, ENTRY_FEATURES);
  const editor = Object.entries(manifest).find(([, chunk]) =>
    chunks.get(chunk.file)?.sources.some((source) => source.endsWith(EDITOR_SOURCE)));
  if (editor === undefined) throw new Error('ProjectWorkspacePage is missing from production source maps.');
  checkSurface('ProjectWorkspacePage', editor[0], EDITOR_FEATURES);

  if (failures.length > 0) {
    console.error(`Bundle check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`Bundle check passed: ${chunks.size} JavaScript chunks, each at most ${CHUNK_LIMIT_BYTES} bytes; no static import cycles.`);
  }
}

try {
  checkBundle();
} catch (error) {
  console.error(`Bundle check failed: ${error.message}`);
  process.exitCode = 1;
}
