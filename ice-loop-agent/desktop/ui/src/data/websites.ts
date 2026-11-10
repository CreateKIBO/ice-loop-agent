// v3（C-02）：wechat / tapnow 为固定站点会话；web 为当前公众号的通用网页会话。三者 Cookie 互不共享，也不跨公众号共享。
export type Website = 'tapnow' | 'wechat' | 'web';
export const WEBSITE_EVENT = 'ice:open-website';
export type WebsiteRequest = { site: Website; url?: string };
export function openWebsite(site: Website, url?: string) {
  window.dispatchEvent(new CustomEvent<WebsiteRequest>(WEBSITE_EVENT, { detail: { site, url } }));
}
/** 收藏地址按域名进入对应会话：公众号后台/TapNow 走各自的固定会话，其余走通用网页会话。 */
export function siteForUrl(url: string): Website {
  try {
    const host = new URL(url).hostname;
    if (host === 'mp.weixin.qq.com') return 'wechat';
    if (host === 'tapnow.media' || host.endsWith('.tapnow.media')) return 'tapnow';
  } catch { /* 无效地址交给浏览器层拒绝 */ }
  return 'web';
}
