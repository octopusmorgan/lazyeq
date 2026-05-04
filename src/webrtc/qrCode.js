/**
 * Generate a QR code data URL for the given text.
 * Uses the 'qrcode' package's browser-compatible toCanvas API.
 */
import QRCode from "qrcode";

/**
 * @param {string} text — The URL or string to encode
 * @param {number} [width=200] — Pixel width of the generated QR
 * @returns {Promise<string>} — PNG data URI (data:image/png;base64,...)
 */
export async function generateQRDataUrl(text, width = 200) {
  // Use a temporary off-screen canvas. toCanvas() uses the browser's
  // native HTMLCanvasElement, avoiding Node canvas bundling issues.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = width;

  await QRCode.toCanvas(canvas, text, {
    width,
    margin: 2,
    color: {
      dark: "#00f5d4",
      light: "#0c0c14",
    },
  });

  return canvas.toDataURL("image/png");
}
