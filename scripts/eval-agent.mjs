import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    cdp: { type: 'string', default: '9341' },
    project: { type: 'string' },
    timeout: { type: 'string', default: '125000' },
    out: { type: 'string' },
    case: { type: 'string', multiple: true },
  },
});

if (values.project === undefined) {
  throw new Error('Usage: pnpm agent:eval -- --project <uuid> [--cdp 9341] [--out report.json]');
}
if (!/^\d+$/.test(values.cdp) || !/^\d+$/.test(values.timeout)) {
  throw new Error('--cdp and --timeout must be positive integers');
}

const projectId = values.project;
const cdpPort = values.cdp;
const caseTimeoutMs = Number(values.timeout);
const projectUrl = `http://localhost:5173/#/projects/${encodeURIComponent(projectId)}`;
const browserSession = `vibe-cs-agent-eval-${process.pid}`;
const browserLauncher = resolveBrowserLauncher();
const selectedCases = new Set(values.case ?? []);
const reports = [];

function resolveBrowserLauncher() {
  if (process.platform !== 'win32') return { executable: 'agent-browser', prefix: [] };
  const located = spawnSync('where.exe', ['agent-browser.ps1'], {
    encoding: 'utf8', windowsHide: true,
  });
  const script = located.stdout?.split(/\r?\n/u).find((line) => line.trim() !== '')?.trim();
  if (located.status !== 0 || script === undefined) {
    throw new Error('agent-browser.ps1 is not available on PATH');
  }
  return { executable: 'powershell.exe', prefix: ['-NoProfile', '-File', script] };
}

function browser(args, timeoutMs = 60_000) {
  const result = spawnSync(
    browserLauncher.executable,
    [...browserLauncher.prefix, '--cdp', cdpPort, '--session', browserSession, ...args],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
  );
  if (result.error !== undefined) {
    throw new Error(`agent-browser ${args[0] ?? 'command'} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`agent-browser ${args[0] ?? 'command'}: ${(
      result.stderr || result.stdout || `exited ${result.status}`
    ).trim()}`);
  }
  return result.stdout.trim();
}

function openBrowser(url) {
  const result = spawnSync(
    browserLauncher.executable,
    [...browserLauncher.prefix, '--cdp', cdpPort, '--session', browserSession, 'open', url],
    { stdio: 'ignore', timeout: 60_000, windowsHide: true },
  );
  if (result.error !== undefined) throw new Error(`agent-browser open failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`agent-browser open exited ${result.status}`);
}

function browserJson(expression) {
  const encoded = Buffer.from(expression, 'utf8').toString('base64');
  const output = browser(['eval', '-b', encoded]);
  return JSON.parse(output);
}

function desktopCall(method, path, body) {
  const call = { method, path, ...(body === undefined ? {} : { body }) };
  return browserJson(
    `window.__TAURI_INTERNALS__.invoke("desktop_call",{call:${JSON.stringify(call)}})`,
  );
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll(read, predicate, timeoutMs, label) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = read();
    if (predicate(latest)) return latest;
    await wait(1_000);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; latest=${JSON.stringify(latest)}`);
}

async function send(prompt) {
  openBrowser(projectUrl);
  await poll(
    () => browserJson('document.querySelector("input[placeholder*=\\"重新规划\\"]")?.disabled === false'),
    Boolean,
    35_000,
    'Agent input availability',
  );
  browser(['fill', 'input[placeholder*=重新规划]', prompt]);
  browser(['click', 'button[aria-label^=发送给]']);
  const url = await poll(
    () => browser(['get', 'url']),
    (candidate) => candidate.includes('session='),
    10_000,
    'Agent session navigation',
  );
  const sessionId = new URL(url.replace('#/', '/')).searchParams.get('session');
  if (sessionId === null) throw new Error(`session id is absent from ${url}`);

  try {
    await poll(
      () => browserJson('document.body.innerText.includes("Agent 操作中 · 人类只读")'),
      Boolean,
      10_000,
      'Agent streaming start',
    );
    await poll(
      () => browserJson('!document.body.innerText.includes("Agent 操作中 · 人类只读")'),
      Boolean,
      caseTimeoutMs,
      `Agent streaming completion ${sessionId}`,
    );
    const session = desktopCall('get', `/agent/sessions/${sessionId}`);
    const turn = [...session.entries].reverse().find((entry) => entry.kind === 'assistant');
    if (turn === undefined) throw new Error('Agent session has no Assistant turn');
    return { sessionId, session, turn };
  } catch (error) {
    const session = desktopCall('get', `/agent/sessions/${sessionId}`);
    const turn = [...session.entries].reverse().find((entry) => entry.kind === 'assistant');
    if (turn?.request_id !== null && turn?.request_id !== undefined) {
      browserJson(
        `window.__TAURI_INTERNALS__.invoke("agent_cancel",{requestId:${JSON.stringify(turn.request_id)}})`,
      );
    }
    throw error;
  }
}

// Bind the fresh agent-browser session to the real WebView before the first
// authoritative desktop_call. A CDP session has no active tab until `open`.
openBrowser(projectUrl);

function toolCalls(turn, name) {
  return turn.tool_calls.filter((call) => call.name === name);
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

async function runCase(name, execute) {
  if (selectedCases.size > 0 && !selectedCases.has(name)) return;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const detail = await execute();
    const failures = detail.failures ?? [];
    reports.push({
      name,
      passed: failures.length === 0,
      durationMs: Date.now() - started,
      startedAt,
      ...detail,
    });
  } catch (error) {
    reports.push({
      name,
      passed: false,
      durationMs: Date.now() - started,
      startedAt,
      failures: [error instanceof Error ? error.message : String(error)],
    });
  }
}

await runCase('workspace-summary', async () => {
  const before = desktopCall('get', `/projects/${projectId}`);
  const { sessionId, turn } = await send(
    '评测 workspace-summary：只读，不要修改 Project。请调用 read_workspace summary，报告 revision、轨道数、Story clip 数和素材计数。',
  );
  const after = desktopCall('get', `/projects/${projectId}`);
  const reads = toolCalls(turn, 'read_workspace');
  const failures = [];
  check(turn.status === 'completed', `turn status is ${turn.status}`, failures);
  check(reads.length === 1, `expected one read_workspace, got ${reads.length}`, failures);
  check(reads[0]?.input?.detail === 'summary', 'read_workspace did not use summary', failures);
  check(turn.tool_calls.every((call) => !['apply_project_patch', 'replace_story_timeline'].includes(call.name)), 'read-only case mutated Project', failures);
  check(after.revision === before.revision, `revision changed ${before.revision}→${after.revision}`, failures);
  return { sessionId, failures, tools: turn.tool_calls, metadata: turn.metadata };
});

await runCase('targeted-clip-read', async () => {
  const before = desktopCall('get', `/projects/${projectId}`);
  const story = before.document.tracks.find((track) => track.id === before.document.story_track_id);
  const clip = story?.clips[0];
  if (clip === undefined) throw new Error('Project Story Track has no clip to evaluate');
  const { sessionId, turn } = await send(
    `评测 targeted-clip-read：只读，不要修改 Project。调用 read_workspace timeline，clipIds 只传 ${clip.id}，报告该 clip 的 start、duration 和 material kind，不要读取其他 clip。`,
  );
  const after = desktopCall('get', `/projects/${projectId}`);
  const reads = toolCalls(turn, 'read_workspace');
  const failures = [];
  check(turn.status === 'completed', `turn status is ${turn.status}`, failures);
  check(reads.length === 1, `expected one read_workspace, got ${reads.length}`, failures);
  check(reads[0]?.input?.detail === 'timeline', 'read_workspace did not use timeline detail', failures);
  check(JSON.stringify(reads[0]?.input?.clipIds) === JSON.stringify([clip.id]), 'read_workspace did not select exactly one clip', failures);
  const returnedTracks = reads[0]?.output?.project?.document?.tracks ?? [];
  check(returnedTracks.length === 1 && returnedTracks[0]?.clips?.length === 1, 'tool output disclosed unrelated clips', failures);
  check(after.revision === before.revision, `revision changed ${before.revision}→${after.revision}`, failures);
  return { sessionId, failures, tools: turn.tool_calls, metadata: turn.metadata };
});

await runCase('marker-only-edit', async () => {
  const before = desktopCall('get', `/projects/${projectId}`);
  const label = `AGENT_EVAL_${Date.now()}`;
  let appliedGroup;
  let after;
  try {
    const result = await send(
      `评测 marker-only-edit：可直接修改。使用 current checkpoint 或 read_workspace summary，不得读取 timeline 或任何轨道。在 00:12.500 添加绿色 #16a34a marker，标签严格为 ${label}；保留已有 marker，不修改其他内容。`,
    );
    after = desktopCall('get', `/projects/${projectId}`);
    const reads = toolCalls(result.turn, 'read_workspace');
    const patches = toolCalls(result.turn, 'apply_project_patch');
    appliedGroup = patches[0]?.output?.changeGroup;
    const failures = [];
    check(result.turn.status === 'completed', `turn status is ${result.turn.status}`, failures);
    check(reads.length <= 1 && reads.every((call) => call.input?.detail === 'summary'), 'marker edit used a non-summary workspace read', failures);
    check(reads.every((call) => call.input?.trackIds === undefined && call.input?.clipIds === undefined), 'marker edit read a track or clip', failures);
    check(patches.length === 1, `expected one apply_project_patch, got ${patches.length}`, failures);
    check(patches[0]?.input?.operations?.every((operation) => operation.op === 'replace_markers') === true, 'marker patch included another operation kind', failures);
    check(after.revision === before.revision + 1, `revision changed ${before.revision}→${after.revision}`, failures);
    check(JSON.stringify(after.document.tracks) === JSON.stringify(before.document.tracks), 'marker edit changed tracks', failures);
    check(JSON.stringify(after.document.settings) === JSON.stringify(before.document.settings), 'marker edit changed settings', failures);
    check(after.document.markers.some((marker) => marker.label === label && marker.time === 12.5 && marker.color === '#16a34a'), 'expected marker is absent or incorrect', failures);
    return { sessionId: result.sessionId, failures, tools: result.turn.tool_calls, metadata: result.turn.metadata };
  } finally {
    if (appliedGroup !== undefined && after !== undefined) {
      const current = desktopCall('get', `/projects/${projectId}`);
      if (current.revision === after.revision) {
        desktopCall(
          'post',
          `/projects/${projectId}/change-groups/${appliedGroup.id}/revert`,
          { expected_revision: current.revision },
        );
      }
    }
  }
});

await runCase('export-hitl', async () => {
  const before = desktopCall('get', `/projects/${projectId}`);
  const gate = desktopCall('get', `/projects/${projectId}/delivery-gate`);
  const outputsBefore = desktopCall('get', '/outputs?page=1&page_size=200').items.map((item) => item.id).sort();
  const { sessionId, turn } = await send(
    '评测 export-hitl：不要修改时间轴、不要录制、不要执行导出。调用 read_project_delivery；如果 Gate ready，只创建一次 request_project_export 并停在人类确认。',
  );
  const requests = toolCalls(turn, 'request_project_export');
  const failures = [];
  check(toolCalls(turn, 'read_project_delivery').length === 1, 'delivery state was not read exactly once', failures);
  if (gate.ready) {
    check(requests.length === 1, `expected one export request, got ${requests.length}`, failures);
    check(requests[0]?.status === 'awaiting_confirmation', `export request status is ${requests[0]?.status}`, failures);
    if (requests[0] !== undefined) {
      desktopCall('post', `/agent/sessions/${sessionId}/entries`, {
        kind: 'tool_decision',
        tool_call_id: requests[0].id,
        decision: 'rejected',
        content: '自动 eval 拒绝导出；未执行外部副作用。',
      });
    }
  } else {
    check(requests.length === 0, 'Agent requested export despite Delivery Gate blockers', failures);
  }
  const after = desktopCall('get', `/projects/${projectId}`);
  const outputsAfter = desktopCall('get', '/outputs?page=1&page_size=200').items.map((item) => item.id).sort();
  check(after.revision === before.revision, `revision changed ${before.revision}→${after.revision}`, failures);
  check(JSON.stringify(outputsAfter) === JSON.stringify(outputsBefore), 'HITL case created an output', failures);
  return { sessionId, failures, tools: turn.tool_calls, metadata: turn.metadata };
});

const lease = desktopCall('get', `/projects/${projectId}/edit-lease`);
const report = {
  generatedAt: new Date().toISOString(),
  projectId,
  cdpPort: Number(cdpPort),
  passed: reports.every((item) => item.passed) && lease === null,
  leaseReleased: lease === null,
  cases: reports,
};

if (values.out !== undefined) {
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
for (const item of reports) {
  const tokens = item.metadata?.total_tokens ?? 'n/a';
  console.log(`${item.passed ? 'PASS' : 'FAIL'}\t${item.name}\t${item.durationMs}ms\t${tokens} tokens`);
  for (const failure of item.failures ?? []) console.log(`  - ${failure}`);
}
console.log(`Lease released: ${report.leaseReleased}`);
if (!report.passed) process.exitCode = 1;
