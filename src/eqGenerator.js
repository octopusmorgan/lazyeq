/**
 * EQ Curve Generator - Clean rewrite
 */

// eqMac 10-band frequencies
export const EQMAC_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Wavelet format: 147 bands from 20Hz to 20kHz
const WAVELET_FREQUENCIES = [
  20, 21, 22, 23, 24, 26, 27, 29, 30, 32, 34, 36, 38, 40, 43, 45, 48, 50,
  53, 56, 59, 63, 66, 70, 74, 78, 83, 87, 92, 97, 103, 109, 115, 121, 128,
  136, 143, 151, 160, 169, 178, 188, 199, 210, 222, 235, 248, 262, 277, 292,
  309, 326, 345, 364, 385, 406, 429, 453, 479, 506, 534, 565, 596, 630,
  665, 703, 743, 784, 829, 875, 924, 977, 1032, 1090, 1151, 1216, 1284,
  1357, 1433, 1514, 1599, 1689, 1784, 1885, 1991, 2103, 2221, 2347, 2479,
  2618, 2766, 2921, 3086, 3260, 3443, 3637, 3842, 4058, 4287, 4528, 4783,
  5052, 5337, 5637, 5955, 6290, 6644, 7018, 7414, 7831, 8272, 8738, 9230,
  9749, 10298, 10878, 11490, 12137, 12821, 13543, 14305, 15110, 15961, 16860,
  17809, 18812, 19871
];

// Harman Loudspeaker Target Curve (2013) - for speakers/room EQ
const HARMAN_TARGET = {
  20: -4.0, 30: -4.0, 40: -3.8, 50: -3.5, 60: -3.2,
  80: -2.8, 100: -2.5, 125: -2.0, 160: -1.5, 200: -1.0,
  250: -0.5, 315: -0.3, 400: 0, 500: 0, 630: 0,
  800: 0, 1000: 0, 1250: 0, 1600: 0, 2000: 0,
  2500: 0.5, 3150: 1.0, 4000: 1.0, 5000: 0.8, 6300: 0.5,
  8000: 0, 10000: 0, 12500: -0.5, 16000: -1.5, 20000: -3.0
};

// Cache sorted keys - avoid re-parsing on every call
const _harMAN_TARGET_KEYS = Object.keys(HARMAN_TARGET).map(Number).sort((a, b) => a - b);

function getHarmanTargetDB(freq) {
  const freqs = _harMAN_TARGET_KEYS;
  if (freq <= freqs[0]) return HARMAN_TARGET[freqs[0]];
  if (freq >= freqs[freqs.length - 1]) return HARMAN_TARGET[freqs[freqs.length - 1]];
  for (let i = 0; i < freqs.length - 1; i++) {
    if (freqs[i] <= freq && freq <= freqs[i + 1]) {
      const ratio = (freq - freqs[i]) / (freqs[i + 1] - freqs[i]);
      return HARMAN_TARGET[freqs[i]] * (1 - ratio) + HARMAN_TARGET[freqs[i + 1]] * ratio;
    }
  }
  return 0;
}

function interpolateToWaveletBands(spectrum, frequencyLabels) {
  const wavBands = new Float32Array(WAVELET_FREQUENCIES.length);
  for (let b = 0; b < WAVELET_FREQUENCIES.length; b++) {
    const targetFreq = WAVELET_FREQUENCIES[b];
    let lowIdx = 0, highIdx = 0;
    for (let i = 0; i < frequencyLabels.length - 1; i++) {
      if (frequencyLabels[i] <= targetFreq && frequencyLabels[i + 1] >= targetFreq) {
        lowIdx = i;
        highIdx = i + 1;
        break;
      }
    }
    if (highIdx > lowIdx && frequencyLabels[highIdx] !== frequencyLabels[lowIdx]) {
      const ratio = (targetFreq - frequencyLabels[lowIdx]) / (frequencyLabels[highIdx] - frequencyLabels[lowIdx]);
      wavBands[b] = spectrum[lowIdx] * (1 - ratio) + spectrum[highIdx] * ratio;
    } else {
      wavBands[b] = spectrum[lowIdx];
    }
  }
  return wavBands;
}

export function generateFlatEQ() {
  return new Float32Array(WAVELET_FREQUENCIES.length);
}

export function generateEQCurve(spectrum, frequencyLabels, targetGain = 0) {
  const gains = new Float32Array(WAVELET_FREQUENCIES.length);
  if (!spectrum || spectrum.length === 0) return gains;
  const wavBands = interpolateToWaveletBands(spectrum, frequencyLabels);
  for (let b = 0; b < WAVELET_FREQUENCIES.length; b++) {
    const target = getHarmanTargetDB(WAVELET_FREQUENCIES[b]);
    gains[b] = target - wavBands[b];
    gains[b] = Math.max(-12, Math.min(12, Math.round(gains[b] * 10) / 10));
  }
  return gains;
}

export function exportWavelet(gains) {
  const parts = [];
  const numBands = WAVELET_FREQUENCIES.length;
  // Normalize to plain Array — Float32Array serialized via JSON.parse loses .length
  const gainsArray = (gains && gains.length > 0) ? Array.from(gains) : [];
  for (let i = 0; i < numBands; i++) {
    let gain = 0;
    if (gainsArray.length >= numBands) {
      gain = gainsArray[i];
    } else if (gainsArray.length > 0) {
      const ratio = i / (numBands - 1);
      const idx = ratio * (gainsArray.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, gainsArray.length - 1);
      const frac = idx - lo;
      gain = gainsArray[lo] * (1 - frac) + gainsArray[hi] * frac;
    }
    parts.push(`${WAVELET_FREQUENCIES[i]} ${gain.toFixed(1)}`);
  }
  return `GraphicEQ: ${parts.join("; ")}`;
}

export function exportEqMac(gains, visData = null) {
  const bands = EQMAC_BANDS;
  // Normalize to plain Array — Float32Array serialized via JSON.parse loses .length
  const gainsArray = (gains && gains.length > 0) ? Array.from(gains) : [];

  if (gainsArray.length === 0) {
    return JSON.stringify({
      name: "lazyEq Preset",
      enabled: true,
      preamp: "0.0 dB",
      filters: bands.map(freq => ({ type: "PK", freq: freq, gain: "0.0", Q: 1.0 }))
    }, null, 2);
  }

  // Calculate average gain for preamp
  let sumGain = 0;
  gainsArray.forEach(g => sumGain += g);
  const avgGain = sumGain / gainsArray.length;
  const preampValue = -avgGain;

  // Frequency-based interpolation when visData is available
  function getGainAtFreq(targetFreq) {
    if (!visData || visData.length === 0) return 0;
    if (visData.length === 1) return gainsArray[0] || 0;

    for (let i = 0; i < visData.length - 1; i++) {
      const f1 = visData[i].x;
      const f2 = visData[i + 1].x;
      if (targetFreq <= f1) return gainsArray[i] || 0;
      if (targetFreq >= f2) continue;
      if (targetFreq >= f1 && targetFreq <= f2) {
        const ratio = (targetFreq - f1) / (f2 - f1);
        return (gainsArray[i] || 0) + ((gainsArray[i + 1] || 0) - (gainsArray[i] || 0)) * ratio;
      }
    }
    return gainsArray[gainsArray.length - 1] || 0;
  }

  const filters = bands.map((freq) => {
    const filterGain = visData ? getGainAtFreq(freq) : gainsArray[Math.min(Math.floor((freq / 20000) * (gainsArray.length - 1)), gainsArray.length - 1)];
    const adjustedGain = filterGain + preampValue;
    return { type: "PK", freq: freq, gain: adjustedGain.toFixed(1), Q: 1.0 };
  });

  return JSON.stringify({
    name: "lazyEq Preset",
    enabled: true,
    preamp: "0.0 dB",
    filters
  }, null, 2);
}

export function generateVisualizationData(spectrum, frequencyLabels, numPoints = 64) {
  if (!spectrum || spectrum.length === 0 || !frequencyLabels || frequencyLabels.length === 0) return [];
  const points = [];
  const minFreq = 20, maxFreq = 20000;

  // Binary search: find nearest linear-FFT bin for a given log frequency.
  // frequencyLabels are linear: label[f] = f * (SAMPLE_RATE / FFT_SIZE).
  // Binary search is O(log n) and introduces no per-iteration allocations.
  for (let i = 0; i < numPoints; i++) {
    const freq = minFreq * Math.pow(maxFreq / minFreq, i / (numPoints - 1));

    // Binary search for closest bin in frequencyLabels
    let lo = 0, hi = frequencyLabels.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (frequencyLabels[mid] <= freq) lo = mid;
      else hi = mid;
    }
    const binIdx = (freq - frequencyLabels[lo]) <= (frequencyLabels[hi] - freq) ? lo : hi;

    points.push({ x: freq, y: spectrum[binIdx] ?? -100 });
  }
  return points;
}

export { getHarmanTargetDB };