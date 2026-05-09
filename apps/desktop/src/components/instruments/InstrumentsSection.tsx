import { useState } from 'react';

// Sidebar dropdown listing the instruments the user can drag onto a
// MIDI track. Mirrors EffectsSection's drag-source pattern so the
// arrangement / lane drop targets pick up a consistent MIME type.
//
// Sits BELOW EffectsSection in ProjectListSidebar — same "stuff you
// can drop into the project" mental model.
//
// v1 ships one instrument: the Sampler. Future synths (subtractive,
// soundfont, drum-rack-as-instrument, etc.) plug into the same
// INSTRUMENT_DRAG_MIME pipeline.

export const INSTRUMENT_DRAG_MIME = 'application/x-ghost-instrument';

export type InstrumentKind = 'sampler';

export const INSTRUMENT_LABEL: Record<InstrumentKind, string> = {
  sampler: 'Sampler',
};

const INSTRUMENTS: Array<{ kind: InstrumentKind; description: string }> = [
  { kind: 'sampler', description: 'Drag onto a MIDI track' },
];

function InstrumentIcon({ kind, size = 12 }: { kind: InstrumentKind; size?: number }) {
  if (kind === 'sampler') {
    // Sample-and-hold-ish glyph: a waveform with brackets to suggest
    // a slice / sample window.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12c1-3 2-3 3 0s2 3 3 0 2-3 3 0 2 3 3 0 2-3 3 0 2 3 3 0" />
      </svg>
    );
  }
  return null;
}

export default function InstrumentsSection() {
  const [open, setOpen] = useState(true);

  return (
    <div className="px-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group w-full flex items-center gap-2 px-3 pt-4 pb-2 select-none"
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="text-ghost-purple shrink-0"
        >
          <rect x="2" y="6" width="20" height="12" rx="1" />
          <line x1="6" y1="6" x2="6" y2="14" />
          <line x1="10" y1="6" x2="10" y2="14" />
          <line x1="14" y1="6" x2="14" y2="14" />
          <line x1="18" y1="6" x2="18" y2="14" />
        </svg>
        <span className="text-[14px] font-bold text-white tracking-tight">Instruments</span>
        <span className="ml-auto text-[11px] text-white/30">{INSTRUMENTS.length}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`text-white/30 transition-transform ${open ? '' : '-rotate-90'}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="px-2 pb-1.5 space-y-0.5">
          {INSTRUMENTS.map(({ kind, description }) => (
            <div
              key={kind}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData(INSTRUMENT_DRAG_MIME, JSON.stringify({ kind }));
                // Plain-text fallback — same convention as effects.
                e.dataTransfer.setData('text/plain', `Instrument: ${INSTRUMENT_LABEL[kind]}`);
              }}
              className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] transition-colors cursor-grab active:cursor-grabbing"
              title={`Drag onto a MIDI track to add ${INSTRUMENT_LABEL[kind]}`}
            >
              <span
                className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                style={{
                  background: 'rgba(124,58,237,0.18)',
                  color: '#A855F7',
                  border: '1px solid rgba(124,58,237,0.35)',
                }}
              >
                <InstrumentIcon kind={kind} size={12} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium text-white/85 truncate">{INSTRUMENT_LABEL[kind]}</span>
                <span className="block text-[10.5px] text-white/35 truncate">{description}</span>
              </span>
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="text-white/25 group-hover:text-white/55 transition-colors shrink-0"
              >
                <circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" />
                <circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />
              </svg>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
