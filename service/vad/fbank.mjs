/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: Unnormalized 16 kHz mono PCM samples and FireRedVAD cmvn.bin.
 * [OUTPUT]: Dependency-free 25 ms / 10 ms / 80-bin Kaldi-compatible CMVN fbank frames.
 * [POS]: Proven FireRedVAD feature donor; HTP inference and cut policy live in separate modules.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const SR = 16_000;
const FRAME_LEN = 400;
const FRAME_SHIFT = 160;
const N_FFT = 512;
const MEL = 80;
const PREEMPH = 0.97;
const LOW_FREQ = 20;
const HIGH_FREQ = SR / 2;
const EPS = 1.1920928955078125e-07;

const WINDOW = (() => {
  const value = new Float64Array(FRAME_LEN);
  for (let index = 0; index < FRAME_LEN; index += 1) {
    value[index] = Math.pow(
      0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FRAME_LEN - 1)),
      0.85,
    );
  }
  return value;
})();

const melScale = (frequency) => 1127 * Math.log(1 + frequency / 700);

const MEL_BANKS = (() => {
  const fftBins = N_FFT / 2 + 1;
  const melLow = melScale(LOW_FREQ);
  const melHigh = melScale(HIGH_FREQ);
  const delta = (melHigh - melLow) / (MEL + 1);
  const banks = [];
  for (let melIndex = 0; melIndex < MEL; melIndex += 1) {
    const left = melLow + melIndex * delta;
    const center = melLow + (melIndex + 1) * delta;
    const right = melLow + (melIndex + 2) * delta;
    const weights = new Float64Array(fftBins);
    for (let bin = 0; bin < fftBins; bin += 1) {
      const mel = melScale((bin * SR) / N_FFT);
      if (mel > left && mel < right) {
        weights[bin] = mel <= center
          ? (mel - left) / (center - left)
          : (right - mel) / (right - center);
      }
    }
    banks.push(weights);
  }
  return banks;
})();

const powerSpectrum = (frame) => {
  const real = new Float64Array(N_FFT);
  const imaginary = new Float64Array(N_FFT);
  for (let index = 0; index < frame.length; index += 1) real[index] = frame[index];
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
  for (let bin = 0; bin <= N_FFT / 2; bin += 1) {
    power[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
  }
  return power;
};

const processFrame = (samples, start) => {
  const frame = new Float64Array(FRAME_LEN);
  for (let index = 0; index < FRAME_LEN; index += 1) frame[index] = samples[start + index];
  let mean = 0;
  for (const value of frame) mean += value;
  mean /= FRAME_LEN;
  for (let index = 0; index < FRAME_LEN; index += 1) frame[index] -= mean;
  for (let index = FRAME_LEN - 1; index > 0; index -= 1) {
    frame[index] -= PREEMPH * frame[index - 1];
  }
  frame[0] -= PREEMPH * frame[0];
  for (let index = 0; index < FRAME_LEN; index += 1) frame[index] *= WINDOW[index];
  const power = powerSpectrum(frame);
  const result = new Float64Array(MEL);
  for (let melIndex = 0; melIndex < MEL; melIndex += 1) {
    const weights = MEL_BANKS[melIndex];
    let energy = 0;
    for (let bin = 0; bin < weights.length; bin += 1) {
      if (weights[bin] !== 0) energy += weights[bin] * power[bin];
    }
    result[melIndex] = Math.log(Math.max(energy, EPS));
  }
  return result;
};

export function loadCmvn(buffer) {
  const values = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 4),
  );
  if (values.length < MEL * 2) throw new Error(`cmvn too small: ${values.length}`);
  return { means: values.slice(0, MEL), istd: values.slice(MEL, MEL * 2) };
}

export function computeFbank(samples, cmvn) {
  if (samples.length < FRAME_LEN) return { feat: [], frames: 0 };
  const frames = Math.floor((samples.length - FRAME_LEN) / FRAME_SHIFT) + 1;
  const feat = [];
  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const raw = processFrame(samples, frameIndex * FRAME_SHIFT);
    const row = new Array(MEL);
    for (let melIndex = 0; melIndex < MEL; melIndex += 1) {
      row[melIndex] = (raw[melIndex] - cmvn.means[melIndex]) * cmvn.istd[melIndex];
    }
    feat.push(row);
  }
  return { feat, frames };
}

export const FBANK_FRAME_SAMPLES = FRAME_SHIFT;
