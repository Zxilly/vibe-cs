/*
 * App shell — the command palette (Ctrl K, expanded state).
 *
 * SOURCE
 * ------
 * 「补齐 · 壳层规格」artboard, first cell, 「命令面板 · 展开态」. Its caption is
 * the behavioural spec: 「Ctrl K。结果按对象类型分组，每组最多 4 条，回车执行首条」.
 * The 页面状态机 board adds the reason it exists: 「本来就能直达任意页面」, drawn
 * as a dotted accent box with no incoming edges — it is a navigation surface,
 * not a step in any flow.
 *
 * Read off the artboard, value by value:
 *   scrim     `neutral-900` at 34%, starting *below* the title bar, so the
 *             44px window chrome (drag region, window buttons) stays usable
 *             while the palette is up
 *   panel     centred, one title-bar height below the chrome (the artboard's
 *             `top:84px` against its own 40px bar), `1px solid neutral-500`,
 *             `--shadow-lg`, on `--color-bg`
 *   header    52px: search glyph, the query, a 「ESC 关闭」chip on the right
 *   group     11px `--font-heading`, `.16em` tracking, neutral-600
 *   row       40px, 14px title, muted hint on the right; the selected row takes
 *             `accent-100` with `inset 2px 0 0 accent` and an ↵ chip
 *   footer    36px: ↑↓ 选择 · ↵ 打开 · TAB 切换分组 · 搜索比赛、选手、证据、页面和动作
 *
 * Three of those sizes are not §3 tokens and are folded, not copied:
 *   52 → `--h-topbar` (56). A 4px fold, the same magnitude §3.4 already signs
 *        off on for 38/44 → 40 and 96 → 92. The row *is* the palette's top bar,
 *        so the bar family is the right one; `--h-row-evidence` is also 52 but
 *        means "two-line evidence row", which this is not.
 *   40 → `--h-row-compact`, whose §3.4 claim list is [38, 34, 36, 40].
 *   36 → `--h-row-compact` as well, same claim list.
 * The 600px width is `--w-overlay`, added to §3.5 for this surface. It is not a
 * fold onto an existing width: the palette is an absolutely positioned card, a
 * role no width in the table had, and folding it onto `--w-split` (520) would
 * have been the widest fold in the table for no reason beyond avoiding a token.
 *
 * WHY NOT `design/feedback/Dialog`
 * --------------------------------
 * Dialog *is* a confirmation by construction: `confirmLabel` and `onConfirm`
 * are required and it always renders a 取消 / 主动作 row. Its own header says so
 * — "Dialog 只承载不可逆动作与正式确认（删除、停止、覆盖）". The palette confirms
 * nothing and has no action row; building it out of Dialog would mean passing a
 * fake confirm handler and hiding the row it insists on rendering. Drawer is
 * the other overlay and is an edge-anchored panel, which this is not.
 *
 * What is reused is the part the artboard actually shares between the three:
 * 「两者都有焦点陷阱、Esc 关闭和关闭后焦点归位」 — Radix's Dialog, the same one
 * Dialog and Drawer use. Esc and focus restoration are therefore one
 * implementation across every overlay in the app, not three.
 *
 * TWO MORE PRIMITIVES THAT DO NOT FIT
 * -----------------------------------
 * `primitives/Input` is a bordered box at one of the four §3.3 control
 * heights — that border *is* the component. The palette's field is a bar: no
 * border of its own, the full width of a 52px header, separated by the header's
 * bottom rule. Using it would mean overriding its border, its height and its
 * padding, i.e. all of it.
 *
 * `data/Empty` is a bordered, centred block with a *required* recovery
 * action ("每条都带一个主要恢复动作"). The palette's empty state has no action to
 * offer — the recovery is to keep typing, which the still-focused field already
 * invites — and a framed box inside a floating panel would draw a second border
 * a few pixels inside the first.
 *
 * KEYBOARD MODEL
 * --------------
 * The list is a combobox popup, not a row of buttons: the input keeps focus and
 * `aria-activedescendant` names the active row. Two things follow, both wanted.
 * TAB is free to mean 「切换分组」 (the artboard's own hint) instead of walking
 * rows, and the focus trap has exactly one focusable element in it, so it can
 * never strand the user on a row. Rows are `role="option"`, not `<button>`,
 * for the same reason.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { Search } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import { Dialog as DialogPrimitive } from 'radix-ui';

import { useOverlayReturnFocus } from '../../design/feedback';
import { cn, Kbd } from '../../design/primitives';
import {
  buildCommandList,
  COMMAND_GROUP_LABEL,
  resolveCommands,
  type CommandDefinition,
  type ResolvedCommand,
} from './commandRegistry';
import {
  DEFAULT_GROUP_LIMIT,
  flattenCommandResults,
  nextGroupSelectionIndex,
  nextSelectionIndex,
  searchCommands,
} from './commandSearch';

export interface CommandPaletteProps {
  readonly open: boolean;
  /** Esc, the scrim, and running a command all route here. */
  readonly onClose: () => void;
  /**
   * Where a page command sends the app — in the shell, react-router's
   * `useNavigate()`. Injected rather than taken from context so the palette
   * stays renderable (and testable) without a router around it.
   */
  readonly navigate: (to: string) => void;
  /** Defaults to `buildCommandList()`. Pass extensions through that helper. */
  readonly commands?: readonly CommandDefinition[] | undefined;
  /** 「每组最多 4 条」. Overridable for a host that has more room. */
  readonly limitPerGroup?: number | undefined;
}

export function CommandPalette({
  open,
  onClose,
  navigate,
  commands,
  limitPerGroup = DEFAULT_GROUP_LIMIT,
}: CommandPaletteProps) {
  const { i18n } = useLingui();
  const baseId = useId();
  const returnFocus = useOverlayReturnFocus(open);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  // The palette stays mounted while closed (the shell renders it next to the
  // title bar), so each opening has to clear the last session's query rather
  // than relying on a fresh mount.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
  }, [open]);

  // Deliberately not memoized. The list is a dozen commands, resolving is a
  // dozen catalog lookups, and a `useMemo` keyed on the i18n context is the
  // usual way a palette ends up showing the previous locale after a language
  // switch (spec §5.2 makes activation asynchronous, so that switch happens
  // under a mounted tree).
  const resolved = resolveCommands(commands ?? buildCommandList(), (descriptor) => i18n._(descriptor));
  const groups = searchCommands(resolved, query, { limitPerGroup });
  const flat = flattenCommandResults(groups);
  const activeIndex = flat.length === 0 ? -1 : Math.min(selected, flat.length - 1);
  const active = activeIndex === -1 ? undefined : flat[activeIndex];

  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const run = (command: ResolvedCommand) => {
    command.run({ navigate });
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(nextSelectionIndex(activeIndex, 1, flat.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(nextSelectionIndex(activeIndex, -1, flat.length));
      return;
    }
    if (event.key === 'Tab') {
      const next = nextGroupSelectionIndex(groups, activeIndex);
      if (next === -1) return;
      // Radix's focus scope also answers Tab. Stopping propagation keeps the
      // two from fighting over the same key; the scope would only re-focus
      // this input anyway, since it is the sole focusable element in the panel.
      event.preventDefault();
      event.stopPropagation();
      setSelected(next);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active !== undefined) run(active);
    }
    // Escape is not handled here: Radix's dismissable layer owns it, and it
    // owns it per overlay rather than on `document`.
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* Starts below the title bar: the artboard draws the scrim as
            `inset:40px 0 0 0` over its own 40px bar, keeping the window
            chrome lit. */}
        <DialogPrimitive.Overlay
          data-overlay="command-palette-backdrop"
          className="fixed inset-x-0 bottom-0 top-[var(--h-titlebar)] z-50 bg-neutral-900/34"
        />
        <DialogPrimitive.Content
          aria-label={t`命令面板`}
          aria-describedby={undefined}
          onCloseAutoFocus={returnFocus}
          data-overlay="command-palette"
          className={
            'fixed inset-x-0 top-[calc(var(--h-titlebar)*2)] z-50 mx-auto flex h-fit ' +
            'max-h-[calc(100%-var(--h-titlebar)*2-1rem)] w-[var(--w-overlay)] max-w-[calc(100%-2rem)] ' +
            'flex-col border border-neutral-500 bg-bg shadow-[var(--shadow-lg)]'
          }
        >
        <div className="flex h-[var(--h-topbar)] flex-none items-center gap-3 border-b border-divider px-4">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" className="flex-none text-neutral-600" />
          <input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex === -1 ? undefined : optionId(activeIndex)}
            aria-label={t`搜索比赛、选手、证据、页面和动作`}
            placeholder={t`跳转、搜索比赛或证据`}
            className="min-w-0 flex-1 bg-transparent text-md placeholder:text-neutral-600"
          />
          {/* A key name plus its verb; the artboard prints both, so both go
              through the macro rather than only the Chinese half. */}
          <span className="flex-none text-2xs text-neutral-600">
            <Kbd>ESC</Kbd> <Trans>关闭</Trans>
          </span>
        </div>

        {flat.length === 0 ? (
          <div role="status" className="flex flex-col gap-1 px-4 py-4">
            <p className="text-base">
              <Trans>没有匹配的结果</Trans>
            </p>
            {/* States the matching contract instead of apologising: the search
                is prefix / substring only, so "为什么搜不到" has an answer. */}
            <p className="text-xs leading-normal text-neutral-600">
              <Trans>换一个更短的关键词，或用页面名、路径、英文名。不做拼音和模糊匹配。</Trans>
            </p>
          </div>
        ) : (
          <div id={listId} role="listbox" aria-label={t`命令`} className="max-h-[60vh] overflow-y-auto py-2">
            {groups.map((group) => {
              const headingId = `${baseId}-group-${group.group}`;
              const hidden = group.total - group.commands.length;
              return (
                <div key={group.group} role="group" aria-labelledby={headingId}>
                  <div
                    id={headingId}
                    className="px-4 pt-3 pb-1 font-heading text-2xs tracking-caps text-neutral-600"
                  >
                    {i18n._(COMMAND_GROUP_LABEL[group.group])}
                  </div>
                  {group.commands.map((command) => {
                    const index = flat.indexOf(command);
                    const isActive = index === activeIndex;
                    return (
                      <div
                        key={command.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isActive}
                        data-command-id={command.id}
                        onClick={() => {
                          run(command);
                        }}
                        className={cn(
                          'flex h-[var(--h-row-compact)] cursor-default items-center gap-3 px-4',
                          isActive
                            ? 'bg-accent-100 text-accent-900 shadow-[inset_2px_0_0_var(--color-accent)]'
                            : 'hover:bg-surface',
                        )}
                      >
                        <span className="min-w-0 truncate text-base">{command.title}</span>
                        <span className="flex-1" />
                        {command.hint === null ? null : (
                          <span
                            className={cn(
                              'flex-none text-xs',
                              isActive ? 'text-accent-800' : 'text-neutral-600',
                            )}
                          >
                            {command.hint}
                          </span>
                        )}
                        {command.shortcut === null ? null : (
                          <Kbd className="tracking-wide">{command.shortcut}</Kbd>
                        )}
                        {isActive ? (
                          <Kbd className="border-accent-300 text-accent-700">↵</Kbd>
                        ) : null}
                      </div>
                    );
                  })}
                  {hidden > 0 ? (
                    // The cap hides rows, so the palette says how many rather
                    // than truncating silently.
                    <div className="px-4 pb-1 text-2xs text-neutral-600">
                      <Plural value={hidden} other="还有 # 条 · 继续输入以缩小范围" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex h-[var(--h-row-compact)] flex-none items-center gap-5 border-t border-divider px-4 text-2xs text-neutral-600">
          <span>
            <Trans>↑↓ 选择</Trans>
          </span>
          <span>
            <Trans>↵ 打开</Trans>
          </span>
          <span>
            <Trans>TAB 切换分组</Trans>
          </span>
          <span className="flex-1" />
          <span className="min-w-0 truncate">
            <Trans>搜索比赛、选手、证据、页面和动作</Trans>
          </span>
        </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
