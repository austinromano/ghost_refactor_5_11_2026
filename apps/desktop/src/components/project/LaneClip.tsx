import { useState, useRef, useEffect } from 'react';
import { useAudioStore, pendingTrackOffsets, pendingTrackProps } from '../../stores/audioStore';
import { useProjectStore } from '../../stores/projectStore';
import { useCollabStore } from '../../stores/collabStore';
import { api } from '../../lib/api';
import { snapToGrid } from '../../lib/audio';
import { getSocket } from '../../lib/socket';
import Waveform from '../tracks/Waveform';
import Avatar from '../common/Avatar';
import { useArrangement, type Member } from './ArrangementComponents';

/**
 * Trim handle — a vertical bar on either edge of a clip that the user drags
 * to retune trimStart / trimEnd. Render is purely visual; behavior is
 * driven by the parent through onDragStart / onDrag / onDragEnd
 * events. Pointer events are stopped here so the parent clip's move-drag
 * doesn't fire on the same press.
 */
function TrimHandle<S>({ edge, onDragStart, onDrag, onDragEnd }: {
  edge: 'start' | 'end';
  onDragStart: () => S;
  onDrag: (snap: S, deltaPx: number) => void;
  onDragEnd: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  // Mirror the pattern the parent clip's move-drag uses: attach window
  // listeners synchronously inside pointerdown so no events are missed
  // during the next React render. Window listeners fire regardless of
  // cursor position, so we don't need setPointerCapture either.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const snap = onDragStart();
    const startX = e.clientX;

    const onMove = (ev: PointerEvent) => {
      onDrag(snap, ev.clientX - startX);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDragging(false);
      onDragEnd();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    setDragging(true);
  };

  const isStart = edge === 'start';
  const edgeStyle: React.CSSProperties = isStart ? { left: 0 } : { right: 0 };
  return (
    <div
      data-trim-handle={edge}
      onPointerDown={onPointerDown}
      className="absolute top-0 bottom-0 z-20 cursor-ew-resize"
      style={{ ...edgeStyle, width: 16 }}
    >
      <div
        data-trim-handle={edge}
        className="absolute top-[2px] bottom-[2px] pointer-events-none transition-[background,box-shadow,width] duration-100"
        style={{
          ...edgeStyle,
          width: dragging ? 9 : 7,
          background: dragging
            ? 'linear-gradient(180deg, #FFE066 0%, #E6AC00 100%)'
            : 'linear-gradient(180deg, rgba(245,197,24,0.95) 0%, rgba(212,160,23,0.95) 100%)',
          borderRadius: isStart ? '4px 0 0 4px' : '0 4px 4px 0',
          boxShadow: dragging
            ? '0 0 14px rgba(245,197,24,0.8), inset 0 0 0 1px rgba(255,224,102,0.6)'
            : '0 0 6px rgba(245,197,24,0.45), inset 0 0 0 1px rgba(255,224,102,0.3)',
        }}
      >
        {/* Centered grip — three short horizontal dashes to signal "drag me". */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[2px]">
          <div style={{ width: 3, height: 1.5, background: 'rgba(0,0,0,0.55)', borderRadius: 1 }} />
          <div style={{ width: 3, height: 1.5, background: 'rgba(0,0,0,0.55)', borderRadius: 1 }} />
          <div style={{ width: 3, height: 1.5, background: 'rgba(0,0,0,0.55)', borderRadius: 1 }} />
        </div>
      </div>
    </div>
  );
}

/* ── Single clip in a lane ── */
export function LaneClip({ track, selectedProjectId, deleteTrack, trackZoom, laneWidth, clipIndex, totalClips, members }: {
  track: any; selectedProjectId: string; deleteTrack: any; trackZoom: 'full' | 'half'; laneWidth: number; clipIndex: number; totalClips: number; members: Member[];
}) {
  const { arrangementDur, bpm } = useArrangement();
  const startOffset = useAudioStore((s) => s.loadedTracks.get(track.id)?.startOffset ?? 0);
  const trimStart = useAudioStore((s) => s.loadedTracks.get(track.id)?.trimStart ?? 0);
  const trimEnd = useAudioStore((s) => s.loadedTracks.get(track.id)?.trimEnd ?? 0);
  const bufferDuration = useAudioStore((s) => s.loadedTracks.get(track.id)?.buffer?.duration ?? 0);
  // Ref to the rendered clip <div> so trim-handle drag-start can read the
  // clip's actual rendered width — `laneWidth` prop is wrongly hardcoded
  // to 100 at the call site, and TRACK_HEADER_WIDTH is 110, which makes
  // any (laneWidth - TRACK_HEADER_WIDTH) math go negative.
  const clipElRef = useRef<HTMLDivElement>(null);
  const playbackRate = useAudioStore((s) => {
    const t = s.loadedTracks.get(track.id);
    return Math.pow(2, ((t?.pitch || 0)) / 12);
  });
  const setTrackTrim = useAudioStore((s) => s.setTrackTrim);
  // Effective trimmed end — 0 in the data model means "use full buffer".
  const effectiveTrimEnd = trimEnd > 0 ? trimEnd : bufferDuration;
  // Trimmed window length scaled by pitch — what the clip box should occupy
  // on the timeline. Shrinks live as the user drags either trim handle.
  const clipDur = bufferDuration > 0
    ? Math.max(0, (effectiveTrimEnd - trimStart) / Math.max(0.0001, playbackRate))
    : 0;
  // Beat-aligned snap: firstBeatOffset tells us where inside the sample the
  // first detected beat lives. We snap that position (not the sample's
  // leading edge) to bar lines so kicks-with-lead-in hit the downbeat.
  // Convert from the original buffer's timeline to the currently-playing
  // (possibly stretched) timeline via the loaded track's stretch factor.
  const beatAlignOffset = useAudioStore((s) => {
    const t = s.loadedTracks.get(track.id);
    if (!t?.firstBeatOffset || !t.originalBuffer) return 0;
    // When warp is off, snap by the clip's leading edge — beat detection
    // is unreliable on samples we wouldn't warp anyway (808s, hits, FX),
    // and forcing a phantom-beat offset there is what stops them from
    // landing on bar lines.
    if (t.warp === false) return 0;
    // buffer.duration includes the pitch-compensation pre-stretch; divide
    // by playbackRate to get the EFFECTIVE (warped-only) length. Then the
    // warp factor = effectiveLen / originalLen, and the beat offset in
    // project-time = source firstBeatOffset * warpFactor.
    const playbackRate = Math.pow(2, (t.pitch || 0) / 12);
    const effectiveLen = t.buffer.duration / Math.max(0.0001, playbackRate);
    const warpFactor = t.originalBuffer.duration > 0 ? effectiveLen / t.originalBuffer.duration : 1;
    return t.firstBeatOffset * warpFactor;
  });
  const setTrackOffset = useAudioStore((s) => s.setTrackOffset);
  // Selection — drives the green ring + what Ctrl+C/Ctrl+V operate on.
  const isSelected = useAudioStore((s) => s.selectedTrackIds.has(track.id));
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);
  const toggleTrackSelection = useAudioStore((s) => s.toggleTrackSelection);
  const addTrackToSelection = useAudioStore((s) => s.addTrackToSelection);
  // Group drag — any selected clip renders its position shifted by the
  // global groupDragDelta while a group drag is in progress.
  const inGroupDrag = useAudioStore((s) => s.groupDragIds.has(track.id));
  const groupDragDelta = useAudioStore((s) => s.groupDragDelta);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  // If a collaborator is currently dragging this clip, lock our own drag
  // and paint a coloured ghost at their live position.
  const remoteDrag = useCollabStore((s) => s.remoteDrags.get(track.id) || null);

  // Prefer time-axis positioning once the buffer has loaded; fall back to the
  // legacy side-by-side layout so clips don't collapse to zero width while the
  // audio is still decoding.
  const haveTime = clipDur > 0 && arrangementDur > 0;
  const effectiveOffset = dragOffset !== null
    ? dragOffset
    : inGroupDrag
      ? Math.max(0, startOffset + groupDragDelta)
      : startOffset;
  const leftPct = haveTime
    ? (effectiveOffset / arrangementDur) * 100
    : clipIndex * (100 / Math.max(1, totalClips));
  const clipWidth = haveTime
    ? (clipDur / arrangementDur) * 100
    : 100 / Math.max(1, totalClips);
  const height = trackZoom === 'half' ? 48 : 70;
  const owner = members.find((m) => m.userId === track.ownerId);
  const ownerName = owner?.displayName || track.ownerName || 'Unknown';
  const displayName = (track.name || 'Track').replace(/\.(wav|mp3|flac|aiff|ogg|m4a)$/i, '').replace(/_/g, ' ');

  // Context-menu state (replaces the old hover-controls overlay). Opens at
  // the cursor position on right-click; closes on any outside click or Esc.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    // Window-level mousedown closes the menu when the click is
    // OUTSIDE the menu. Without the data-attribute check here, the
    // native event reached window before React fired the menu
    // item's click handler — closing the menu unmounted the button
    // and the Duplicate / Delete clicks silently dropped. React's
    // own onMouseDown stopPropagation on the menu element only
    // stops the synthetic event, not native bubbling.
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-clip-context-menu]')) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Build the list of clips these actions apply to: the whole selection if
  // this clip is part of a multi-selection, otherwise just this clip.
  const targetsForAction = (): string[] => {
    const sel = useAudioStore.getState().selectedTrackIds;
    if (sel.has(track.id) && sel.size > 1) return Array.from(sel);
    return [track.id];
  };

  const duplicateClip = async () => {
    const ids = targetsForAction();
    const projectBpm = useAudioStore.getState().projectBpm || 120;
    const grid = useAudioStore.getState().gridDivision;
    const loadedTracks = useAudioStore.getState().loadedTracks;
    const projectTracks = (useProjectStore.getState().currentProject?.tracks || []) as any[];
    for (const id of ids) {
      const srcTrack = projectTracks.find((t: any) => t.id === id);
      if (!srcTrack?.fileId) continue;
      const loaded = loadedTracks.get(id);
      // Compute the duplicate's drop position from the AUDIBLE clip
      // length, not the raw buffer length. With pitch ≠ 0 the buffer
      // is pre-stretched (so buffer.duration ≠ audible length), and
      // trim moves the visual end inward — both used to make
      // duplicate either land mid-clip or stack right on top, which
      // is why the user had to click multiple times before a take
      // actually appeared after the source.
      let clipDur = 0;
      if (loaded?.buffer) {
        const bufDur = loaded.buffer.duration;
        const tStart = loaded.trimStart || 0;
        const tEnd = loaded.trimEnd > 0 ? loaded.trimEnd : bufDur;
        const rate = Math.pow(2, (loaded.pitch || 0) / 12);
        clipDur = Math.max(0, (tEnd - tStart) / rate);
      }
      if (clipDur <= 0) {
        // Source audio still loading. Skip rather than stacking the
        // duplicate at the source's offset (which is what made the
        // first few right-click → Duplicate clicks feel like no-ops).
        if (typeof console !== 'undefined') console.warn('[duplicate] source clip buffer not loaded yet — try again in a moment');
        continue;
      }
      const rawOffset = (loaded?.startOffset ?? 0) + clipDur;
      const newOffset = Math.max(0, snapToGrid(rawOffset, projectBpm, grid, 'nearest'));
      const result = await api.addTrack(selectedProjectId, {
        name: srcTrack.name || 'Track', type: srcTrack.type || 'audio',
        fileId: srcTrack.fileId, fileName: srcTrack.name,
      } as any);
      if (result?.id) {
        pendingTrackOffsets.set(result.id, newOffset);
        // Carry the source clip's mix state through so duplicates inherit
        // volume / pitch / mute / warp / BPM override / trim instead of
        // resetting to defaults.
        if (loaded) {
          pendingTrackProps.set(result.id, {
            volume: loaded.volume,
            muted: loaded.muted,
            soloed: loaded.soloed,
            pitch: loaded.pitch,
            bpm: loaded.bpm || undefined,
            warp: loaded.warp,
            trimStart: loaded.trimStart,
            trimEnd: loaded.trimEnd,
          });
        }
      }
    }
    window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
    window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
  };

  const deleteClip = async () => {
    const ids = targetsForAction();
    for (const id of ids) {
      useAudioStore.getState().removeTrack(id);
      try { await deleteTrack(selectedProjectId, id); } catch { /* continue remaining */ }
    }
    useAudioStore.getState().clearSelection();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (remoteDrag) return;
    e.preventDefault();
    e.stopPropagation();
    // Right-click on a clip that isn't already in the selection replaces
    // selection with just this clip (so menu actions apply to what the
    // user visibly right-clicked). Right-click on a clip that IS in the
    // selection keeps the multi-selection intact.
    if (!isSelected) setSelectedTrackIds([track.id]);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    // Trim handles stop propagation themselves, but a defensive check by
    // data attribute means we won't accidentally start a clip move-drag if
    // any future code path slips past stopPropagation.
    if ((e.target as HTMLElement).closest('[data-trim-handle]')) return;
    if (!haveTime) return;
    // Conflict guard: someone else is already dragging this clip.
    if (remoteDrag) return;
    // Selection semantics: shift or ctrl/cmd extends; plain click replaces.
    if (e.shiftKey) addTrackToSelection(track.id);
    else if (e.ctrlKey || e.metaKey) toggleTrackSelection(track.id);
    else if (!isSelected) setSelectedTrackIds([track.id]);
    // If the clip is already in a multi-selection and user just clicks,
    // leave the selection as-is (so they can then drag the whole group).
    const clipEl = e.currentTarget;
    const laneEl = clipEl.parentElement;
    if (!laneEl) return;

    e.preventDefault();
    const startX = e.clientX;
    const laneWidthPx = laneEl.clientWidth;
    const initialOffset = startOffset;
    let liveOffset = initialOffset;
    const socket = getSocket();
    let lastEmit = 0;

    // Group drag setup: if this clip is part of a multi-selection, capture
    // every selected clip's initial offset so we can shift them together.
    // Leftmost clip caps the negative delta so the group can't slide past 0.
    const initialSel = useAudioStore.getState().selectedTrackIds;
    const isGroupDrag = initialSel.has(track.id) && initialSel.size > 1;
    const loadedTracksMap = useAudioStore.getState().loadedTracks;
    const groupIds: string[] = isGroupDrag ? Array.from(initialSel) : [];
    const initialGroupOffsets = new Map<string, number>();
    let groupLeftmost = Infinity;
    if (isGroupDrag) {
      for (const id of groupIds) {
        const l = loadedTracksMap.get(id);
        const off = l?.startOffset ?? 0;
        initialGroupOffsets.set(id, off);
        if (off < groupLeftmost) groupLeftmost = off;
      }
    }

    const handleMove = (ev: PointerEvent) => {
      const deltaX = ev.clientX - startX;
      const deltaTime = (deltaX / laneWidthPx) * arrangementDur;
      if (isGroupDrag) {
        // Clamp so the leftmost clip stays at ≥ 0.
        const clamped = Math.max(-groupLeftmost, deltaTime);
        useAudioStore.getState().setGroupDrag(groupIds, clamped);
        liveOffset = initialOffset + clamped;
      } else {
        liveOffset = Math.max(0, initialOffset + deltaTime);
        setDragOffset(liveOffset);
      }
      // Throttle live drag broadcast to ~30 Hz so collaborators see a smooth
      // ghost move without flooding the socket. Broadcast only for the
      // initiator clip during group drags — multi-clip ghosts would flood.
      const now = performance.now();
      if (socket && now - lastEmit > 33) {
        lastEmit = now;
        socket.emit('clip:drag', { projectId: selectedProjectId, trackId: track.id, liveOffset });
      }
    };
    const handleUp = () => {
      const grid = useAudioStore.getState().gridDivision;
      // Snap the clip's LEADING EDGE to the grid — what the user sees on
      // the timeline is what gets snapped. The previous beat-aligned snap
      // (firstBeatOffset shifts the snap target by the detected first
      // downbeat) made clips look misaligned even though their first hit
      // landed on the bar; the new behavior matches every modern DAW.
      void beatAlignOffset;
      const snappedInitiator = Math.max(0, snapToGrid(liveOffset, bpm, grid, 'nearest'));
      if (isGroupDrag) {
        const finalDelta = snappedInitiator - initialOffset;
        for (const id of groupIds) {
          const init = initialGroupOffsets.get(id) ?? 0;
          const next = Math.max(0, init + finalDelta);
          if (Math.abs(next - init) > 0.001) setTrackOffset(id, next);
        }
        useAudioStore.getState().endGroupDrag();
      } else {
        setDragOffset(null);
        if (Math.abs(snappedInitiator - initialOffset) > 0.001) {
          setTrackOffset(track.id, snappedInitiator);
        }
      }
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      // Clear the remote ghost for every collaborator.
      if (socket) socket.emit('clip:drag', { projectId: selectedProjectId, trackId: track.id, liveOffset: null });
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  // Remote ghost: someone else is dragging this clip — render a coloured
  // outline at their live position + a small caption with their name.
  const remoteGhostLeftPct = remoteDrag && haveTime
    ? (remoteDrag.liveOffset / arrangementDur) * 100
    : 0;

  // Silence unused-import linter; setTrackTrim, laneWidth are unused here
  // but retained as references to preserve future hooks.
  void setTrackTrim; void laneWidth;

  return (
    <>
    {remoteDrag && haveTime && (
      <div
        className="absolute top-1 bottom-1 rounded-lg pointer-events-none"
        style={{
          left: `${remoteGhostLeftPct}%`,
          width: `${clipWidth}%`,
          border: `2px dashed ${remoteDrag.colour}`,
          background: `${remoteDrag.colour}14`,
          boxShadow: `0 0 10px ${remoteDrag.colour}55`,
          zIndex: 9,
        }}
      >
        <span
          className="absolute -top-4 left-0 px-1.5 py-0.5 rounded text-[9px] font-bold whitespace-nowrap"
          style={{ background: remoteDrag.colour, color: '#000' }}
        >
          {remoteDrag.displayName}
        </span>
      </div>
    )}
    <div
      ref={clipElRef}
      data-clip-id={track.id}
      onPointerDown={handlePointerDown}
      onContextMenu={handleContextMenu}
      className={`absolute top-1 bottom-1 group rounded-lg overflow-hidden ${haveTime && !remoteDrag ? 'cursor-grab active:cursor-grabbing' : ''} ${remoteDrag ? 'cursor-not-allowed' : ''}`}
      style={{
        left: `${leftPct}%`,
        width: `${clipWidth}%`,
        background: '#0A0412',
        border: isSelected ? '1px solid rgba(0,255,200,0.7)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow:
          dragOffset !== null ? '0 0 0 1px rgba(168,85,247,0.6), 0 4px 16px rgba(124,58,237,0.3)'
          : isSelected ? '0 0 0 1px rgba(0,255,200,0.45), 0 0 12px rgba(0,255,200,0.25)'
          : undefined,
        zIndex: dragOffset !== null ? 10 : isSelected ? 5 : undefined,
        opacity: remoteDrag ? 0.5 : 1,
        userSelect: 'none',
      }}
    >
      <Waveform
        seed={track.name + (track.type || 'audio')}
        height={height - 2}
        fileId={track.fileId}
        projectId={selectedProjectId}
        trackId={track.id}
        showPlayhead={true}
        viewStart={trimStart}
        viewEnd={effectiveTrimEnd}
      />
      {isSelected && !remoteDrag && bufferDuration > 0 && haveTime && (
        <TrimHandle
          edge="start"
          onDragStart={() => {
            const t = useAudioStore.getState().loadedTracks.get(track.id);
            const bufDur = t?.buffer?.duration ?? 0;
            const tEnd = (t?.trimEnd ?? 0) > 0 ? (t!.trimEnd) : bufDur;
            const tStart = t?.trimStart ?? 0;
            const tOff = t?.startOffset ?? 0;
            const rate = Math.pow(2, ((t?.pitch || 0)) / 12);
            // Read the clip's actual rendered width straight off the DOM.
            // The `laneWidth` prop is hardcoded to 100 upstream and isn't
            // safe to use here.
            const visiblePx = clipElRef.current?.getBoundingClientRect().width ?? 0;
            const visibleSourceSpan = tEnd - tStart;
            // Capture: pixel-per-source-second mapping is taken at drag start
            // and held for the whole drag so the cursor stays 1:1 with the
            // edge even though the clip box width is changing as we trim.
            return {
              tStart, tOff, tEnd, rate,
              pxPerSourceSec: visibleSourceSpan > 0 && visiblePx > 0
                ? visiblePx / visibleSourceSpan
                : 0,
              bufDur,
            };
          }}
          onDrag={(snap, deltaPx) => {
            if (snap.pxPerSourceSec <= 0) return;
            const deltaSourceSec = deltaPx / snap.pxPerSourceSec;
            // Free target — what the edge would be without grid snapping.
            const minTrim = Math.max(0, snap.tStart - snap.tOff);
            const maxTrim = snap.tEnd - 0.01;
            let nextTrim = Math.min(maxTrim, Math.max(minTrim, snap.tStart + deltaSourceSec));
            let nextOffset = Math.max(0, snap.tOff + (nextTrim - snap.tStart));

            // Live snap the visible LEFT edge (= nextOffset) to the grid.
            // grid = 0 means "free" — snapToGrid returns input unchanged.
            const grid = useAudioStore.getState().gridDivision;
            if (grid > 0) {
              const snappedOffset = Math.max(0, snapToGrid(nextOffset, bpm, grid, 'nearest'));
              const offsetDelta = snappedOffset - nextOffset;
              // Move trimStart in lockstep so the audio anchored at the new
              // edge is the same source sample that would have been there
              // unsnapped. Source-sec = timeline-sec * playbackRate.
              nextTrim = Math.min(maxTrim, Math.max(0, nextTrim + offsetDelta * snap.rate));
              nextOffset = snappedOffset;
            }

            const audioStore = useAudioStore.getState();
            audioStore.setTrackTrim(track.id, nextTrim, audioStore.loadedTracks.get(track.id)?.trimEnd ?? 0);
            audioStore.setTrackOffset(track.id, nextOffset);
          }}
          onDragEnd={() => {
            window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
          }}
        />
      )}
      {isSelected && !remoteDrag && bufferDuration > 0 && haveTime && (
        <TrimHandle
          edge="end"
          onDragStart={() => {
            const t = useAudioStore.getState().loadedTracks.get(track.id);
            const bufDur = t?.buffer?.duration ?? 0;
            const tEnd = (t?.trimEnd ?? 0) > 0 ? (t!.trimEnd) : bufDur;
            const tStart = t?.trimStart ?? 0;
            const tOff = t?.startOffset ?? 0;
            const rate = Math.pow(2, ((t?.pitch || 0)) / 12);
            // Read the clip's actual rendered width straight off the DOM.
            // The `laneWidth` prop is hardcoded to 100 upstream and isn't
            // safe to use here.
            const visiblePx = clipElRef.current?.getBoundingClientRect().width ?? 0;
            const visibleSourceSpan = tEnd - tStart;
            return {
              tStart, tOff, tEnd, rate,
              pxPerSourceSec: visibleSourceSpan > 0 && visiblePx > 0
                ? visiblePx / visibleSourceSpan
                : 0,
              bufDur,
            };
          }}
          onDrag={(snap, deltaPx) => {
            if (snap.pxPerSourceSec <= 0) return;
            const deltaSourceSec = deltaPx / snap.pxPerSourceSec;
            const minEnd = snap.tStart + 0.01;
            const maxEnd = snap.bufDur;
            let nextEnd = Math.min(maxEnd, Math.max(minEnd, snap.tEnd + deltaSourceSec));

            // Live snap the visible RIGHT edge to the grid by working back
            // from the snapped timeline position to a buffer-time trimEnd.
            const grid = useAudioStore.getState().gridDivision;
            if (grid > 0) {
              const visualRightEdge = snap.tOff + (nextEnd - snap.tStart) / snap.rate;
              const snappedRight = snapToGrid(visualRightEdge, bpm, grid, 'nearest');
              nextEnd = snap.tStart + (snappedRight - snap.tOff) * snap.rate;
              nextEnd = Math.min(maxEnd, Math.max(minEnd, nextEnd));
            }

            const audioStore = useAudioStore.getState();
            // 0 in the data model means "use full buffer" — collapse back
            // to that when the user drags out to (or past) the natural end.
            audioStore.setTrackTrim(track.id, snap.tStart, nextEnd >= snap.bufDur ? 0 : nextEnd);
          }}
          onDragEnd={() => {
            window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
          }}
        />
      )}
      {/* Track name only — uploader avatar moved to the right-click context
          menu so the clip stays clean. */}
      {clipIndex === 0 && (
        <div className="absolute left-2 top-1 z-10 pointer-events-none flex flex-col gap-1 items-start" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))' }}>
          <p className="text-[10px] font-bold text-white/80 whitespace-nowrap">{displayName}</p>
        </div>
      )}
    </div>
    {menu && (
      <div
        data-clip-context-menu
        onMouseDown={(e) => e.stopPropagation()}
        className="fixed z-50 min-w-[180px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
        style={{
          left: menu.x, top: menu.y,
          background: 'rgba(20, 12, 30, 0.96)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {/* Header: who added this clip. Avatar isn't a profile link inside
            the menu either — pointer-events:none so the click flows up to
            the menu's outside-click dismiss. */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06]">
          <span className="pointer-events-none">
            <Avatar name={ownerName} src={owner?.avatarUrl || null} size="xs" userId={null} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider text-white/40">Added by</div>
            <div className="text-[12px] font-semibold text-white/85 truncate">{ownerName}</div>
          </div>
        </div>
        <button
          onClick={() => { setMenu(null); duplicateClip(); }}
          className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          Duplicate
        </button>
        <button
          onClick={() => { setMenu(null); deleteClip(); }}
          className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          Delete
        </button>
      </div>
    )}
    </>
  );
}
