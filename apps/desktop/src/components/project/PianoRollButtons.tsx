import { useMidiTrack } from '../../stores/midiTrackStore';
import { api } from '../../lib/api';

/**
 * Floating buttons for the bottom-right of the arrangement column:
 *   - "+ MIDI Track" creates a new MIDI track on the current project
 *     and refreshes so it shows up as a lane immediately.
 *   - "Piano Roll" opens the editor panel for whatever clip is
 *     currently selected (renders only while the panel is closed —
 *     the panel itself owns the ✕ to close).
 *
 * Phase 5 will replace the standalone Piano Roll button with the
 * "click any MIDI clip in the arrangement" entrypoint as the
 * primary path; this button stays as a fallback for power users
 * who want to switch between clips without going through the lane.
 */
export function PianoRollOpenButton() {
  const open = useMidiTrack((s) => s.open);
  const setOpen = useMidiTrack((s) => s.setOpen);
  if (open) return null;
  return (
    <button
      onClick={() => setOpen(true)}
      className="absolute bottom-3 right-3 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-white shadow-lg transition-all hover:scale-[1.02]"
      style={{ background: 'linear-gradient(180deg, #9333EA 0%, #6B21A8 100%)', boxShadow: '0 4px 12px rgba(147,51,234,0.4)' }}
      title="Open piano roll for the selected clip"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="1" />
        <line x1="6" y1="6" x2="6" y2="14" />
        <line x1="10" y1="6" x2="10" y2="14" />
        <line x1="14" y1="6" x2="14" y2="14" />
        <line x1="18" y1="6" x2="18" y2="14" />
      </svg>
      Piano Roll
    </button>
  );
}

/**
 * Adds a MIDI track to the current project. Sits to the LEFT of the
 * Piano Roll button so the two are visually grouped. Once clicked
 * the new lane appears in the arrangement; the user clicks empty
 * lane space to start a clip.
 */
export function AddMidiTrackButton({ projectId }: { projectId: string }) {
  const open = useMidiTrack((s) => s.open);
  // We hide the button while the panel is open — the panel covers
  // most of the bottom-right area anyway, and adding new tracks
  // mid-edit would require closing the piano roll first to see them.
  if (open) return null;

  const onClick = async () => {
    if (!projectId) return;
    try {
      await api.addTrack(projectId, { name: 'MIDI', type: 'midi' as any } as any);
      // Sampler is opt-in: the user adds it later via drag-drop on
      // the lane header or the FX chain. Each track's instrument is
      // keyed by its own track id, so per-track state stays isolated.
      window.dispatchEvent(new CustomEvent('ghost-refresh-project'));
    } catch { /* server error — user can retry */ }
  };

  return (
    <button
      onClick={onClick}
      className="absolute bottom-3 right-[148px] z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-white shadow-lg transition-all hover:scale-[1.02]"
      style={{ background: 'linear-gradient(180deg, #4F46E5 0%, #3730A3 100%)', boxShadow: '0 4px 12px rgba(79,70,229,0.4)' }}
      title="Add a MIDI track to the arrangement"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      MIDI
    </button>
  );
}
