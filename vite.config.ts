import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri attend un port fixe et ne doit pas masquer les erreurs Rust.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" },
});
