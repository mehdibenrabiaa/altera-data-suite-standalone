import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        onstart({ startup }) {
          // --remote-debugging-port makes the dev window inspectable via CDP.
          startup([".", "--no-sandbox", "--remote-debugging-port=9700"]);
        },
      },
      preload: {
        input: "electron/preload.ts",
      },
    }),
  ],
  build: {
    // Multi-page app -- the Settings window is a genuinely separate entry
    // (settings.html + src/settings-main.tsx), not a route within the main
    // one, so it needs its own listing here to actually land in dist/ (Vite
    // only builds index.html by default). Dev mode needs no such config --
    // Vite's dev server already serves any .html file in the project root.
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        filterBuilder: resolve(__dirname, "filter-builder.html"),
        browse: resolve(__dirname, "browse.html"),
        headerPromoter: resolve(__dirname, "header-promoter.html"),
        merge: resolve(__dirname, "merge.html"),
        shiftColumns: resolve(__dirname, "shift-columns.html"),
        cleaner: resolve(__dirname, "cleaner.html"),
        unique: resolve(__dirname, "unique.html"),
        columnEdit: resolve(__dirname, "column-edit.html"),
        changeType: resolve(__dirname, "change-type.html"),
        regex: resolve(__dirname, "regex.html"),
        export: resolve(__dirname, "export.html"),
        cascadeFill: resolve(__dirname, "cascade-fill.html"),
        unpivotColumns: resolve(__dirname, "unpivot-columns.html"),
        pivotColumns: resolve(__dirname, "pivot-columns.html"),
        addColumn: resolve(__dirname, "add-column.html"),
        conditionalColumn: resolve(__dirname, "conditional-column.html"),
      },
    },
  },
});
