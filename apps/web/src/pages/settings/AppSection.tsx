/*
 * pages/settings — 设置 · 应用.
 *
 * The artboard names this section and does not draw its rows, so what is in it
 * is decided by what `AppConfig` actually carries at the application level:
 * `locale`, `theme`, `update_manifest_url`. Three fields, three rows, nothing
 * invented around them.
 *
 * ── 语言 and 主题 write through and take effect at the next read ──────────
 *
 * Both are stored settings, and both are *also* live UI state that the shell
 * already owns — `app/` picks the locale for Lingui and the theme for the
 * `data-theme` attribute. This section writes the stored value; it does not
 * reach into the shell to switch the running app, because two writers for one
 * piece of state is how they end up disagreeing.
 *
 * That is a real limitation and it is stated on screen: the change is saved,
 * and it applies the next time the app starts. Silently doing half of it would
 * be worse than saying which half.
 *
 * ── 更新源 ────────────────────────────────────────────────────────────────
 *
 * `update_manifest_url` is an administrator-controlled HTTPS manifest for
 * manual update checks. Empty means "no manifest", which is the default and a
 * legitimate answer — so the field is optional and the hint says what an empty
 * value means rather than leaving a blank box to be interpreted.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';

import { Skeleton } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Seg, Input } from '../../design/primitives';
import { useAppConfig, useUpdateAppConfig } from '../../data/config';
import { dataErrorMessage } from '../../data/errors';
import type { AppConfig } from '../../shared/desktop/dto';
import { SettingsBlock, SettingsRow } from './settingsShared';

/** The two Lingui catalogues that exist. A third would need a catalogue first. */
const LOCALES = [
  // lint-copy-ok: endonyms. A language picker whose options are translated into
  // the language currently active shows the reader only the names they cannot
  // read — the one place where not translating is the accessible choice.
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
] as const;

/** The two `data-theme` values `design/theme.css` defines. */
const THEMES = ['light', 'dark'] as const;

export function AppSection() {
  const config = useAppConfig();
  const update = useUpdateAppConfig();
  const [manifestDraft, setManifestDraft] = useState<string | null>(null);

  const current = config.data;
  const blocked = update.isPending;
  const blockedReason = blocked ? t`正在保存` : undefined;
  const write = (next: AppConfig) => void update.mutateAsync(next).catch(() => undefined);

  const configError = dataErrorMessage(config.error);
  const writeError = dataErrorMessage(update.error);

  const manifest = manifestDraft ?? current?.update_manifest_url ?? '';
  const manifestInvalid = manifest.trim() !== '' && !manifest.trim().startsWith('https://');

  return (
    <div className="flex flex-col">
      {configError === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void config.refetch() }}>
          <Trans>读不到设置：{configError}</Trans>
        </Alert>
      )}
      {writeError === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>知道了</Trans>, onAction: () => update.reset() }}>
          <Trans>这次改动没有保存：{writeError}</Trans>
        </Alert>
      )}

      <SettingsBlock id="appearance" title={<Trans>外观与语言</Trans>}>
        {current === undefined ? (
          <Skeleton />
        ) : (
          <>
            <SettingsRow
              label={<Trans>语言</Trans>}
              hint={<Trans>界面文案使用的语言。改动会保存，下次启动应用时生效。</Trans>}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
            >
              <Seg
                name="app-locale"
                size="sm"
                value={current.locale}
                aria-label={t`界面语言`}
                options={LOCALES.map((locale) => ({
                  value: locale.value,
                  label: locale.label,
                  disabled: blocked,
                }))}
                onChange={(locale) => write({ ...current, locale })}
              />
            </SettingsRow>

            <SettingsRow
              label={<Trans>主题</Trans>}
              hint={<Trans>界面使用的配色。改动会保存，下次启动应用时生效。</Trans>}
              {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
            >
              <Seg
                name="app-theme"
                size="sm"
                value={THEMES.includes(current.theme as (typeof THEMES)[number]) ? current.theme : 'light'}
                aria-label={t`主题`}
                options={[
                  { value: 'light', label: <Trans>浅色</Trans>, disabled: blocked },
                  { value: 'dark', label: <Trans>深色</Trans>, disabled: blocked },
                ]}
                onChange={(theme) => write({ ...current, theme })}
              />
            </SettingsRow>
          </>
        )}
      </SettingsBlock>

      <SettingsBlock id="updates" title={<Trans>更新</Trans>}>
        {current === undefined ? (
          <Skeleton />
        ) : (
          <SettingsRow
            label={<Trans>更新源</Trans>}
            hint={
              <Trans>
                手动检查更新时读取的清单地址。留空表示不检查更新，这也是默认。
              </Trans>
            }
            {...(blockedReason === undefined ? {} : { disabledReason: blockedReason })}
          >
            <div className="flex min-w-72 flex-1 flex-col gap-1">
              <Input
                value={manifest}
                disabled={blocked}
                data-setting="update-manifest"
                aria-label={t`更新源地址`}
                placeholder="https://"
                invalid={manifestInvalid}
                onChange={(event) => setManifestDraft(event.target.value)}
                onBlur={() => {
                  /* An invalid value *keeps* its draft: clearing it would
                     restore the stored URL under the user's cursor and take
                     the error message with it, so the field would appear to
                     have accepted and then forgotten what they typed. */
                  if (manifestInvalid) return;
                  const next = manifest.trim();
                  setManifestDraft(null);
                  if (next === current.update_manifest_url) return;
                  write({ ...current, update_manifest_url: next });
                }}
              />
              {manifestInvalid ? (
                <p className="text-xs leading-normal text-fail-text">
                  {/* Refused here rather than at the service, because the
                      service's message would arrive after the field lost
                      focus and the user moved on. */}
                  <Trans>只接受 https:// 开头的地址。</Trans>
                </p>
              ) : null}
            </div>
          </SettingsRow>
        )}
      </SettingsBlock>
    </div>
  );
}
