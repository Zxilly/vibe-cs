/*
 * Domain layer, 2 of 3 — agent/AgentObjectRefChip.
 *
 * 「方案 #P-118 · 改过 2 次」 — one object a session touched, as the drawer's
 * session rows and the 引用中 line draw it. §4.5.1's Reference is a *two-way*
 * record, so the same chip is what a plan's 改动来源 list uses for the objects
 * on the other side of it.
 *
 * ── Three small decisions ─────────────────────────────────────────────────
 *
 * **The kind is an icon plus a screen-reader word, not a prefix.**
 * `AgentObjectRef.label` is whatever the server named the object, and the
 * artboard's 「方案 #P-118」 may already be that whole string; prefixing the kind
 * would produce 「方案 方案 #P-118」 on a backend that includes it. The icon
 * comes from `AGENT_OBJECT_KIND`, which is total over the four kinds, so an
 * unknown kind cannot render as a blank chip.
 *
 * **「改过 N 次」 appears only when N > 1.** `touch_count` is 1 for an object a
 * session has touched once, and 「改过 1 次」 is noise on every chip in the
 * drawer — the artboard prints the count on exactly one of its five rows. This
 * is the same 「后端没有的字段一律省略，不要渲染 0」 rule applied to a 1.
 *
 * **`status` is not drawn here.** It is free text on the wire
 * (`agentContract.ts` gap 9) and cannot be mapped to `StatusDot`'s closed set;
 * the rows that need it print the server's own sentence themselves.
 */

import { useLingui } from '@lingui/react';
import { Plural } from '@lingui/react/macro';

import { Badge, type BadgeVariant } from '../../design/primitives';
import type { AgentObjectRef } from '../../shared/desktop/dto';

import { AGENT_OBJECT_KIND } from './types';

export interface AgentObjectRefChipProps {
  readonly objectRef: AgentObjectRef;
  readonly tone?: BadgeVariant | undefined;
  /** Makes the chip a button — 「打开这个对象」. */
  readonly onSelect?: ((objectRef: AgentObjectRef) => void) | undefined;
  readonly className?: string | undefined;
}

export function AgentObjectRefChip({ objectRef, tone = 'neutral', onSelect, className }: AgentObjectRefChipProps) {
  const { i18n } = useLingui();

  const kind = AGENT_OBJECT_KIND[objectRef.kind];
  const KindIcon = kind.icon;

  const body = (
    <>
      <KindIcon size={11} strokeWidth={1.5} aria-hidden="true" className="flex-none" />
      <span className="sr-only">{i18n._(kind.label)} </span>
      <span className="min-w-0 truncate">{objectRef.label}</span>
      {objectRef.touch_count > 1 ? (
        <span data-ref-touches={objectRef.touch_count} className="flex-none">
          · <Plural value={objectRef.touch_count} other="改过 # 次" />
        </span>
      ) : null}
    </>
  );

  const shared = `max-w-full gap-1 ${className ?? ''}`.trimEnd();

  return onSelect === undefined ? (
    <Badge data-agent-object-ref={objectRef.id} data-object-kind={objectRef.kind} variant={tone} className={shared}>
      {body}
    </Badge>
  ) : (
    <Badge
      asChild
      data-agent-object-ref={objectRef.id}
      data-object-kind={objectRef.kind}
      variant={tone}
      className={shared}
      title={objectRef.summary === '' ? undefined : objectRef.summary}
      onClick={() => onSelect(objectRef)}
    >
      <button type="button">
        {body}
      </button>
    </Badge>
  );
}
