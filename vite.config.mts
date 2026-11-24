import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  resolve: { alias: [{ find: /^vm$/, replacement: fileURLToPath(new URL("./src/renderer/vm-shim.ts", import.meta.url)) }] },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // The chunks are read from the installed app's own folder, never downloaded: the 500 kB web default does not
    // apply. The entry (the app itself, about 1.4 MB) and Mermaid's lazily loaded diagram kinds stay under this.
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Match only each vendor's own modules. Pulling their dependencies into a
          // group can put shared React code in a lazy feature's chunk.
          includeDependenciesRecursively: false,
          groups: [
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "puck", test: /[\\/]node_modules[\\/]@puckeditor[\\/]/ },
            { name: "pdfjs", test: /[\\/]node_modules[\\/]pdfjs-dist[\\/]/ },
            { name: "katex", test: /[\\/]node_modules[\\/]katex[\\/]/ },
          ],
        }
      }
    }
  }
});
