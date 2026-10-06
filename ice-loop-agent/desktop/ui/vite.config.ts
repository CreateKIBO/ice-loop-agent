import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 桌面离线产物：固定相对路径，产出单入口 dist/，由 Electron file:// 加载。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome130",
  },
  server: { port: 5183, strictPort: true },
});
