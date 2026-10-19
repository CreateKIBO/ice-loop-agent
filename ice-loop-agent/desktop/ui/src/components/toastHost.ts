// Notifications belong inside the active modal, where they participate in layout
// and remain reachable by its focus trap instead of covering footer controls.
const hosts: HTMLElement[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const toastHost = {
  get: () => hosts.at(-1) ?? null,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function registerToastHost(host: HTMLElement) {
  hosts.push(host); emit();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = hosts.indexOf(host);
    if (index >= 0) { hosts.splice(index, 1); emit(); }
  };
}
