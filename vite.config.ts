import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/gamedev-10-bomberman/" : "/",
  server: { port: 5182, open: true },
  build: { target: "es2020" },
}));
