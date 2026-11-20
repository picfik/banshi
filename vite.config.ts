import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const { VITE_BASE_PATH } = process.env;
  return {
    base: VITE_BASE_PATH || "/",
    plugins: [react()],
  };
});
