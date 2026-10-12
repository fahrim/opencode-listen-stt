# opencode-listen-stt

Offline voice dictation for [OpenCode](https://opencode.ai) **V2** on Windows. Press a key, talk, and the text lands in your prompt.

- **99 languages.** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with `large-v3-turbo`.
- **GPU accelerated.** CUDA on NVIDIA, Vulkan on AMD and Intel Arc. Detected automatically — you do not pick a backend.
- **Fully offline.** No cloud, no API key, no account.
- **Turkish works properly.** See [the note below](#the-turkish-problem) — this is the reason this plugin exists.

> Not affiliated with the OpenCode team. Independent community plugin.

## Voice output

This plugin only listens. To hear answers read aloud — Microsoft Edge neural
voices, free, no API key, Turkish included — see
[opencode-speak-tts](https://github.com/fahrim/opencode-speak-tts). The two are
independent; either one works without the other.

## Why not `opencode-voice`?

Two reasons, both structural rather than fixable by configuration:

1. **It is a V1 plugin.** OpenCode 2.x rejects V1 TUI modules with `Invalid V2 TUI plugin module`, and V1's `client.tui.appendPrompt()` has no V2 equivalent.
2. **Its STT model cannot do Turkish.** It ships NVIDIA Parakeet, which supports 25 languages — Russian and German are among them, Turkish is not. Feeding it a Turkish recording produces `Merhaba Bubir Dikte Denemissidr. Lutvan Bujum Ned Orias.` Whisper transcribes the same audio as `Merhaba, bu bir dikte denemesidir. Lütfen bu cümleyi doğru yaz.`

### The Turkish problem

Two separate traps, and only fixing one is not enough:

- Parakeet does not know Turkish, so it guesses from a neighbouring phonology. No setting changes this — the model is the limit.
- Whisper *does* know Turkish, but with no language hint it auto-detects, reads a Turkish recording as **English**, and returns Latin-script nonsense. Passing `language` explicitly fixes it, and also roughly halves transcription time.

This plugin always sends the language. `/voice-language` changes it.

## Requirements

- **Windows 10/11**
- **OpenCode V2** (`opencode --version` → 2.x)
- **[ffmpeg](https://ffmpeg.org/download.html)** on `PATH` — `winget install Gyan.FFmpeg`
- A ggml model (the installer fetches one, ~547 MB)

## Install

```powershell
git clone https://github.com/fahrim/opencode-listen-stt "$env:TEMP\opencode-listen-stt"
pwsh -NoProfile -File "$env:TEMP\opencode-listen-stt\install.ps1"
```

The installer detects your GPU and points at the right whisper.cpp build.

**On AMD or Intel, one extra step:** upstream publishes no Vulkan build for Windows, so the installer tells you where to get one:

```powershell
# from https://github.com/fahrim/whisper-vulkan-win
# extract into %LOCALAPPDATA%\opencode-listen-stt\runtime
```

Then re-run the installer.

Restart OpenCode and check that it loaded:

```powershell
opencode api get /api/plugin   # look for opencode-listen-stt, status "active"
```

Press your hotkey. If no microphone has been chosen yet it asks on the first
press, so there is nothing to configure before you start — `/voice-mic` is only
there for changing it later.

## Usage

| Command | What it does |
| --- | --- |
| `/voice-record` | Start or stop dictation (also your configured hotkey) |
| `/voice-submit` | Start, then dictate and add in one step |
| `/voice-cancel` | Discard the current recording |
| `/voice-mic` | Choose the microphone |
| `/voice-language` | Choose the dictation language |
| `/voice-hotkey` | Change the recording shortcut |
| `/voice-status` | Show backend, language and device |

All commands are in the palette (`ctrl+p`) under **Voice**.

Transcribed text is inserted into the composer for you to review before sending.

## Performance

Measured on an **AMD Radeon RX 7700 XT**, `large-v3-turbo-q5_0`, a 5-second Turkish clip:

| Backend | First transcription | Warm |
| --- | ---: | ---: |
| CPU (12 threads) | 11.1s | ~11s |
| Vulkan | 2.1s | **0.20s** |

Whisper is CPU-only upstream on Windows, so the Vulkan build comes from [whisper-vulkan-win](https://github.com/fahrim/whisper-vulkan-win).

## Configuration

`~/.config/opencode/opencode-listen-stt.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `language` | `tr` | Spoken language passed to whisper. The installer writes `tr`. With no config file at all it falls back to `auto`, which is slower and mis-reads Turkish as English. |
| `backend` | `auto` | `auto`, `cuda`, `vulkan` or `cpu` |
| `model` | installer download | Full path to a ggml model file. The installer writes it; delete the key and the plugin still finds the model in `models/`. |
| `runtime` | detected | whisper.cpp folder |
| `ffmpeg` | `ffmpeg` | ffmpeg executable, if it is not on `PATH` |
| `port` | `8801` | Local server port |
| `threads` | `0` | `0` means auto |
| `sampleRate` | `16000` | Capture sample rate, in Hz |
| `idleMinutes` | `10` | Model unload delay after the last recording |
| `maxSeconds` | `300` | Hard cap per recording |
| `hotkey` | `ctrl+y` | Recording shortcut |
| `mic` | `""` | Microphone device name; empty means ask on first use |

Unknown or wrongly-typed values are ignored rather than fatal, so a typo cannot stop the plugin loading.

## Languages

The engine supports 99. `/voice-language` offers the common ones; any whisper.cpp code (`tr`, `en`, `de`, `fr`, `es`, `ru`, `ja`, …) works if you set it in the config file.

## Troubleshooting

- **No devices listed** — check `ffmpeg -list_devices true -f dshow -i dummy`, and Windows *Settings → Privacy → Microphone*.
- **Transcription is in the wrong language** — `/voice-language`, or set `language` in the config. Auto-detection reads Turkish as English.
- **Slow** — `/voice-status` shows the backend. If it says `CPU` on an AMD or Intel GPU, the Vulkan runtime is missing or in the wrong folder.
- **Diagnostics** — `%LOCALAPPDATA%\opencode-listen-stt\listen-stt.log`.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT