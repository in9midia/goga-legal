import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // O contrato do grafo mora na API (fonte unica) e a UI importa o arquivo
      // direto; o `zod` dele resolve pelo node_modules DESTA pasta, senao o
      // bundle levaria duas copias do zod e o instanceof entre elas falharia.
      "@shared": path.resolve(import.meta.dirname, "../api/src/shared"),
      zod: path.resolve(import.meta.dirname, "node_modules/zod"),
    },
  },
  server: {
    fs: { allow: [".."] },
    proxy: { "/api": { target: process.env.STUDIO_API ?? "http://localhost:8787", changeOrigin: false } },
  },
});
