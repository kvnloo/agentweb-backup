/**
 * Which side shows the newer creative (A) of a weekly calibration pair (ENG-2142). Stable per
 * pair, so a reload shows the same sides, and about half the pairs each way, so the reviewer
 * cannot tell which creative is the newer one from its position.
 */
export function newerOnRight(caseId: string): boolean {
  let hash = 2166136261;
  for (let i = 0; i < caseId.length; i++) hash = Math.imul(hash ^ caseId.charCodeAt(i), 16777619);
  return (hash & 1) === 1;
}
