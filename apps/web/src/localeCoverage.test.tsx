/*
 * `markup` project — the last line of defence against copy that never reached
 * a macro.
 *
 * `lingui extract` counts missing translations, but it can only count strings
 * it knows about: a zh-CN literal written straight into JSX has no msgid, so
 * the catalog reports zero missing while the text is on screen untranslated in
 * every locale. Nothing else in the suite can see that.
 *
 * So switch the app to en-US, render every §7 destination, and assert no Han
 * character survives. Anything that appears is copy that skipped `t` / `Trans`.
 *
 * This replaces the second half of the pre-redesign `shared/i18n/coverage.test`,
 * deleted with that runtime in phase 4. Two things changed: it reads the real
 * `en-US/messages.po` instead of mocking the translation functions, so it fails
 * on a *wrong* translation and not only a missing macro; and the page list
 * comes from `APP_PAGES`, so a new route is covered the moment it is bound
 * rather than when someone remembers to add it here.
 *
 * The `.po` is parsed rather than imported from `locales/en-US/messages.mjs`,
 * because that file is a `lingui compile` output, is not in git, and depending
 * on it would make `pnpm test` fail on a clean checkout until `pnpm lint` had
 * run once. Parsing means reproducing one thing `compile` does: a `.po` is
 * keyed by the source text, the runtime is keyed by a hash of it, so the ids
 * come from Lingui's own `generateMessageId` rather than from the msgid.
 */

import { i18n } from '@lingui/core';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import path from 'node:path';
import { prerenderToNodeStream } from 'react-dom/static';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';

import { APP_PAGES } from './routes';

const han = /\p{Script=Han}/u;

/**
 * Minimal gettext reader: enough for what `lingui extract` writes, which is
 * `msgctxt`/`msgid`/`msgstr` entries whose values are either one quoted string
 * or an empty one followed by continuation lines. Comments and flags skipped.
 */
function catalogFromPo(source: string): Record<string, string> {
  const messages: Record<string, string> = {};
  let context: string | undefined;
  let id = '';
  let field: 'msgctxt' | 'msgid' | 'msgstr' | null = null;
  let buffer = '';

  const unquote = (line: string): string =>
    line
      .slice(1, -1)
      .replace(/\\n/gu, '\n')
      .replace(/\\t/gu, '\t')
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, '\\');

  const flush = (): void => {
    if (field === 'msgctxt') context = buffer;
    else if (field === 'msgid') id = buffer;
    else if (field === 'msgstr' && id !== '' && buffer !== '') {
      messages[generateMessageId(id, context)] = buffer;
    }
  };

  const begin = (keyword: typeof field, line: string): void => {
    flush();
    field = keyword;
    buffer = unquote(line.slice(keyword!.length + 1));
  };

  for (const line of source.split('\n')) {
    const text = line.trim();
    if (text.startsWith('msgctxt ')) begin('msgctxt', text);
    else if (text.startsWith('msgid ')) begin('msgid', text);
    else if (text.startsWith('msgstr ')) begin('msgstr', text);
    else if (text.startsWith('"') && field) buffer += unquote(text);
    else if (text === '') {
      // A blank line closes the entry — and `msgctxt` belongs to one entry only.
      flush();
      field = null;
      context = undefined;
      id = '';
      buffer = '';
    }
  }
  flush();

  return messages;
}

beforeAll(() => {
  const catalog = fs.readFileSync(
    path.resolve(import.meta.dirname, 'locales/en-US/messages.po'),
    'utf8',
  );
  const messages = catalogFromPo(catalog);
  // A guard on the guard: an empty catalog would make every assertion below
  // pass by rendering the authored zh-CN fallback… which contains Han and so
  // would fail loudly instead. This checks the parser found something anyway,
  // because a *partial* parse would silently narrow the test's reach. The
  // unified Project rewrite deliberately removed the duplicate Agent, Plan,
  // Montage, Editor, and Recording surfaces, so the current full catalog is
  // smaller than the old multi-product catalog.
  expect(Object.keys(messages).length).toBeGreaterThan(1300);
  i18n.loadAndActivate({ locale: 'en-US', messages });
});

/**
 * `prerenderToNodeStream`, not `renderToStaticMarkup`, because `routes.tsx`
 * binds every page through `lazy()`: the tree is asynchronous, so rendering it
 * with a synchronous API can only throw. This one awaits the dynamic imports
 * and every Suspense boundary, then hands over the finished markup.
 */
async function markupFor(id: string): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const { prelude } = await prerenderToNodeStream(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter>{APP_PAGES[id as keyof typeof APP_PAGES]}</MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
  let markup = '';
  for await (const chunk of prelude) markup += String(chunk);
  return markup;
}

describe('en-US covers every destination', () => {
  it.each(Object.keys(APP_PAGES))('renders %s without Han text', async (id) => {
    const markup = await markupFor(id);
    // Report the offending text, not just a boolean: a failure here is someone
    // finding out *which* string skipped the macro, from the test output alone.
    const offending = markup.match(/[^<>]*\p{Script=Han}[^<>]*/gu);
    expect(offending ?? []).toEqual([]);
    expect(markup).not.toMatch(han);
  }, 10_000);
});
