/*
 * `interaction` project — the writes of Review 与注释.
 *
 * §10.4 gap 16 left `/evidence` shipping with its annotate buttons disabled
 * because `DesktopClient` carried no evidence writes. `data/match.ts` declares
 * them now, so this file proves the composer actually submits — and that it
 * refuses, out loud, when the address carries no tick to hang the note on.
 */

import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useCreateMatchAnnotation,
  useDeleteMatchAnnotation,
  useGenerateMatchReview,
  useMatchAnalysis,
  useMatchAnnotations,
  useUpdateMatchAnnotation,
} from '../../../data/match';
import type { MatchContextPatch } from '../workspaceContext';
import { ReviewView } from './ReviewView';
import { ANALYSIS, ANNOTATIONS, DEMO_ID, REVIEW_RESULT } from './test/fixtures';
import { mutationResult, queryResult, renderView, viewProps } from './test/renderView';

vi.mock('../../../data/match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../data/match')>();
  return {
    ...actual,
    useMatchAnalysis: vi.fn(),
    useMatchAnnotations: vi.fn(),
    useGenerateMatchReview: vi.fn(),
    useCreateMatchAnnotation: vi.fn(),
    useUpdateMatchAnnotation: vi.fn(),
    useDeleteMatchAnnotation: vi.fn(),
  };
});

const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const generate = vi.fn();

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  remove.mockReset();
  generate.mockReset();

  vi.mocked(useMatchAnalysis).mockReturnValue(queryResult(ANALYSIS) as never);
  vi.mocked(useMatchAnnotations).mockReturnValue(queryResult(ANNOTATIONS) as never);
  vi.mocked(useGenerateMatchReview).mockReturnValue(mutationResult({ mutate: generate }) as never);
  vi.mocked(useCreateMatchAnnotation).mockReturnValue(mutationResult({ mutate: create }) as never);
  vi.mocked(useUpdateMatchAnnotation).mockReturnValue(mutationResult({ mutate: update }) as never);
  vi.mocked(useDeleteMatchAnnotation).mockReturnValue(mutationResult({ mutate: remove }) as never);
});

function openAnnotations(): void {
  fireEvent.click(screen.getByRole('radio', { name: /我的注释/u }));
}

describe('the tabs', () => {
  it('moves between 结论 and 我的注释', () => {
    renderView(<ReviewView.Body {...viewProps()} />);
    expect(document.querySelector('[data-review-insights]')).not.toBeNull();

    openAnnotations();
    expect(document.querySelector('[data-review-annotations]')).not.toBeNull();
    expect(document.querySelector('[data-review-insights]')).toBeNull();
  });
});

describe('生成 AI 点评', () => {
  it('sends the whole match at the tone the tag states', () => {
    renderView(<ReviewView.Body {...viewProps({ context: { player: 'kael' } })} />);

    fireEvent.click(screen.getByRole('button', { name: '生成 AI 点评' }));

    expect(generate).toHaveBeenCalledWith({
      demoId: DEMO_ID,
      request: { scope: 'match', player_id: 'kael', highlight_ids: [], tone: 'analytical' },
    });
  });

  it('takes a citation back to the round, the tick and the evidence', () => {
    const updateContext = vi.fn<(patch: MatchContextPatch) => void>();
    vi.mocked(useGenerateMatchReview).mockReturnValue(
      mutationResult({ mutate: generate, data: REVIEW_RESULT }) as never,
    );
    renderView(<ReviewView.Body {...viewProps({ updateContext })} />);

    fireEvent.click(screen.getByRole('button', { name: /1v3 残局/u }));

    expect(updateContext).toHaveBeenCalledWith({
      round: 21,
      tick: 148_920,
      evidence: 'h-21-clutch',
    });
  });
});

describe('the annotation composer', () => {
  it('refuses out loud when the address carries no anchor', () => {
    renderView(<ReviewView.Body {...viewProps()} />);
    openAnnotations();

    const submit = screen.getByRole('button', { name: '添加注释' });
    expect(submit).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('注释内容')).toHaveProperty('disabled', true);
    expect(document.body.textContent).toContain('注释挂在一条证据的 tick 上');
  });

  it('writes the note against the evidence in the address', () => {
    renderView(
      <ReviewView.Body
        {...viewProps({ context: { evidence: 'e-kill-sable', round: 21, tick: 149_128 } })}
      />,
    );
    openAnnotations();

    fireEvent.change(screen.getByLabelText('注释内容'), { target: { value: ' 这个点位可教学 ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加注释' }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({
      demo_id: DEMO_ID,
      evidence_id: 'e-kill-sable',
      round: 21,
      tick: 149_128,
      body: '这个点位可教学',
      tags: [],
    });
  });

  it('will not submit an empty note', () => {
    renderView(
      <ReviewView.Body
        {...viewProps({ context: { evidence: 'e-kill-sable', round: 21, tick: 149_128 } })}
      />,
    );
    openAnnotations();

    fireEvent.change(screen.getByLabelText('注释内容'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '添加注释' })).toHaveProperty('disabled', true);
  });
});

describe('the annotation list', () => {
  it('flips 待处理 to 已处理 without touching the text or the tags', () => {
    renderView(<ReviewView.Body {...viewProps()} />);
    openAnnotations();

    fireEvent.click(screen.getByRole('button', { name: '标记已处理' }));

    expect(update).toHaveBeenCalledWith({
      id: 'a-1',
      body: 'R21 的穿墙点可做教学',
      tags: [],
      reviewState: 'resolved',
    });
  });

  it('reopens a resolved one', () => {
    renderView(<ReviewView.Body {...viewProps()} />);
    openAnnotations();

    fireEvent.click(screen.getByRole('button', { name: '重新打开' }));
    expect(update.mock.calls[0]?.[0]).toMatchObject({ id: 'a-2', reviewState: 'open' });
  });

  it('deletes one', () => {
    renderView(<ReviewView.Body {...viewProps()} />);
    openAnnotations();

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[0] as HTMLElement);
    expect(remove).toHaveBeenCalledWith('a-1');
  });
});
