import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { normalizeAnalysis } from '../../shared/desktop/client';
import type { MatchAnalysisRecord } from '../../shared/desktop/dto';
import { buildManAdvantageWorkspace } from './manAdvantageWorkspace';

const auditDatabase = process.env.VIBE_CS_MAJOR_AUDIT_DB;
const describeMajorAudit = auditDatabase ? describe : describe.skip;

describeMajorAudit('persisted Major man advantage oracle', () => {
  it('reconstructs every exact death tick across the three persisted maps', () => {
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
        const result = buildManAdvantageWorkspace(workspace);
        const verified = result.rounds.filter((round) => round.state === 'available');
        const deaths = verified.flatMap((round) => round.transitions.flatMap(
          (transition) => transition.deaths,
        ));
        return {
          map: workspace.map_name,
          availability: result.availability.state,
          rounds: `${result.summary.verified_rounds}/${result.summary.total_rounds}`,
          tick_groups: verified.reduce((count, round) => count + round.transitions.length, 0),
          deaths: deaths.length,
          first_lead_a: verified.filter((round) => round.first_lead_team === 'A').length,
          first_lead_b: verified.filter((round) => round.first_lead_team === 'B').length,
          first_lead_won: result.summary.first_lead_won,
          first_lead_lost: result.summary.first_lead_lost,
          lead_change_rounds: result.summary.lead_change_rounds,
          max_lead_changes: Math.max(...verified.map((round) => round.lead_changes ?? 0)),
          actorless_deaths: deaths.filter((death) => death.actor_id === null).length,
          same_team_deaths: deaths.filter((death) => death.elimination_relation === 'same_team').length,
        };
      }).sort((left, right) => left.map.localeCompare(right.map));

      expect(oracle).toEqual([
        {
          map: 'de_anubis',
          availability: 'available',
          rounds: '21/21',
          tick_groups: 138,
          deaths: 139,
          first_lead_a: 10,
          first_lead_b: 11,
          first_lead_won: 13,
          first_lead_lost: 8,
          lead_change_rounds: 8,
          max_lead_changes: 3,
          actorless_deaths: 2,
          same_team_deaths: 0,
        },
        {
          map: 'de_inferno',
          availability: 'available',
          rounds: '21/21',
          tick_groups: 134,
          deaths: 135,
          first_lead_a: 6,
          first_lead_b: 15,
          first_lead_won: 17,
          first_lead_lost: 4,
          lead_change_rounds: 6,
          max_lead_changes: 3,
          actorless_deaths: 2,
          same_team_deaths: 2,
        },
        {
          map: 'de_mirage',
          availability: 'available',
          rounds: '21/21',
          tick_groups: 133,
          deaths: 133,
          first_lead_a: 10,
          first_lead_b: 11,
          first_lead_won: 17,
          first_lead_lost: 4,
          lead_change_rounds: 5,
          max_lead_changes: 2,
          actorless_deaths: 0,
          same_team_deaths: 0,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('keeps the persisted Anubis simultaneous actorless ending as one 2v0 to 0v0 transition', () => {
    if (!auditDatabase) throw new Error('VIBE_CS_MAJOR_AUDIT_DB is required.');
    const database = new DatabaseSync(auditDatabase, { readOnly: true });
    try {
      const rows = database.prepare('select document_json from analyses').all() as Array<{
        document_json?: unknown;
      }>;
      const anubis = rows
        .map((row) => typeof row.document_json === 'string'
          ? normalizeAnalysis(JSON.parse(row.document_json) as MatchAnalysisRecord)
          : null)
        .find((workspace) => workspace?.map_name === 'de_anubis');
      if (!anubis) throw new Error('The persisted Anubis analysis document is unavailable.');

      const transition = buildManAdvantageWorkspace(anubis).rounds
        .find((round) => round.round === 15)?.transitions
        .find((candidate) => candidate.tick === 135_720);

      expect(transition).toMatchObject({
        remaining_before: { A: 2, B: 0 },
        remaining_after: { A: 0, B: 0 },
      });
      expect(transition?.deaths).toHaveLength(2);
      expect(transition?.deaths.every((death) => death.actor_id === null)).toBe(true);
    } finally {
      database.close();
    }
  });
});
