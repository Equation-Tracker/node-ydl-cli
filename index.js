const ytdl = require("ytdl-core");
const ffmpeg = require("fluent-ffmpeg");
const chalk = require("chalk");
const cliProgress = require("cli-progress");
const inquirer = require("inquirer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const os = require("os");
const VIDEO_ITAGS = {
  299: "1080p60 (mp4/avc1)", 298: "720p60 (mp4/avc1)", 137: "1080p (mp4/avc1)", 136: "720p (mp4/avc1)",
  135: "480p (mp4/avc1)", 134: "360p (mp4/avc1)", 133: "240p (mp4/avc1)", 160: "144p (mp4/avc1)",
  303: "1080p60 (webm/vp9)", 302: "720p60 (webm/vp9)", 271: "1440p (webm/vp9)", 313: "2160p (webm/vp9)",
  248: "1080p (webm/vp9)", 247: "720p (webm/vp9)", 244: "480p (webm/vp9)", 243: "360p (webm/vp9)",
  242: "240p (webm/vp9)", 278: "144p (webm/vp9)",
};
const AUDIO_ITAGS = { 141: "256kbps (m4a/mp4a)", 251: "160kbps (webm/opus)", 140: "128kbps (m4a/mp4a)", 250: "70kbps (webm/opus)" };
const MP3_BITRATES = { "320k": "320 kbps", "256k": "256 kbps", "192k": "192 kbps", "160k": "160 kbps", "128k": "128 kbps" };
const getDefaultOutputPath = () => path.join(os.homedir(), "Downloads", "YouTube");
function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)}${units[unitIndex]}`;
};
function formatTime(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ${Math.floor(seconds % 60)}s`;
  const hours = minutes / 60;
  return `${Math.floor(hours)}h ${Math.floor(minutes % 60)}m`;
};
function getBitrateChoices(sourceBitrate) {
  return Object.entries(MP3_BITRATES).map(([value, label]) => ({
    name: `${label}${parseInt(value) > sourceBitrate ? ' (will upscale)' : ''}`,
    value: value
  }));
}
class ProgressBar {
  constructor(total) {
    const formattedTotal = formatSize(total);
    this.bar = new cliProgress.SingleBar({
      format: ` Downloading: |${chalk.cyan("{bar}")}| {percentage}% | {downloaded} / ${formattedTotal} | {speed}/s | ETA: {eta}`,
      barCompleteChar: "█",
      barIncompleteChar: "-",
      hideCursor: true,
      clearOnComplete: true,
      stopOnComplete: true,
    }, cliProgress.Presets.shades_classic);
    this.total = total;
    this.current = 0;
    this.startTime = Date.now();
    this.lastUpdate = this.startTime;
    this.lastBytes = 0;
    this.bar.start(total, 0, {
      downloaded: "0B",
      total: formattedTotal,
      speed: "0B",
      eta: "calculating...",
    });
  }
  update(downloaded) {
    const now = Date.now();
    const timeDiff = (now - this.lastUpdate) / 1000;
    if (timeDiff >= 0.5) {
      const byteDiff = downloaded - this.lastBytes;
      const speed = byteDiff / timeDiff;
      const eta = (this.total - downloaded) / speed;
      this.bar.update(downloaded, {
        downloaded: formatSize(downloaded),
        speed: formatSize(speed),
        eta: formatTime(eta),
      });
      this.lastUpdate = now;
      this.lastBytes = downloaded;
    }
  }
  finish() {
    this.bar.update(this.total, {
      downloaded: formatSize(this.total),
      speed: "0B",
      eta: "0s"
    });
    this.bar.stop();
  }
}
async function getVideoInfo(url) {
  try {
    const info = await ytdl.getInfo(url);
    const availableVideoItags = {};
    const availableAudioItags = {};
    info.formats.forEach((format) => {
      if (format.hasVideo && !format.hasAudio && VIDEO_ITAGS[format.itag]) {
        availableVideoItags[format.itag] = VIDEO_ITAGS[format.itag];
      } else if (!format.hasVideo && format.hasAudio && AUDIO_ITAGS[format.itag]) {
        availableAudioItags[format.itag] = AUDIO_ITAGS[format.itag];
      }
    });
    const sortedVideoFormats = Object.entries(availableVideoItags).map(([itag, quality]) => ({
        itag: parseInt(itag),
        quality,
        resolution: parseInt(quality.match(/\d+/)[0])
      })).sort((a, b) => b.resolution - a.resolution);
    const sortedAudioFormats = Object.entries(availableAudioItags).map(([itag, quality]) => ({
        itag: parseInt(itag),
        quality,
        bitrate: parseInt(quality.match(/\d+/)[0])
      })).sort((a, b) => b.bitrate - a.bitrate);
    if (sortedVideoFormats.length === 0) {
      throw new Error("No compatible video formats found");
    }
    if (sortedAudioFormats.length === 0) {
      throw new Error("No compatible audio formats found");
    }
    return {
      title: info.videoDetails.title,
      formats: info.formats,
      availableVideoFormats: sortedVideoFormats,
      availableAudioFormats: sortedAudioFormats
    };
  } catch (error) {
    console.error(chalk.red("Failed to get video info:"), error.message);
    process.exit(1);
  }
}
function sanitizeFilename(filename) {
  return filename.replace(/[^a-z0-9\s-_.]/gi, "_");
}
async function downloadVideo(url, videoItag, audioItag, targetBitrate = null, outputPath = null) {
  let tempDir = path.join(os.tmpdir(), `yt_download_${uuidv4()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  let error = null;
  try {
    outputPath = outputPath || getDefaultOutputPath();
    fs.mkdirSync(outputPath, { recursive: true });
    const info = await getVideoInfo(url);
    console.log(`Downloading: ${info.title}`);
    const videoPath = path.join(tempDir, `${uuidv4()}.mp4`);
    const audioFormat = info.formats.find(f => f.itag === audioItag);
    const audioPath = path.join(tempDir, `${uuidv4()}.${audioFormat.container}`);
    const outputFile = path.join(outputPath, `${sanitizeFilename(info.title)}.mp4`);
    const sourceBitrate = parseInt(audioFormat.audioBitrate);
    const requestedBitrate = targetBitrate ? parseInt(targetBitrate) : sourceBitrate;
    const needsUpscaling = requestedBitrate > sourceBitrate;
    if (needsUpscaling) console.log(chalk.yellow(`\nNote: Will upscale audio from ${sourceBitrate}kbps to ${requestedBitrate}kbps`));
    console.log(`\nDownloading video...`);
    await new Promise((resolve, reject) => {
      const videoStream = ytdl(url, { quality: videoItag });
      const format = info.formats.find((f) => f.itag === videoItag);
      if (!format || !format.contentLength) {
        reject(new Error("Could not determine video size"));
        return;
      }
      const videoProgress = new ProgressBar(parseInt(format.contentLength));
      const fileStream = fs.createWriteStream(videoPath);
      videoStream.pipe(fileStream);
      videoStream.on("progress", (_, downloaded, total) => {
        videoProgress.update(downloaded);
      });
      fileStream.on("finish", () => {
        videoProgress.finish();
        resolve();
      });
      videoStream.on("error", (err) => {
        videoProgress.finish();
        reject(new Error(`Video download failed: ${err.message}`));
      });
    });
    console.log(`\nDownloading audio...`);
    await new Promise((resolve, reject) => {
      const audioStream = ytdl(url, { quality: audioItag });
      const format = info.formats.find((f) => f.itag === audioItag);
      if (!format || !format.contentLength) {
        reject(new Error("Could not determine audio size"));
        return;
      }
      const audioProgress = new ProgressBar(parseInt(format.contentLength));
      const fileStream = fs.createWriteStream(audioPath);
      audioStream.pipe(fileStream);
      audioStream.on("progress", (_, downloaded, total) => {
        audioProgress.update(downloaded);
      });
      fileStream.on("finish", () => {
        audioProgress.finish();
        resolve();
      });
      audioStream.on("error", (err) => {
        audioProgress.finish();
        reject(new Error(`Audio download failed: ${err.message}`));
      });
    });
    console.log("\nMerging video and audio...");
    await new Promise((resolve, reject) => {
      const command = ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions(["-c:v copy"]);
      if (needsUpscaling) {
        command
          .audioFrequency(48000)
          .audioBitrate(targetBitrate);
      } else {
        command.outputOptions(["-c:a copy"]);
      }
      command
        .output(outputFile)
        .on("start", (cmd) => {
          console.log(chalk.yellow("FFmpeg command:"), cmd);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            process.stdout.write(`\rMerging: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", () => {
          console.log(chalk.green("\nDownload complete:"), outputFile);
          resolve();
        })
        .on("error", (err) => {
          console.error(chalk.red("\nFFmpeg error:"), err.message);
          reject(err);
        })
        .run();
    });
    return outputFile;
  } catch (err) {
    error = err;
    console.error(chalk.red("\nAn error occurred:"), err.message);
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(chalk.yellow("Cleaned up temporary files"));
    }
    process.exit(error ? 1 : 0);
  }
}
async function downloadAudioOnly(url, audioItag = null, outputPath = null) {
  let tempDir = path.join(os.tmpdir(), `yt_download_${uuidv4()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  let error = null;
  try {
    outputPath = outputPath || getDefaultOutputPath();
    fs.mkdirSync(outputPath, { recursive: true });
    const info = await getVideoInfo(url);
    console.log(`Downloading: ${info.title}`);
    const bestAudio = info.availableAudioFormats[0];
    console.log(`\nFound best audio quality: ${bestAudio.quality}`);
    const audioPath = path.join(tempDir, `${uuidv4()}.${info.formats.find(f => f.itag === bestAudio.itag).container}`);
    const { targetBitrate } = await inquirer.prompt([{
      type: "list",
      name: "targetBitrate",
      message: "Select MP3 output quality:",
      choices: getBitrateChoices(bestAudio.bitrate)
    }]);
    const outputFile = path.join(outputPath, `${sanitizeFilename(info.title)}.mp3`);
    console.log(`\nDownloading audio...`);
    await new Promise((resolve, reject) => {
      const audioStream = ytdl(url, { quality: bestAudio.itag });
      const format = info.formats.find((f) => f.itag === bestAudio.itag);
      if (!format || !format.contentLength) {
        reject(new Error("Could not determine audio size"));
        return;
      }
      const audioProgress = new ProgressBar(parseInt(format.contentLength));
      const fileStream = fs.createWriteStream(audioPath);
      audioStream.pipe(fileStream);
      audioStream.on("progress", (_, downloaded, total) => {
        audioProgress.update(downloaded);
      });
      fileStream.on("finish", () => {
        audioProgress.finish();
        resolve();
      });
      audioStream.on("error", (err) => {
        audioProgress.finish();
        reject(new Error(`Audio download failed: ${err.message}`));
      });
    });
    console.log("\nConverting to MP3...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(audioPath)
        .toFormat("mp3")
        .audioBitrate(targetBitrate)
        .output(outputFile)
        .on("start", (cmd) => {
          console.log(chalk.yellow("FFmpeg command:"), cmd);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            process.stdout.write(`\rConverting: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", () => {
          console.log(chalk.green("\nDownload complete:"), outputFile);
          resolve();
        })
        .on("error", (err) => {
          console.error(chalk.red("\nFFmpeg error:"), err.message);
          reject(err);
        })
        .run();
    });
    return outputFile;
  } catch (err) {
    error = err;
    console.error(chalk.red("\nAn error occurred:"), err.message);
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(chalk.yellow("Cleaned up temporary files"));
    }
    process.exit(error ? 1 : 0);
  }
}
if (require.main === module) {
  inquirer.prompt([
    {
      type: "input",
      name: "url",
      message: "Enter YouTube URL:",
      validate: (input) => ytdl.validateURL(input) ? true : "Please enter a valid YouTube URL",
    },
    {
      type: "list",
      name: "type",
      message: "What would you like to download?",
      choices: [
        { name: "Video with Audio", value: "video" },
        { name: "Audio Only", value: "audio" }
      ]
    }
  ]).then(async (answers) => {
    if (answers.type === "audio") {
      downloadAudioOnly(answers.url);
    } else {
      const info = await getVideoInfo(answers.url);
      const { videoItag, audioItag } = await inquirer.prompt([
        {
          type: "list",
          name: "videoItag",
          message: "Select video quality:",
          choices: info.availableVideoFormats.map(format => ({
            name: format.quality,
            value: format.itag
          }))
        },
        {
          type: "list",
          name: "audioItag",
          message: "Select source audio quality:",
          choices: info.availableAudioFormats.map(format => ({
            name: format.quality,
            value: format.itag
          }))
        }
      ]);
      const audioFormat = info.formats.find(f => f.itag === audioItag);
      const sourceBitrate = parseInt(audioFormat.audioBitrate);
      const { targetBitrate } = await inquirer.prompt([
        {
          type: "list",
          name: "targetBitrate",
          message: "Select output audio quality:",
          choices: getBitrateChoices(sourceBitrate)
        }
      ]);
      downloadVideo(answers.url, videoItag, audioItag, targetBitrate);
    }
  }).catch((error) => {
    console.error(chalk.red("\nAn error occurred:"), error.message);
    process.exit(1);
  });
}
export { downloadAudioOnly, downloadVideo, ProgressBar, formatSize, getVideoInfo, formatTime };