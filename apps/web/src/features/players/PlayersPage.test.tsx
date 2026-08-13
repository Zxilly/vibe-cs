import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PlayersPage.tsx', import.meta.url), 'utf8');

describe('explicit cross-page player comparison wiring', () => {
  it('owns at most two explicit Steam ids independently of the current directory page', () => {
    expect(source).toMatch(/const \[comparedIds, setComparedIds\] = useState<string\[\]>\(\[\]\)/);
    expect(source).toMatch(/toggleComparedPlayerIds\(comparedIds, player\.steam_id\)/);
    expect(source).not.toContain('retainComparedPlayersOnPage');
    expect(source).not.toMatch(/setComparedIds\([\s\S]{0,120}response\.items/);
  });

  it('loads both selected players from one atomic pair endpoint and suppresses stale completion', () => {
    expect(source).toMatch(/const left = comparedIds\[0\][\s\S]*?const right = comparedIds\[1\]/);
    expect(source).toMatch(/commands\.comparePlayers\(left, right, controller\.signal\)/);
    expect(source).toMatch(/const requestRevision = \+\+comparisonRequestRevision\.current/);
    expect(source).toMatch(/controller\.signal\.aborted[\s\S]*?\|\| !isCurrentRequest\(comparisonRequestRevision\.current, requestRevision\)/);
    expect(source).toMatch(/return \(\) => controller\.abort\(\)/);
    expect(source).toMatch(/scannedDemos=\{comparison\.scanned_demos\}/);
    expect(source).toMatch(/scanComplete=\{comparison\.scan_complete\}/);
  });

  it('reconciles a 404 with exact reads and removes only catalog-missing ids', () => {
    expect(source).toMatch(/error instanceof DesktopError && error\.status === 404/);
    expect(source).toMatch(/reconcileComparedPlayerIds\([\s\S]*?commands\.getPlayer\(id, controller\.signal\)/);
    expect(source).toMatch(/setComparedIds\(\(current\)[\s\S]*?reconciliation\.retainedIds/);
    expect(source).toMatch(/players\.compare\.missingRemoved/);
  });

  it('re-requests the last real player match page instead of committing an empty overflow page', () => {
    expect(source).toMatch(/const requestedPage = matchPage/);
    expect(source).toMatch(/const availablePage = requestedPlayerMatchPage\(\s*requestedPage,\s*response\.total,\s*response\.page_size,?\s*\)/);
    expect(source).toMatch(/if \(availablePage !== requestedPage\)[\s\S]*?setMatchPage\(availablePage\)[\s\S]*?return/);
    expect(source.indexOf('setMatchPage(availablePage)')).toBeLessThan(source.indexOf('setMatches(response)'));
  });

  it('retries only the failed player match request', () => {
    expect(source).toMatch(/const \[matchesRefreshRevision, setMatchesRefreshRevision\] = useState\(0\)/);
    expect(source).toMatch(/\[matchPage, matchesRefreshRevision, refreshRevision, selectedId\]/);
    expect(source).toMatch(/onRetryMatches=\{\(\) => setMatchesRefreshRevision\(\(current\) => current \+ 1\)\}/);
  });
});
