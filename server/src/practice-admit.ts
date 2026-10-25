/** Admission caps for free practice and survival matches, kept apart so the 6 hour survival
 *  matches cannot exhaust the practice pool of the test server. Pure: the hub counts, this decides. */
export type PracticeMode = "normal" | "survival";

export interface PracticeCounts {
  /** Running non-survival practice matches. */
  normal: number;
  /** Running survival matches. */
  survival: number;
  /** Running matches of THIS mode from the requesting IP. */
  perIp: number;
}

export interface PracticeCaps {
  maxPractice: number;
  maxPerIp: number;
  maxSurvival: number;
  maxSurvivalPerIp: number;
}

/** null = admitted; "busy" = refused with the same error practice has always used. */
export function practiceAdmit(mode: PracticeMode, counts: PracticeCounts, caps: PracticeCaps): "busy" | null {
  if (mode === "survival") {
    if (counts.survival >= caps.maxSurvival) return "busy";
    if (counts.perIp >= caps.maxSurvivalPerIp) return "busy";
    return null;
  }
  if (counts.normal >= caps.maxPractice) return "busy";
  if (counts.perIp >= caps.maxPerIp) return "busy";
  return null;
}
