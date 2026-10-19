export type ModelRoute = { primary: string; fallbacks: string[]; thinking_policy: string };
export type RouteProfile = { profile_id: string; provider: string; model_id: string; has_key: boolean; status: string };
export type RouteSettings = { profiles: RouteProfile[]; routes?: Record<string, ModelRoute> };
export type ModelReadiness = "unknown" | "missing" | "unrouted" | "untested" | "ready";
export const TEXT_ROLES = [
  { id: "writer", label: "创作对话与正文" }, { id: "planner", label: "选题与大纲" },
  { id: "researcher", label: "素材整理" }, { id: "reviewer", label: "文章审校" },
  { id: "title_editor", label: "标题润色" }, { id: "code_helper", label: "代码辅助" },
] as const;
export function writingReadiness(settings?: RouteSettings): ModelReadiness {
  if (!settings?.profiles) return "unknown";
  const route = settings.routes?.writer;
  const chain = route ? [route.primary, ...(route.fallbacks || [])] : [];
  const usable = settings.profiles.filter(profile => profile.has_key && chain.includes(profile.profile_id));
  if (usable.some(profile => profile.status === "verified")) return "ready";
  if (usable.length) return "untested";
  return settings.profiles.some(profile => profile.has_key) ? "unrouted" : "missing";
}
export function textRoutes(routes: Record<string, ModelRoute> = {}): Record<string, ModelRoute> {
  return Object.fromEntries(TEXT_ROLES.filter(role => routes[role.id]).map(role =>
    [role.id, { ...routes[role.id], fallbacks: [...routes[role.id].fallbacks] }]));
}
export function assignPrimary(routes: Record<string, ModelRoute>, primary: string, roleId?: string) {
  return Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, !roleId || roleId === id
    ? { ...route, primary, fallbacks: route.fallbacks.filter(id => id !== primary) }
    : { ...route, fallbacks: [...route.fallbacks] }]));
}
