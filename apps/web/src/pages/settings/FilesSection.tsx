/*
 * pages/settings — 设置 · 文件与资料库.
 *
 *   数据目录      where everything this app writes goes, and what it is using
 *   监听目录      the folders watched for new Demos
 *
 * ── 数据目录 is one setting, and everything derives from it ───────────────
 *
 * Recordings, exports, proxies, the database — all of it lives under
 * `data_dir`. That is why 「游戏与录制」's 录制输出目录 row points here rather
 * than offering a second picker: two controls writing one field is how they end
 * up showing different values.
 *
 * Changing it does **not** move what is already there. The service starts using
 * the new location; the old files stay where they are. That is stated on the
 * row, because a settings change that silently orphans a library is the kind of
 * thing a user finds out about a week later.
 *
 * ── 监听目录 goes through its own hook, and not because of the route ─────
 *
 * There is no separate route: `useSetDemoWatchPaths` is a config PUT like
 * every other write here. What it adds is the *invalidation* — it refreshes
 * `qk.demos.all` as well as the config, because changing the watched folders
 * changes which Demos the library will have. A plain `useUpdateAppConfig`
 * would save the list and leave the library showing the old one until
 * something else happened to invalidate it.
 *
 * Duplicate folders are rejected before the round trip by `rejectWatchPath`,
 * which normalises Windows paths — two entries differing only by case or a
 * trailing separator name one folder, and 「移除」 would then take the wrong
 * row.
 */

import { t } from '@lingui/core/macro';
import { Plural, Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { Skeleton } from '../../design/data';
import { Dialog, Notice } from '../../design/feedback';
import { Button } from '../../design/primitives';
import {
  rejectWatchPath,
  useAppConfig,
  useSetDemoWatchPaths,
  useStorageStatus,
  useUpdateAppConfig,
} from '../../data/config';
import { dataErrorMessage } from '../../data/errors';
import { useNativeShell, useNativeShellAction } from '../../data/nativeShell';
import { useServiceAction } from '../../data/serviceAction';
import { formatBytes, PathReadout, SettingsBlock, SettingsRow } from './settingsShared';

export function FilesSection() {
  const config = useAppConfig();
  const storage = useStorageStatus();
  const update = useUpdateAppConfig();
  const setWatchPaths = useSetDemoWatchPaths();
  const service = useServiceAction();
  const shell = useNativeShell();
  const shellAction = useNativeShellAction();
  const [picking, setPicking] = useState(false);
  const [movingTo, setMovingTo] = useState<string | null>(null);

  const current = config.data;
  const busy = update.isPending || setWatchPaths.isPending || picking;
  const blocked = service.blocked || busy;
  const blockedReason = service.blocked ? service.buttonProps.disabledReason : undefined;

  const configError = dataErrorMessage(config.error);
  const writeError = dataErrorMessage(update.error) ?? dataErrorMessage(setWatchPaths.error);

  const watchPaths = current?.demo_watch_paths ?? [];

  return (
    <div className="flex flex-col">
      {configError === null ? null : (
        <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void config.refetch() }}>
          <Trans>读不到设置：{configError}</Trans>
        </Notice>
      )}
      {writeError === null ? null : (
        <Notice
          tone="danger"
          action={{
            label: <Trans>知道了</Trans>,
            onAction: () => {
              update.reset();
              setWatchPaths.reset();
            },
          }}
        >
          <Trans>这次改动没有保存：{writeError}</Trans>
        </Notice>
      )}

      <SettingsBlock
        title={<Trans>数据目录</Trans>}
        description={<Trans>录制结果、导出成片和应用自己的数据都放在这里。</Trans>}
      >
        {current === undefined ? (
          <Skeleton />
        ) : (
          <>
            <SettingsRow
              label={<Trans>位置</Trans>}
              hint={
                <Trans>
                  影响：之后所有新文件的落点。已经写好的文件不会被搬走，仍留在原来的目录里。
                </Trans>
              }
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
            >
              <div className="flex items-center gap-2.5">
                <Button
                  variant="secondary"
                  size="sm"
                  {...shellAction.buttonProps}
                  onClick={() => void shell.openDirectory(current.data_dir)}
                >
                  <Trans>打开目录</Trans>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  {...(shellAction.available
                    ? { disabled: blocked, ...(blockedReason === undefined ? {} : { disabledReason: blockedReason }) }
                    : shellAction.buttonProps)}
                  onClick={() => {
                    setPicking(true);
                    void shell
                      .chooseDirectories({ title: t`选择数据目录`, multiple: false })
                      .then((paths) => {
                        const [path] = paths;
                        if (path !== undefined && path !== current.data_dir) setMovingTo(path);
                      })
                      .finally(() => setPicking(false));
                  }}
                >
                  <Trans>更改</Trans>
                </Button>
              </div>
            </SettingsRow>
            <PathReadout path={current.data_dir} empty={<Trans>还没有设置</Trans>} />

            <SettingsRow
              label={<Trans>占用</Trans>}
              hint={<Trans>影响：磁盘剩余空间。清理入口在「输出与任务记录」。</Trans>}
            >
              {storage.isPending ? (
                <Skeleton width="10rem" />
              ) : storage.data === undefined ? (
                <span className="text-xs text-neutral-600">
                  <Trans>读不到占用统计</Trans>
                </span>
              ) : (
                <span className="font-mono text-xs text-neutral-700" data-storage-usage="">
                  <Trans>
                    已用 {formatBytes(storage.data.directory_bytes)} · 可用{' '}
                    {formatBytes(storage.data.filesystem_available_bytes)}
                  </Trans>
                </span>
              )}
            </SettingsRow>
            {storage.data?.scan_complete === false ? (
              <p className="text-xs leading-normal text-neutral-600">
                {/* The service says when it stopped counting. Printing the
                    partial total as if it were complete would understate the
                    usage on exactly the libraries where it matters. */}
                <Trans>目录太大，这次只统计了一部分，实际占用比上面多。</Trans>
              </p>
            ) : null}
          </>
        )}
      </SettingsBlock>

      <SettingsBlock
        title={<Trans>监听目录</Trans>}
        description={<Trans>这些文件夹里出现新的 Demo 会被自动收进资料库。</Trans>}
      >
        {current === undefined ? (
          <Skeleton />
        ) : (
          <>
            {watchPaths.length === 0 ? (
              <p className="text-xs leading-normal text-neutral-600">
                <Trans>还没有监听目录。加一个之后，新的 Demo 会自己进来。</Trans>
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {watchPaths.map((path) => (
                  <li key={path} className="flex items-center justify-between gap-3" data-watch-path={path}>
                    <PathReadout path={path} empty={null} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={blocked}
                      disabledReason={blockedReason ?? t`正在保存`}
                      onClick={() => {
                        if (current === undefined) return;
                        void setWatchPaths
                          .mutateAsync({
                            config: current,
                            paths: watchPaths.filter((each) => each !== path),
                          })
                          .catch(() => undefined);
                      }}
                    >
                      <Trans>移除</Trans>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button
                variant="secondary"
                size="sm"
                {...(shellAction.available
                  ? { disabled: blocked, ...(blockedReason === undefined ? {} : { disabledReason: blockedReason }) }
                  : shellAction.buttonProps)}
                onClick={() => {
                  setPicking(true);
                  void shell
                    .chooseDirectories({ title: t`选择要监听的目录`, multiple: true })
                    .then((paths) => {
                      /* `rejectWatchPath` rather than `includes`: on Windows
                         two strings differing only by case or a trailing
                         separator are the same folder, and the picker has no
                         idea what the list already holds. */
                      const added: string[] = [];
                      for (const path of paths) {
                        if (rejectWatchPath(path, [...watchPaths, ...added]) === null) added.push(path);
                      }
                      if (added.length > 0) {
                        void setWatchPaths
                          .mutateAsync({ config: current, paths: [...watchPaths, ...added] })
                          .catch(() => undefined);
                      }
                    })
                    .finally(() => setPicking(false));
                }}
              >
                <Trans>添加目录</Trans>
              </Button>
            </div>
            <p className="text-xs leading-normal text-neutral-600">
              <Plural
                value={watchPaths.length}
                _0="影响：目前不会自动发现任何 Demo。"
                other="影响：这 # 个目录里的新 Demo 会自动进入资料库。"
              />
            </p>
          </>
        )}
      </SettingsBlock>

      <Dialog
        open={movingTo !== null}
        title={<Trans>把数据目录改到这里？</Trans>}
        confirmLabel={<Trans>改为这个目录</Trans>}
        confirmDisabled={update.isPending}
        onConfirm={() => {
          if (current === undefined || movingTo === null) return;
          void update.mutateAsync({ ...current, data_dir: movingTo }).catch(() => undefined);
          setMovingTo(null);
        }}
        onClose={() => setMovingTo(null)}
      >
        <Trans>
          之后的新文件会写到 {movingTo}。已经在旧目录里的录制结果、成片和索引不会被搬过去，
          资料库里它们的记录也还指向旧位置。
        </Trans>
      </Dialog>
    </div>
  );
}
