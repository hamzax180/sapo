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
          resolve({ ok: true, url });
        }
      };
      webcontainerInstance.on('server-ready', onReady);
      
      webcontainerInstance.spawn('npm', ['run', 'preview']).then(process => {
        process.output.pipeTo(new WritableStream({ write() {} })).catch(() => {});
        process.exit.then(code => {
          if (code !== 0) {
            webcontainerInstance.off('server-ready', onReady);
            resolve({ ok: false, url: '' });
          }
        });
      }).catch(err => {
        webcontainerInstance.off('server-ready', onReady);
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
