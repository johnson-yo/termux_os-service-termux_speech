/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: A complete 16 kHz mono s16le WAV, SenseVoice am.mvn, and tokens.json.
 * [OUTPUT]: SenseVoice [1,167,560] LFR/CMVN tensors and decoded CTC text.
 * [POS]: Dependency-free exact port of the proven SenseVoice spool-worker preprocessing contract.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';

const SAMPLE_RATE = 16_000;
const FRAME_LEN = 400;
const FRAME_SHIFT = 160;
const N_FFT = 512;
const MEL = 80;
const SENSE_T = 167;
const SENSE_DIM = 560;
const EPS = 1.1920928955078125e-7;

const HAMMING = Float64Array.from(
  { length: FRAME_LEN },
  (_, index) => 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (FRAME_LEN - 1)),
);

const hzToMel = (hz) => 1127 * Math.log(1 + hz / 700);
const melToHz = (mel) => 700 * (Math.exp(mel / 1127) - 1);

const MEL_BANKS = (() => {
  const low = hzToMel(20);
  const high = hzToMel(SAMPLE_RATE / 2);
  const points = Array.from({ length: MEL + 2 }, (_, index) => {
    const mel = low + (high - low) * index / (MEL + 1);
    return Math.max(0, Math.min(N_FFT / 2, Math.floor(
      (N_FFT + 1) * melToHz(mel) / SAMPLE_RATE,
    )));
  });
  return Array.from({ length: MEL }, (_, melIndex) => {
    const left = points[melIndex];
    const center = Math.max(points[melIndex + 1], left + 1);
    const right = Math.max(points[melIndex + 2], center + 1);
    return Float64Array.from({ length: N_FFT / 2 + 1 }, (_, bin) => {
      if (bin < left || bin >= right) return 0;
      return bin < center
        ? (bin - left) / (center - left)
        : (right - bin) / (right - center);
    });
  });
})();

const powerSpectrum = (frame) => {
  const real = new Float64Array(N_FFT);
  const imaginary = new Float64Array(N_FFT);
  real.set(frame);
  for (let index = 1, reversed = 0; index < N_FFT; index += 1) {
    let bit = N_FFT >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let length = 2; length <= N_FFT; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < N_FFT; start += length) {
      let currentReal = 1;
      let currentImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const upperReal = real[start + offset];
        const upperImaginary = imaginary[start + offset];
        const lowerReal = real[start + offset + length / 2] * currentReal
          - imaginary[start + offset + length / 2] * currentImaginary;
        const lowerImaginary = real[start + offset + length / 2] * currentImaginary
          + imaginary[start + offset + length / 2] * currentReal;
        real[start + offset] = upperReal + lowerReal;
        imaginary[start + offset] = upperImaginary + lowerImaginary;
        real[start + offset + length / 2] = upperReal - lowerReal;
        imaginary[start + offset + length / 2] = upperImaginary - lowerImaginary;
        const nextReal = currentReal * stepReal - currentImaginary * stepImaginary;
        currentImaginary = currentReal * stepImaginary + currentImaginary * stepReal;
        currentReal = nextReal;
      }
    }
  }
  const power = new Float64Array(N_FFT / 2 + 1);
  for (let bin = 0; bin < power.length; bin += 1) {
    power[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
  }
  return power;
};

const fbankFrame = (samples, start) => {
  const frame = new Float64Array(FRAME_LEN);
  let mean = 0;
  for (let index = 0; index < FRAME_LEN; index += 1) {
    frame[index] = samples[start + index];
    mean += frame[index];
  }
  mean /= FRAME_LEN;
  for (let index = 0; index < FRAME_LEN; index += 1) frame[index] -= mean;
  for (let index = FRAME_LEN - 1; index > 0; index -= 1) {
    frame[index] -= 0.97 * frame[index - 1];
  }
  frame[0] *= 0.03;
  for (let index = 0; index < FRAME_LEN; index += 1) frame[index] *= HAMMING[index];
  const power = powerSpectrum(frame);
  return Float32Array.from({ length: MEL }, (_, melIndex) => {
    const weights = MEL_BANKS[melIndex];
    let energy = 0;
    for (let bin = 0; bin < weights.length; bin += 1) {
      if (weights[bin] !== 0) energy += weights[bin] * power[bin];
    }
    return Math.log(Math.max(energy, EPS));
  });
};

export function readWavMono16(file) {
  const raw = fs.readFileSync(file);
  if (raw.length < 44 || raw.toString('ascii', 0, 4) !== 'RIFF'
    || raw.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`invalid WAV: ${file}`);
  }
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= raw.length) {
    const id = raw.toString('ascii', offset, offset + 4);
    const size = raw.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > raw.length) break;
    if (id === 'fmt ' && size >= 16) {
      audioFormat = raw.readUInt16LE(body);
      channels = raw.readUInt16LE(body + 2);
      sampleRate = raw.readUInt32LE(body + 4);
      bits = raw.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size & 1);
  }
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== SAMPLE_RATE
    || bits !== 16 || dataOffset < 0) {
    throw new Error('SenseVoice WAV must be PCM 16kHz mono s16le');
  }
  const count = Math.floor(Math.min(dataSize, raw.length - dataOffset) / 2);
  return Float32Array.from(
    { length: count },
    (_, index) => raw.readInt16LE(dataOffset + index * 2),
  );
}

export function loadSenseCmvn(file) {
  const groups = [...fs.readFileSync(file, 'utf8').matchAll(/\[([^\]]*)]/gs)]
    .map((match) => match[1]);
  if (groups.length < 3) throw new Error(`invalid SenseVoice am.mvn: ${file}`);
  const values = (text) => Float32Array.from(
    text.trim().split(/\s+/).filter(Boolean).map(Number),
  );
  const add = values(groups[1]);
  const scale = values(groups[2]);
  if (add.length !== SENSE_DIM || scale.length !== SENSE_DIM) {
    throw new Error(`SenseVoice CMVN dimension mismatch: ${add.length}/${scale.length}`);
  }
  return { add, scale };
}

export function makeSenseVoiceInput(samples, cmvn) {
  if (!(samples instanceof Float32Array) && !(samples instanceof Float64Array)) {
    throw new TypeError('SenseVoice samples must be a typed array');
  }
  const speech = new Float32Array(SENSE_T * SENSE_DIM);
  if (samples.length < FRAME_LEN) return { speech, validFrames: 0 };
  const frameCount = Math.floor((samples.length - FRAME_LEN) / FRAME_SHIFT) + 1;
  const fbank = Array.from(
    { length: frameCount },
    (_, index) => fbankFrame(samples, index * FRAME_SHIFT),
  );
  const lfrCount = Math.ceil(frameCount / 6);
  const validFrames = Math.min(lfrCount, SENSE_T);
  for (let time = 0; time < validFrames; time += 1) {
    const start = time * 6 - 3;
    for (let block = 0; block < 7; block += 1) {
      const source = Math.max(0, Math.min(frameCount - 1, start + block));
      for (let mel = 0; mel < MEL; mel += 1) {
        const dimension = block * MEL + mel;
        speech[time * SENSE_DIM + dimension] = (
          fbank[source][mel] + cmvn.add[dimension]
        ) * cmvn.scale[dimension];
      }
    }
  }
  return { speech, validFrames };
}

export function wavToSenseVoiceInput(wavFile, cmvnFile) {
  return makeSenseVoiceInput(readWavMono16(wavFile), loadSenseCmvn(cmvnFile));
}

export function loadTokens(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tokens = Array.isArray(parsed) ? parsed : parsed?.tokens;
  if (!Array.isArray(tokens)) throw new Error(`unsupported SenseVoice tokens: ${file}`);
  return tokens.map((token) => String(token));
}

export function decodeCtcIds(ids, tokens) {
  const selected = [];
  let previous = -1;
  for (const raw of ids ?? []) {
    const id = Number(raw);
    if (Number.isInteger(id) && id !== previous && id !== 0) selected.push(id);
    previous = id;
  }
  const text = selected
    .map((id) => tokens[id] ?? '')
    .filter((token) => !(token.startsWith('<') && token.endsWith('>')))
    .join('')
    .replaceAll('▁', ' ')
    .trim();
  return { text, tokenIds: selected };
}

export function tensorSpec(dtype, shape, values) {
  const width = dtype === 'int32' ? 4 : 4;
  const bytes = Buffer.alloc(values.length * width);
  for (let index = 0; index < values.length; index += 1) {
    if (dtype === 'int32') bytes.writeInt32LE(Number(values[index]), index * 4);
    else bytes.writeFloatLE(Number(values[index]), index * 4);
  }
  return { dtype, shape, data_b64: bytes.toString('base64') };
}

export const SENSEVOICE_SHAPE = Object.freeze([1, SENSE_T, SENSE_DIM]);
