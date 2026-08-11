import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const han = /\p{Script=Han}/u;

function productionModules(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return target.endsWith(path.join('shared', 'i18n')) ? [] : productionModules(target);
    }
    return /\.(ts|tsx)$/u.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/u.test(entry.name) ? [target] : [];
  });
}

describe('complete typed UI localization', () => {
  it('keeps production Han copy inside the typed catalog', () => {
    const sourceRoot = path.resolve(import.meta.dirname, '../..');
    const offenders = productionModules(sourceRoot)
      .filter((file) => han.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });

  it('renders every primary workspace route without Han text in en-US', async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import('./index')>('./index');
    vi.doMock('./index', () => ({
      ...actual,
      currentLocale: () => 'en-US',
      msg: (key: Parameters<typeof actual.msg>[0]) => actual.msg(key, 'en-US'),
      msgf: (key: Parameters<typeof actual.msgf>[0], values: Parameters<typeof actual.msgf>[1]) => actual.msgf(key, values, 'en-US'),
      useI18n: () => ({
        locale: 'en-US',
        t: (key: Parameters<typeof actual.translate>[1]) => actual.translate('en-US', key),
        text: (key: Parameters<typeof actual.msg>[0]) => actual.msg(key, 'en-US'),
        format: (key: Parameters<typeof actual.msgf>[0], values: Parameters<typeof actual.msgf>[1]) => actual.msgf(key, values, 'en-US'),
      }),
    }));
    const modules = await Promise.all([
      import('../../features/guide/GuidePage'),
      import('../../features/library/LibraryPage'),
      import('../../features/analysis/AnalysisPage'),
      import('../../features/players/PlayersPage'),
      import('../../features/production/ProductionPage'),
      import('../../features/queue/QueuePage'),
      import('../../features/studio/StudioPage'),
      import('../../features/montage/MontagePage'),
      import('../../features/lite-cut/LiteCutPage'),
      import('../../features/outputs/OutputsPage'),
      import('../../features/match-history/MatchHistoryPage'),
      import('../../features/recovery/RecoveryPage'),
      import('../../features/settings/SettingsPage'),
    ]);
    const pages: ComponentType[] = [
      modules[0].GuidePage,
      modules[1].LibraryPage,
      modules[2].AnalysisPage,
      modules[3].PlayersPage,
      modules[4].ProductionPage,
      modules[5].QueuePage,
      modules[6].StudioPage,
      modules[7].MontagePage,
      modules[8].LiteCutPage,
      modules[9].OutputsPage,
      modules[10].MatchHistoryPage,
      modules[11].RecoveryPage,
      modules[12].SettingsPage,
    ];

    for (const Page of pages) {
      const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page)));
      expect(markup).not.toMatch(han);
    }
  });
});
