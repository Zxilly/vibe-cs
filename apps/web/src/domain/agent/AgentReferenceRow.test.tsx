import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { AgentReferenceRow } from './AgentReferenceRow';
import { REFERENCE_FAILED_OUTPUT, REFERENCE_PLAN, REFERENCE_TASK } from './agentFixtures.testing';

describe('AgentReferenceRow', () => {
  it('names the object and prints the server’s own status sentence', () => {
    const html = renderMarkup(<AgentReferenceRow reference={REFERENCE_TASK} />);

    expect(html).toContain('录制任务 · Rhea 双杀');
    expect(html).toContain('运行中 · 可停止或调整未开始的片段');
    // The id exactly as the server sends it — no 「#」 prepended, or a backend
    // that already includes one would print 「##A-2483」.
    expect(html).toContain('>A-2483<');
  });

  it('draws no status dot, because the status is free text and maps to nothing', () => {
    const html = renderMarkup(<AgentReferenceRow reference={REFERENCE_TASK} />);

    expect(html).not.toContain('data-status=');
  });

  it('prints a real percentage and fabricates none', () => {
    expect(renderMarkup(<AgentReferenceRow reference={REFERENCE_TASK} />)).toContain('33%');
    // The plan has no percentage; nothing is invented for it.
    expect(renderMarkup(<AgentReferenceRow reference={REFERENCE_PLAN} />)).not.toContain('data-reference-progress');
  });

  it('omits the item count when the backend has none', () => {
    expect(renderMarkup(<AgentReferenceRow reference={REFERENCE_PLAN} />)).toContain('共 4 项');
    expect(renderMarkup(<AgentReferenceRow reference={REFERENCE_FAILED_OUTPUT} />)).not.toContain(
      'data-reference-count',
    );
  });

  it('gives a failure an icon beside its colour', () => {
    const html = renderMarkup(<AgentReferenceRow reference={REFERENCE_FAILED_OUTPUT} />);

    expect(html).toContain('data-reference-error');
    expect(html).toContain('磁盘空间不足');
    expect(html).toContain('text-fail-text');
    expect(html).toContain('lucide-circle-alert');
  });

  it('offers 引用 as the row’s one verb', () => {
    const html = renderMarkup(<AgentReferenceRow reference={REFERENCE_TASK} onReference={() => undefined} />);

    expect(html).toContain('data-reference-action');
    expect(html).toContain('引用');
  });

  it('replaces the button with a state once the session holds the reference', () => {
    const html = renderMarkup(
      <AgentReferenceRow reference={REFERENCE_PLAN} referenced onReference={() => undefined} />,
    );

    expect(html).toContain('data-reference-state="referenced"');
    expect(html).toContain('已引用');
    expect(html).not.toContain('data-reference-action');
  });

  it('highlights the plan the new session is about to take over', () => {
    const html = renderMarkup(<AgentReferenceRow reference={REFERENCE_PLAN} emphasis />);

    expect(html).toContain('border-accent');
    expect(html).toContain('bg-accent-100');
  });
});
