/**
 * Internationalization (i18n) - English/Spanish strings
 */

const i18nStrings = {
  'en-US': {
    'btn.Noise': 'Calibrate Noise',
    'btn.Sweep': 'Start Sweep',
    'btn.Stop': 'Stop',
    'btn.ExportWavelet': 'Export Wavelet',
    'btn.ExportEqMac': 'Export EQ Mac',
    'status.Recording': 'Recording...',
    'status.Calibrating': 'Calibrating mic...',
    'status.SweepStarted': 'Sweep started',
    'status.SweepFinished': 'Sweep finished',
    'status.Processing': 'Processing...',
    'status.ExportDone': 'Export complete',
    'status.Error': 'Error',
    'label.MicSelect': 'Microphone',
    'label.FoundMics': 'Found {count} microphone(s)',
    'noMics': 'No microphones found',
    'desktopMic': 'Desktop Mic (Recommended)',
    'bluetoothMic': 'Bluetooth (Avoid)',
    'freq.Hz': 'Hz',
    'freq.kHz': 'kHz'
  }
};

/**
 * Get localized string
 * @param {string} key - String key (e.g., 'btn.Sweep')
 * @param {string} locale - Locale code 'en-US' or 'es-AR' (default: browser locale or 'en-US')
 * @returns {string} Localized string
 */
export function t(key, locale = null) {
  const actualLocale = locale || navigator.language || 'en-US';
  const strings = i18nStrings[actualLocale] || i18nStrings['en-US'];
  return strings[key] || key;
}

export { i18nStrings };