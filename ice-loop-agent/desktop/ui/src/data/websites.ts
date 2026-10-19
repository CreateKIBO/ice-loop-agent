export type Website = 'tapnow' | 'wechat';
export const WEBSITE_EVENT = 'ice:open-website';
export function openWebsite(site: Website) { window.dispatchEvent(new CustomEvent(WEBSITE_EVENT, { detail: site })); }
