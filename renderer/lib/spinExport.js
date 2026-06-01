/**
 * v0.43.0: spin export — turn a product's ordered image set into a shareable
 * video file (MP4 preferred, WebM fallback). Renderer-only, zero new
 * dependencies: it draws each frame to a hidden canvas and records the canvas
 * stream with MediaRecorder, which Chromium 130 (in Electron 33) supports for
 * both H.264/MP4 and VP9/WebM.
 *
 * GIF export was the original ask, but animated GIF is 5–10× larger than an
 * H.264 MP4 of the same spin at similar quality, and every modern target
 * (Shopify, WhatsApp, iOS Photos, Mail) plays MP4 inline. So we ship video.
 *
 * Why captureStream(0) + requestFrame(): the default captureStream(fps) emits
 * frames on a wall-clock timer regardless of what we've drawn, so a slow draw
 * step gets duplicate frames at the wrong time. Pulling frames manually means
 * every `drawImage` is captured exactly once, in order, at the cadence we ask
 * for.
 */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load frame: ${url}`));
    img.src = url;
  });
}

// Ranked candidates by codec quality + file-size. We pick the FIRST candidate
// the platform admits to supporting via MediaRecorder.isTypeSupported(). If
// the caller asks for MP4 first, we try those first; the WebM fallbacks make
// this robust on Linux/Win/older Chromium too.
function pickMimeType(preferred) {
  const mp4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=h264', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const ranked = preferred === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of ranked) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) { /* ignore */ }
  }
  return '';
}

/**
 * Encode an ordered set of image URLs into a spin video.
 *
 * @param {string[]} imageUrls   ordered frame URLs (e.g. appImageSrc(...) per image)
 * @param {object}   [opts]
 * @param {number}   [opts.fps=12]
 * @param {number}   [opts.loops=2]      number of full rotations
 * @param {number}   [opts.maxSide=1024] downscale so neither dim > maxSide
 * @param {string}   [opts.background='#FFFFFF']  fill behind each frame
 * @param {'mp4'|'webm'} [opts.format='mp4']      preferred container
 * @param {(stage, ratio) => void} [opts.onProgress]  'load' | 'render'
 * @returns {Promise<{ blob: Blob, mimeType: string, width: number, height: number, frames: number, fps: number, ext: string }>}
 */
export async function exportSpinVideo(imageUrls, opts = {}) {
  const fps = Math.max(1, Math.min(30, Number(opts.fps) || 12));
  const loops = Math.max(1, Math.min(8, Number(opts.loops) || 2));
  const maxSide = Math.max(64, Math.min(2048, Number(opts.maxSide) || 1024));
  const background = opts.background || '#FFFFFF';
  const format = opts.format === 'webm' ? 'webm' : 'mp4';
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
    throw new Error('Need at least 2 frames to spin');
  }

  const mimeType = pickMimeType(format);
  if (!mimeType) throw new Error('This build can\'t record video — no supported MediaRecorder codec.');

  // Preload all frames first so the recording loop never blocks on network.
  const imgs = [];
  for (let i = 0; i < imageUrls.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential is fine; small N
    imgs.push(await loadImage(imageUrls[i]));
    onProgress?.('load', (i + 1) / imageUrls.length);
  }

  // Canvas sized to the largest frame, downscaled to fit within maxSide so we
  // keep the file small + encoding fast. Each frame is then fit-inside this
  // canvas with a background fill — so mismatched frame sizes still look right.
  const naturalW = Math.max(...imgs.map((i) => i.naturalWidth || i.width));
  const naturalH = Math.max(...imgs.map((i) => i.naturalHeight || i.height));
  const downscale = Math.min(1, maxSide / Math.max(naturalW, naturalH));
  const W = Math.max(2, Math.round(naturalW * downscale));
  const H = Math.max(2, Math.round(naturalH * downscale));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Paint an initial frame BEFORE captureStream so the recorder sees a valid
  // first frame the moment we hit start(). Some Chromium builds drop the very
  // first requestFrame() if the canvas is still blank.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  {
    const img = imgs[0];
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const s = Math.min(W / iw, H / ih);
    const dw = iw * s; const dh = ih * s;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  const stream = canvas.captureStream(0); // manual frame requests
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start();

  const totalFrames = imgs.length * loops;
  const frameMs = 1000 / fps;
  for (let f = 0; f < totalFrames; f += 1) {
    const img = imgs[f % imgs.length];
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const s = Math.min(W / iw, H / ih);
    const dw = iw * s; const dh = ih * s;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    if (track.requestFrame) track.requestFrame();
    onProgress?.('render', (f + 1) / totalFrames);
    // eslint-disable-next-line no-await-in-loop -- we WANT one frame per tick
    await new Promise((r) => setTimeout(r, frameMs));
  }
  rec.stop();
  await stopped;

  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(chunks, { type: mimeType }), mimeType, width: W, height: H, frames: totalFrames, fps, ext };
}
