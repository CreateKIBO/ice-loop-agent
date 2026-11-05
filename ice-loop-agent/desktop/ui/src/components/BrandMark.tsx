// 应用标识（第26轮）：蓝白回环图标。文件位于 desktop/ui/public/brand-mark.png，
// 由 Vite 原样复制到 dist 根目录，经 ice://app/ui/brand-mark.png 加载（CSP img-src 'self'）。
// 纯装饰：旁边总有"ICE Loop Studio"文字或页面标题，因此对读屏隐藏。
export function BrandMark({ className = "", size }: { className?: string; size?: number }) {
  return (
    <span className={"ice-brand-mark " + className} aria-hidden="true"
          style={size ? { width: size, height: size } : undefined}>
      <img src="./brand-mark.png" alt="" draggable={false} />
    </span>
  );
}
