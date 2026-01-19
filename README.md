# pdf-to-mp4

Convert PDF files to MP4 videos with optional per-page audio narration.

## Features

- Convert each PDF page to a video frame
- Optional audio narration for each page
- Automatic page duration based on audio length
- Audio noise reduction (RNNoise) and loudness normalization
- Image caching for faster re-encoding
- Customizable resolution and frame rate

## Requirements

- Node.js 18+
- FFmpeg installed and available in PATH

## Usage

```bash
npx github:tnayuki/pdf-to-mp4 <pdf> [output] [options]
```

### Arguments

- `<pdf>` - Input PDF file (required)
- `[output]` - Output MP4 file (default: `<input>.mp4`)

### Options

- `-w, --width <number>` - Video width (default: 1920)
- `-h, --height <number>` - Video height (default: 1080)
- `-f, --framerate <number>` - Frame rate (default: 30)
- `-a, --audio-dir <path>` - Directory with audio files (default: `<input>-audio/`)

### Examples

Basic conversion:

```bash
npx github:tnayuki/pdf-to-mp4 presentation.pdf
```

With custom resolution:

```bash
npx github:tnayuki/pdf-to-mp4 presentation.pdf -w 1280 -h 720
```

With explicit audio directory:

```bash
npx github:tnayuki/pdf-to-mp4 presentation.pdf -a ./narration/
```

## Audio Files

Place audio files in a directory named `<pdf-name>-audio/` (e.g., `presentation-audio/` for `presentation.pdf`).

Audio files should be named by page number:

```
presentation-audio/
  1.mp3
  2.mp3
  3.wav
  ...
```

Supported formats: `.mp3`, `.wav`, `.m4a`, `.aac`, `.ogg`

Each page will display for the duration of its audio file plus a 1-second interval before the next page. Pages without audio will display for 1 second.

## Credits

Audio noise reduction uses the [somnolent-hogwash](https://github.com/GregorR/rnnoise-models) RNNoise model.

## License

MIT
