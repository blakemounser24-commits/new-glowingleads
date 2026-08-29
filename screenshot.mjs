import puppeteer from "file:///C:/Users/user/Downloads/1080p%20watch/node_modules/puppeteer/lib/puppeteer/puppeteer.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "temporary screenshots");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const url = process.argv[2] || "http://localhost:3000";
const label = process.argv[3];

let n = 1;
const existing = fs.readdirSync(outDir).filter(f => f.startsWith("screenshot-"));
if (existing.length > 0) {
  const nums = existing.map(f => {
    const m = f.match(/screenshot-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  n = Math.max(...nums) + 1;
}

const fileName = label ? `screenshot-${n}-${label}.png` : `screenshot-${n}.png`;
const outPath = path.join(outDir, fileName);

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox"]
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await page.screenshot({ path: outPath, fullPage: false });
await browser.close();

console.log(outPath);
