/*
 * Search, active filters and saved views under the library toolbar.
 *
 * The artboard draws, left to right: a search box, four dropdown chips (地图 /
 * 状态 / 平台 / 标签), the saved-view tags, then 列配置 and
 * 导出元数据 flush right. `design/layout/Page`'s `bar` slot is the strip;
 * `--h-bar` is its minimum height.
 *
 * The search box is the one flexible item: it grows to `--w-panel` and never
 * shrinks below `--w-subnav`. Controls wrap in narrow desktop windows so
 * reset and library actions remain visible without horizontal scrolling.
 *
 * ## The dropdowns are `OverflowMenu`
 *
 * There is no Select in `design/primitives` — the reference never draws an open
 * one — but `OverflowMenu` is exactly the 「地图：Mirage ▾」 disclosure, keyboard
 * contract included, and it already marks the current item. Reusing it beats
 * inventing a ninth primitive inside a page (the brief: 「能复用就必须复用」).
 *
 * ## Where each dropdown's options come from
 *
 *   状态   `DemoLifecycleStatus`, a closed enum on the wire
 *   平台   `DemoMatchSource`, likewise. The chip is named 平台 rather than the
 *          artboard's 来源 because the table's 来源 column is a different field
 *          — how the file arrived (本地文件 / 监听目录 / 已导入) — and one word
 *          for two facts made a FACEIT filter look broken next to a column of
 *          「本地文件」.
 *   标签   `useReviewTags()`, a real catalogue endpoint
 *   地图   `useDemoMapNames()` — every distinct map in the catalogue, so the
 *          menu keeps offering the other maps after one is picked.
 *
 * 「近 7 天」, the second tag the artboard draws, is absent: `DemoQuery` has no
 * date range, so the chip would filter nothing.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Search, X } from 'lucide-react';
import { useRef } from 'react';

import { OverflowMenu, type OverflowMenuItem } from '../../../design/layout';
import { Badge, Button, cn, InputGroup, InputGroupAddon, InputGroupInput } from '../../../design/primitives';
import type { DemoLifecycleStatus, DemoMatchSource, ReviewTag } from '../../../shared/desktop/dto';
import type { ActionAvailability } from './libraryColumns';
import { clearLibraryFilters, hasActiveFilter, type LibraryAddress } from './libraryQuery';
import type { SavedLibraryView } from './librarySession';

/** The wire's six record states, in the order `DemoRecord.status` declares. */
const STATUS_OPTIONS: readonly { value: DemoLifecycleStatus; label: MessageDescriptor }[] = [
  { value: 'discovered', label: msg`待索引` },
  { value: 'indexing', label: msg`索引中` },
  { value: 'ready', label: msg`已就绪` },
  { value: 'analyzing', label: msg`分析中` },
  { value: 'failed', label: msg`索引失败` },
  { value: 'missing', label: msg`文件缺失` },
];

/**
 * `DemoMatchSource` — the platform a match was played on. These are proper
 * nouns, so they are not translated and carry no macro.
 */
const MATCH_SOURCE_OPTIONS: readonly { value: DemoMatchSource; label: string }[] = [
  { value: 'valve', label: 'Valve' },
  { value: 'faceit', label: 'FACEIT' },
  { value: 'esl', label: 'ESL' },
  { value: 'esportal', label: 'Esportal' },
  { value: 'esplay', label: 'Esplay' },
  { value: 'esportligaen', label: 'Esportligaen' },
  { value: 'challengermode', label: 'Challengermode' },
  { value: 'ebot', label: 'eBot' },
  { value: 'fastcup', label: 'FastCup' },
  { value: 'five_eplay', label: '5EPlay' },
  { value: 'matchzy', label: 'MatchZy' },
  // lint-copy-ok: a brand, like every other name in this list. Perfect World
  // publishes CS in China under this name and does not use a Latin one there.
  { value: 'perfect_world', label: '完美世界' },
  { value: 'pracc', label: 'PRACC' },
  { value: 'renown', label: 'Renown' },
];

export interface LibraryFiltersProps {
  readonly address: LibraryAddress;
  readonly onChange: (change: Partial<LibraryAddress>) => void;
  /** Every distinct map in the catalogue, from `useDemoMapNames()`. */
  readonly mapNames: readonly string[];
  readonly tags: readonly ReviewTag[];
  readonly savedViews: readonly SavedLibraryView[];
  readonly onApplySavedView: (view: SavedLibraryView) => void;
  readonly onSaveView: () => void;
  readonly onConfigureColumns: () => void;
  /** 「导出元数据」 — writes the current query's rows to a file the user picks. */
  readonly onExport: () => void;
  readonly exportButtonProps: ActionAvailability;
}

export function LibraryFilters({
  address,
  onChange,
  mapNames,
  tags,
  savedViews,
  onApplySavedView,
  onSaveView,
  onConfigureColumns,
  onExport,
  exportButtonProps,
}: LibraryFiltersProps) {
  const { i18n } = useLingui();
  const searchInput = useRef<HTMLInputElement>(null);

  // The selected map stays listed while the catalogue is still loading, so a
  // pasted `?map=` address can be cleared before the list arrives.
  const maps = [...new Set([...mapNames, ...(address.map === '' ? [] : [address.map])])].sort();

  const mapItems = withAll(
    address.map,
    maps.map((name) => ({ value: name, label: name })),
    (value) => {
      onChange({ map: value });
    },
  );

  const statusItems = withAll(
    address.status,
    STATUS_OPTIONS.map((option) => ({ value: option.value, label: i18n._(option.label) })),
    (value) => {
      onChange({ status: value as DemoLifecycleStatus | '' });
    },
  );

  const sourceItems = withAll(
    address.source,
    MATCH_SOURCE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    (value) => {
      onChange({ source: value as DemoMatchSource | '' });
    },
  );

  const tagItems = withAll(
    address.tagId,
    tags.map((tag) => ({ value: tag.id, label: tag.name })),
    (value) => {
      onChange({ tagId: value });
    },
  );

  const currentMap = address.map === '' ? t`全部` : address.map;
  const currentStatus = labelOf(
    STATUS_OPTIONS.map((option) => ({ value: option.value, label: i18n._(option.label) })),
    address.status,
  );
  const currentSource = labelOf(MATCH_SOURCE_OPTIONS, address.source);
  const currentTag = labelOf(
    tags.map((tag) => ({ value: tag.id, label: tag.name })),
    address.tagId,
  );

  return (
    <div
      data-library-filters
      className="flex min-h-[var(--h-bar)] flex-none flex-wrap items-center gap-2 border-b border-divider bg-surface-chrome px-6 py-2"
    >
      <InputGroup
        size="sm"
        ground="bg"
        className="min-w-[var(--w-subnav)] max-w-[var(--w-panel)] flex-1 basis-[var(--w-subnav)]"
      >
        <InputGroupAddon>
          <Search strokeWidth={1.5} />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchInput}
          aria-label={t`搜索比赛、选手或文件名`}
          placeholder={t`搜索比赛、选手或文件名`}
          value={address.search}
          onChange={(event) => {
            onChange({ search: event.target.value });
          }}
        />
        {address.search === '' ? null : (
          <InputGroupAddon align="inline-end" aria-hidden={false}>
            <Button
              size="sm"
              variant="ghost"
              icon
              aria-label={t`清空搜索`}
              onClick={() => {
                onChange({ search: '' });
                searchInput.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </InputGroupAddon>
        )}
      </InputGroup>

      <FilterMenu name={t`地图`} current={currentMap} items={mapItems} active={address.map !== ''} />
      <FilterMenu name={t`状态`} current={currentStatus} items={statusItems} active={address.status !== ''} />
      <FilterMenu name={t`平台`} current={currentSource} items={sourceItems} active={address.source !== ''} />
      <FilterMenu name={t`标签`} current={currentTag} items={tagItems} active={address.tagId !== ''} />

      {hasActiveFilter(address) ? (
        <Button size="sm" variant="ghost" onClick={() => {
          onChange(clearLibraryFilters(address));
          searchInput.current?.focus();
        }}>
          <Trans>重置筛选</Trans>
        </Button>
      ) : null}

      {savedViews.map((view) => (
        <Badge
          key={view.name}
          asChild
          variant="accent"
          className="flex-none"
          onClick={() => {
            onApplySavedView(view);
          }}
        >
          <button type="button">
            <Trans>保存的视图 · {view.name}</Trans>
          </button>
        </Badge>
      ))}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onSaveView}>
          <Trans>保存为视图</Trans>
        </Button>
        <Button size="sm" variant="ghost" onClick={onConfigureColumns}>
          <Trans>列配置</Trans>
        </Button>
        <Button size="sm" variant="ghost" {...exportButtonProps} onClick={onExport}>
          <Trans>导出元数据</Trans>
        </Button>
      </div>
    </div>
  );
}

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 「全部」 first, then the options, with the current one marked. Always
 * offering 全部 is what keeps a filter escapable — §8's rule that a blocked
 * action is disabled rather than removed, applied to a menu.
 */
function withAll(
  current: string,
  options: readonly FilterOption[],
  onSelect: (value: string) => void,
): readonly OverflowMenuItem[] {
  return [
    {
      id: '',
      label: t`全部`,
      current: current === '',
      onSelect: () => {
        onSelect('');
      },
    },
    ...options.map((option) => ({
      id: option.value,
      label: option.label,
      current: option.value === current,
      onSelect: () => {
        onSelect(option.value);
      },
    })),
  ];
}

function labelOf(options: readonly FilterOption[], value: string): string {
  if (value === '') return t`全部`;
  return options.find((option) => option.value === value)?.label ?? value;
}

/** 「地图：Mirage ▾」 — the artboard's chip, at `--h-ctl-sm`. */
function FilterMenu({
  name,
  current,
  items,
  active,
}: {
  name: string;
  current: string;
  items: readonly OverflowMenuItem[];
  active: boolean;
}) {
  return (
    <OverflowMenu
      className="flex-none"
      label={name}
      align="start"
      triggerLabel={
        <span className="truncate">
          {name}
          {'：'}
          {current}
        </span>
      }
      triggerClassName={cn(
        'h-[var(--h-ctl-sm)] max-w-[var(--w-subnav)] border',
        active ? 'border-accent bg-accent-100 text-accent-800' : 'border-divider text-text',
      )}
      items={items}
    />
  );
}
