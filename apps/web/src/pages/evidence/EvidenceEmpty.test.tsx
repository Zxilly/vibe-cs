/*
 * `markup` project — 「为什么搜不到」 has three different true answers.
 *
 * This is the assertion the brief asks for by name: 「空结果不是道歉：照命令面板
 * 的先例，把『为什么搜不到』说出来」. The command palette's precedent is to state
 * the matching contract; here the contract has a second half — whether the
 * index is even in a position to answer — and the recovery action differs for
 * each of the three cases.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { conditionSummaryText } from './conditionSummary';
import { EvidenceEmpty } from './EvidenceEmpty';
import { activeConditions, readEvidenceSearch } from './evidenceSearchParams';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

const base = {
  indexedItems: 1_284_632,
  indexedDemos: 248,
  totalAnalyses: 248,
  conditions: [],
  onRetry: () => undefined,
};

describe('nothing indexed', () => {
  const html = render(
    <EvidenceEmpty {...base} indexState="empty" indexedItems={0} totalAnalyses={12} />,
  );

  it('blames the index, not the query', () => {
    expect(html).toContain('还没有可检索的证据');
    expect(html).toContain('已分析 12 场');
  });

  it('sends the user where the fix actually is', () => {
    // 「清空条件」 would change nothing here, so it is not offered.
    expect(html).toContain('去资料库分析一场');
    expect(html).toContain('href="/library"');
    expect(html).not.toContain('清空条件');
  });
});

describe('still indexing', () => {
  const html = render(
    <EvidenceEmpty {...base} indexState="partial" indexedDemos={3} totalAnalyses={12} />,
  );

  it('says how far it has got, with both halves of the fraction', () => {
    expect(html).toContain('已索引 3 / 12 场');
  });

  it('offers the only recovery that can help: try again later', () => {
    expect(html).toContain('重新检索');
  });
});

describe('a complete index and no match', () => {
  it('names the conditions rather than apologising', () => {
    const state = readEvidenceSearch(new URLSearchParams('player=Kael&map=de_mirage&headshot=1'));
    const conditions = activeConditions(state);
    const html = render(
      <EvidenceEmpty
        {...base}
        indexState="complete"
        conditions={conditions}
        conditionSummary={conditionSummaryText(conditions)}
        onClearConditions={() => undefined}
      />,
    );

    expect(html).toContain('没有命中的证据');
    expect(html).toContain('当前条件：');
    expect(html).toContain('Kael');
    expect(html).toContain('de_mirage');
    expect(html).toContain('仅爆头');
    expect(html).toContain('清空条件');
  });

  it('states the corpus size when there was nothing to relax', () => {
    const html = render(<EvidenceEmpty {...base} indexState="complete" indexedItems={4200} />);
    expect(html).toContain('已有 4200 条证据');
    expect(html).toContain('重新检索');
  });
});
