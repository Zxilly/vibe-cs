import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(root, 'apps', 'agent');
const binaryDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'binaries');
const targetTriple = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).stdout.trim();
if (!targetTriple) throw new Error('unable to resolve Rust host tuple for the agent sidecar');
if (process.platform !== 'win32') {
  throw new Error('the current sidecar packager supports Windows; add a platform-specific SEA signing step before cross-platform release');
}

await mkdir(binaryDir, { recursive: true });
const blob = path.join(agentDir, '.sea-agent.blob');
const config = path.join(agentDir, '.sea-config.json');
const executable = path.join(binaryDir, `vibe-cs-agent-${targetTriple}.exe`);
await writeFile(config, JSON.stringify({
  main: path.join(agentDir, 'dist', 'index.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}));

const sea = spawnSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
if (sea.status !== 0) throw new Error('Node SEA blob generation failed');
await copyFile(process.execPath, executable);
const inject = spawnSync(
  process.execPath,
  [
    path.join(agentDir, 'node_modules', 'postject', 'dist', 'cli.js'),
    executable, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { cwd: agentDir, stdio: 'inherit' },
);
await rm(config, { force: true });
await rm(blob, { force: true });
if (inject.status !== 0) {
  await rm(executable, { force: true });
  throw new Error('Node SEA injection failed');
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(executable)) hash.update(chunk);
const digest = hash.digest('hex');
await writeFile(`${executable}.sha256`, `${digest}\n`, { encoding: 'ascii' });
process.stdout.write(`Agent sidecar ready: ${executable}\n`);
