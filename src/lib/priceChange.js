// Incomplete price objects must never reach React as children, but older
// cached payloads may still store the change as a bare number.
export function changeOf(entry) {
  if (Number.isFinite(entry)) return entry;
  if (entry && typeof entry === "object" && Number.isFinite(entry.change)) {
    return entry.change;
  }
  return undefined;
}
