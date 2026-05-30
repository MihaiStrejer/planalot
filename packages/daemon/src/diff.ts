import type { PlanModification } from "@planalot/shared";

export function computeLineModifications(before: string, after: string, maxTrail: number): PlanModification[] {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  const modifications: PlanModification[] = [];

  let left = 0;
  let rightBefore = beforeLines.length - 1;
  let rightAfter = afterLines.length - 1;

  while (left <= rightBefore && left <= rightAfter && beforeLines[left] === afterLines[left]) left++;
  while (rightBefore >= left && rightAfter >= left && beforeLines[rightBefore] === afterLines[rightAfter]) {
    rightBefore--;
    rightAfter--;
  }

  if (left > rightBefore && left > rightAfter) return [];

  const beforeChunk = beforeLines.slice(left, rightBefore + 1);
  const afterChunk = afterLines.slice(left, rightAfter + 1);
  const type = beforeChunk.length === 0 ? "added" : afterChunk.length === 0 ? "removed" : "changed";
  modifications.push({
    id: `mod-${Date.now()}-${left}`,
    type,
    ...(beforeChunk.length === 0 ? {} : { beforeStartLine: left + 1, beforeEndLine: rightBefore + 1, beforeText: beforeChunk.join("\n") }),
    ...(afterChunk.length === 0 ? {} : { afterStartLine: left + 1, afterEndLine: rightAfter + 1, afterText: afterChunk.join("\n") }),
  });

  return modifications.slice(-Math.max(1, maxTrail));
}
