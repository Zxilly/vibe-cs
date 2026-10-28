/*
 * Interaction tests for 设置 · AI 与 Agent's stored controls — the ones that
 * only exist once `getAgentWorkspaceSettings` has answered.
 *
 * What is pinned is the shape of the write: `updateAgentWorkspaceSettings`
 * replaces the whole document, so a row that sent only its own field would
 * silently reset every other one.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentWorkspaceSettings, LlmConfig } from '../../../shared/desktop/dto';
import { renderPage } from '../../../test/renderPage';
import { AiAgentSection } from './AiAgentSection';

const SETTINGS: AgentWorkspaceSettings = {
  session_retention: { mode: 'recent_count', count: 50 },
  show_evidence_reads: true,
  /* The service's own default, which no fixed set of stops used to contain. */
  default_video_seconds: 180,
  default_camera_style: 'pov',
  commentary_tone: 'professional',
};

function render(overrides: Record<string, unknown> = {}) {
  const written: AgentWorkspaceSettings[] = [];
  renderPage({
    element: <AiAgentSection />,
    client: {
      getConfig: () => new Promise(() => {}),
      getAgentWorkspaceSettings: () => Promise.resolve(SETTINGS),
      getAgentSessionStorage: () => Promise.resolve({
        session_count: 2,
        entry_count: 9,
        conversation_bytes: 1024,
        oldest_session_at: null,
        newest_session_at: null,
      }),
      updateAgentWorkspaceSettings: (next: AgentWorkspaceSettings) => {
        written.push(next);
        return Promise.resolve(next);
      },
      ...overrides,
    },
  });
  return { written };
}

const LLM: LlmConfig = {
  provider: 'openai', model: 'test-model', base_url: 'https://example.com/v1', api_key: '',
  prompt: '', parameter_style: 'openai', parameters: {},
};

describe('model connection feedback', () => {
  it('clears the previous successful test when the model changes', async () => {
    const testLlm = vi.fn().mockResolvedValue({
      ok: true, provider: 'openai', model: 'test-model',
      capabilities: { protocol: 'openai', chat: true, stream: true, tools: true },
    });
    render({ getConfig: async () => ({ llm: LLM, llm_has_api_key: true }), testLlm });
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }));
    await screen.findByText(/连接正常/u);

    fireEvent.change(screen.getByRole('textbox', { name: /^模型/u }), { target: { value: 'another-model' } });

    expect(screen.queryByText(/连接正常/u)).toBeNull();
    expect(testLlm).toHaveBeenCalledTimes(1);
  });

  it('associates invalid JSON with its field and removes a stale connection retry', async () => {
    const testLlm = vi.fn().mockRejectedValue(new Error('Connection refused'));
    render({ getConfig: async () => ({ llm: LLM, llm_has_api_key: true }), testLlm });
    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }));
    await screen.findByRole('button', { name: '重试' });

    fireEvent.click(screen.getByText('请求参数'));
    const json = screen.getByLabelText('完整参数 JSON');
    fireEvent.change(json, { target: { value: '{invalid' } });

    expect(json.getAttribute('aria-invalid')).toBe('true');
    const messageId = json.getAttribute('aria-describedby');
    expect(messageId).not.toBeNull();
    expect(document.getElementById(messageId!)?.textContent).toContain('请输入有效的 JSON 对象');
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试' })).toBeNull());
    const test = screen.getByRole('button', { name: '测试连接' });
    expect(test.hasAttribute('disabled')).toBe(true);
    fireEvent.click(test);
    expect(testLlm).toHaveBeenCalledTimes(1);
  });
});

describe('默认成片时长', () => {
  it('shows the stored value itself, whatever it is', async () => {
    render();
    const field = await screen.findByLabelText('默认成片时长') as HTMLInputElement;
    expect(field.value).toBe('180');
    expect(document.body.textContent).not.toContain('不在上面这几档里');
  });

  it('commits a new length on blur as one whole document', async () => {
    const { written } = render();
    const field = await screen.findByLabelText('默认成片时长');

    fireEvent.change(field, { target: { value: '45' } });
    expect(written).toHaveLength(0);
    fireEvent.blur(field);

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toEqual({ ...SETTINGS, default_video_seconds: 45 });
  });

  it('refuses a length outside the service range at the field and keeps the draft', async () => {
    const { written } = render();
    const field = await screen.findByLabelText('默认成片时长') as HTMLInputElement;

    fireEvent.change(field, { target: { value: '4000' } });
    fireEvent.blur(field);

    expect(document.body.textContent).toContain('5 到 3600');
    expect(field.value).toBe('4000');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(written).toHaveLength(0);
  });

  it('writes nothing when the field is left unchanged', async () => {
    const { written } = render();
    const field = await screen.findByLabelText('默认成片时长');

    fireEvent.blur(field);

    expect(written).toHaveLength(0);
  });
});

describe('the section shares the settings page shapes', () => {
  it('draws the three blocks as settings blocks with their controls in rows', async () => {
    render();
    await screen.findByLabelText('默认成片时长');

    expect(document.querySelectorAll('[data-settings-block]')).toHaveLength(3);
    expect(document.querySelector('#setting-behavior [data-settings-row]')).not.toBeNull();
    expect(document.querySelector('#setting-conversations [data-settings-row]')).not.toBeNull();
    expect(screen.getByRole('switch', { name: '录制前始终由你确认' }).getAttribute('aria-disabled')).toBe('true');
  });
});
