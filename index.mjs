#!/usr/bin/env node
import { pdf } from "pdf-to-img";
import Ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { parseFile } from "music-metadata";
import { Command } from "commander";
import { createHash } from "crypto";
import { writeFile, mkdir, stat, readdir, rm } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";

async function getCacheDir(pdfPath) {
  const absolutePath = resolve(pdfPath);
  const hash = createHash("md5")
    .update(absolutePath)
    .digest("hex")
    .slice(0, 12);
  const name = basename(pdfPath, ".pdf");
  const cacheDir = join(tmpdir(), "pdf-to-mp4", `${name}-${hash}`);
  await mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

async function getCachedPages(pdfPath, cacheDir) {
  try {
    const pdfStat = await stat(pdfPath);
    const files = await readdir(cacheDir);
    const pngFiles = files
      .filter((f) => f.endsWith(".png"))
      .sort((a, b) => parseInt(a) - parseInt(b));

    if (pngFiles.length === 0) return null;

    const firstImageStat = await stat(join(cacheDir, pngFiles[0]));
    if (firstImageStat.mtimeMs > pdfStat.mtimeMs) {
      console.log("Using cached images");
      return pngFiles.map((f) => join(cacheDir, f));
    }
  } catch {
    // Cache doesn't exist or is invalid
  }
  return null;
}

async function cachePages(cacheDir, pages) {
  const paths = [];
  for (let i = 0; i < pages.length; i++) {
    const path = join(cacheDir, `${i}.png`);
    await writeFile(path, pages[i]);
    paths.push(path);
  }
  return paths;
}

async function findAudioFile(audioDir, pageIndex) {
  if (!audioDir) return null;

  const extensions = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];
  const pageNum = pageIndex + 1;

  for (const ext of extensions) {
    const filePath = join(audioDir, `${pageNum}${ext}`);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

async function getAudioDuration(audioPath) {
  try {
    const metadata = await parseFile(audioPath);
    return metadata.format.duration || 0;
  } catch {
    return 0;
  }
}

async function pdfToMp4(
  pdfPath,
  outputPath,
  { width, height, frameRate, audioDir }
) {
  const cacheDir = await getCacheDir(pdfPath);
  let pagePaths = await getCachedPages(pdfPath, cacheDir);

  if (!pagePaths) {
    const doc = await pdf(pdfPath, { scale: 2 });
    console.log(`Total pages: ${doc.length}`);

    const pages = [];
    let pageNum = 0;
    for await (const page of doc) {
      pages.push(page);
      console.log(`Converted page ${++pageNum}`);
    }

    pagePaths = await cachePages(cacheDir, pages);
    console.log("Cached images for future use");
  }

  console.log(`Video: ${width}x${height} @ ${frameRate}fps`);

  const interval = 1; // 1 second interval between pages

  // Prepare audio info for each page
  const pageAudioInfo = [];
  for (let i = 0; i < pagePaths.length; i++) {
    const audioPath = await findAudioFile(audioDir, i);
    if (audioPath) {
      const duration = await getAudioDuration(audioPath);
      pageAudioInfo.push({ audioPath, duration });
      console.log(`Page ${i + 1}: audio found (${duration.toFixed(1)}s)`);
    } else {
      pageAudioInfo.push({ audioPath: null, duration: 1 });
      if (audioDir) {
        console.warn(`Warning: No audio file found for page ${i + 1}`);
      }
    }
  }

  // Create resized frames in temp directory
  const tempDir = join(cacheDir, "frames");
  await mkdir(tempDir, { recursive: true });

  // Create concat file for ffmpeg
  let concatContent = "";

  for (let i = 0; i < pagePaths.length; i++) {
    const framePath = join(tempDir, `frame_${String(i).padStart(4, "0")}.png`);

    // Resize image
    await sharp(pagePaths[i])
      .resize(width, height, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .toFile(framePath);

    const duration =
      pageAudioInfo[i].duration + (i < pagePaths.length - 1 ? interval : 0);
    const frameFileName = `frame_${String(i).padStart(4, "0")}.png`;
    concatContent += `file '${frameFileName}'\n`;
    concatContent += `duration ${duration}\n`;
  }

  // Add last frame again (ffmpeg concat demuxer requirement)
  const lastFrameFileName = `frame_${String(pagePaths.length - 1).padStart(
    4,
    "0"
  )}.png`;
  concatContent += `file '${lastFrameFileName}'\n`;

  const concatFile = join(tempDir, "concat.txt");
  await writeFile(concatFile, concatContent);

  // Use absolute path for output
  const absoluteOutputPath = join(process.cwd(), outputPath);

  // Calculate total duration for progress display
  const totalDuration = pageAudioInfo.reduce(
    (sum, info, i) => sum + info.duration + (i < pageAudioInfo.length - 1 ? interval : 0),
    0
  );

  console.log(`Encoding with ffmpeg... (${totalDuration.toFixed(1)}s)`);

  // Build ffmpeg command with fluent-ffmpeg
  const hasAudio = pageAudioInfo.some((p) => p.audioPath);

  await new Promise((resolve, reject) => {
    let command = Ffmpeg()
      .input(concatFile)
      .inputFormat("concat")
      .inputOptions(["-safe", "0"]);

    // Add audio inputs and build filter
    if (hasAudio) {
      const audioInputs = [];
      let currentTime = 0;

      for (let i = 0; i < pageAudioInfo.length; i++) {
        const info = pageAudioInfo[i];
        const pageDuration =
          info.duration + (i < pageAudioInfo.length - 1 ? interval : 0);

        if (info.audioPath) {
          const absoluteAudioPath = join(process.cwd(), info.audioPath);
          command = command.input(absoluteAudioPath);
          audioInputs.push({
            index: audioInputs.length + 1,
            delay: currentTime * 1000,
          });
        }

        currentTime += pageDuration;
      }

      if (audioInputs.length > 0) {
        const delayFilters = audioInputs
          .map(
            (input, idx) =>
              `[${input.index}:a]adelay=${Math.round(input.delay)}|${Math.round(
                input.delay
              )}[a${idx}]`
          )
          .join(";");

        const mixInputs = audioInputs.map((_, idx) => `[a${idx}]`).join("");
        const filterComplex = `${delayFilters};${mixInputs}amix=inputs=${audioInputs.length}:duration=longest,highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;

        command = command
          .complexFilter(filterComplex)
          .outputOptions(["-map", "0:v", "-map", "[aout]"])
          .audioCodec("aac")
          .audioBitrate("128k");
      }
    }

    command
      .videoCodec("libx264")
      .outputOptions(["-pix_fmt", "yuv420p"])
      .fps(frameRate)
      .on("progress", (progress) => {
        if (progress.frames) {
          const totalFrames = Math.ceil(totalDuration * frameRate);
          const percent = Math.min(100, (progress.frames / totalFrames) * 100);
          process.stdout.write(`\rEncoding: ${percent.toFixed(1)}%`);
        }
      })
      .on("end", () => {
        process.stdout.write(`\rEncoding: 100.0%\n`);
        console.log("Encoding complete");
        resolve();
      })
      .on("error", (err) => {
        reject(err);
      })
      .save(absoluteOutputPath);
  });

  // Cleanup temp frames
  await rm(tempDir, { recursive: true });

  console.log(`Video saved: ${outputPath}`);
}

const program = new Command();

program
  .name("pdf-to-mp4")
  .description("Convert PDF to MP4 video with optional audio")
  .argument("<pdf>", "Input PDF file")
  .argument("[output]", "Output MP4 file")
  .option("-w, --width <number>", "Video width", "1920")
  .option("-h, --height <number>", "Video height", "1080")
  .option("-f, --framerate <number>", "Frame rate", "30")
  .option(
    "-a, --audio-dir <path>",
    "Directory with audio files (default: <input>-audio/)"
  )
  .action(async (pdfFile, outputFile, options) => {
    const pdfPath = pdfFile;
    const outputPath =
      outputFile || join(dirname(pdfPath), basename(pdfPath, ".pdf") + ".mp4");
    const defaultAudioDir = join(
      dirname(pdfPath),
      basename(pdfPath, ".pdf") + "-audio"
    );
    const audioDir =
      options.audioDir ??
      (existsSync(defaultAudioDir) ? defaultAudioDir : null);

    try {
      await pdfToMp4(pdfPath, outputPath, {
        width: parseInt(options.width, 10),
        height: parseInt(options.height, 10),
        frameRate: parseFloat(options.framerate),
        audioDir,
      });
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(1);
    }
  });

program.parse();
