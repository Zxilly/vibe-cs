import { msg, msgf } from '../../shared/i18n';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { commands } from '../../shared/desktop/client';
import type { CaptureLatencyCalibration, CaptureLatencySample } from '../../shared/desktop/dto';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { Badge, Button, Field, Notice, Spinner } from '../../shared/ui';
import './recordingCalibration.css';

const initialSamples: CaptureLatencySample[] = [
  { game_observed_ms: 0, obs_observed_ms: 0 },
  { game_observed_ms: 1_000, obs_observed_ms: 1_000 },
  { game_observed_ms: 2_000, obs_observed_ms: 2_000 },
];

export function RecordingCalibrationPanel({
  onApply,
}: {
  onApply: (delayMs: number) => void;
}) {
  const [samples, setSamples] = useState(initialSamples);
  const action = useAsyncAction<CaptureLatencyCalibration>();
  const update = (index: number, key: keyof CaptureLatencySample, value: number) => {
    setSamples((current) => current.map((sample, sampleIndex) => (
      sampleIndex === index ? { ...sample, [key]: value } : sample
    )));
  };
  const calibrate = () => action.run(
    () => commands.calibrateRecordingLatency({ samples }),
    msg("m0556"),
  );
  const result = action.state.status === 'success' ? action.state.data : null;

  return (
    <div className="recording-calibration">
      <div className="recording-calibration__header">
        <div><strong>{msg("m0053")}</strong><small>{msg("m0386")}</small></div>
        <Button size="sm" disabled={samples.length >= 64} onClick={() => setSamples((current) => [...current, { game_observed_ms: 0, obs_observed_ms: 0 }])}><Plus size={13} />{msg("m0825")}</Button>
      </div>
      {samples.map((sample, index) => (
        <div className="field-row" key={`latency-${index}`}>
          <Field label={msgf("m0827", [index + 1])}><div className="number-control"><input type="number" value={sample.game_observed_ms} onChange={(event) => update(index, 'game_observed_ms', Number(event.target.value))} /><span>ms</span></div></Field>
          <Field label={msgf("m0826", [index + 1])}><div className="number-control"><input type="number" value={sample.obs_observed_ms} onChange={(event) => update(index, 'obs_observed_ms', Number(event.target.value))} /><span>ms</span></div></Field>
          <Button size="sm" variant="danger" disabled={samples.length <= 3} onClick={() => setSamples((current) => current.filter((_, sampleIndex) => sampleIndex !== index))}><Trash2 size={13} />{msg("m1048")}</Button>
        </div>
      ))}
      <div className="field-row">
        <Button disabled={action.state.status === 'loading'} onClick={() => void calibrate()}>{action.state.status === 'loading' ? <Spinner /> : <Gauge size={14} />}{msg("m1110")}</Button>
        {result ? <Button variant="primary" onClick={() => onApply(result.recommended_delay_ms)}>{msg("m0553")} {result.recommended_delay_ms} ms</Button> : null}
      </div>
      {action.state.status === 'error' ? <Notice tone="danger">{action.state.message}</Notice> : null}
      {result ? <Notice tone={result.confidence === 'low' ? 'warning' : 'success'} title={msg("m0821")}>{msg("m0218")} {result.median_offset_ms} {msg("m0085")} {result.jitter_ms} ms · <Badge tone={result.confidence === 'high' ? 'success' : result.confidence === 'medium' ? 'blue' : 'warning'}>{result.confidence}</Badge> {result.diagnostic}</Notice> : null}
    </div>
  );
}
