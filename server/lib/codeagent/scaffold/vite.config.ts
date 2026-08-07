import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Every generated app is installable — a home-screen icon, offline
    // caching, no browser chrome once launched. This is infrastructure
    // (like tailwind.config.js), never something the model writes itself.
    // registerType "autoUpdate" means a republish takes effect on next
    // load with no user-facing "new version available" prompt to design.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pwa-icon.svg"],
      manifest: {
        name: "Souqi App", short_name: "App",
        theme_color: "#1aa6df", background_color: "#ffffff", display: "standalone",
        icons: [
          { src: "pwa-icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" },
          { src: "pwa-icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "maskable" }
        ]
      }
    })
  ],
  server: { host: true, strictPort: true },
  // Relative asset paths ("./assets/x.js" instead of "/assets/x.js") — this
  // build gets served through Souqi's own proxy at an arbitrary per-project
  // path prefix (/api/codeagent/preview/<slug>/...), not from the origin
  // root. Root-relative paths would resolve against whatever origin the
  // browser thinks it's on, ignoring the prefix entirely — found live as a
  // 404 on every asset the moment the proxy went in. Relative paths resolve
  // correctly against the CURRENT document URL regardless of what prefix
  // it's served under, with no per-request HTML rewriting needed.
  base: "./"
});
