# YouTube Downloader (Node.js)

A Node.js application to download YouTube videos with selectable video and audio quality.

## Prerequisites

- Node.js (v12 or higher)
- FFmpeg (must be installed and available in system PATH)
- npm (Node Package Manager)

## Installation

1. Clone or download this repository
2. Navigate to the project directory
3. Install dependencies:

```bash
npm install
```

## Usage

Run the application:

```bash
npm start
```

The application will:

1. Prompt you for a YouTube URL
2. Show available video qualities
3. Show available audio qualities
4. Let you select desired video and audio quality
5. Download and merge the video and audio tracks
6. Save the final video in your Downloads/YouTube folder

## Features

- Download YouTube videos in various qualities
- Separate video and audio quality selection
- Progress bars with download speed and ETA
- Automatic cleanup of temporary files
- User-friendly CLI interface
- Downloads saved to Downloads/YouTube folder by default
