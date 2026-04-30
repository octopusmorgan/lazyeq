/**
 * Internationalization (i18n) - English/Spanish strings
 */

const i18nStrings = {
  // English
  'en-US': {
    'btn.Noise': 'Calibrate Noise',
    'btn.Sweep': 'Start Sweep',
    'btn.Stop': 'Stop',
    'btn.RoomWalk': 'Room Walk',
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
  },
  // Spanish
  'es-AR': {
    'btn.Noise': 'Calibrar Ruido',
    'btn.Sweep': 'Iniciar Sweep',
    'btn.Stop': 'Detener',
    'btn.RoomWalk': 'Recorrido',
    'btn.ExportWavelet': 'Exportar Wavelet',
    'btn.ExportEqMac': 'Exportar EQ Mac',
    'status.Recording': 'Grabando...',
    'status.Calibrating': 'Calibrando micrófono...',
    'status.SweepStarted': 'Sweep iniciado',
    'status.SweepFinished': 'Sweep terminado',
    'status.Processing': 'Procesando...',
    'status.ExportDone': 'Exportación completa',
    'status.Error': 'Error',
    'label.MicSelect': 'Micrófono',
    'label.FoundMics': '{count} micrófono(s) encontrado(s)',
    'noMics': 'No se encontraron micrófonos',
    'desktopMic': 'Micrófono (Recomendado)',
    'bluetoothMic': 'Bluetooth (Evitar)',
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