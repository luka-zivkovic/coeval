import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    proxy: {
      "/api": process.env.COEVAL_API_ORIGIN || "http://localhost:8787",
      "/health": process.env.COEVAL_API_ORIGIN || "http://localhost:8787"
    }
  }
});
