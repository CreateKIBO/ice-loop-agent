'use strict';
// Pure merge policy: a late model response must not replace a user's new edits.
(function (root) {
  const names = ['topic', 'core_benefit', 'exercise_to_answer', 'next_episode_plan', 'materials_text'];
  function merge(snapshot, current, suggestions, replace = false, touched = []) {
    const values = { ...current }, changed = [];
    if (snapshot.series !== current.series || snapshot.episode !== current.episode) return { values, changed, stale: true };
    for (const name of names) {
      if (touched.includes(name) || current[name] !== snapshot[name]) continue;
      if (!replace && String(snapshot[name] || '').trim()) continue;
      const value = suggestions[name];
      if (typeof value !== 'string' || !value.trim() || value === current[name]) continue;
      values[name] = value; changed.push(name);
    }
    return { values, changed, stale: false };
  }
  const helpers = { merge, names };
  if (typeof module !== 'undefined') module.exports = helpers;
  else root.iceBrief = helpers;
})(globalThis);
