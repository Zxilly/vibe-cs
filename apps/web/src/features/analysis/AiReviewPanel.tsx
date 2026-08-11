import { currentLocale, msg, msgf } from '../../shared/i18n';
import { Bot, CircleStop, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, readableError } from '../../shared/api/client';
import type {
  AnalysisWorkspace,
  LlmReviewResult,
  LlmReviewScope,
  LlmReviewTone,
  PlayerAnalysis,
} from '../../shared/api/dto';
import { Badge, Button, Card, EmptyState, Notice, Spinner } from '../../shared/ui';
import {
  buildReviewRequest,
  maximumReviewHighlights,
  toggleReviewHighlight,
} from './aiReview';

export type ReviewConfiguration = {
  status: 'loading' | 'ready' | 'error';
  configured: boolean;
  provider: string;
  model: string;
};

type AnalysisSource = 'loading' | 'service' | 'preview' | 'error';

const scopeLabels: Record<LlmReviewScope, string> = {
  match: msg("m0684"),
  highlights: msg("m1070"),
  player: msg("m0584"),
};

const toneLabels: Record<LlmReviewTone, string> = {
  analytical: msg("m0682"),
  coach: msg("m0681"),
  direct: msg("m1022"),
};

function formattedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function AiReviewPanel({
  demoId,
  workspace,
  selectedPlayer,
  source,
  configuration,
}: {
  demoId: string;
  workspace: AnalysisWorkspace;
  selectedPlayer: PlayerAnalysis | null;
  source: AnalysisSource;
  configuration: ReviewConfiguration;
}) {
  const [scope, setScope] = useState<LlmReviewScope>('match');
  const [tone, setTone] = useState<LlmReviewTone>('analytical');
  const [selectedHighlightIds, setSelectedHighlightIds] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LlmReviewResult | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const availableHighlights = workspace.highlights.slice(0, maximumReviewHighlights);

  useEffect(() => () => requestRef.current?.abort(), []);

  const generate = async () => {
    if (status === 'running' || source !== 'service' || !configuration.configured) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setStatus('running');
    setError(null);
    try {
      const response = await api.reviewDemo(
        demoId,
        buildReviewRequest(
          scope,
          tone,
          selectedPlayer?.id ?? null,
          selectedHighlightIds,
        ),
        controller.signal,
      );
      if (requestRef.current !== controller) return;
      setResult(response);
    } catch (cause: unknown) {
      if (requestRef.current !== controller || controller.signal.aborted) return;
      setError(readableError(cause));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setStatus('idle');
      }
    }
  };

  const cancel = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    setStatus('idle');
  };

  const canGenerate = source === 'service'
    && configuration.configured
    && status !== 'running'
    && (scope !== 'player' || selectedPlayer !== null)
    && (scope !== 'highlights' || availableHighlights.length > 0);

  return (
    <div className="ai-review-view">
      <Card className="ai-review-controls">
        <div className="card-heading">
          <div>
            <h2>{msg("m0351")}</h2>
            <p>{msg("m0342")}</p>
          </div>
          <Bot size={20} />
        </div>

        {source !== 'service' ? (
          <Notice tone="warning">{msg("m1025")}</Notice>
        ) : configuration.status === 'loading' ? (
          <Notice tone="info"><Spinner />{msg("m0873")}</Notice>
        ) : configuration.status === 'error' ? (
          <Notice tone="danger">{msg("m0710")}</Notice>
        ) : !configuration.configured ? (
          <Notice tone="warning">

           {msg("m0469")}<Link to="/settings">{msg("m0296")}</Link>
          </Notice>
        ) : (
          <div className="ai-review-provider">
            <ShieldCheck size={15} />
            <span><strong>{configuration.model}</strong><small>{configuration.provider} {msg("m0123")}</small></span>
            <Badge tone="success">{msg("m0546")}</Badge>
          </div>
        )}

        <div className="ai-review-options">
          <label>
            <span>{msg("m0417")}</span>
            <select
              value={scope}
              onChange={(event) => {
                setScope(event.target.value as LlmReviewScope);
                setResult(null);
                setError(null);
              }}
            >
              {Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>{msg("m1105")}</span>
            <select value={tone} onChange={(event) => setTone(event.target.value as LlmReviewTone)}>
              {Object.entries(toneLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div>
            <span>{msg("m1118")}</span>
            <strong>{scope === 'player' ? selectedPlayer?.name ?? msg("m0771") : scope === 'highlights' ? (selectedHighlightIds.length > 0 ? msgf("m0100", [selectedHighlightIds.length]) : msgf("m0233", [maximumReviewHighlights])) : workspace.map_name || msg("m0578")}</strong>
          </div>
        </div>

        {scope === 'highlights' ? (
          availableHighlights.length > 0 ? (
            <fieldset className="ai-review-highlights">
              <legend>{msg("m1005")}</legend>
              {availableHighlights.map((highlight) => (
                <label key={highlight.id}>
                  <input
                    type="checkbox"
                    checked={selectedHighlightIds.includes(highlight.id)}
                    onChange={() => setSelectedHighlightIds((current) => toggleReviewHighlight(current, highlight.id))}
                  />
                  <span><strong>{highlight.label}</strong><small>{highlight.round > 0 ? msgf("m1059", [highlight.round]) : msg("m0226")} · {highlight.kind}</small></span>
                </label>
              ))}
            </fieldset>
          ) : (
            <EmptyState icon={<Sparkles size={20} />} title={msg("m0896")} description={msg("m1234")} />
          )
        ) : null}

        <div className="ai-review-actions">
          <Button variant="primary" disabled={!canGenerate} onClick={() => void generate()}>
            {status === 'running' ? <Spinner /> : <Sparkles size={14} />}
            {status === 'running' ? msg("m0857") : msg("m0987")}
          </Button>
          {status === 'running' ? <Button onClick={cancel}><CircleStop size={14} />{msg("m0327")}</Button> : null}
          <small>{msg("m0144")}</small>
        </div>
        {error ? <Notice tone="danger" title={msg("m0416")}>{error}</Notice> : null}
      </Card>

      <Card className="ai-review-result" aria-live="polite">
        {!result ? (
          <EmptyState
            icon={<Bot size={22} />}
            title={status === 'running' ? msg("m0853") : msg("m0466")}
            description={status === 'running' ? msg("m1141") : msg("m1240")}
          />
        ) : (
          <article>
            <header>
              <div>
                <span>AI REVIEW</span>
                <h2>{scopeLabels[result.scope]}</h2>
              </div>
              <div>
                {result.cached ? <Badge tone="success">{msg("m1083")}</Badge> : <Badge tone="accent">{msg("m0698")}</Badge>}
                <Badge tone="neutral">{toneLabels[result.tone]}</Badge>
              </div>
            </header>
            <p className="ai-review-commentary">{result.commentary}</p>
            <div className="ai-review-evidence">
              <strong>{msg("m0560")}</strong>
              <div>{result.evidence_ids.map((id) => <code key={id}>{id}</code>)}</div>
            </div>
            <footer>
              <span>{result.provider} / {result.model}</span>
              <span>{formattedTime(result.generated_at)}</span>
              <span title={result.evidence_sha256}>{msg("m1120")} {result.evidence_sha256.slice(0, 12)}</span>
            </footer>
          </article>
        )}
      </Card>
    </div>
  );
}
