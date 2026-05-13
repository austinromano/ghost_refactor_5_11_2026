// Canvas drawing helpers for the vertical (9:16) composite recorder.
// All pure functions over a CanvasRenderingContext2D — no React, no
// store access. Lifted out of RecordVerticalOverlay so the overlay
// component stays focused on lifecycle / state / UI.

// Frame-fit math: scale + crop so the source fills the destination
// rect like CSS object-fit: cover. Used for the camera region — we
// preserve the user's face cam aspect and crop excess.
export function drawCover(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (!sw || !sh) return;
  const sourceAspect = sw / sh;
  const destAspect = dw / dh;
  let cropW = sw;
  let cropH = sh;
  let cropX = 0;
  let cropY = 0;
  if (sourceAspect > destAspect) {
    // Source is wider than dest — crop the sides.
    cropW = sh * destAspect;
    cropX = (sw - cropW) / 2;
  } else {
    // Source is taller than dest — crop the top/bottom.
    cropH = sw / destAspect;
    cropY = (sh - cropH) / 2;
  }
  try {
    ctx.drawImage(src, cropX, cropY, cropW, cropH, dx, dy, dw, dh);
  } catch { /* video may not be ready yet */ }
}

// Stretch-fit: scale the entire source to exactly fill dest. Used for
// the screen-share region so the bottom 72% is ALWAYS filled edge-to-
// edge, regardless of whether the captured window's content actually
// reaches its edges. Cover-fit was leaving black space whenever the
// user's shared window had empty area below the app (browser chrome,
// taskbar, etc) — drawCover would dutifully scale that empty area
// into the dest. Stretch-fit accepts a small aspect distortion in
// exchange for never showing dead space.
export function drawStretch(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (!sw || !sh) return;
  try {
    ctx.drawImage(src, 0, 0, sw, sh, dx, dy, dw, dh);
  } catch { /* video may not be ready yet */ }
}

// Contain-fit: scale the source to fit ENTIRELY inside dest while
// preserving aspect — adds letterbox bars (top/bottom) or pillarbox
// bars (left/right) when aspects differ, never crops the source.
// Used for the screen-share region so the user sees the full
// landscape capture inside the vertical 9:16 frame.
export function drawContain(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  dx: number, dy: number, dw: number, dh: number,
): void {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (!sw || !sh) return;
  const sourceAspect = sw / sh;
  const destAspect = dw / dh;
  let drawW = dw;
  let drawH = dh;
  if (sourceAspect > destAspect) {
    // Source wider than dest — letterbox (bars top + bottom). Width
    // fills, height shrinks.
    drawW = dw;
    drawH = dw / sourceAspect;
  } else {
    // Source taller than dest — pillarbox (bars left + right).
    drawH = dh;
    drawW = dh * sourceAspect;
  }
  const drawX = dx + (dw - drawW) / 2;
  const drawY = dy + (dh - drawH) / 2;
  try {
    ctx.drawImage(src, 0, 0, sw, sh, drawX, drawY, drawW, drawH);
  } catch { /* video may not be ready yet */ }
}

// Draw the official Ghost Session mark — a 1:1 canvas port of the
// SVG path used in WelcomeHero (the ghost on the home screen). The
// stroke + eye fills use the brand gradient `#00FFC8 → #7C3AED`.
// Source viewBox is 20×22; we scale that into a (cx, cy)-centered
// box `size` wide.
export function drawBrandGhost(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const VB_W = 20;
  const VB_H = 22;
  const scale = size / VB_W;
  const renderH = VB_H * scale;
  const x0 = cx - size / 2;
  const y0 = cy - renderH / 2;

  // Map a viewBox coordinate (in 0..20, 0..22 space) to canvas px.
  const cvx = (vx: number) => x0 + vx * scale;
  const cvy = (vy: number) => y0 + vy * scale;

  ctx.save();
  // Body path — same M10 1 C…V9 C…z command sequence as the SVG.
  ctx.beginPath();
  ctx.moveTo(cvx(10), cvy(1));
  ctx.bezierCurveTo(cvx(5.5), cvy(1), cvx(2), cvy(4.5), cvx(2), cvy(9));
  ctx.lineTo(cvx(2), cvy(17));
  ctx.lineTo(cvx(4), cvy(15));
  ctx.lineTo(cvx(6), cvy(17));
  ctx.lineTo(cvx(8), cvy(15));
  ctx.lineTo(cvx(10), cvy(17));
  ctx.lineTo(cvx(12), cvy(15));
  ctx.lineTo(cvx(14), cvy(17));
  ctx.lineTo(cvx(16), cvy(15));
  ctx.lineTo(cvx(18), cvy(17));
  ctx.lineTo(cvx(18), cvy(9));
  ctx.bezierCurveTo(cvx(18), cvy(4.5), cvx(14.5), cvy(1), cvx(10), cvy(1));
  ctx.closePath();
  // Soft mint fill (rgba(0,255,200,0.08) in the SVG) — keeps the
  // ghost's interior just barely tinted.
  ctx.fillStyle = 'rgba(0,255,200,0.10)';
  ctx.fill();
  // Brand gradient stroke — diagonal across the path.
  const gradient = ctx.createLinearGradient(x0, y0, x0 + size, y0 + renderH);
  gradient.addColorStop(0, '#00FFC8');
  gradient.addColorStop(1, '#7C3AED');
  ctx.strokeStyle = gradient;
  ctx.lineWidth = Math.max(1.2, scale * 1.4);
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Eyes — gradient-filled ovals with darker pupils, exactly the
  // proportions used in the SVG (rx 1.6, ry 1.8 / pupil rx 0.6, ry 0.7).
  const eyeRx = 1.6 * scale;
  const eyeRy = 1.8 * scale;
  const pupilRx = 0.6 * scale;
  const pupilRy = 0.7 * scale;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(cvx(7.5), cvy(9.5), eyeRx, eyeRy, 0, 0, Math.PI * 2);
  ctx.ellipse(cvx(12.5), cvy(9.5), eyeRx, eyeRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0A0412';
  ctx.beginPath();
  ctx.ellipse(cvx(7.5), cvy(9.2), pupilRx, pupilRy, 0, 0, Math.PI * 2);
  ctx.ellipse(cvx(12.5), cvy(9.2), pupilRx, pupilRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Round-rect path. Canvas's roundRect is not yet universal so we
// pave a manual one with arcTo for portability.
export function pathRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Brand watermark — dark rounded pill in the bottom-right corner
// containing the ghost mascot + the wordmark "ghost session". Sized
// relative to the canvas so it reads at the same proportional weight
// regardless of output resolution.
export function drawWatermark(ctx: CanvasRenderingContext2D): void {
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  const iconSize = Math.round(canvasW * 0.06);          // ghost icon size
  const fontSize = Math.round(canvasW * 0.038);          // wordmark text
  const padX = Math.round(canvasW * 0.018);
  const padY = Math.round(canvasW * 0.014);
  const gap = Math.round(canvasW * 0.012);
  const margin = Math.round(canvasW * 0.025);
  const radius = Math.round(canvasW * 0.018);

  const text = 'ghost session';
  ctx.save();
  ctx.font = `700 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  const textWidth = ctx.measureText(text).width;

  const pillW = padX * 2 + iconSize + gap + textWidth;
  const pillH = padY * 2 + iconSize;
  const pillX = canvasW - pillW - margin;
  const pillY = canvasH - pillH - margin;

  // Drop shadow on the pill itself so it lifts off the screen capture
  // even when the captured area is dark.
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 6;
  pathRoundRect(ctx, pillX, pillY, pillW, pillH, radius);
  ctx.fillStyle = 'rgba(15, 12, 32, 0.92)';
  ctx.fill();
  // Subtle hairline border — kills the shadow that would otherwise
  // bleed through the pill content.
  ctx.shadowColor = 'transparent';
  pathRoundRect(ctx, pillX, pillY, pillW, pillH, radius);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();

  // Brand ghost mark on the left side of the pill — same path +
  // gradient the home page uses.
  drawBrandGhost(ctx, pillX + padX + iconSize / 2, pillY + pillH / 2, iconSize);

  // Wordmark — right side, gradient-filled to mirror the home-page
  // hero where {firstName} sits in `linear-gradient(120deg, #00FFC8
  // 0%, #7C3AED 55%, #EC4899 100%)`. canvas createLinearGradient
  // takes start + end points, so we map CSS 120° to the equivalent
  // diagonal across the wordmark's bounding box.
  const textX = pillX + padX + iconSize + gap;
  const textY = pillY + pillH / 2 + 1;
  // Approximate 120deg: gradient runs from upper-left to lower-right
  // across the text. Slight downward angle so it reads diagonal.
  const gradStartX = textX;
  const gradStartY = pillY + padY * 0.4;
  const gradEndX = textX + textWidth;
  const gradEndY = pillY + pillH - padY * 0.4;
  const wordGrad = ctx.createLinearGradient(gradStartX, gradStartY, gradEndX, gradEndY);
  wordGrad.addColorStop(0, '#00FFC8');
  wordGrad.addColorStop(0.55, '#7C3AED');
  wordGrad.addColorStop(1, '#EC4899');
  ctx.fillStyle = wordGrad;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, textX, textY);
  ctx.restore();
}

export function pickMimeType(): string | undefined {
  // Try the most specific MP4 / H.264 codec strings first — modern
  // Chromium (116+) and Safari accept these and we want MP4 output
  // since TikTok / Reels / Shorts upload mp4 directly. Fall through
  // to webm only if no mp4 candidate is supported on this engine.
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',  // baseline 3.0 + AAC-LC (most universal)
    'video/mp4;codecs=avc1.42001E,mp4a.40.2',
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2',  // main 3.0 + AAC-LC
    'video/mp4;codecs=avc1.640028,mp4a.40.2',  // high 4.0 + AAC-LC
    'video/mp4;codecs=h264,aac',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* some browsers throw on unsupported strings instead of returning false */ }
  }
  return undefined;
}
