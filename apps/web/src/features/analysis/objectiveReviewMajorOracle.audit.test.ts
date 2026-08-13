import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { normalizeAnalysis } from '../../shared/desktop/client';
import type { MatchAnalysisRecord } from '../../shared/desktop/dto';
import { buildObjectiveReviewWorkspace } from './objectiveReviewWorkspace';

const auditDatabase = process.env.VIBE_CS_MAJOR_AUDIT_DB;
const describeMajorAudit = auditDatabase ? describe : describe.skip;

describeMajorAudit('persisted Major objective review oracle', () => {
  it('reconstructs all 34 canonical plant rounds across the three persisted maps', () => {
    if (!auditDatabase) throw new Error('VIBE_CS_MAJOR_AUDIT_DB is required.');
    const database = new DatabaseSync(auditDatabase, { readOnly: true });
    try {
      const rows = database.prepare(
        'select document_json from analyses order by demo_id',
      ).all() as Array<{ document_json?: unknown }>;
      const oracle = rows.map((row) => {
        if (typeof row.document_json !== 'string') {
          throw new Error('A persisted Major analysis document is unavailable.');
        }
        const workspace = normalizeAnalysis(JSON.parse(row.document_json) as MatchAnalysisRecord);
        const result = buildObjectiveReviewWorkspace(workspace);
        return {
          map: workspace.map_name,
          availability: result.availability.state,
          plants: result.summary.verified_plant_rounds,
          wins: result.summary.planting_team_wins,
          losses: result.summary.planting_team_losses,
          defuses: result.summary.defuses,
          explosions: result.summary.explosions,
          no_terminal_events: result.summary.no_terminal_events,
          post_plant_kills: result.summary.post_plant_kills,
          post_plant_damage: result.summary.post_plant_damage,
        };
      }).sort((left, right) => left.map.localeCompare(right.map));

      expect(oracle).toEqual([
        {
          map: 'de_anubis',
          availability: 'available',
          plants: 15,
          wins: 14,
          losses: 1,
          defuses: 1,
          explosions: 8,
          no_terminal_events: 6,
          post_plant_kills: 45,
          post_plant_damage: 150,
        },
        {
          map: 'de_inferno',
          availability: 'available',
          plants: 11,
          wins: 8,
          losses: 3,
          defuses: 3,
          explosions: 5,
          no_terminal_events: 3,
          post_plant_kills: 16,
          post_plant_damage: 42,
        },
        {
          map: 'de_mirage',
          availability: 'available',
          plants: 8,
          wins: 7,
          losses: 1,
          defuses: 1,
          explosions: 3,
          no_terminal_events: 4,
          post_plant_kills: 19,
          post_plant_damage: 55,
        },
      ]);
    } finally {
      database.close();
    }
  });
});
