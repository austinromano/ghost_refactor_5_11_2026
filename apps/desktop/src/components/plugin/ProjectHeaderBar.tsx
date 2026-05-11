import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectDetail } from '@ghost/types';

interface Props {
  project: ProjectDetail;
  canDelete: boolean;
  canRename: boolean;
  onNameChange: (name: string) => void;
  onTempoChange: (tempo: number) => void;
  onKeyChange: (key: string) => void;
  onTimeSignatureChange: (timeSignature: string) => void;
  onShowVersionHistory: () => void;
  onShareToFeed: () => void;
  onShareLink: () => void;
  onInvite: () => void;
  onDelete: () => void;
  onLeave: () => void;
}

// Live MM:SS countdown to a fixed deadline. Used for the Beat Battle
// production-phase timer rendered next to the key. Re-renders once a
// second; freezes at 00:00 when the deadline passes so the user still
// sees the placeholder instead of negative numbers.
function BattleCountdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const target = Date.parse(endsAt);
  const secondsLeft = Number.isFinite(target)
    ? Math.max(0, Math.ceil((target - now) / 1000))
    : 0;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const danger = secondsLeft <= 30 && secondsLeft > 0;
  return (
    <>
      <span className="text-[13px] text-white/50 font-semibold px-1.5">TIMER</span>
      <span
        className="text-[15px] font-bold tabular-nums px-2 py-0.5 rounded"
        style={{
          fontFamily: "'Consolas', monospace",
          color: secondsLeft === 0 ? '#F472B6' : danger ? '#FBBF24' : '#F0ABFC',
          background: 'rgba(20,10,40,0.4)',
          border: `1px solid ${danger ? 'rgba(251,191,36,0.45)' : 'rgba(232,121,249,0.30)'}`,
          textShadow: danger ? '0 0 6px rgba(251,191,36,0.45)' : '0 0 6px rgba(232,121,249,0.30)',
        }}
        title={`Battle ends at ${new Date(endsAt).toLocaleTimeString()}`}
      >
        {mm}:{ss}
      </span>
    </>
  );
}

const TIME_SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '6/8', '7/8', '9/8', '12/8'];

export default function ProjectHeaderBar({
  project, canDelete, canRename, onNameChange, onTempoChange, onKeyChange, onTimeSignatureChange,
  onShowVersionHistory, onShareToFeed, onShareLink, onInvite, onDelete, onLeave,
}: Props) {
  const [name, setName] = useState(project.name);
  const [bpm, setBpm] = useState(project.tempo ? String(project.tempo) : '');
  const [key, setKey] = useState(project.key || '');
  const [timeSig, setTimeSig] = useState(project.timeSignature || '');
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bpmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setName(project.name);
    setBpm(project.tempo ? String(project.tempo) : '');
    setKey(project.key || '');
    setTimeSig(project.timeSignature || '');
  }, [project.id]);

  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        const portalMenu = document.querySelector('[data-project-menu-portal]');
        if (portalMenu && portalMenu.contains(target)) return;
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const debouncedName = (val: string) => {
    setName(val);
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => { if (val.trim()) onNameChange(val); }, 500);
  };

  const debouncedBpm = (val: string) => {
    setBpm(val);
    if (bpmTimer.current) clearTimeout(bpmTimer.current);
    bpmTimer.current = setTimeout(() => { if (val) onTempoChange(parseInt(val, 10)); }, 500);
  };

  const debouncedKey = (val: string) => {
    setKey(val);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => { if (val) onKeyChange(val); }, 500);
  };

  return (
    <div className="flex items-center gap-3 shrink-0 rounded-2xl mb-1 pl-6 pr-3 min-w-0 h-[50px] glass glass-glow">
      <input
        className={`text-[15px] font-bold text-white bg-transparent border border-transparent outline-none px-2 py-0 rounded-md transition-colors min-w-[60px] flex-1 ${
          canRename
            ? 'hover:bg-white/[0.04] hover:border-white/[0.08] focus:bg-white/[0.04] focus:border-ghost-green/30 cursor-text'
            : 'cursor-default'
        }`}
        value={name}
        readOnly={!canRename}
        title={canRename ? undefined : 'Only the session host can rename this project'}
        onChange={(e) => { if (canRename) debouncedName(e.target.value); }}
        onBlur={() => { if (!canRename) return; if (nameTimer.current) clearTimeout(nameTimer.current); if (name.trim() && name !== project.name) onNameChange(name); }}
      />
      {project.updatedAt && (
        <>
          <div className="w-px h-5 bg-white/10 shrink-0" />
          <span className="text-[14px] text-ghost-green font-semibold shrink-0 whitespace-nowrap">
            {new Date(project.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </>
      )}
      <div className="w-px h-5 bg-white/10 shrink-0" />
      <div className="flex items-center gap-0 shrink-0">
        <span className="text-[13px] text-white/50 font-semibold px-1.5">BPM</span>
        <input
          type="text"
          inputMode="numeric"
          maxLength={3}
          className="w-10 text-[15px] font-bold text-white/90 outline-none px-1 py-0.5 rounded text-center cursor-text"
          style={{ fontFamily: "'Consolas', monospace", background: 'rgba(20,10,40,0.4)', border: '1px solid rgba(124,58,237,0.15)' }}
          value={bpm}
          onChange={(e) => debouncedBpm(e.target.value.replace(/\D/g, '').slice(0, 3))}
          onBlur={() => { if (bpmTimer.current) clearTimeout(bpmTimer.current); if (bpm) onTempoChange(parseInt(bpm, 10)); }}
        />
        <span className="text-[13px] text-white/50 font-semibold px-1.5">TIME</span>
        <select
          className="text-[15px] font-bold text-white/90 outline-none px-1 py-0.5 rounded text-center cursor-pointer appearance-none"
          style={{ fontFamily: "'Consolas', monospace", backgroundImage: 'none', background: 'rgba(20,10,40,0.4)', border: '1px solid rgba(124,58,237,0.15)' }}
          value={timeSig}
          onChange={(e) => { setTimeSig(e.target.value); onTimeSignatureChange(e.target.value); }}
        >
          <option value="" style={{ background: '#1a0e2e', color: '#fff' }}></option>
          {TIME_SIGNATURES.map((ts) => (
            <option key={ts} style={{ background: '#1a0e2e', color: '#fff' }} value={ts}>{ts}</option>
          ))}
        </select>
        <span className="text-[13px] text-white/50 font-semibold px-1.5">KEY</span>
        <input
          type="text"
          maxLength={3}
          className="w-10 text-[15px] font-bold text-white/90 outline-none px-1 py-0.5 rounded text-center cursor-text"
          style={{ fontFamily: "'Consolas', monospace", background: 'rgba(20,10,40,0.4)', border: '1px solid rgba(124,58,237,0.15)' }}
          value={key}
          onChange={(e) => debouncedKey(e.target.value.slice(0, 3))}
          onBlur={() => { if (keyTimer.current) clearTimeout(keyTimer.current); if (key) onKeyChange(key); }}
        />
        {project.projectType === 'beat-battle' && project.battleEndsAt && (
          <BattleCountdown endsAt={project.battleEndsAt} />
        )}
      </div>
      <div className="relative z-20" ref={menuRef}>
        <button
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          className="w-9 h-9 flex items-center justify-center rounded-md text-ghost-text-muted hover:text-white hover:bg-white/[0.1] transition-colors cursor-pointer"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2.5" /><circle cx="12" cy="12" r="2.5" /><circle cx="12" cy="19" r="2.5" />
          </svg>
        </button>
        {showMenu && menuRef.current && createPortal(
          <div
            data-project-menu-portal
            className="fixed w-40 glass rounded-lg shadow-popup animate-popup border border-white/10 py-1"
            style={{
              zIndex: 9999,
              top: (menuRef.current.getBoundingClientRect().bottom || 0) + 4,
              left: (menuRef.current.getBoundingClientRect().right || 0) - 160,
            }}
          >
            <button onClick={() => { setShowMenu(false); onShowVersionHistory(); }} className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              History
            </button>
            {project.projectType !== 'beat-battle' && (
              <>
                <button onClick={() => { setShowMenu(false); onShareToFeed(); }} className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" />
                  </svg>
                  Share to Feed
                </button>
                <button onClick={() => { setShowMenu(false); onInvite(); }} className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
                  </svg>
                  Invite Collaborator
                </button>
                <button onClick={() => { setShowMenu(false); onShareLink(); }} className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-text-secondary hover:bg-white/[0.06] hover:text-white transition-colors flex items-center gap-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                  Share Link
                </button>
                <div className="h-px bg-white/5 mx-2 my-1" />
              </>
            )}
            {canDelete ? (
              <button onClick={() => { setShowMenu(false); onDelete(); }} className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Project
              </button>
            ) : (
              <button onClick={() => { setShowMenu(false); onLeave(); }} className="w-full px-3 py-1.5 text-[13px] text-left text-ghost-error-red hover:bg-ghost-error-red/10 transition-colors flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Leave Project
              </button>
            )}
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}
