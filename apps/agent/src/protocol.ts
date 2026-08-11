import { z } from 'zod';

const historyMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(16_000),
}).strict();

export function isAllowedProviderBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

export const agentRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  mode: z.enum(['guide', 'edit', 'hlae']),
  message: z.string().trim().min(1).max(8_000),
  history: z.array(historyMessageSchema).max(40),
  config: z.object({
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    baseUrl: z.string().url().max(2_048).refine(isAllowedProviderBaseUrl, {
      message: 'remote model endpoints must use HTTPS; HTTP is restricted to loopback',
    }),
    apiKey: z.string().min(1).max(16_384),
    customInstructions: z.string().max(4_000),
  }).strict(),
  context: z.object({
    demo: z.unknown().nullable(),
    analysis: z.unknown().nullable(),
    editorProject: z.unknown().nullable(),
    selectedAudio: z.unknown().nullable(),
    audioAnalysis: z.unknown().nullable(),
    beatAlignmentDraft: z.unknown().nullable(),
  }).strict(),
}).strict();

export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const agentResponseSchema = z.object({
  requestId: z.string(),
  content: z.string().min(1).max(64_000),
  toolCalls: z.array(z.object({
    name: z.string(),
    input: z.unknown(),
    output: z.unknown(),
  }).strict()).max(32),
  plans: z.array(z.object({
    kind: z.enum(['highlight_edit', 'beat_alignment', 'hlae']),
    title: z.string(),
    payload: z.unknown(),
  }).strict()).max(8),
  provider: z.string(),
  model: z.string(),
}).strict();

export type AgentResponse = z.infer<typeof agentResponseSchema>;

export type CapturedPlan = AgentResponse['plans'][number];
