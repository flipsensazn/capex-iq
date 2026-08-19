export function countPendingMembers(members) {
  if (!Array.isArray(members)) return 0;

  return members.filter(member => {
    if (!member || typeof member !== "object" || Array.isArray(member) || member.malformed === true) {
      return false;
    }

    const features = member.features;
    if (!features || typeof features !== "object" || Array.isArray(features)) return false;

    return !Object.values(features).some(value => value === true);
  }).length;
}
