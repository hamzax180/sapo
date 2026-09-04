import { WebContainer } from 'https://cdn.jsdelivr.net/npm/@webcontainer/api@1/+esm';

const packageJson = {
  "name": "souqi-code-app",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 4173 --strictPort"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.5.3",
    "vite": "^5.3.1"
  }
};

const viteConfigTs = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { host: true, strictPort: true },
  base: "./"
});`;

const tsconfigJson = {
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
};

const tailwindConfigJs = `export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: []
};`;

const postcssConfigJs = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};`;

const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Souqi Code app</title>
    <style>
      /* This preview is framed as an iPhone/iPad/monitor mockup — a real
         device doesn't show OS scrollbar chrome, so this shouldn't either.
         Baked into the scaffold itself (not injected from the parent page)
         because the WebContainer dev server is served from its own origin;
         nothing outside this document can reach in to style it. Scrolling
         still works via wheel/touch, only the bar is hidden. */
      html, body, * { scrollbar-width: none; -ms-overflow-style: none; }
      html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { display: none; width: 0; height: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

const srcMainTsx = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;

const srcAppTsx = `export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <h1 className="text-2xl font-semibold">Souqi Code</h1>
    </div>
  );
}`;

const srcIndexCss = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

const publicPwaIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#1aa6df"/>
  <path d="M180 336V176h72c39.8 0 66 24.3 66 61.5 0 22.6-11 40.2-29 49.6L336 336h-46l-40-70h-30v70h-40zm40-104h28c17.7 0 27-8.4 27-23.6 0-15.2-9.3-23.6-27-23.6h-28v47.3z" fill="#fff"/>
</svg>`;

const scaffoldFiles = {
  'package.json': { file: { contents: JSON.stringify(packageJson, null, 2) } },
  'vite.config.ts': { file: { contents: viteConfigTs } },
  'tsconfig.json': { file: { contents: JSON.stringify(tsconfigJson, null, 2) } },
  'tailwind.config.js': { file: { contents: tailwindConfigJs } },
  'postcss.config.js': { file: { contents: postcssConfigJs } },
  'index.html': { file: { contents: indexHtml } },
  'src': {
    directory: {
      'main.tsx': { file: { contents: srcMainTsx } },
      'App.tsx': { file: { contents: srcAppTsx } },
      'index.css': { file: { contents: srcIndexCss } }
    }
  },
  'public': {
    directory: {
      'pwa-icon.svg': { file: { contents: publicPwaIconSvg } }
    }
  }
};

let webcontainerInstance = null;

class WCRuntime {
  async boot(onLog) {
    if (webcontainerInstance) {
      if (onLog) onLog("WebContainer already booted.");
      return;
    }
    
    if (onLog) onLog("Booting WebContainer...");
    try {
      webcontainerInstance = await WebContainer.boot();
      if (onLog) onLog("WebContainer booted successfully. Mounting files...");
      await webcontainerInstance.mount(scaffoldFiles);
      if (onLog) onLog("Files mounted.");
    } catch (err) {
      throw new Error("Failed to boot WebContainer: " + err.message);
    }
  }

  async _runCommand(cmd, args, onLog) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    
    const process = await webcontainerInstance.spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    
    process.output.pipeTo(new WritableStream({
      write(data) {
        if (onLog) onLog(data);
        stdout += data;
      }
    }));
    
    const exitCode = await process.exit;
    return { ok: exitCode === 0, code: exitCode, stdout, stderr };
  }

  async install(onLog) {
    if (onLog) onLog("Running npm install...");
    const res = await this._runCommand('npm', ['install', '--no-audit', '--no-fund'], onLog);
    return { ok: res.ok, output: res.stdout };
  }

  /**
   * Boot and install, once, and let anyone wait for it.
   *
   * isBooted() only says a WebContainer exists — it says nothing about
   * whether node_modules does. The two were being conflated: boot+install
   * ran detached in the background while startPreview() gated on
   * isBooted(), so `npm run preview` could fire while npm install was
   * still unpacking, or after it had failed. Either way vite was not on
   * disk yet and the command died with 127, which reads as a broken
   * scaffold rather than a race.
   *
   * Cached, so calling it per preview costs nothing after the first.
   * Never rejects: callers ask isReady() and get installError() for the
   * reason, because "install failed" is a state to render, not an
   * exception to unwind through a UI event handler.
   */
  prepare(onLog) {
    if (!this._prepare) {
      this._prepare = (async () => {
        try {
          await this.boot(onLog);
          const res = await this.install(onLog);
          this._installed = res.ok;
          if (!res.ok) this._installError = (res.output || "").slice(-2000);
        } catch (e) {
          this._installed = false;
          this._installError = e.message;
        }
        return this._installed === true;
      })();
    }
    return this._prepare;
  }

  /** True only when npm install has finished successfully. */
  isReady() { return this._installed === true; }

  /** Why prepare() failed, when it did. */
  installError() { return this._installError || ""; }

  async writeFiles(files) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        try {
          await webcontainerInstance.fs.mkdir(dir);
        } catch(e) {
          // ignore if exists
        }
      }
      await webcontainerInstance.fs.writeFile(path, content);
    }
  }

  async build(onLog) {
    // Both build and preview need node_modules, and three separate callers
    // invoked this without waiting for the install — two of them inside a
    // catch that swallowed the result. Ensuring it here fixes all of them
    // at once, and cannot be forgotten by the next caller. Free once warm.
    await this.prepare(onLog);
    if (!this.isReady()) {
      const why = this.installError() || "dependencies are not installed";
      if (onLog) onLog("Cannot build: " + why);
      // Same shape _runCommand returns, so callers that read .stdout to
      // parse build errors still work and report something true rather
      // than a confusing "command not found: vite".
      return { ok: false, code: 127, stdout: "", stderr: why };
    }
    if (onLog) onLog("Running npm run build...");
    return await this._runCommand('npm', ['run', 'build'], onLog);
  }

  async startPreview(iframeEl) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    
    return new Promise((resolve, reject) => {
      // Register listener BEFORE spawning to avoid race condition
      const onReady = (port, url) => {
        if (port === 4173) {
          if (iframeEl) iframeEl.src = url;
          unsubscribe();
          resolve({ ok: true, url });
        }
      };
      // WebContainer's on() RETURNS the unsubscribe function; there is no
      // off() on the instance. Calling one threw "webcontainerInstance.off
      // is not a function" — and it threw from inside the exit and catch
      // handlers, which are exactly the paths that run when the preview
      // fails. So a failed preview never resolved or rejected: the promise
      // hung, the iframe stayed blank, and the only visible symptom was a
      // TypeError naming a line that was itself the error handler.
      const unsubscribe = webcontainerInstance.on('server-ready', onReady);

      // Capture the output instead of discarding it. When the command
      // fails, its stderr is the only thing that says why, and it was
      // being written into a sink that dropped every byte.
      let output = "";

      webcontainerInstance.spawn('npm', ['run', 'preview']).then(process => {
        process.output.pipeTo(new WritableStream({
          write(chunk) { if (output.length < 4000) output += chunk; }
        })).catch(() => {});
        process.exit.then(code => {
          if (code !== 0) {
            unsubscribe();
            resolve({ ok: false, url: '', code: code, output: output.trim() });
          }
        });
      }).catch(err => {
        unsubscribe();
        reject(err);
      });
    });
  }

  async readFile(path) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    return await webcontainerInstance.fs.readFile(path, 'utf-8');
  }

  async listFiles(dir) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    return await webcontainerInstance.fs.readdir(dir);
  }

  async readDist() {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    const results = [];
    
    const walk = async (relDir) => {
      const absDir = relDir ? 'dist/' + relDir : 'dist';
      const entries = await webcontainerInstance.fs.readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relDir ? relDir + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          await walk(relPath);
        } else {
          const content = await webcontainerInstance.fs.readFile('dist/' + relPath);
          let binary = '';
          for (let i = 0; i < content.byteLength; i++) {
            binary += String.fromCharCode(content[i]);
          }
          results.push({ path: relPath, base64: btoa(binary), size: content.byteLength });
        }
      }
    };
    
    try { await walk(''); } catch (e) { console.warn('Could not read dist directory:', e); }
    return results;
  }

  async writeFile(path, content) {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      try { await webcontainerInstance.fs.mkdir(dir); } catch(e) { /* exists */ }
    }
    await webcontainerInstance.fs.writeFile(path, content);
  }

  async readAllSrcFiles() {
    if (!webcontainerInstance) throw new Error("WebContainer not booted");
    const files = {};
    const walk = async (dir) => {
      const entries = await webcontainerInstance.fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const path = dir + '/' + entry.name;
        if (entry.isDirectory()) {
          await walk(path);
        } else {
          try { files[path] = await webcontainerInstance.fs.readFile(path, 'utf-8'); } catch(e) { /* skip binary */ }
        }
      }
    };
    await walk('src');
    return files;
  }

  async restoreFiles(files) {
    await this.writeFiles(files);
  }

  destroy() {
    if (webcontainerInstance) {
      webcontainerInstance.teardown();
      webcontainerInstance = null;
    }
  }

  isBooted() {
    return webcontainerInstance !== null;
  }
}

export { WCRuntime };
