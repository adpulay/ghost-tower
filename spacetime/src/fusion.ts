// Fusion score, INTERFACES.md §4. Pure so it can be unit-tested and reused by the eval.

export interface FusionWeights {
  /** weight of the LTE/5G -> 2G -> back signal */
  w_rat: number;
  /** weight of the classifier scam probability */
  w_sms: number;
  /** weight of the carrier SMSC mismatch signal */
  w_smsc: number;
  /** confidence bonus in recluster when any event has smsc_match == "no" (§ tracking step 5) */
  smsc_bonus: number;
}

export const DEFAULT_WEIGHTS: FusionWeights = { w_rat: 0.45, w_sms: 0.35, w_smsc: 0.2, smsc_bonus: 0.1 };

/** Events below this are stored but ignored by recluster (§4). */
export const FUSION_MIN = 0.3;
/** 2G stays longer than this look like genuinely poor coverage, not a blaster. */
export const RAT_DROP_MAX_SECS = 30;

export interface FusionInput {
  rat_drop: boolean;
  rat_drop_secs: number;
  sms_score: number;
  smsc_match: string;
}

export function ratDropSignal(e: FusionInput): number {
  return e.rat_drop && e.rat_drop_secs <= RAT_DROP_MAX_SECS ? 1 : 0;
}

export function smscSignal(smsc: string): number {
  if (smsc === 'no') return 1;
  if (smsc === 'yes') return 0;
  return 0.5; // "unknown" and anything unexpected
}

export function normalizeSmsc(smsc: string): 'yes' | 'no' | 'unknown' {
  const s = smsc.trim().toLowerCase();
  return s === 'yes' || s === 'no' ? s : 'unknown';
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

export function fusionScore(e: FusionInput, w: FusionWeights = DEFAULT_WEIGHTS): number {
  return (
    w.w_rat * ratDropSignal(e) + w.w_sms * clamp01(e.sms_score) + w.w_smsc * smscSignal(e.smsc_match)
  );
}

/** Weight presets for the TESTING.md §2c ablation. Subsets are renormalized to sum to 1. */
export const ABLATION_PRESETS: Record<string, FusionWeights> = {
  text_only: { w_rat: 0, w_sms: 1, w_smsc: 0, smsc_bonus: 0 },
  drop_only: { w_rat: 1, w_sms: 0, w_smsc: 0, smsc_bonus: 0 },
  text_drop: { w_rat: 0.45 / 0.8, w_sms: 0.35 / 0.8, w_smsc: 0, smsc_bonus: 0 },
  all_three: DEFAULT_WEIGHTS,
};
