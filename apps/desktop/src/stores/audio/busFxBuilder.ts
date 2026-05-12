import { getCtx, wireDrumBusOutput, wireMasterFx } from './graph';
import { buildTrackEqChain, removeTrackEq } from './trackEq';
import { buildTrackCompChain, removeTrackComp } from './trackComp';
import { buildTrackReverbChain, removeTrackReverb } from './trackReverb';
import {
  useEffectsStore,
  DRUM_RACK_FX_KEY,
  MASTER_FX_KEY,
  type EqParams,
  type CompParams,
  type ReverbParams,
} from '../effectsStore';

// Rebuild the drum rack's bus FX chain from scratch. Reads the chain
// shape from effectsStore and splices the resulting biquad / compressor /
// reverb stages between the drum bus output and the main mixer.
// Called on rewire AND at module load so the rack picks up
// any persisted chain even before the user presses play.
export function rebuildDrumBusFx() {
  try {
    const ctx = getCtx();
    // Tear down whatever was registered on the drum-rack key last
    // pass so we don't leak biquad / compressor nodes across rewires.
    removeTrackEq(DRUM_RACK_FX_KEY);
    removeTrackComp(DRUM_RACK_FX_KEY);
    removeTrackReverb(DRUM_RACK_FX_KEY);
    const chain = useEffectsStore.getState().getChain(DRUM_RACK_FX_KEY);
    if (!chain || chain.length === 0) {
      wireDrumBusOutput(null);
      return;
    }
    let firstInput: AudioNode | null = null;
    let cursor: AudioNode | null = null;
    for (const fx of chain) {
      try {
        let stage: { input: AudioNode; output: AudioNode } | null = null;
        if (fx.kind === 'eq' && fx.params && 'bands' in fx.params) {
          stage = buildTrackEqChain(ctx, DRUM_RACK_FX_KEY, DRUM_RACK_FX_KEY, (fx.params as EqParams).bands as any, fx.bypassed);
        } else if (fx.kind === 'comp' && fx.params && 'threshold' in fx.params) {
          stage = buildTrackCompChain(ctx, DRUM_RACK_FX_KEY, DRUM_RACK_FX_KEY, fx.params as CompParams, fx.bypassed);
        } else if (fx.kind === 'reverb' && fx.params && 'mix' in fx.params) {
          stage = buildTrackReverbChain(ctx, DRUM_RACK_FX_KEY, DRUM_RACK_FX_KEY, fx.params as ReverbParams, fx.bypassed);
        }
        if (!stage) continue;
        if (!firstInput) firstInput = stage.input;
        if (cursor) cursor.connect(stage.input);
        cursor = stage.output;
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[audioStore] drum bus FX build failed for', fx.kind, err);
      }
    }
    if (firstInput && cursor) {
      wireDrumBusOutput({ input: firstInput, output: cursor });
    } else {
      wireDrumBusOutput(null);
    }
  } catch { /* audio not initialised yet — wireDrumBusOutput re-init is a no-op */ }
}

// Same shape as rebuildDrumBusFx but for the master bus. The chain
// is spliced between mixerBus and masterGain so every track + drum
// row routes through it (same place a hardware mixer's master
// inserts would sit).
export function rebuildMasterFx() {
  try {
    const ctx = getCtx();
    removeTrackEq(MASTER_FX_KEY);
    removeTrackComp(MASTER_FX_KEY);
    removeTrackReverb(MASTER_FX_KEY);
    const chain = useEffectsStore.getState().getChain(MASTER_FX_KEY);
    if (!chain || chain.length === 0) {
      wireMasterFx(null);
      return;
    }
    let firstInput: AudioNode | null = null;
    let cursor: AudioNode | null = null;
    for (const fx of chain) {
      try {
        let stage: { input: AudioNode; output: AudioNode } | null = null;
        if (fx.kind === 'eq' && fx.params && 'bands' in fx.params) {
          stage = buildTrackEqChain(ctx, MASTER_FX_KEY, MASTER_FX_KEY, (fx.params as EqParams).bands as any, fx.bypassed);
        } else if (fx.kind === 'comp' && fx.params && 'threshold' in fx.params) {
          stage = buildTrackCompChain(ctx, MASTER_FX_KEY, MASTER_FX_KEY, fx.params as CompParams, fx.bypassed);
        } else if (fx.kind === 'reverb' && fx.params && 'mix' in fx.params) {
          stage = buildTrackReverbChain(ctx, MASTER_FX_KEY, MASTER_FX_KEY, fx.params as ReverbParams, fx.bypassed);
        }
        if (!stage) continue;
        if (!firstInput) firstInput = stage.input;
        if (cursor) cursor.connect(stage.input);
        cursor = stage.output;
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[audioStore] master bus FX build failed for', fx.kind, err);
      }
    }
    if (firstInput && cursor) {
      wireMasterFx({ input: firstInput, output: cursor });
    } else {
      wireMasterFx(null);
    }
  } catch { /* audio not initialised yet */ }
}
