/*
 * pages/library — the 52px strip under the toolbar of 「02 Demo 资料库」.
 *
 * The artboard draws, left to right: a search box, four dropdown chips (地图 /
 * 状态 / 来源 / 标签), a hairline, the saved-view tags, then 列配置 and
 * 导出元数据 flush right. `design/layout/Page`'s `bar` slot is the strip;
 * `--h-bar` is its height (§3.4 merges the drawn 50 / 52 into 46).
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
 *   来源   `DemoMatchSource`, likewise
 *   标签   `useReviewTags()`, a real catalogue endpoint
 *   地图   **derived from the rows on screen**, plus whatever is selected. The
 *          bridge has no map-catalogue command (`getRadarOverview` takes a name
 *          and gives a picture), so this is the only list that exists. Keeping
 *          the selected value in it means a filter can always be cleared even
 *          after it has narrowed its own menu down to one entry. Reported as a
 *          gap rather than hidden.
 *
 * 「近 7 天」, the second tag the artboard draws, is absent: `DemoQuery` has no
 * date range, so the chip would filter nothing.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Search } from 'lucide-react';

import { OverflowMenu, type OverflowMenuItem } from '../../design/layout';
import { Badge, Button, InputGroup, InputGroupAddon, InputGroupInput } from '../../design/primitives';
import type { DemoLifecycleStatus, DemoMatchSource, ReviewTag } from '../../shared/desktop/dto';
import type { LibraryAddress } from './libraryQuery';

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

export interface SavedLibraryView {
  readonly name: string;
  readonly address: LibraryAddress;
}

export interface LibraryFiltersProps {
  readonly address: LibraryAddress;
  readonly onChange: (change: Partial<LibraryAddress>) => void;
  /** Map names on the current page — the only catalogue that exists. */
  readonly mapNames: readonly string[];
  readonly tags: readonly ReviewTag[];
  readonly savedViews: readonly SavedLibraryView[];
  readonly onApplySavedView: (view: SavedLibraryView) => void;
  readonly onSaveView: () => void;
  readonly onConfigureColumns: () => void;
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
}: LibraryFiltersProps) {
  const { i18n } = useLingui();

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
      className="flex h-[var(--h-bar)] flex-none items-center gap-2.5 overflow-x-auto overscroll-x-contain border-b border-divider bg-surface-chrome px-7"
    >
      <InputGroup size="sm" ground="bg" className="min-w-0 max-w-[var(--w-panel)] flex-1">
        <InputGroupAddon>
          <Search strokeWidth={1.5} />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={t`搜索比赛、选手或文件名`}
          placeholder={t`搜索比赛、选手或文件名`}
          value={address.search}
          onChange={(event) => {
            onChange({ search: event.target.value });
          }}
        />
      </InputGroup>

      <FilterMenu name={t`地图`} current={currentMap} items={mapItems} />
      <FilterMenu name={t`状态`} current={currentStatus} items={statusItems} />
      <FilterMenu name={t`来源`} current={currentSource} items={sourceItems} />
      <FilterMenu name={t`标签`} current={currentTag} items={tagItems} />

      <span className="h-5 w-px flex-none bg-divider" aria-hidden="true" />

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
      <Button size="sm" variant="ghost" className="flex-none" onClick={onSaveView}>
        <Trans>保存为视图</Trans>
      </Button>

      <div className="flex-1" aria-hidden="true" />

      <Button size="sm" variant="ghost" className="flex-none" onClick={onConfigureColumns}>
        <Trans>列配置</Trans>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="flex-none"
        disabled
        disabledReason={t`暂不支持把导出的文件保存到磁盘`}
      >
        <Trans>导出元数据</Trans>
      </Button>
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
}: {
  name: string;
  current: string;
  items: readonly OverflowMenuItem[];
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
      triggerClassName="h-[var(--h-ctl-sm)] max-w-[var(--w-subnav)] border border-divider text-text"
      items={items}
    />
  );
}
