import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT_PREFIX = 'VIBE_CS_AGENT_EVENT:';
const TEST_SECRET = 'vibe-cs-e2e-secret';
const MAXIMUM_CAPTURE_BYTES = 2 * 1024 * 1024;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..', '..', '..');

function streamChunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-vibe-cs-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'vibe-cs-e2e-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response, chunks) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    assert.ok(total <= MAXIMUM_CAPTURE_BYTES, 'provider request exceeded 2 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function spawnSidecar(executable, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd: workspaceRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('bundled sidecar E2E timed out'));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAXIMUM_CAPTURE_BYTES) {
        child.kill();
        reject(new Error('bundled sidecar stdout exceeded 2 MiB'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAXIMUM_CAPTURE_BYTES) stderr.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const providerRequests = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${TEST_SECRET}`);
    const body = await readJson(request);
    providerRequests.push(body);
    if (providerRequests.length === 1) {
      const argumentsJson = JSON.stringify({
        highlightIds: ['ace-1'],
        pacing: 'impact',
        includeContextSeconds: 2,
        transitionStyle: 'flash',
      });
      sendStream(response, [
        streamChunk({
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call-edit-plan',
            type: 'function',
            function: { name: 'draft_edit_plan', arguments: argumentsJson },
          }],
        }),
        streamChunk({}, 'tool_calls'),
      ]);
      return;
    }
    sendStream(response, [
      streamChunk({ role: 'assistant', content: '已生成一段基于 ace-1 证据的剪辑草案。' }),
      streamChunk({}, 'stop'),
    ]);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'fixture_failure', message: String(error) } }));
  }
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const targetTriple = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(targetTriple, 'unable to resolve Rust host tuple');
  const executable = path.join(
    workspaceRoot,
    'apps', 'desktop', 'src-tauri', 'binaries',
    `vibe-cs-agent-${targetTriple}.exe`,
  );
  const request = {
    requestId: '00000000-0000-4000-8000-0000000000e2',
    mode: 'edit',
    message: '请把 ace-1 做成有冲击力的剪辑草案。',
    history: [],
    config: {
      provider: 'vibe-cs-e2e',
      model: 'vibe-cs-e2e-model',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: TEST_SECRET,
      customInstructions: '',
    },
    context: {
      demo: { id: '00000000-0000-4000-8000-0000000000d1', file_name: 'verified.dem' },
      analysis: {
        tick_rate: 64,
        highlights: [{
          id: 'ace-1', kind: 'multi_kill', title: 'Ace', player_id: 'player-1', round: 7,
          start_tick: 1_000, end_tick: 1_500, description: 'Five verified eliminations',
        }],
      },
      editorProject: null,
      selectedAudio: null,
      audioAnalysis: null,
      beatAlignmentDraft: null,
    },
  };

  const result = await spawnSidecar(executable, request);
  assert.equal(result.code, 0, `sidecar failed: ${result.stderr}`);
  assert.ok(!result.stdout.includes(TEST_SECRET), 'sidecar stdout leaked the provider secret');
  assert.ok(!result.stderr.includes(TEST_SECRET), 'sidecar stderr leaked the provider secret');
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    assert.ok(line.startsWith(EVENT_PREFIX), `unexpected sidecar output: ${line}`);
    return JSON.parse(line.slice(EVENT_PREFIX.length));
  });
  const completed = events.find((event) => event.type === 'complete');
  assert.ok(completed, 'sidecar did not emit a completion event');
  assert.equal(completed.response.requestId, request.requestId);
  assert.match(completed.response.content, /ace-1/);
  assert.deepEqual(completed.response.plans, [{
    kind: 'highlight_edit',
    title: 'Recorded highlight edit draft',
    payload: {
      demo_id: request.context.demo.id,
      highlight_ids: ['ace-1'],
      intent: { pacing: 'impact', include_context_seconds: 2, transition: 'flash' },
    },
  }]);
  assert.equal(completed.response.toolCalls.length, 1);
  assert.equal(completed.response.toolCalls[0].name, 'draft_edit_plan');
  assert.equal(providerRequests.length, 2, 'Mastra did not complete the tool round-trip');
  const followUpMessages = providerRequests[1].messages ?? [];
  assert.ok(followUpMessages.some((message) => message.role === 'tool'), 'tool result was not returned to the model');
  process.stdout.write('Bundled SEA → streamed provider → Mastra tool → typed proposal E2E passed.\n');
} finally {
  server.close();
  await once(server, 'close').catch(() => {});
}
