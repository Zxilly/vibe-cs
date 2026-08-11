import { agentRequestSchema, agentResponseSchema } from './protocol.js';
import { runAgent } from './agent.js';

const EVENT_PREFIX = 'VIBE_CS_AGENT_EVENT:';
const MAXIMUM_REQUEST_BYTES = 2 * 1024 * 1024;

async function readRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAXIMUM_REQUEST_BYTES) throw new Error('agent request exceeds 2 MiB');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const request = agentRequestSchema.parse(await readRequest());
  await runAgent(request, (event) => {
    const validated = event.type === 'complete'
      ? { ...event, response: agentResponseSchema.parse(event.response) }
      : event;
    process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(validated)}\n`);
  });
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error && cause.message.startsWith('upstream model request failed')
    ? cause.message
    : 'local agent request failed';
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: 'error', error: message.slice(0, 2_000) })}\n`);
  process.exitCode = 1;
});
