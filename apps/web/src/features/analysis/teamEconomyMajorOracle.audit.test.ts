import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { normalizeAnalysis } from '../../shared/desktop/client';
import type { MatchAnalysisRecord } from '../../shared/desktop/dto';
import { buildTeamEconomyWorkspace } from './teamEconomyWorkspace';

const auditDatabase = process.env.VIBE_CS_MAJOR_AUDIT_DB;
const majorDemoId = process.env.VIBE_CS_MAJOR_AUDIT_DEMO_ID;
const describeMajorAudit = auditDatabase && majorDemoId ? describe : describe.skip;

describeMajorAudit('persisted Major M1 team economy oracle', () => {
  it('derives the exact decoded purchase matrix from the persisted analysis JSON', () => {
    if (!auditDatabase || !majorDemoId) {
      throw new Error('VIBE_CS_MAJOR_AUDIT_DB and VIBE_CS_MAJOR_AUDIT_DEMO_ID are required.');
    }
    const database = new DatabaseSync(auditDatabase, { readOnly: true });
    try {
      const row = database.prepare(
        'select document_json from analyses where demo_id = ?',
      ).get(majorDemoId) as { document_json?: unknown } | undefined;
      if (typeof row?.document_json !== 'string') {
        throw new Error('The persisted Major M1 analysis document is unavailable.');
      }
      const workspace = normalizeAnalysis(JSON.parse(row.document_json) as MatchAnalysisRecord);
      const result = buildTeamEconomyWorkspace(workspace, {
        team: null,
        side: null,
        round: null,
        page: 1,
      });

      expect(result.availability).toEqual({
        state: 'available',
        reason: null,
        failure_code: null,
        failure_round: null,
        rejected_purchase_count: 0,
      });
      expect(result.cells.map((cell) => [
        `${cell.team}/${cell.side}`,
        cell.purchase_count,
        cell.decoded_purchase_cost,
      ])).toEqual([
        ['A/T', 456, 255_700],
        ['A/CT', 209, 128_650],
        ['B/T', 281, 174_200],
        ['B/CT', 420, 253_000],
      ]);
    } finally {
      database.close();
    }
  });
});
