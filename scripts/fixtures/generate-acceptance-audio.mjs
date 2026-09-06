// Deterministic original music for end-to-end editing acceptance, not a product synthesizer.
// Usage: node scripts/fixtures/generate-acceptance-audio.mjs <new-output-directory>
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

if (!process.argv[2]) throw new Error('Provide a new output directory.');
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: false });
const rate = 48_000;
const beatSeconds = 0.5;
const tau = 2 * Math.PI;
const frequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
const chords = [[45, 48, 52], [41, 45, 48], [48, 52, 55], [43, 47, 50]];
const melody = [69, 72, 76, 79, 76, 74, 72, 67, 69, 72, 74, 76, 72, 71, 67, 64];

function music(seconds) {
  const samples = Math.round(seconds * rate);
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 4, 40);
  let randomState = 0x56494245;
  let previousNoise = 0;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const beat = t / beatSeconds;
    const phase = (beat % 1) * beatSeconds;
    const halfPhase = (beat % 0.5) * beatSeconds;
    const chord = chords[Math.floor(beat / 8) % chords.length];
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    const noise = (randomState >>> 0) / 0x80000000 - 1;
    const highNoise = (noise - previousNoise) * 0.5;
    previousNoise = noise;
    const kick = 0.20 * Math.exp(-phase * 22) * Math.sin(tau * (48 * phase + 7 * (1 - Math.exp(-phase * 35))));
    const snare = Math.floor(beat) % 2 === 1 ? 0.065 * noise * Math.exp(-phase * 30) : 0;
    const hat = 0.035 * highNoise * Math.exp(-halfPhase * 90);
    const bass = 0.07 * Math.sin(tau * frequency(chord[0] - 12) * t) * Math.exp(-phase * 5);
    let pad = 0;
    for (const note of chord) pad += 0.016 * Math.sin(tau * frequency(note + 12) * t);
    const pluck = 0.04 * Math.sin(tau * frequency(melody[Math.floor(beat * 2) % melody.length]) * halfPhase)
      * Math.exp(-halfPhase * 14) * Math.min(halfPhase / 0.004, 1);
    const fade = Math.min(1, t / 1.5, (seconds - t) / 2);
    const value = (kick + snare + hat + bass + pad + pluck) * fade;
    const left = Math.max(-0.95, Math.min(0.95, value + pad * 0.08 * fade));
    const right = Math.max(-0.95, Math.min(0.95, value - pad * 0.08 * fade));
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    wav.writeInt16LE(Math.round(left * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(right * 32767), 46 + i * 4);
  }
  return { wav, peak };
}

const results = [];
for (const seconds of [20, 180]) {
  const { wav, peak } = music(seconds);
  const path = join(directory, `original-test-bed-${seconds}s.wav`);
  await writeFile(path, wav, { flag: 'wx' });
  results.push({ path, seconds, sampleRate: rate, channels: 2, peak });
}
await writeFile(join(directory, 'provenance.json'), JSON.stringify({
  purpose: 'Original procedural music for Vibe CS acceptance; no external recordings or samples.',
  bpm: 120, license: 'CC0-1.0', results,
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify(results, null, 2));
