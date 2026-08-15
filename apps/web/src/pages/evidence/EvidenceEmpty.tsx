/*
 * pages/evidence — 「没有命中的证据」, with a reason.
 *
 * `design/data/EmptyState` ships the `no-hits` preset and its own note says why
 * the copy is only half there: 「当前条件：…」 is a rendering of live filter
 * state, so the preset keeps the general advice and the page passes the
 * conditions in. This is the page half.
 *
 * The shape follows the command palette's precedent — 「没有匹配的结果 / 换一个
 * 更短的关键词……不做拼音和模糊匹配」 — which states the matching contract instead
 * of apologising. An empty evidence search has three different true causes and
 * only one of them is the user's query:
 *
 *   index empty     nothing has been analysed into the index yet. Loosening the
 *                   filters would change nothing, so the recovery is 「去资料库
 *                   分析一场」, not 「清空条件」.
 *   index partial   the projection is still running. The row may exist and
 *                   simply not be in yet; the honest recovery is to wait and
 *                   retry, and the count says how far it has got.
 *   index complete  the query really matched nothing. Now — and only now — the
 *                   advice is to relax a condition, and the conditions are
 *                   named so the reader can pick one.
 *
 * `EvidenceIndexState` is computed in `data/evidence.ts` because reading the
 * response's `availability` block is a contract question; the wording is here
 * because copy is not.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import type { EvidenceIndexState } from '../../data/evidence';
import { EmptyState } from '../../design/data';
import { Button } from '../../design/primitives';
import { RouteLink } from '../RouteLink';
import type { EvidenceCondition } from './evidenceSearchParams';

export interface EvidenceEmptyProps {
  readonly indexState: EvidenceIndexState;
  /** How many rows the index holds in total, for the partial case. */
  readonly indexedItems: number;
  /** How many analyses exist, so 「已索引 3 / 12」 has both halves. */
  readonly indexedDemos: number;
  readonly totalAnalyses: number;
  /** The conditions the user actually set, already rendered by the caller. */
  readonly conditions: readonly EvidenceCondition[];
  readonly conditionSummary?: ReactNode | undefined;
  /** 「清空条件」. Absent when there is nothing to clear. */
  readonly onClearConditions?: (() => void) | undefined;
  /** 「重试」 for the partial case — the projection may have advanced. */
  readonly onRetry: () => void;
}

export function EvidenceEmpty({
  indexState,
  indexedItems,
  indexedDemos,
  totalAnalyses,
  conditions,
  conditionSummary,
  onClearConditions,
  onRetry,
}: EvidenceEmptyProps) {
  if (indexState === 'empty') {
    return (
      <EmptyState
        className="m-7"
        title={<Trans>索引里还没有证据</Trans>}
        description={
          <Trans>
            证据是分析产出的。已分析 {totalAnalyses} 场，但还没有一场进入证据索引，所以任何条件都会是零命中。
          </Trans>
        }
        actions={
          <RouteLink to="/library">
            <Trans>去资料库分析一场</Trans>
          </RouteLink>
        }
      />
    );
  }

  if (indexState === 'partial') {
    return (
      <EmptyState
        className="m-7"
        title={<Trans>索引还在建立</Trans>}
        description={
          <Trans>
            已索引 {indexedDemos} / {totalAnalyses} 场，共 {indexedItems} 条证据。你要找的这条可能还没进来，等一会儿再试一次。
          </Trans>
        }
        actions={
          <Button variant="secondary" onClick={onRetry}>
            <Trans>重新检索</Trans>
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      className="m-7"
      preset="no-hits"
      description={
        conditions.length === 0 ? (
          <Trans>索引里有 {indexedItems} 条证据，但这次检索一条也没匹配上。</Trans>
        ) : (
          <>
            <Trans>当前条件：</Trans>
            {conditionSummary}
            <Trans>。放宽时间范围通常最有效。</Trans>
          </>
        )
      }
      actions={
        onClearConditions === undefined ? (
          <Button variant="secondary" onClick={onRetry}>
            <Trans>重新检索</Trans>
          </Button>
        ) : (
          <Button variant="secondary" onClick={onClearConditions}>
            <Trans>清空条件</Trans>
          </Button>
        )
      }
    />
  );
}
