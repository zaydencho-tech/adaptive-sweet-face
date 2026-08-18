import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { buviStandalonePlugin } from "./scripts/vite-plugin-buvi-standalone.mjs";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(projectDirectory, "public");

/**
 * Dedicated offline distribution build for public/buvi.html.
 *
 * Keep this separate from vite.config.ts: the normal configuration belongs to
 * the Lovable/TanStack app and continues to produce the normal web build.
 */
export default defineConfig({
  root: publicDirectory,
  publicDir: false,
  plugins: [
    viteSingleFile({ removeViteModuleLoader: true }),
    buviStandalonePlugin({ publicDirectory }),
  ],
  build: {
    outDir: path.join(projectDirectory, "dist-single"),
    emptyOutDir: true,
    copyPublicDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: path.join(publicDirectory, "buvi.html"),
    },
  },
});
