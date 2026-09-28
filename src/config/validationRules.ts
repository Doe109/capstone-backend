/**
 * RoadWatch Validation Rules & Mathematical Formulas
 * Central configuration for crowdsourced road condition verification & resolution.
 */

export const VALIDATION_RULES = {
  MIN_RESPONSES: 5,
  MIN_REPAIR_VOTES: 5,
  LOCATION_RADIUS_M: 30,
  VOTE_RADIUS_M: 100,
  W_LVS: 0.60,
  W_CV: 0.40,
  RRS_THRESHOLD: 0.70,
  VOTING_WINDOW_DAYS: 7,
} as const;

/**
 * Computes Location Validation Score (LVS) based only on votes made within 30 meters.
 * - onsiteAgree: agreeing votes with distance <= 30m
 * - onsiteDisagree: disagreeing votes with distance <= 30m
 * 
 * Rules:
 * - 0 votes within 30m -> LVS = 0
 * - onsiteAgree > onsiteDisagree -> LVS = 1
 * - onsiteAgree == onsiteDisagree -> LVS = 0.5 (tie)
 * - onsiteDisagree > onsiteAgree -> LVS = 0
 */
export function computeLVS(onsiteAgree: number, onsiteDisagree: number): number {
  const totalOnsite = onsiteAgree + onsiteDisagree;
  if (totalOnsite === 0) {
    return 0.0;
  }
  if (onsiteAgree > onsiteDisagree) {
    return 1.0;
  }
  if (onsiteAgree === onsiteDisagree) {
    return 0.5;
  }
  return 0.0;
}

/**
 * Computes Community Validation Score (CV) using Laplace Smoothing across ALL accepted votes (<= 100m).
 * CV = (agreeCount + 1) / (totalCount + 2)
 */
export function computeCV(agreeCount: number, totalCount: number): number {
  return parseFloat(((agreeCount + 1) / (totalCount + 2)).toFixed(3));
}

/**
 * Computes Road Reliability Score (RRS).
 * RRS = 0.60 * LVS + 0.40 * CV
 */
export function computeRRS(lvs: number, cv: number): number {
  return parseFloat(((VALIDATION_RULES.W_LVS * lvs) + (VALIDATION_RULES.W_CV * cv)).toFixed(3));
}

/**
 * Evaluates whether a pending report achieves 'Verified' status immediately after a vote.
 * Condition:
 * 1. Total accepted responses >= 5
 * 2. LVS == 1.0 (strict onsite majority within 30m)
 * 3. Overall agree > disagree
 * 4. RRS >= 0.70
 */
export function evaluateVerificationStatus(params: {
  total: number;
  agreeCount: number;
  disagreeCount: number;
  onsiteAgreeCount: number;
  onsiteDisagreeCount: number;
}): {
  lvs: number;
  cv: number;
  rrs: number;
  shouldVerify: boolean;
} {
  const { total, agreeCount, disagreeCount, onsiteAgreeCount, onsiteDisagreeCount } = params;
  const lvs = computeLVS(onsiteAgreeCount, onsiteDisagreeCount);
  const rawCv = (agreeCount + 1) / (total + 2);
  const cv = parseFloat(rawCv.toFixed(3));
  // Compute RRS with full floating point precision then format to 3 decimal places
  const rrs = parseFloat(((VALIDATION_RULES.W_LVS * lvs) + (VALIDATION_RULES.W_CV * rawCv)).toFixed(3));

  const shouldVerify =
    total >= VALIDATION_RULES.MIN_RESPONSES &&
    lvs === 1.0 &&
    agreeCount > disagreeCount &&
    rrs >= VALIDATION_RULES.RRS_THRESHOLD;

  return { lvs, cv, rrs, shouldVerify };
}
