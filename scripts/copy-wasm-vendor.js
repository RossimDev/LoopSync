"use strict";

/**
 * Copia os arquivos do ffmpeg.wasm dos pacotes npm para static/vendor/, para
 * que o app funcione como site estático (ex.: Vercel) sem depender de CDN.
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const vendor = path.join(root, "static", "vendor");

const files = [
  ["@ffmpeg/ffmpeg/dist/umd/ffmpeg.js", "ffmpeg.js"],
  ["@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js", "814.ffmpeg.js"],
  ["@ffmpeg/util/dist/umd/index.js", "ffmpeg-util.js"],
  ["@ffmpeg/core/dist/esm/ffmpeg-core.js", "ffmpeg-core.js"],
  ["@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "ffmpeg-core.wasm"],
];

fs.mkdirSync(vendor, { recursive: true });

for (const [from, to] of files) {
  const src = path.join(root, "node_modules", from);
  const dest = path.join(vendor, to);
  fs.copyFileSync(src, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`vendor/${to}  (${kb} KB)`);
}

console.log("ffmpeg.wasm copiado para static/vendor/");
