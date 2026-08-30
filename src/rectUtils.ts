// Returns a unique name by appending _01, _02, … when `base` is already
// taken. `excludeId` is the rect being renamed — its own current name
// doesn't count.
export function uniqueRectName(base: string, existingRects: { id: string; name?: string }[], excludeId?: string): string {
  const taken = new Set(existingRects.filter(r => r.id !== excludeId).map(r => r.name ?? r.id));
  if (!taken.has(base)) return base;
  const stripped = base.replace(/_\d+$/, "");
  let i = 1;
  while (taken.has(`${stripped}_${String(i).padStart(2, "0")}`)) i++;
  return `${stripped}_${String(i).padStart(2, "0")}`;
}
