import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { getCtx, getMasterFader } from '../../stores/audio/graph';
import { useAudioStore } from '../../stores/audioStore';
import { drawCover, drawStretch, drawContain, drawWatermark, pickMimeType } from './recordCanvas';

// Vertical (9:16) composite recorder for TikTok / Reels / Shorts.
//
// What the recorded video contains:
//   - Top ~28%: the user's webcam (object-cover crop).
//   - Bottom ~72%: a live screen capture of the app the user shared
//     (typically the Ghost Session tab in a narrow window so the
//     arrangement / mixer / plugins stack vertically the way the
//     reference TikToks do).
//   - Audio: the project's master output, tapped from the master
//     fader through a parallel MediaStreamDestinationNode so speaker
//     playback is unaffected. Mic is intentionally OFF — the audio
//     bed is the project, not the user's voice.
//
// How the composite is built:
//   - A hidden 1080×1920 <canvas> is updated each animation frame
//     with drawImage calls from two off-DOM <video> elements (camera
//     + screen). canvas.captureStream(30) gives us a single video
//     track that MediaRecorder can encode.
//   - The audio track and the canvas video track go into one
//     combined MediaStream that the recorder writes to a Blob.
//
// While recording, the entire overlay UI hides itself (display:
// none) so it doesn't end up captured by the screen-share track.
// The user controls stop via the browser's built-in "Stop sharing"
// bar — when the screen track ends we finalise the take and
// re-expand the overlay to show the preview + save/retake buttons.

interface Props {
  open: boolean;
  onClose: () => void;
}

// Recorder lifecycle:
//   requesting_camera → previewing → requesting_screen
//   → ready_to_record → recording → finalizing → reviewing
// Screen capture is acquired BEFORE the user presses record so they
// can confirm the composite (camera + screen) reads correctly. The
// big record button only appears once both streams are live.
type Phase =
  | 'requesting_camera'
  | 'previewing'
  | 'requesting_screen'
  | 'ready_to_record'
  | 'recording'
  | 'finalizing'
  | 'reviewing'
  | 'error';

const OUTPUT_W = 1080;
const OUTPUT_H = 1920;
const CAMERA_HEIGHT = Math.round(OUTPUT_H * 0.28);
const SCREEN_TOP = CAMERA_HEIGHT;
const SCREEN_HEIGHT = OUTPUT_H - CAMERA_HEIGHT;


export default function RecordVerticalOverlay({ open, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('requesting_camera');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultMime, setResultMime] = useState<string>('video/webm');
  // Brief "Saved to Downloads" toast so the user can see the action
  // landed (browsers don't always show a download bar by default,
  // and a webview embed doesn't show one at all).
  const [savedToast, setSavedToast] = useState<string | null>(null);
  // Share menu visibility. Opened from the review-state Share
  // button. Hides when the user picks a destination or closes it.
  const [showShareMenu, setShowShareMenu] = useState(false);
  // Camera selector — populated from navigator.mediaDevices once
  // we've been granted permission. Persisted choice lets the user
  // default to e.g. their iPhone (Continuity Camera on macOS, or a
  // Camo / EpocCam virtual webcam on Windows) across sessions.
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(() => {
    try { return localStorage.getItem('ghost_record_camera_id'); } catch { return null; }
  });

  // Holds every track / node we create here so cleanup is deterministic.
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafIdRef = useRef<number | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  // Canvas captureStream — created once when the compositor starts
  // (after both camera + screen are live) and reused for both the
  // preview panel and the MediaRecorder feed. Stored in a ref so
  // beginRecording() can find it after chooseWindow() finished.
  const canvasStreamRef = useRef<MediaStream | null>(null);
  // Compositor RAF throttling. The drawFrame closure is stored in a
  // ref so beginRecording() can kick the loop after chooseWindow()
  // built it. lastFrameTimeRef keeps a rolling timestamp so we
  // sleep between frames instead of redrawing on every display
  // refresh — see drawFrame for rationale.
  const drawFrameFnRef = useRef<(() => void) | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const COMPOSITOR_FRAME_MS = 1000 / 30;

  // <video> elements feed the canvas compositor. The "preview" video
  // is what the user sees in the overlay before recording starts —
  // mirrored locally so the framing reads correctly.
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Acquire camera on open. Mic stays off intentionally.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('requesting_camera');
    setError(null);
    setResultUrl((url) => {
      if (url) URL.revokeObjectURL(url);
      return null;
    });
    setElapsedMs(0);
    chunksRef.current = [];

    (async () => {
      try {
        // Try the saved deviceId first. If it fails (most common
        // cause: the saved camera — e.g. iPhone via Continuity
        // Camera — isn't connected anymore so getUserMedia throws
        // OverconstrainedError), drop the stale id and retry with
        // the default camera before showing an error.
        let stream: MediaStream;
        try {
          stream = await acquireCameraStream(selectedCameraId);
        } catch (firstErr) {
          if (!selectedCameraId) throw firstErr;
          try { localStorage.removeItem('ghost_record_camera_id'); } catch { /* ignore */ }
          if (!cancelled) setSelectedCameraId(null);
          stream = await acquireCameraStream(null);
        }
        if (cancelled) {
          for (const t of stream.getTracks()) try { t.stop(); } catch { /* ignore */ }
          return;
        }
        cameraStreamRef.current = stream;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
          cameraVideoRef.current.play().catch(() => { /* autoplay-blocked is fine */ });
        }
        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
          previewVideoRef.current.play().catch(() => { /* autoplay-blocked is fine */ });
        }
        // Refresh the device list now that permission is granted —
        // before getUserMedia, enumerateDevices returns blank labels
        // (privacy guard). Now we can show real names like
        // "iPhone (Continuity Camera)".
        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) setCameras(list.filter((d) => d.kind === 'videoinput'));
        } catch { /* ignore */ }
        setPhase('previewing');
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = (err as { message?: string })?.message || 'Camera access denied';
        setError(msg);
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanupAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Build the getUserMedia constraints for a specific camera. If the
  // user has chosen a deviceId we lock to it; otherwise we hint
  // facingMode 'user' so a laptop's built-in front camera is the
  // default before they explicitly pick something else (e.g. their
  // iPhone via Continuity Camera).
  async function acquireCameraStream(deviceId: string | null): Promise<MediaStream> {
    // Cap the camera hard at 720p / 30 fps using `max` constraints
    // (rather than `ideal`) so high-quality phones / external cams
    // like the DJI Osmo Pocket don't try to deliver 4K @ 60 fps.
    // Decoding and copying those frames every RAF tick was starving
    // the audio thread and causing DAW lag.
    const video: MediaTrackConstraints = {
      width: { max: 1280, ideal: 1280 },
      height: { max: 720, ideal: 720 },
      frameRate: { max: 30, ideal: 30 },
    };
    if (deviceId) {
      video.deviceId = { exact: deviceId };
    } else {
      video.facingMode = 'user';
    }
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }

  // Swap the camera stream live. Stops the current tracks, opens a
  // new stream from the chosen device, and rewires every <video>
  // that was reading from the old one. Persisted so the choice
  // sticks across sessions.
  async function switchCamera(deviceId: string) {
    setSelectedCameraId(deviceId);
    try { localStorage.setItem('ghost_record_camera_id', deviceId); } catch { /* ignore */ }
    // Tear down the current stream so the OS hands the device back.
    if (cameraStreamRef.current) {
      for (const t of cameraStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
      cameraStreamRef.current = null;
    }
    try {
      const next = await acquireCameraStream(deviceId);
      cameraStreamRef.current = next;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = next;
        cameraVideoRef.current.play().catch(() => { /* ignore */ });
      }
      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = next;
        previewVideoRef.current.play().catch(() => { /* ignore */ });
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Camera switch failed';
      setError(msg);
    }
  }

  function cleanupAll() {
    // Stop recorder if running.
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    // Cancel compositor.
    if (rafIdRef.current != null) {
      // Either an animation frame ID or a setTimeout ID — both
      // cancel safely on either API for non-matching values.
      cancelAnimationFrame(rafIdRef.current);
      clearTimeout(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (recordTimerRef.current != null) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    // Stop camera + screen tracks.
    if (cameraStreamRef.current) {
      for (const t of cameraStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
      cameraStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      for (const t of screenStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
      screenStreamRef.current = null;
    }
    // Detach the parallel master-fader edge.
    if (audioDestRef.current) {
      try { getMasterFader().disconnect(audioDestRef.current); } catch { /* ignore */ }
      audioDestRef.current = null;
    }
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    if (previewVideoRef.current) previewVideoRef.current.srcObject = null;
    canvasStreamRef.current = null;
  }

  function tapMasterAudio(): MediaStreamTrack | null {
    const ctx = getCtx();
    const dest = ctx.createMediaStreamDestination();
    audioDestRef.current = dest;
    getMasterFader().connect(dest);
    const tracks = dest.stream.getAudioTracks();
    return tracks[0] || null;
  }

  // Step 1 — get the screen-share stream + start the canvas
  // compositor. Doesn't touch MediaRecorder yet; the user reviews
  // the composite preview first and triggers the take with the big
  // record button (beginRecording).
  async function chooseWindow() {
    const cam = cameraStreamRef.current;
    if (!cam) return;
    setPhase('requesting_screen');
    setError(null);

    let screenStream: MediaStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
        // Non-standard hints — Chromium pre-selects the current tab,
        // selfBrowserSurface tells the picker to allow this tab as
        // a target. Other browsers ignore both fields.
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      } as MediaStreamConstraints);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Screen share cancelled';
      setError(msg);
      setPhase('previewing');
      return;
    }
    screenStreamRef.current = screenStream;
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = screenStream;
      try { await screenVideoRef.current.play(); } catch { /* ignore */ }
    }

    // If the user hits Stop sharing in the browser at any point,
    // tear the compositor down + drop back to camera-only preview.
    const screenTrack = screenStream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.addEventListener('ended', () => {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          stopRecording();
        } else {
          // User cancelled the share before recording started.
          stopCompositor();
          screenStreamRef.current = null;
          setPhase('previewing');
        }
      });
    }

    // Wire the canvas + RAF compositor — this populates the live
    // canvas captureStream that both the panel preview and the
    // recorder consume.
    const canvas = canvasRef.current;
    if (!canvas) {
      setError('Canvas missing');
      setPhase('error');
      return;
    }
    canvas.width = OUTPUT_W;
    canvas.height = OUTPUT_H;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) {
      setError('2D context missing');
      setPhase('error');
      return;
    }
    const drawFrame = () => {
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
      const camV = cameraVideoRef.current;
      const scrV = screenVideoRef.current;
      if (camV && camV.videoWidth > 0) {
        drawCover(ctx2d, camV, 0, 0, OUTPUT_W, CAMERA_HEIGHT);
      }
      if (scrV && scrV.videoWidth > 0) {
        // Two-band layout below the camera:
        //   1) FULL landscape capture — shows the whole shared window,
        //      sized to fit the canvas width without cropping.
        //   2) PLAYHEAD ZOOM strip — fills the remaining space at the
        //      bottom with a 2× zoom into a window of the timeline
        //      that follows the playhead. Way more legible on a phone
        //      than the full app at small scale.
        const sw = scrV.videoWidth;
        const sh = scrV.videoHeight;
        if (sw > 0 && sh > 0) {
          // Band 1 — full landscape, top-aligned in the screen region.
          const scaleW = OUTPUT_W / sw;
          const scaleH = SCREEN_HEIGHT / sh;
          const scale = Math.min(scaleW, scaleH);
          const fullW = sw * scale;
          const fullH = sh * scale;
          const fullX = (OUTPUT_W - fullW) / 2;
          const fullY = SCREEN_TOP;
          try {
            ctx2d.drawImage(scrV, 0, 0, sw, sh, fullX, fullY, fullW, fullH);
          } catch { /* video not ready */ }

          // Band 2 — playhead-tracking zoom of the timeline area.
          // Sits below the landscape band; height fills whatever
          // canvas space is left.
          const zoomTop = Math.round(fullY + fullH);
          const zoomH = OUTPUT_H - zoomTop;
          if (zoomH > 80) {
            // Empirical fractions of where the timeline lives in the
            // captured app. Sidebar ≈ 12 % left; header + collab ≈
            // 18 % top; arrangement ends ≈ 78 % top (plugins below).
            // Tuned for the standard Ghost Session web layout — small
            // visible drift if the user has resized panels, but the
            // zoom still reads OK because the crop is tall enough to
            // catch waveforms / drum lanes / sequencer.
            const TX_LO = 0.12;
            const TX_HI = 1.00;
            const TY_LO = 0.18;
            const TY_HI = 0.78;
            // Pick a source crop with the same aspect as the dest
            // band so the zoom doesn't distort vertically.
            const destAspect = OUTPUT_W / zoomH;
            const cropH_frac = TY_HI - TY_LO;
            const cropH_px = cropH_frac * sh;
            // cropW chosen to match dest aspect.
            const cropW_px = Math.min(cropH_px * destAspect, sw * (TX_HI - TX_LO));
            // Where the playhead sits as a fraction of total
            // arrangement duration. Uses .getState() on every frame
            // — cheap; no React re-render is triggered.
            const audio = useAudioStore.getState();
            const dur = audio.duration > 0 ? audio.duration : 1;
            const t = Math.max(0, Math.min(dur, audio.currentTime));
            const progress = dur > 0 ? t / dur : 0;
            // Slide the crop window across the timeline range. Clamp
            // so the right edge of the crop never overruns the
            // timeline area's right boundary.
            const timelineLeftPx = TX_LO * sw;
            const timelineRightPx = TX_HI * sw;
            const maxStart = Math.max(timelineLeftPx, timelineRightPx - cropW_px);
            const cropX_px = timelineLeftPx + (maxStart - timelineLeftPx) * progress;
            const cropY_px = TY_LO * sh;
            try {
              ctx2d.drawImage(
                scrV,
                cropX_px, cropY_px, cropW_px, cropH_px,
                0, zoomTop, OUTPUT_W, zoomH,
              );
            } catch { /* video not ready */ }
            // Thin progress bar across the bottom of the zoom band so
            // viewers immediately read it as "this is following the
            // playhead". Drawn as a thin filled rect; current
            // progress = filled portion in mint-green.
            const barH = 4;
            const barY = OUTPUT_H - barH - 2;
            ctx2d.fillStyle = 'rgba(255,255,255,0.10)';
            ctx2d.fillRect(0, barY, OUTPUT_W, barH);
            ctx2d.fillStyle = '#00FFC8';
            ctx2d.fillRect(0, barY, OUTPUT_W * progress, barH);
          }
        }
      }
      // Watermark — drawn programmatically each frame as a dark pill
      // containing the ghost mascot + "ghost session" wordmark, so the
      // saved video always ships with the brand mark baked in. No
      // image-load step, no async race; just pure canvas paths so the
      // mark is always crisp at 1080×1920.
      drawWatermark(ctx2d);
      // Throttle the compositor to ~30 fps so heavy frames (1080×
      // 1920 with two drawImage strips + watermark paths) don't
      // hog the main thread at the display's full 60 / 120 Hz
      // refresh — that competition was visibly stalling the audio
      // engine when an external camera was in use.
      const now = performance.now();
      const wait = Math.max(0, lastFrameTimeRef.current + COMPOSITOR_FRAME_MS - now);
      if (wait < 1) {
        lastFrameTimeRef.current = now;
        rafIdRef.current = requestAnimationFrame(drawFrame);
      } else {
        rafIdRef.current = window.setTimeout(() => {
          lastFrameTimeRef.current = performance.now();
          rafIdRef.current = requestAnimationFrame(drawFrame);
        }, wait) as unknown as number;
      }
    };
    drawFrameFnRef.current = drawFrame;

    setPhase('ready_to_record');
  }

  function stopCompositor() {
    if (rafIdRef.current != null) {
      // Either an animation frame ID or a setTimeout ID — both
      // cancel safely on either API for non-matching values.
      cancelAnimationFrame(rafIdRef.current);
      clearTimeout(rafIdRef.current);
      rafIdRef.current = null;
    }
    drawFrameFnRef.current = null;
    canvasStreamRef.current = null;
  }

  // Step 2 — actually start the recording. The compositor RAF was
  // BUILT in chooseWindow but not kicked yet (we don't want
  // heavy 1080×1920 drawing competing with the audio thread while
  // the user is just previewing). Kick it now, capture the canvas
  // stream, and pipe it into MediaRecorder.
  function beginRecording() {
    const canvas = canvasRef.current;
    const draw = drawFrameFnRef.current;
    if (!canvas || !draw) return;
    chunksRef.current = [];

    if (!canvasStreamRef.current) {
      canvasStreamRef.current = canvas.captureStream(30);
    }
    const canvasStream = canvasStreamRef.current;
    lastFrameTimeRef.current = performance.now();
    rafIdRef.current = requestAnimationFrame(draw);

    const audioTrack = tapMasterAudio();
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
    const combined = new MediaStream(tracks);

    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(combined, { mimeType }) : new MediaRecorder(combined);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || 'Recorder failed to start';
      setError(msg);
      setPhase('error');
      return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setResultMime(rec.mimeType || 'video/webm');
      // Tear down compositor + tracks now that the take is final.
      stopCompositor();
      if (screenStreamRef.current) {
        for (const t of screenStreamRef.current.getTracks()) try { t.stop(); } catch { /* ignore */ }
        screenStreamRef.current = null;
      }
      if (audioDestRef.current) {
        try { getMasterFader().disconnect(audioDestRef.current); } catch { /* ignore */ }
        audioDestRef.current = null;
      }
      if (recordTimerRef.current != null) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setPhase('reviewing');
    };
    rec.start(250);

    startTimeRef.current = performance.now();
    setElapsedMs(0);
    if (recordTimerRef.current != null) clearInterval(recordTimerRef.current);
    recordTimerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startTimeRef.current);
    }, 100);
    setPhase('recording');
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      setPhase('finalizing');
      try { rec.stop(); } catch { /* onstop will still fire and re-set phase */ }
    }
  }

  async function downloadResult() {
    if (!resultUrl) return;
    const ext = resultMime.includes('mp4') ? 'mp4' : 'webm';
    // ISO-style date so multiple takes don't collide and the file
    // sorts chronologically in Downloads.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `ghost-session-${stamp}.${ext}`;

    // Inside the JUCE plugin's WebView2 host the browser's anchor-
    // click download is silently swallowed; the C++ side has its
    // own ghost:// download protocol. To use it we need a fetchable
    // URL — the original blob: URL is scoped to the page, so we
    // fetch the blob, base64-encode it, and hand the data: URL to
    // ghost://download-stem (which already accepts an arbitrary
    // URL + fileName). For regular browsers the anchor path is
    // taken and the file lands in the user's Downloads folder.
    const isPlugin = !!(window as { chrome?: { webview?: unknown } }).chrome?.webview;

    if (isPlugin) {
      try {
        const res = await fetch(resultUrl);
        const buf = await res.arrayBuffer();
        // Build base64 from Uint8Array — chunked so we don't hit
        // the call-stack ceiling on long takes.
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        const b64 = btoa(binary);
        const dataUrl = `data:${resultMime};base64,${b64}`;
        const ghostUrl = `ghost://download-stem?url=${encodeURIComponent(dataUrl)}&fileName=${encodeURIComponent(fileName)}`;
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = ghostUrl;
        document.body.appendChild(iframe);
        setTimeout(() => { try { iframe.remove(); } catch { /* ignore */ } }, 1500);
        flashSaved(fileName);
        return;
      } catch (err) {
        // Fall through to the anchor path on encode/fetch failure.
        if (typeof console !== 'undefined') console.warn('[record] plugin download failed, falling back', err);
      }
    }

    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Give the browser a tick to start streaming the blob before
    // we yank the anchor — instant remove + revoke can race the
    // download in some Chromium builds.
    setTimeout(() => { try { a.remove(); } catch { /* ignore */ } }, 200);
    flashSaved(fileName);
  }

  function flashSaved(fileName: string) {
    setSavedToast(`Saved ${fileName} to Downloads`);
    window.setTimeout(() => setSavedToast(null), 2400);
  }

  function discardResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    setElapsedMs(0);
    setShowShareMenu(false);
    setPhase('previewing');
  }

  // Try the native Web Share API first — on mobile this opens the
  // OS share sheet with Instagram / TikTok / X / etc. as one-tap
  // targets. On desktop browsers the API rarely accepts video
  // files, so we fall back to a popover with launchers that open
  // the platform's web upload page in a new tab. Truly *automatic*
  // posting to Instagram personal accounts isn't possible — Meta's
  // Graph API only supports Business/Creator accounts via a Meta
  // OAuth flow + app review, which would be a separate server-side
  // integration phase.
  async function shareResult() {
    if (!resultUrl) return;
    try {
      const res = await fetch(resultUrl);
      const blob = await res.blob();
      const ext = resultMime.includes('mp4') ? 'mp4' : 'webm';
      const fileName = `ghost-session-${Date.now()}.${ext}`;
      const file = new File([blob], fileName, { type: blob.type });
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void> };
      if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        try {
          await nav.share({
            files: [file],
            title: 'Ghost Session take',
            text: 'Made with Ghost Session',
          });
          flashSaved('Shared');
          return;
        } catch {
          // User cancelled the share sheet — fall through to the
          // platform-launcher popover below.
        }
      }
    } catch {
      // fetch / File construction failed — still show the popover.
    }
    setShowShareMenu(true);
  }

  // Save-then-launch: the platform doesn't give us an API to upload
  // a file from a web link, so we kick off a download (the user
  // already has the file in Downloads) and open the platform's
  // upload page in a new tab. The user manually picks the freshly-
  // downloaded file in the platform's uploader.
  function saveAndOpen(url: string) {
    downloadResult().catch(() => { /* ignore — open the platform anyway */ });
    window.open(url, '_blank', 'noopener,noreferrer');
    setShowShareMenu(false);
  }

  const formatTime = (ms: number): string => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = (total % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Drag handling — the panel floats over the project and can be
  // moved freely so the user can keep working underneath it. Drag
  // is gated to a dedicated header bar via dragControls so clicks on
  // the record/save buttons don't accidentally start a drag gesture.
  const dragControls = useDragControls();

  // Hidden video elements + canvas live OUTSIDE the overlay so the
  // screen capture (which records the visible page) doesn't see
  // them, and so they keep playing when phase === 'recording'
  // collapses the visible overlay UI.
  const offscreenScaffold = (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: -99999,
        top: -99999,
        width: 1,
        height: 1,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <video ref={cameraVideoRef} muted playsInline autoPlay />
      <video ref={screenVideoRef} muted playsInline autoPlay />
      <canvas ref={canvasRef} width={OUTPUT_W} height={OUTPUT_H} />
    </div>
  );

  return (
    <>
      {offscreenScaffold}
      <AnimatePresence>
        {open && (
          <motion.div
            // Floating, draggable panel — no full-screen backdrop so
            // the user can keep using the project underneath. dragMomentum
            // is off because momentum on a panel feels janky. constraints
            // pin to the document body so the panel can't be flung
            // off-screen.
            drag
            dragMomentum={false}
            dragElastic={0.04}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ left: -2000, right: 2000, top: -2000, bottom: 2000 }}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26 }}
            className="fixed z-[100]"
            // Default-position the panel near the top-right so it
            // doesn't cover the arrangement view. The user can drag
            // it anywhere from there.
            style={{ top: 96, right: 24 }}
          >
            {phase === 'recording' ? (
              // Collapsed REC pill — during recording the full panel
              // would dominate the captured frame, so shrink to a
              // tiny pill the user can drag off to a corner. Same
              // dragControls so the pill moves with the existing
              // window position.
              <div
                onPointerDown={(e) => { if (e.button === 0) dragControls.start(e); }}
                className="flex items-center gap-2 px-3 py-2 rounded-full select-none"
                style={{
                  background: 'rgba(15,12,32,0.95)',
                  border: '1px solid rgba(239,68,68,0.55)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                  cursor: 'grab',
                  touchAction: 'none',
                }}
                title="Drag to move"
              >
                <motion.span
                  className="w-2 h-2 rounded-full bg-red-500"
                  animate={{ opacity: [1, 0.35, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                />
                <span className="text-[11px] font-bold text-white tabular-nums">REC {formatTime(elapsedMs)}</span>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={stopRecording}
                  className="ml-1 px-2.5 h-6 rounded-full text-[10.5px] font-bold text-white"
                  style={{ background: '#ef4444' }}
                  title="Stop recording"
                >
                  Stop
                </button>
              </div>
            ) : (
            <div className="relative flex flex-col items-center">
              {/* Drag-handle bar — the only place that initiates a
                  drag gesture. Click-targets inside the frame stay
                  free of drag interference. */}
              <div
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragControls.start(e);
                }}
                className="w-full h-7 flex items-center justify-between px-2 rounded-t-2xl"
                style={{
                  width: 360,
                  background: 'rgba(15,12,32,0.96)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'grab',
                  touchAction: 'none',
                  userSelect: 'none',
                }}
                title="Drag to move"
              >
                <div className="flex items-center gap-1.5 text-white/55">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="5" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="9" cy="19" r="1.6" />
                    <circle cx="15" cy="5" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="15" cy="19" r="1.6" />
                  </svg>
                  <span className="text-[10.5px] font-semibold tracking-wide uppercase">Vertical Recorder</span>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.06]"
                  title="Close"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* 9:16 preview frame — shows what the recording will
                  look like. Camera fills the top region; bottom
                  region is a placeholder until the user clicks
                  record (which prompts for the screen share). */}
              <div
                className="relative overflow-hidden flex flex-col"
                style={{
                  width: 360,
                  height: 640,
                  background: '#0a0a0f',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderTop: 'none',
                  borderBottomLeftRadius: 16,
                  borderBottomRightRadius: 16,
                  boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 4px rgba(168,85,247,0.12)',
                }}
              >
                {/* Camera region — top 28%. Mirrored so the user
                    sees themselves the way they expect. */}
                <div className="relative" style={{ height: `${(CAMERA_HEIGHT / OUTPUT_H) * 100}%`, flex: 'none' }}>
                  {!resultUrl && (
                    <video
                      ref={previewVideoRef}
                      muted
                      playsInline
                      autoPlay
                      className="absolute inset-0 w-full h-full object-cover"
                      style={{ transform: 'scaleX(-1)', background: '#0a0a0f' }}
                    />
                  )}
                  {/* Camera-source picker — appears once the OS has
                      told us which video inputs exist. iPhone via
                      Continuity Camera (macOS) or via Camo / EpocCam
                      (Windows) lands in this list as soon as the
                      phone is connected. Selection persists in
                      localStorage. */}
                  {!resultUrl && cameras.length > 1 && (
                    <div
                      className="absolute top-2 left-2 flex items-center gap-1 px-2 py-1 rounded-full"
                      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                      <select
                        value={selectedCameraId ?? cameras[0]?.deviceId ?? ''}
                        onChange={(e) => switchCamera(e.target.value)}
                        className="bg-transparent text-white text-[10.5px] font-semibold outline-none cursor-pointer"
                        style={{ maxWidth: 220 }}
                        title="Camera source"
                      >
                        {cameras.map((d) => (
                          <option key={d.deviceId} value={d.deviceId} className="text-black">
                            {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Screen-share region — bottom 72%. Once chooseWindow
                    has succeeded, the live screen-capture <video>
                    fills this region so the user sees both their
                    camera (top) and the shared window (bottom)
                    inside one panel. Note: when the panel is over
                    the captured surface, this preview will recurse
                    visually — the user can drag the panel out of
                    the captured region to avoid that. */}
                {!resultUrl && (
                  <div
                    className="relative flex-1 overflow-hidden"
                    style={{
                      background: 'linear-gradient(180deg, rgba(20,12,44,0.6) 0%, rgba(8,6,18,0.95) 100%)',
                    }}
                  >
                    {/* Live screen-capture preview — visible from the
                        moment chooseWindow finishes through end of
                        recording. While recording, the panel is
                        replaced by the REC pill (see top of render),
                        so we only need ready_to_record + finalizing
                        here. */}
                    {(phase === 'ready_to_record' || phase === 'finalizing') && screenStreamRef.current && (
                      <video
                        autoPlay
                        muted
                        playsInline
                        ref={(el) => {
                          if (el && !el.srcObject && screenStreamRef.current) {
                            el.srcObject = screenStreamRef.current;
                          }
                        }}
                        className="absolute inset-0 w-full h-full object-cover bg-black"
                      />
                    )}

                    {phase === 'requesting_screen' && (
                      <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                        <div>
                          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(168,134,255,0.85)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                          <div className="text-[12px] text-white/85 font-semibold mb-1">Pick the window to share</div>
                          <div className="text-[10.5px] text-white/55 leading-snug">
                            Choose the Ghost Session window in your browser's screen-share dialog.
                          </div>
                        </div>
                      </div>
                    )}

                    {(phase === 'requesting_camera' || phase === 'previewing') && (
                      <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                        <div>
                          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(168,134,255,0.65)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2">
                            <rect x="2" y="3" width="20" height="14" rx="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                          </svg>
                          <div className="text-[12px] text-white/80 font-semibold mb-1">Choose a window to share</div>
                          <div className="text-[10.5px] text-white/50 leading-snug max-w-[240px] mx-auto">
                            Click the button below and pick the Ghost Session window so it appears here under your camera.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Reviewing — single full-frame video with the
                    composited result so the user sees exactly what
                    the saved file looks like. */}
                {resultUrl && (
                  <video
                    src={resultUrl}
                    controls
                    playsInline
                    className="absolute inset-0 w-full h-full object-cover bg-black"
                  />
                )}

                {phase === 'error' && error && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/85 px-6 text-center">
                    <div>
                      <div className="text-[14px] font-semibold text-red-300 mb-1">Camera unavailable</div>
                      <div className="text-[11.5px] text-white/70">{error}</div>
                    </div>
                  </div>
                )}

                {/* Bottom controls — record / save / retake. Hidden
                    during requesting/finalising states so the user
                    doesn't double-click. */}
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-4 pb-5">
                  {phase === 'previewing' && !resultUrl && (
                    <button
                      type="button"
                      onClick={chooseWindow}
                      className="px-5 h-11 rounded-full text-[12.5px] font-bold text-white flex items-center gap-2"
                      style={{
                        background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)',
                        boxShadow: '0 6px 18px rgba(124,58,237,0.35)',
                      }}
                      title="Choose window to share"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                      Choose Window
                    </button>
                  )}
                  {phase === 'ready_to_record' && (
                    <button
                      type="button"
                      onClick={beginRecording}
                      className="w-16 h-16 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
                      style={{
                        background: 'rgba(255,255,255,0.95)',
                        boxShadow: '0 6px 18px rgba(0,0,0,0.45), 0 0 0 4px rgba(255,255,255,0.18)',
                      }}
                      title="Start recording"
                    >
                      <span className="block w-12 h-12 rounded-full" style={{ background: '#ef4444' }} />
                    </button>
                  )}
                  {/* Stop button removed — the recording phase now
                      collapses the entire panel into the REC pill at
                      the top of the render, which has its own Stop
                      button. */}
                  {resultUrl && phase === 'reviewing' && (
                    <>
                      <button
                        type="button"
                        onClick={discardResult}
                        className="px-3 h-10 rounded-full text-[12px] font-semibold text-white/85 hover:text-white"
                        style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)' }}
                      >
                        Retake
                      </button>
                      <button
                        type="button"
                        onClick={downloadResult}
                        className="px-3.5 h-10 rounded-full text-[12px] font-semibold text-white"
                        style={{ background: 'linear-gradient(180deg, #ef4444 0%, #991b1b 100%)' }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={shareResult}
                        className="px-3.5 h-10 rounded-full text-[12px] font-semibold text-white flex items-center gap-1.5"
                        style={{ background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)' }}
                        title="Share to socials"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                        Share
                      </button>
                    </>
                  )}
                  {(phase === 'requesting_camera' || phase === 'finalizing') && (
                    <span className="text-[11.5px] text-white/70">
                      {phase === 'requesting_camera' ? 'Requesting camera…' : 'Finalising…'}
                    </span>
                  )}
                </div>

                {/* Share popover — opens over the preview when the
                    user clicks Share and Web Share API can't take the
                    file directly (true on most desktop browsers).
                    Each row downloads the file and opens the
                    platform's upload page so the user can pick the
                    just-saved file from their Downloads folder. */}
                <AnimatePresence>
                  {showShareMenu && (
                    <motion.div
                      key="share-menu"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      transition={{ type: 'spring', stiffness: 280, damping: 26 }}
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ background: 'rgba(8,6,18,0.92)', backdropFilter: 'blur(6px)' }}
                    >
                      <div className="w-[88%] rounded-xl p-3" style={{ background: 'rgba(20,14,40,0.95)', border: '1px solid rgba(168,134,255,0.22)' }}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-[12px] font-bold text-white">Share to…</span>
                          <button
                            type="button"
                            onClick={() => setShowShareMenu(false)}
                            className="ml-auto w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/[0.08]"
                            title="Close"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <SharePlatformRow
                            label="Instagram"
                            color="linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)"
                            onClick={() => saveAndOpen('https://www.instagram.com/')}
                          />
                          <SharePlatformRow
                            label="TikTok"
                            color="#000"
                            onClick={() => saveAndOpen('https://www.tiktok.com/upload?lang=en')}
                          />
                          <SharePlatformRow
                            label="YouTube Shorts"
                            color="#ff0000"
                            onClick={() => saveAndOpen('https://www.youtube.com/upload')}
                          />
                          <SharePlatformRow
                            label="X (Twitter)"
                            color="#000"
                            onClick={() => saveAndOpen('https://twitter.com/compose/tweet')}
                          />
                        </div>
                        <div className="mt-2.5 text-[10px] text-white/45 leading-snug">
                          The file downloads to your Downloads folder, then the platform opens — pick the just-saved video in their uploader. Direct posting from the desktop browser isn't supported by the platforms.
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="mt-3 text-[11px] text-white/55 max-w-[360px] text-center">
                Top: your camera. Bottom: a screen capture of the app you pick. Audio is the project's master output — start playback before recording.
              </div>

              {/* Saved-to-Downloads confirmation. AnimatePresence so
                  the toast slides in/out instead of popping. */}
              <AnimatePresence>
                {savedToast && (
                  <motion.div
                    key="saved-toast"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    transition={{ type: 'spring', stiffness: 280, damping: 24 }}
                    className="mt-2 px-3.5 py-1.5 rounded-full text-[11.5px] font-semibold text-white flex items-center gap-1.5"
                    style={{ background: 'rgba(34,197,94,0.20)', border: '1px solid rgba(34,197,94,0.45)' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {savedToast}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

    </>
  );
}

// One row in the Share-to popover — coloured chip + platform name
// + chevron. The platform's brand colour is set by the parent so
// future additions don't need a new component.
function SharePlatformRow({ label, color, onClick }: {
  label: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-white/[0.06]"
    >
      <span
        aria-hidden
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white"
        style={{ background: color }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </span>
      <span className="text-[12.5px] font-semibold text-white/95">{label}</span>
      <svg className="ml-auto text-white/35" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}
