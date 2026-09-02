"use strict";

/**
 * Create small synthetic test media so the real ffmpeg pipeline can be
 * validated without any user file: a short looping video with a visible color
 * that changes every few seconds, and an audio file with a clear tone.
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const { ffmpegPath, getMediaInfo } = require("../lib/media");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function createVideo(outPath, { duration, width = 640, height = 360 } = {}) {
  const color = duration >= 50 ? "blue" : "purple";
  const filters = [
    `color=c=${color}:s=${width}x${height}:r=30:d=${duration}`,
    `drawtext=text='LoopSync ${duration}s':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
    `fps=30`,
  ].join(",");
  await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", filters, "-c:v", "libx264", "-pix_fmt", "yuv420p", outPath]);
}

async function createAudio(outPath, { duration }) {
  await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-ac", "2", "-c:a", "aac", outPath]);
}

async function createTestAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });

  const tasks = [
    createVideo(path.join(dir, "video-05.mp4"), { duration: 5, width: 320, height: 240 }),
    createVideo(path.join(dir, "video-15.mp4"), { duration: 15, width: 320, height: 180 }),
    createVideo(path.join(dir, "video-30.mp4"), { duration: 30, width: 320, height: 180 }),
    createVideo(path.join(dir, "video-60.mp4"), { duration: 60, width: 320, height: 180 }),
    createAudio(path.join(dir, "audio-20.m4a"), { duration: 20 }),
    createAudio(path.join(dir, "audio-30.m4a"), { duration: 30 }),
    createAudio(path.join(dir, "audio-120.m4a"), { duration: 120 }),
    createAudio(path.join(dir, "audio-135.m4a"), { duration: 135 }),
  ];

  for (const t of tasks) await t;
  return dir;
}

async function main() {
  const dir = process.argv[2] || path.join(process.cwd(), "tmp-test-assets");
  await createTestAssets(dir);

  const files = [
    "video-05.mp4", "video-15.mp4", "video-30.mp4", "video-60.mp4",
    "audio-20.m4a", "audio-30.m4a", "audio-120.m4a", "audio-135.m4a",
  ];

  for (const file of files) {
    const info = getMediaInfo(path.join(dir, file));
    console.log(`${file}: duration=${info.duration.toFixed(3)}s hasVideo=${info.hasVideo} hasAudio=${info.hasAudio}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createVideo, createAudio, createTestAssets };
