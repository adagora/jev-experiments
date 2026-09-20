import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: {
    port: 5174,
    proxy: { "/api": { target: "http://localhost:8788", changeOrigin: true } },
  },
});
