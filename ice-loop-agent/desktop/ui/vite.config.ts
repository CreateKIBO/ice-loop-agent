import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Offline assets use relative paths and load through Electron ice://app/ui/.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome130",
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep the renderer runtime stable across application-only updates.
          // This is still a static dependency; it is not a RAM reduction claim.
          groups: [{ name: "vendor-react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 20 }],
        },
      },
    },
  },
  server: { port: 5183, strictPort: true },
});
