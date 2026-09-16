/*
 * pages/evidence — the 「证据详情」 panel of 「05 证据检索」.
 *
 * `design/layout/Inspector` uses the shared 380px context width and brings the
 * §8 collapse for free: below 1100px it folds itself
 * into a 46px summary strip plus a drawer, and 「在比赛工作区打开」 — a main
 * action — rides on the strip rather than into the drawer. Nothing here has to
 * know about the breakpoint.
 *
 * ── Fields the artboard draws that the index does not carry ────────────────
 *
 * The reference lists 武器 / 距离, 交战轴, 回合情境 and 空间证据.
 * `EvidenceSearchItem` has the weapon, the headshot / penetration flags, the
 * source (event vs highlight) and an `attributes` bag that may hold a world
 * position. It has **no** distance, no engagement bearing and no round context.
 * Those three are not rendered as blanks or as zeros — they are simply absent,
 * and they are reported as a contract gap. A panel that printed 「0.0m」 for a
 * distance nobody measured would be worse than one that stays quiet.
 *
 * ── The annotation block ───────────────────────────────────────────────────
 *
 * The notes already on this row, then a one-line composer. The page owns the
 * read and the write (`data/evidence.ts`, `data/match.ts`) and hands the panel
 * the rows and a promise-returning `onCreateNote`, so this file stays a pure
 * function of its props and the composer can clear itself when the write
 * lands. The 「注释」 face of the same page lists every note across matches.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useState, type FormEvent, type ReactNode } from 'react';

import { Empty, Skeleton } from '../../../design/data';
import { Alert, StatusDot } from '../../../design/feedback';
import { Inspector } from '../../../design/layout';
import { Badge, Button, Input } from '../../../design/primitives';
import { EVIDENCE_KIND, formatTickCount, formatWeaponName } from '../../../domain/match';
import type { EvidenceAnnotation, EvidenceSearchItem } from '../../../shared/desktop/dto';
import { evidenceEventLabel } from './evidenceEventLabel';
import { evidenceKindOf, evidencePosition, formatMatchDay } from './evidenceItems';

export interface EvidenceDetailProps {
  /** `null` when nothing is selected. */
  readonly row: EvidenceSearchItem | null;
  readonly onOpenWorkspace: (row: EvidenceSearchItem) => void;
  readonly onLocate: (row: EvidenceSearchItem) => void;
  readonly onAddToVideo: (row: EvidenceSearchItem) => void;
  /** The notes already written on `row`. */
  readonly notes?: readonly EvidenceAnnotation[] | undefined;
  readonly notesLoading?: boolean | undefined;
  /** Writes a note on `row`. Resolves once the note is stored; the composer
   *  clears on that and leaves the text in place on a rejection. */
  readonly onCreateNote: (row: EvidenceSearchItem, body: string) => Promise<unknown>;
  readonly createPending?: boolean | undefined;
  /** Why the last write failed, shown until dismissed. Both or neither: an
   *  `Alert` always carries its recovery action. */
  readonly noteError?: string | null | undefined;
  readonly onDismissNoteError?: (() => void) | undefined;
}

function Field({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="flex-none text-neutral-600">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

export function EvidenceDetail({
  row,
  onOpenWorkspace,
  onLocate,
  onAddToVideo,
  notes = [],
  notesLoading = false,
  onCreateNote,
  createPending = false,
  noteError = null,
  onDismissNoteError,
}: EvidenceDetailProps) {
  const { i18n } = useLingui();

  if (row === null) {
    return (
      <Inspector title={<Trans>证据详情</Trans>} label={t`证据详情`}>
        <Empty
          title={<Trans>还没有选中证据</Trans>}
          actions={null}
        />
      </Inspector>
    );
  }

  const position = evidencePosition(row);
  const day = formatMatchDay(row.match_date);
  const subject =
    row.actor_name ?? row.actor_id ?? row.demo_display_name;
  const target = row.target_name ?? row.target_id;
  const eventLabel = evidenceEventLabel(row);
  const eventText = i18n._(eventLabel ?? EVIDENCE_KIND[evidenceKindOf(row)].label);
  /* 「tick 105 600」 is one value: the group separator cannot break, and
     neither can the gap between the word and the number. */
  const tick = <span className="whitespace-nowrap font-mono">tick {formatTickCount(row.tick)}</span>;

  return (
    <Inspector
      title={<Trans>证据详情</Trans>}
      label={t`证据详情`}
      summary={
        <Trans>
          选中 {subject} · 第 {row.round} 回合 · {tick}
        </Trans>
      }
      summaryActions={
        <Button variant="primary" size="sm" onClick={() => onOpenWorkspace(row)}>
          <Trans>在比赛工作区打开</Trans>
        </Button>
      }
      footer={
        <>
          <Button variant="primary" size="lg" block onClick={() => onOpenWorkspace(row)}>
            <Trans>在比赛工作区打开</Trans>
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" grow onClick={() => onLocate(row)}>
              <Trans>2D 回放定位</Trans>
            </Button>
            <Button variant="secondary" size="sm" grow onClick={() => onAddToVideo(row)}>
              <Trans>加入作品</Trans>
            </Button>
          </div>
        </>
      }
    >
      <div>
        <div className="font-heading text-xl">
          {target === null ? (
            <>{subject}</>
          ) : (
            <Trans>
              {subject} → {target}
            </Trans>
          )}
        </div>
        <div className="mt-0.5 text-xs text-neutral-700">
          <Trans>
            {row.demo_display_name} · {row.map_name} · 第 {row.round} 回合 · {tick}
          </Trans>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Field label={<Trans>事件</Trans>}>{eventText}</Field>
        <Field label={<Trans>武器</Trans>}>
          {row.weapon === null ? <span className="text-neutral-600">—</span> : formatWeaponName(row.weapon)}
        </Field>
        <Field label={<Trans>命中方式</Trans>}>
          <span className="flex items-center justify-end gap-2">
            {row.penetrated === true ? <Badge variant="accent"><Trans>穿墙</Trans></Badge> : null}
            {row.headshot === true ? <Badge variant="accent"><Trans>爆头</Trans></Badge> : null}
            {row.penetrated !== true && row.headshot !== true ? (
              <span className="text-neutral-600">—</span>
            ) : null}
          </span>
        </Field>
        <Field label={<Trans>来源</Trans>}>
          {row.source_kind === 'highlight' ? <Trans>高光检测</Trans> : <Trans>逐事件时间轴</Trans>}
        </Field>
        <Field label={<Trans>比赛日期</Trans>}>
          {day === '' ? <span className="text-neutral-600">—</span> : day}
        </Field>
        <Field label={<Trans>空间证据</Trans>}>
          <span className="flex items-center justify-end gap-2">
            <StatusDot status={position === null ? 'idle' : 'ok'} />
            {position === null ? <Trans>不可用</Trans> : <Trans>可用</Trans>}
          </span>
        </Field>
      </div>

      <div data-evidence-notes="" className="border border-divider p-3">
        <div className="mb-2 font-heading text-xs tracking-caps text-neutral-700">
          <Trans>注释</Trans>
        </div>
        {notesLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton width="88%" />
            <Skeleton width="62%" />
          </div>
        ) : notes.length === 0 ? (
          <p className="text-xs leading-normal text-neutral-700">
            <Trans>这条证据还没有注释。注释是跨比赛复用的，写在这里的话会出现在「注释」视图里。</Trans>
          </p>
        ) : (
          <ul className="flex list-none flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} data-evidence-note={note.id} className="flex items-start gap-2">
                <p className="min-w-0 flex-1 break-words text-xs leading-normal">{note.body}</p>
                <Badge variant={note.review_state === 'resolved' ? 'neutral' : 'outline'}>
                  {note.review_state === 'resolved' ? <Trans>已处理</Trans> : <Trans>待处理</Trans>}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {noteError === null || onDismissNoteError === undefined ? null : (
          <div className="mt-2">
            <Alert
              variant="danger"
              action={{ label: <Trans>知道了</Trans>, onAction: onDismissNoteError }}
            >
              <Trans>注释没有写成功：{noteError}</Trans>
            </Alert>
          </div>
        )}
        <NoteComposer
          key={row.evidence_id}
          pending={createPending}
          onSubmit={(body) => onCreateNote(row, body)}
        />
      </div>
    </Inspector>
  );
}

/** One line and a button. Keyed by the row it is about, so a half-typed note
 *  does not follow the reader to the next row. */
function NoteComposer({
  pending,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly onSubmit: (body: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState('');
  const body = draft.trim();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (body === '' || pending) return;
    onSubmit(body).then(
      () => setDraft(''),
      () => undefined,
    );
  };

  return (
    <form data-evidence-note-composer="" className="mt-2 flex items-center gap-2" onSubmit={submit}>
      <Input
        size="sm"
        ground="bg"
        value={draft}
        aria-label={t`注释内容`}
        placeholder={t`为什么这条值得剪`}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={body === '' || pending}>
        <Trans>写注释</Trans>
      </Button>
    </form>
  );
}
