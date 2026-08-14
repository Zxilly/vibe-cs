import type { AnalysisWorkspace, LlmReviewResult } from '../../shared/desktop/dto';

export type ReviewDelivery = {
  fileName: string;
  mediaType: 'text/html';
  html: string;
};

export type ReviewDeliveryLabels = {
  matchResult: string;
  team: string;
  score: string;
  playerPerformance: string;
  player: string;
  aiReview: string;
  highlights: string;
  noHighlights: string;
  evidenceReferences: string;
  noEvidence: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/iu;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function filePart(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/^de_/, '').replace(/[^a-z0-9_-]+/gu, '-');
  return normalized.replace(/^-+|-+$/gu, '').slice(0, 48) || 'match';
}

export function buildReviewDelivery({
  workspace,
  review,
  producerRunId,
  labels,
}: {
  workspace: AnalysisWorkspace;
  review: LlmReviewResult;
  producerRunId: string;
  labels: ReviewDeliveryLabels;
}): ReviewDelivery {
  if (review.demo_id !== workspace.demo_id) throw new Error('Review delivery must use the same Demo');
  if (!uuidPattern.test(producerRunId)) throw new Error('Review delivery requires an exact producer run');
  if (!sha256Pattern.test(review.evidence_sha256)) throw new Error('Review delivery requires an exact evidence digest');

  const teamRows = workspace.teams.map((team) => `
    <tr><td>${escapeHtml(team.side)}</td><td>${escapeHtml(team.name || `Team ${team.side}`)}</td><td>${team.score}</td></tr>`).join('');
  const playerRows = [...workspace.players]
    .sort((left, right) => right.kills - left.kills || left.name.localeCompare(right.name))
    .map((player) => `
    <tr><td>${escapeHtml(player.name)}</td><td>${escapeHtml(player.team)}</td><td>${player.kills}</td><td>${player.deaths}</td><td>${player.assists}</td><td>${(player.headshot_rate * 100).toFixed(1)}%</td><td>${player.adr.toFixed(1)}</td><td>${player.kill_death_ratio.toFixed(2)}</td></tr>`)
    .join('');
  const highlights = workspace.highlights.map((highlight) => `
    <li><strong>${escapeHtml(highlight.label)}</strong><span>R${highlight.round} · ${escapeHtml(highlight.kind)} · tick ${highlight.start_tick}–${highlight.end_tick}</span></li>`).join('');
  const evidence = review.evidence_ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('');
  const generated = new Date(review.generated_at);
  if (Number.isNaN(generated.getTime())) throw new Error('Review delivery requires a valid generated time');
  const generatedIso = generated.toISOString();
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Vibe CS Review · ${escapeHtml(workspace.map_name)}</title>
<style>body{margin:0;background:#0b1120;color:#e5e7eb;font:15px/1.6 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:48px}header,section{margin-bottom:24px;padding:24px;border:1px solid #273449;border-radius:14px;background:#111827}h1,h2{margin:0 0 12px}p{white-space:pre-wrap}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;color:#94a3b8;font-family:monospace}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #273449;text-align:left}code{display:inline-block;margin:4px;padding:5px 7px;border-radius:5px;background:#1e293b;color:#67e8f9}li{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid #273449}li span{color:#94a3b8}</style></head><body><main>
<header><small>VIBE CS · REVIEW DELIVERY</small><h1>${escapeHtml(workspace.map_name)}</h1><div class="meta"><span>Demo ${escapeHtml(workspace.demo_id)}</span><span>Producer ${escapeHtml(producerRunId)}</span><span>Generated ${escapeHtml(generatedIso)}</span><span>Evidence SHA-256 ${escapeHtml(review.evidence_sha256)}</span></div></header>
<section><h2>${escapeHtml(labels.matchResult)}</h2><table><thead><tr><th>Slot</th><th>${escapeHtml(labels.team)}</th><th>${escapeHtml(labels.score)}</th></tr></thead><tbody>${teamRows}</tbody></table></section>
<section><h2>${escapeHtml(labels.playerPerformance)}</h2><table><thead><tr><th>${escapeHtml(labels.player)}</th><th>Slot</th><th>K</th><th>D</th><th>A</th><th>HS</th><th>ADR</th><th>K/D</th></tr></thead><tbody>${playerRows}</tbody></table></section>
<section><h2>${escapeHtml(labels.aiReview)}</h2><p>${escapeHtml(review.commentary)}</p><div><strong>${escapeHtml(review.provider)} / ${escapeHtml(review.model)}</strong> · ${escapeHtml(review.scope)} · ${escapeHtml(review.tone)}</div></section>
<section><h2>${escapeHtml(labels.highlights)}</h2><ul>${highlights || `<li>${escapeHtml(labels.noHighlights)}</li>`}</ul></section>
<section><h2>${escapeHtml(labels.evidenceReferences)}</h2>${evidence || `<span>${escapeHtml(labels.noEvidence)}</span>`}</section>
</main></body></html>`;
  return {
    fileName: `vibe-cs-review-${filePart(workspace.map_name)}-${generatedIso.slice(0, 10)}.html`,
    mediaType: 'text/html',
    html,
  };
}
