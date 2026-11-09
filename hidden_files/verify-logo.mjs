// Logo check: serves site/ locally and checks the logo renders in the
// header on the homepage and the communities page, the SVG favicon link
// is present and no PNG favicon link exists (the PNG is a local-only
// binary the text-only push tool cannot push, so the site must not
// reference it), no page errors, and the header does not overflow at
// phone width (390px). Run from /tmp/og-test/ (puppeteer-core lives
// there).
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const SITE = '/home/hatch/workspace/commonhold/site';
const PORT = 8142;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

const browser = await puppeteer.launch({ executablePath: SHELL, args: ['--no-sandbox', '--disable-gpu'] });

// 1. Serve the site and check the header on both pages.
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: SITE, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const page = await browser.newPage();
let pageErrors = 0;
page.on('pageerror', (e) => { pageErrors++; console.log('PAGE ERROR:', String(e).slice(0, 200)); });

// Stub RPC so the sandbox (no live RPC) does not stall the pages.
await page.evaluateOnNewDocument(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (String(url).includes('rpc.testnet')) {
      return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 'q', error: { message: 'stub: offline' } }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return realFetch(url, opts);
  };
});

async function checkPage(path, label) {
  await page.goto(`${BASE}/${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));
  const info = await page.evaluate(() => {
    const img = document.querySelector('header.top .brand .brand-mark');
    const r = img ? img.getBoundingClientRect() : null;
    const svgFav = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
    const pngFav = document.querySelector('link[rel="icon"][type="image/png"]');
    return {
      hasImg: !!img,
      src: img ? img.getAttribute('src') : null,
      natural: img ? img.naturalWidth : 0,
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      visible: r ? r.width > 0 && r.height > 0 : false,
      wordmark: (document.querySelector('header.top .brand span') || {}).textContent || '',
      svgFav: svgFav ? svgFav.getAttribute('href') : null,
      pngFav: pngFav ? pngFav.getAttribute('href') : null,
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
  check(`${label}: logo img in header`, info.hasImg && info.src === 'assets/logo.svg', info.src);
  check(`${label}: logo image loaded`, info.natural > 0, 'naturalWidth ' + info.natural);
  check(`${label}: logo renders at 28x28`, info.w === 28 && info.h === 28, info.w + 'x' + info.h);
  check(`${label}: wordmark still OwnGround`, info.wordmark === 'OwnGround', info.wordmark);
  check(`${label}: SVG favicon link`, info.svgFav === 'assets/favicon.svg', info.svgFav);
  check(`${label}: no PNG favicon link (unpushable binary)`, info.pngFav === null, info.pngFav);
  return info;
}

await page.setViewport({ width: 1280, height: 800 });
await checkPage('index.html', 'homepage');
await checkPage('communities.html', 'communities');

// 3. Phone width: no horizontal overflow, logo still visible.
await page.setViewport({ width: 390, height: 844 });
const phone = await checkPage('index.html', 'homepage @390px');
check('phone width: no horizontal overflow', phone.scrollW <= 390, 'scrollWidth ' + phone.scrollW + ' vs innerWidth ' + phone.innerW);

check('no page errors across the run', pageErrors === 0, pageErrors + ' page errors');

await browser.close();
server.kill();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECKS FAILED');
process.exit(failures === 0 ? 0 : 1);
