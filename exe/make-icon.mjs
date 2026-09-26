// Generates exe/winres/icon.png (256x256) from the Doge IDE logo using headless Edge.
// Re-runnable: only refreshes the file.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const tmp = join(here, '.tmp');
const outDir = join(here, 'winres');
mkdirSync(tmp, { recursive: true });
mkdirSync(outDir, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="52" fill="#1a1b26"/>
  <circle cx="128" cy="128" r="96" fill="#7aa2f7"/>
  <text x="128" y="166" text-anchor="middle" fill="#1a1b26" font-size="128" font-weight="bold" font-family="Segoe UI, Arial, sans-serif">D</text>
</svg>`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:256px;height:256px;background:transparent;overflow:hidden}
svg{display:block}
</style></head><body>${svg}</body></html>`;

const htmlPath = join(tmp, 'icon.html');
const pngPath = join(outDir, 'icon.png');
writeFileSync(htmlPath, html, 'utf8');

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
let edge = candidates.find((p) => existsSync(p));
if (!edge) {
  try {
    edge = execFileSync('where.exe', ['msedge'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {}
}
if (!edge) {
  console.error('msedge.exe not found: install Edge or place icon.png manually in exe/winres/');
  process.exit(1);
}

execFileSync(edge, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--default-background-color=00000000',
  '--window-size=256,256',
  `--screenshot=${pngPath}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`,
], { stdio: 'ignore' });

console.log(`icon written: ${pngPath}`);
