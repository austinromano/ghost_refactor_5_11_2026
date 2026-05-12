import { useState, useRef, useEffect } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { useAudioStore } from '../../stores/audioStore';
import { useDrumRack, getRowAnalyser } from '../../stores/drumRackStore';
import { getDrumAnalyser } from '../../stores/audio/graph';
import { useEffectsStore, EFFECT_DRAG_MIME, DRUM_RACK_FX_KEY, type EffectKind } from '../../stores/effectsStore';
import { TrackHeader, AnalyserMeter, useArrangement } from './ArrangementComponents';

export const DRUM_RACK_LANE_KEY = '__drumrack__';

function DrumRackLevelMeter() {
  return <AnalyserMeter getNode={() => getDrumAnalyser()} />;
}

function DrumRowLevelMeter({ rowId }: { rowId: string }) {
  return <AnalyserMeter getNode={() => getRowAnalyser(rowId)} />;
}

/* ── Drum-rack lane ──
   One combined drum-rack lane with draggable clips. Each clip carries
   its own step pattern; click an empty slot to add one, click a clip
   to edit it in the panel below, drag the body to move, drag the
   right edge to resize, right-click to delete. */
export function DrumRackLanes({ laneHeight }: { laneHeight: number }) {
  const clips = useDrumRack((s) => s.clips);
  const rows = useDrumRack((s) => s.rows);
  const selectedClipId = useDrumRack((s) => s.selectedClipId);
  const expanded = useDrumRack((s) => s.expanded);
  const setExpanded = useDrumRack((s) => s.setExpanded);
  const tallRows = useDrumRack((s) => s.tallRows);
  const setTallRows = useDrumRack((s) => s.setTallRows);
  const selectClip = useDrumRack((s) => s.selectClip);
  const createClipAt = useDrumRack((s) => s.createClipAt);
  const moveClip = useDrumRack((s) => s.moveClip);
  const resizeClip = useDrumRack((s) => s.resizeClip);
  const deleteClip = useDrumRack((s) => s.deleteClip);
  const setOpen = useDrumRack((s) => s.setOpen);
  const { bpm, arrangementDur } = useArrangement();
  const barSec = 240 / Math.max(1, bpm);
  const stepDur = 60 / Math.max(1, bpm) / 4; // 16th note in seconds
  const defaultClipSec = 8 * barSec;
  const laneRef = useRef<HTMLDivElement | null>(null);
  const dragControls = useDragControls();
  const hue = 165; // ghost-green family for the drum lane

  if (arrangementDur <= 0) return null;

  // Convert a clientX to project-time using the lane's bounding box.
  const xToTime = (clientX: number): number => {
    const el = laneRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * arrangementDur;
  };

  // Snap a project-time to the nearest bar so clips always land on the
  // grid. 1-bar resolution matches the ruler the user sees above.
  const snapToBar = (t: number) => Math.round(t / barSec) * barSec;

  // Click empty space on the lane → create an 8-bar clip there, snapped
  // to the bar the click landed in.
  const handleLaneMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-drum-clip]')) return;
    const t = Math.max(0, snapToBar(xToTime(e.clientX)));
    const id = createClipAt(t, defaultClipSec);
    selectClip(id);
    setOpen(true);
  };

  // Effect-drop target for the drum rack — group-style. Drops land on
  // DRUM_RACK_FX_KEY so the chain wires between drumBus and the mixer
  // and processes the entire rack as one signal.
  const [fxDragOver, setFxDragOver] = useState(false);
  const isEffectDrag = (dt: DataTransfer) => {
    for (const t of Array.from(dt.types)) if (t === EFFECT_DRAG_MIME) return true;
    return false;
  };
  const onFxDragOver = (e: React.DragEvent) => {
    if (!isEffectDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!fxDragOver) setFxDragOver(true);
  };
  const onFxDragLeave = (e: React.DragEvent) => {
    if (!isEffectDrag(e.dataTransfer)) return;
    setFxDragOver(false);
  };
  const onFxDrop = (e: React.DragEvent) => {
    if (!isEffectDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    setFxDragOver(false);
    try {
      const raw = e.dataTransfer.getData(EFFECT_DRAG_MIME);
      const payload = JSON.parse(raw) as { kind: EffectKind };
      if (!payload?.kind) return;
      useEffectsStore.getState().add(DRUM_RACK_FX_KEY, payload.kind);
    } catch { /* malformed — ignore */ }
  };

  // Click-to-select the drum rack as the FX-edit context. Mirrors the
  // master bus pattern via setSelectedBusId so SampleEditorPanel can
  // open the chain editor for DRUM_RACK_FX_KEY.
  const setSelectedBusId = useAudioStore((s) => s.setSelectedBusId);
  const setSelectedTrackIds = useAudioStore((s) => s.setSelectedTrackIds);
  const selectDrumRackForFx = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    setSelectedTrackIds([]);
    setSelectedBusId(DRUM_RACK_FX_KEY);
  };

  // Right-click → delete-rack context menu. Anchor stored as screen
  // coords; window-level mousedown / Escape dismiss it. The drum rack
  // is a per-project singleton, so "delete" here clears every clip
  // off the arrangement instead of removing a track row from the
  // project.tracks table — that lets the user wipe the rack without
  // also losing the configured row kit.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!headerMenu) return;
    const onDown = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHeaderMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [headerMenu]);

  const clipCount = clips.length;
  const clearDrumRack = () => {
    if (clipCount === 0) return;
    if (!window.confirm(`Clear all ${clipCount} drum clip${clipCount === 1 ? '' : 's'} from the arrangement?`)) return;
    useDrumRack.setState({ clips: [], selectedClipId: null });
  };

  return (
    <Reorder.Item
      value={DRUM_RACK_LANE_KEY}
      dragListener={false}
      dragControls={dragControls}
      className="flex flex-col gap-1"
      whileDrag={{ scale: 1.005, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      transition={{ duration: 0.15 }}
      as="div"
      onDragOver={onFxDragOver}
      onDragEnter={onFxDragOver}
      onDragLeave={onFxDragLeave}
      onDrop={onFxDrop}
    >
      <div className="flex relative" style={{ height: laneHeight }}>
        <div
          data-track-header
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            // Don't start the lane drag if the pointer-down was on the
            // chevron / level meter button — those have their own click.
            if ((e.target as HTMLElement).closest('button')) return;
            e.preventDefault();
            dragControls.start(e);
          }}
          onClick={selectDrumRackForFx}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setHeaderMenu({ x: e.clientX, y: e.clientY });
          }}
          className="h-full flex shrink-0 relative cursor-grab active:cursor-grabbing"
        >
          <TrackHeader name="Drum Rack" hue={hue} trackIds={[]} laneKey={DRUM_RACK_FX_KEY} meter={<DrumRackLevelMeter />} />
          {/* Expand / collapse toggle — opens per-row sub-lanes below. */}
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="absolute left-1 bottom-1 w-4 h-4 rounded flex items-center justify-center bg-black/30 hover:bg-black/50 text-white/85 transition-colors z-10"
            title={expanded ? 'Collapse drum lanes' : 'Expand drum lanes — show one lane per row'}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {/* Tall-rows toggle — only meaningful while the rack is
              expanded. Renders the per-row sub-lanes at the same height
              as a regular audio track instead of the compact 24 px
              default. */}
          {expanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setTallRows(!tallRows); }}
              className={`absolute left-6 bottom-1 w-4 h-4 rounded flex items-center justify-center transition-colors z-10 ${tallRows ? 'bg-ghost-purple/60 text-white' : 'bg-black/30 hover:bg-black/50 text-white/85'}`}
              title={tallRows ? 'Shrink drum row lanes back to compact height' : 'Expand drum row lanes to full track height'}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="8 7 12 3 16 7" />
                <polyline points="8 17 12 21 16 17" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </button>
          )}
        </div>
        <div
          ref={laneRef}
          onMouseDown={handleLaneMouseDown}
          className="relative rounded-r-lg flex-1 cursor-cell"
          style={{
            background: 'rgba(10,4,18,0.4)',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}
          title="Click empty space to add a clip"
        >
          {fxDragOver && (
            <div
              className="absolute inset-0 pointer-events-none rounded-r-lg flex items-center justify-center"
              style={{
                background: 'rgba(168, 85, 247, 0.10)',
                boxShadow: 'inset 0 0 0 2px rgba(168, 85, 247, 0.55)',
                zIndex: 5,
              }}
            >
              <span
                className="text-[11px] font-bold tracking-wider uppercase text-white px-2 py-1 rounded-md"
                style={{ background: 'rgba(168, 85, 247, 0.35)', backdropFilter: 'blur(4px)' }}
              >
                Drop to add to drum rack
              </span>
            </div>
          )}
          {clips.map((clip) => (
            <DrumClipBlock
              key={clip.id}
              clipId={clip.id}
              startSec={clip.startSec}
              lengthSec={clip.lengthSec}
              patternSteps={clip.patternSteps}
              steps={clip.steps}
              rowCount={rows.length}
              arrangementDur={arrangementDur}
              stepDur={stepDur}
              hue={hue}
              selected={clip.id === selectedClipId}
              onSelect={() => { selectClip(clip.id); setOpen(true); }}
              onMove={(newStart) => moveClip(clip.id, Math.max(0, snapToBar(newStart)))}
              onResize={(newLen) => resizeClip(clip.id, Math.max(barSec, snapToBar(newLen)))}
              onDelete={() => deleteClip(clip.id)}
              xToTime={xToTime}
            />
          ))}
        </div>
      </div>

      {expanded && rows.map((row, rowIdx) => (
        <DrumRowLane
          key={row.id}
          row={row}
          rowIdx={rowIdx}
          rowHue={(270 + rowIdx * 35) % 360}
          clips={clips}
          arrangementDur={arrangementDur}
          stepDur={stepDur}
          subLaneHeight={tallRows ? laneHeight : 24}
        />
      ))}
      {headerMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] min-w-[160px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{
            left: headerMenu.x, top: headerMenu.y,
            background: 'rgba(20, 12, 30, 0.96)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            onClick={() => { setHeaderMenu(null); clearDrumRack(); }}
            disabled={clipCount === 0}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            {clipCount === 0 ? 'No drum clips to clear' : `Delete drum rack (${clipCount} clip${clipCount === 1 ? '' : 's'})`}
          </button>
        </div>
      )}
    </Reorder.Item>
  );
}

/* Per-row sub-lane shown when the drum rack is expanded. Renders only
   the hits for this single row across every clip — the kick lane shows
   kick hits, the snare lane shows snare hits, etc. Read-only for now;
   editing happens in the rack panel below. */
function DrumRowLane({ row, rowIdx, rowHue, clips, arrangementDur, stepDur, subLaneHeight = 24 }: {
  row: { id: string; name: string; muted: boolean };
  rowIdx: number;
  rowHue: number;
  clips: Array<{ id: string; startSec: number; lengthSec: number; patternSteps: number; steps: number[][] }>;
  arrangementDur: number;
  stepDur: number;
  // 24 px = compact default; passed at full track-lane height when the
  // drum-rack tall-rows toggle is on.
  subLaneHeight?: number;
}) {
  return (
    <div className="flex" style={{ height: subLaneHeight }}>
      <div data-track-header className="h-full flex shrink-0">
        <TrackHeader name={row.name && row.name !== 'Empty' ? row.name : `Row ${rowIdx + 1}`} hue={rowHue} trackIds={[]} meter={<DrumRowLevelMeter rowId={row.id} />} />
      </div>
      <div
        className="relative rounded-r-lg flex-1"
        style={{
          background: 'rgba(10,4,18,0.3)',
          borderBottom: '1px solid rgba(255,255,255,0.03)',
          opacity: row.muted ? 0.4 : 1,
        }}
      >
        {clips.map((clip) => {
          const totalSteps = Math.max(1, Math.round(clip.lengthSec / Math.max(stepDur, 1e-6)));
          const rowSteps = clip.steps[rowIdx] || [];
          return (
            <div key={clip.id}>
              {Array.from({ length: totalSteps }).map((_, sIdx) => {
                if (!rowSteps[sIdx % clip.patternSteps]) return null;
                const hitTime = clip.startSec + sIdx * stepDur;
                if (hitTime >= arrangementDur) return null;
                const leftPct = (hitTime / arrangementDur) * 100;
                const widthPct = (stepDur / arrangementDur) * 100;
                return (
                  <div
                    key={sIdx}
                    className="absolute top-1 bottom-1 rounded-sm"
                    style={{
                      left: `${leftPct}%`,
                      width: `${Math.max(0.25, widthPct - 0.05)}%`,
                      background: `hsl(${rowHue}, 70%, 60%)`,
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(0,0,0,0.4)',
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DrumClipBlock({
  clipId, startSec, lengthSec, patternSteps, steps, rowCount,
  arrangementDur, stepDur, hue, selected, onSelect, onMove, onResize, onDelete, xToTime,
}: {
  clipId: string;
  startSec: number;
  lengthSec: number;
  patternSteps: number;
  steps: number[][];
  rowCount: number;
  arrangementDur: number;
  stepDur: number;
  hue: number;
  selected: boolean;
  onSelect: () => void;
  onMove: (newStart: number) => void;
  onResize: (newLen: number) => void;
  onDelete: () => void;
  xToTime: (clientX: number) => number;
}) {
  const leftPct = (startSec / arrangementDur) * 100;
  const widthPct = Math.max(0.5, (lengthSec / arrangementDur) * 100);

  // Drag (move) on the body. Drag (resize) on the right edge.
  const dragRef = useRef<{ kind: 'move' | 'resize'; startX: number; startStart: number; startLen: number } | null>(null);

  const onBodyDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect();
    dragRef.current = { kind: 'move', startX: e.clientX, startStart: startSec, startLen: lengthSec };
    const realMove = (ev: MouseEvent) => {
      const d = dragRef.current; if (!d || d.kind !== 'move') return;
      const dt = xToTime(ev.clientX) - xToTime(d.startX);
      onMove(d.startStart + dt);
    };
    window.addEventListener('mousemove', realMove);
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', realMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mouseup', onUp);
  };

  const onResizeDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect();
    dragRef.current = { kind: 'resize', startX: e.clientX, startStart: startSec, startLen: lengthSec };
    const realMove = (ev: MouseEvent) => {
      const d = dragRef.current; if (!d || d.kind !== 'resize') return;
      const dt = xToTime(ev.clientX) - xToTime(d.startX);
      onResize(d.startLen + dt);
    };
    window.addEventListener('mousemove', realMove);
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', realMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mouseup', onUp);
  };

  // Right-click context menu — Delete + Loop this section. Replaces
  // the previous instant-delete on right-click which was too easy to
  // hit by accident. State holds the menu's anchor in screen coords;
  // a window-level mousedown / Escape dismisses it.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const setLoopRegion = useAudioStore((s) => s.setLoopRegion);
  const loopRegion = useAudioStore((s) => s.loopRegion);
  const isLoopedSection = !!loopRegion
    && Math.abs(loopRegion.start - startSec) < 1e-3
    && Math.abs(loopRegion.end - (startSec + lengthSec)) < 1e-3;

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // Step preview — render the pattern as it ACTUALLY plays. Pattern
  // repeats every patternSteps × stepDur seconds, so an 8-bar clip with
  // a 16-step (1-bar) pattern shows 8 reps × 16 dots; with 32 steps
  // (2 bars), 4 reps × 32 dots. Only "on" cells render — sparse and
  // positioned absolutely so width matches the real step duration.
  const totalSteps = Math.max(1, Math.round(lengthSec / Math.max(stepDur, 1e-6)));

  return (
    <div
      data-drum-clip
      onMouseDown={onBodyDown}
      onContextMenu={onContext}
      className="absolute top-0.5 bottom-0.5 rounded overflow-hidden cursor-grab active:cursor-grabbing select-none"
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        background: `linear-gradient(180deg, hsla(${hue},70%,40%,0.95), hsla(${hue},65%,28%,0.95))`,
        boxShadow: selected
          ? `0 0 0 2px hsl(${hue},90%,65%), 0 2px 8px rgba(0,0,0,0.45)`
          : 'inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 4px rgba(0,0,0,0.4)',
      }}
      title={`Drum clip — drag to move, right edge to resize, right-click for options`}
    >
      {/* Step pattern preview overlaid as cells, repeated across the
          clip's full length to match what the scheduler actually plays. */}
      <div className="absolute inset-1 flex flex-col gap-[1px] pointer-events-none">
        {steps.slice(0, Math.max(1, rowCount)).map((rowSteps, rIdx) => {
          const widthPctEach = 100 / totalSteps;
          return (
            <div key={rIdx} className="flex-1 relative min-h-0">
              {Array.from({ length: totalSteps }).map((_, sIdx) => {
                const on = !!rowSteps?.[sIdx % patternSteps];
                if (!on) return null;
                const leftPct = (sIdx / totalSteps) * 100;
                return (
                  <div
                    key={sIdx}
                    className="absolute top-0 bottom-0 rounded-[1px]"
                    style={{
                      left: `${leftPct}%`,
                      width: `${Math.max(0.25, widthPctEach - 0.1)}%`,
                      background: 'rgba(255,255,255,0.85)',
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      {/* Resize handle (right edge) */}
      <div
        onMouseDown={onResizeDown}
        className="absolute top-0 bottom-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/30"
        title="Drag to resize"
      />
      {/* Label */}
      <span
        className="absolute top-0.5 left-1 text-[9px] font-semibold text-white/95 pointer-events-none"
        style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
      >
        {lengthSec.toFixed(2)}s
      </span>
      {/* satisfy unused-binding lint */}
      <span className="hidden">{clipId}</span>
      {menu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-[60] min-w-[180px] rounded-md py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
          style={{
            left: menu.x, top: menu.y,
            background: 'rgba(20, 12, 30, 0.96)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <button
            onClick={() => {
              setMenu(null);
              if (isLoopedSection) setLoopRegion(null);
              else setLoopRegion({ start: startSec, end: startSec + lengthSec });
            }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-white/80 hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 1 21 5 17 9" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <polyline points="7 23 3 19 7 15" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
            </svg>
            {isLoopedSection ? 'Stop looping' : 'Loop this section'}
          </button>
          <button
            onClick={() => { setMenu(null); onDelete(); }}
            className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
