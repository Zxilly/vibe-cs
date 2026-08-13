import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PlayersPage.tsx', import.meta.url), 'utf8');

describe('explicit cross-page player comparison wiring', () => {
  it('owns directory, profile, and comparison identity in the current URL', () => {
    expect(source).toMatch(/const \[searchParams, setSearchParams\] = useSearchParams\(\)/);
    expect(source).toMatch(/playerDirectoryQueryFromParams\(searchParams\)/);
    expect(source).toMatch(/const comparedIds = playerQuery\.comparedIds/);
    expect(source).toMatch(/const selectedId = playerQuery\.playerId/);
    expect(source).toMatch(/toggleComparedPlayerIds\(comparedIds, player\.steam_id\)/);
    expect(source).toContain('playerDirectoryQueryToParams');
    expect(source).not.toContain('retainComparedPlayersOnPage');
    expect(source).not.toMatch(/useState<string\[\]>\(\[\]\)/);
    expect(source).toContain('const compactInspectorOpen = playerQuery.inspectorOpen');
    expect(source).not.toMatch(/useState\(\s*playerQuery\.comparedIds\.length > 0/);
  });

  it('loads both selected players from one atomic pair endpoint and suppresses stale completion', () => {
    expect(source).toMatch(/const left = comparedIds\[0\][\s\S]*?const right = comparedIds\[1\]/);
    expect(source).toMatch(/commands\.comparePlayers\(left, right, controller\.signal\)/);
    expect(source).toMatch(/const requestRevision = \+\+comparisonRequestRevision\.current/);
    expect(source).toMatch(/controller\.signal\.aborted[\s\S]*?\|\| !isCurrentRequest\(comparisonRequestRevision\.current, requestRevision\)/);
    expect(source).toMatch(/return \(\) => controller\.abort\(\)/);
    expect(source).toMatch(/coverage=\{comparison\.coverage\}/);
  });

  it('reconciles a 404 with exact reads and removes only catalog-missing ids', () => {
    expect(source).toMatch(/error instanceof DesktopError && error\.status === 404/);
    expect(source).toMatch(/reconcileComparedPlayerIds\([\s\S]*?commands\.getPlayer\(id, controller\.signal\)/);
    expect(source).toMatch(/setSearchParams\(\(current\)[\s\S]*?reconciliation\.retainedIds/);
    expect(source).toContain("currentQuery.comparedIds.join('\\0') !== requestedSelectionIdentity");
    expect(source).toMatch(
      /inspectorOpen:\s*currentQuery\.inspectorOpen\s*&& reconciliation\.retainedIds\.length > 0/,
    );
    expect(source).toMatch(/players\.compare\.missingRemoved/);
  });

  it('re-requests the last real player match page instead of committing an empty overflow page', () => {
    expect(source).toMatch(/const requestedPage = matchPage/);
    expect(source).toMatch(/const availablePage = requestedPlayerMatchPage\(\s*requestedPage,\s*response\.total,\s*response\.page_size,?\s*\)/);
    expect(source).toMatch(/if \(availablePage !== requestedPage\)[\s\S]*?updatePlayerQuery\(\{ matchesPage: availablePage \}, true\)[\s\S]*?return/);
    expect(source.indexOf('updatePlayerQuery({ matchesPage: availablePage }, true)')).toBeLessThan(source.indexOf('setMatches(response)'));
  });

  it('retries only the failed player match request', () => {
    expect(source).toMatch(/const \[matchesRefreshRevision, setMatchesRefreshRevision\] = useState\(0\)/);
    expect(source).toMatch(/\[matchPage, matchesRefreshRevision, refreshRevision, selectedId, updatePlayerQuery\]/);
    expect(source).toMatch(/onRetryMatches=\{\(\) => setMatchesRefreshRevision\(\(current\) => current \+ 1\)\}/);
  });

  it('does not leave actionable rows from an older URL query on screen', () => {
    expect(source).toMatch(
      /const requestRevision = \+\+listRequestRevision\.current;\s*setItems\(\[\]\);\s*setTotal\(0\);\s*setCoverage\(null\);\s*setListState\('loading'\)/,
    );
    expect(source).toMatch(
      /listState === 'error'[\s\S]*?title=\{t\('players\.directory\.error'\)\}[\s\S]*?description=\{listError/,
    );
    expect(source).not.toContain('msg("m0314")');
  });

  it('does not refetch the directory when only URL-owned selection changes', () => {
    expect(source).toMatch(
      /\}, \[\s*debouncedSearch,\s*directorySort\.direction,\s*directorySort\.key,\s*page,\s*refreshRevision,\s*updatePlayerQuery,\s*\]\);/,
    );
    expect(source).toContain("aria-busy={listState === 'loading'}");
  });
});
