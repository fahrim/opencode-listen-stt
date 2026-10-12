# opencode-listen-stt

Offline voice dictation for [OpenCode](https://opencode.ai) **V2** on Windows. Press a key, talk, and the text lands in your prompt.

- **99 languages.** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with `large-v3-turbo` — the model's full range, not a curated subset.
- **The right language, first try.** The spoken language is pinned rather than guessed: more accurate, and roughly twice as fast.
- **GPU accelerated.** CUDA on NVIDIA, Vulkan on AMD and Intel Arc. Detected automatically — you do not pick a backend.
- **Fully offline.** No cloud, no API key, no account. Audio never leaves your machine.

> Not affiliated with the OpenCode team. Independent community plugin.

## Voice output

This plugin only listens. To hear answers read aloud — Microsoft Edge neural
voices, free, no API key, any language Edge supports — see
[opencode-speak-tts](https://github.com/fahrim/opencode-speak-tts). The two are
independent; either one works without the other.

## Why this exists

Dictation plugins for OpenCode tend to arrive in one of two shapes. Either they
target the older plugin API and do not load on OpenCode 2.x at all, or they ship
a single specialised model covering roughly two dozen languages, which rules out
everything outside that set. Neither is a mistake — they are limits of the
approach, and neither is fixable from a settings file.

whisper.cpp covers 99 languages and runs on the GPU you already have. This
plugin is built around that: nothing curated, and no setting left to chance.

## The language problem

Speech models have a quality cliff. A model can be excellent at some languages
and unusable at others — and when it meets one it does not know, it does not say
so. It returns confident, plausible, wrong text.

There are two separate causes, and they need different answers:

- **The model does not cover the language at all.** No setting helps. The model
  is the limit, and the fix is a different model.
- **The model covers it, but nothing told it which one to use.** Whisper reads a
  Turkish recording as English when left to auto-detect. Naming the language
  fixes it, and roughly halves the transcription time as well, because the model
  stops testing hypotheses.

The second is the quieter failure. A model with no coverage announces itself; a
mis-detected one looks like the model is simply bad at your language, which
sends people looking for a bigger download instead of a setting.

Turkish is where this is easiest to show, because the failure has a distinctive
shape. The same recording, three ways:

| | What comes back |
| --- | --- |
| A model with no coverage of the language | `Merhaba Bubir Dikte Denemissidr. Lutvan Bujum Ned Orias.` |
| Whisper, language left to auto-detect | Read as English, returned as Latin-script noise |
| Whisper, language set to `tr` | `Merhaba, bu bir dikte denemesidir. Lütfen bu cümleyi doğru yaz.` |

So this plugin always sends the language. The installer writes `tr`; set any
other with `/voice-language`. That is the whole of it.

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

The installer does the whole job: it detects your GPU, installs the plugin,
fetches the whisper.cpp runtime, downloads the model, and writes your settings
file. Run it again at any time to repair an install.

**On AMD or Intel, one extra step:** upstream publishes no Vulkan build for Windows, so the installer tells you where to get one:

```powershell
# from https://github.com/fahrim/whisper-vulkan-win
# extract into %LOCALAPPDATA%\opencode-listen-stt\runtime
```

Then re-run the installer.

Restart OpenCode and check that it loaded:

```powershell
opencode plugin list    # opencode-listen-stt, showing a local path
```

Press your hotkey. If no microphone has been chosen yet it asks on the first
press, so there is nothing to configure before you start — `/voice-mic` is only
there for changing it later.

### Already run whisper.cpp?

If you have a whisper.cpp runtime and a model already, skip the installer and
take the plugin from OpenCode:

```powershell
opencode plugin add github:fahrim/opencode-listen-stt
```

Point `runtime` and `model` at what you have in `opencode-listen-stt.json`.
`opencode plugin check` and `opencode plugin update` keep it current.

Do not do both. The installer puts the plugin in `~/.config/opencode/plugins/`,
and a local folder and a package of the same name are loaded separately — every
command would end up registered twice.

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
| `language` | `tr` | Spoken language passed to whisper. The installer writes `tr`; with no config file at all it falls back to `auto`, which is slower and guesses. |
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

whisper.cpp recognises 99. `/voice-language` lists the common ones under their
English names; anything else takes its whisper code — `tr`, `en`, `de`, `fr`,
`es`, `ru`, `uk`, `pl`, `ar`, `hi` and the rest — in the config file.

`auto` is available, and it is the slowest and least reliable of the choices,
because it is a guess. [The language problem](#the-language-problem) above is
what a wrong guess looks like.

## Troubleshooting

- **No devices listed** — check `ffmpeg -list_devices true -f dshow -i dummy`, and Windows *Settings → Privacy → Microphone*.
- **Transcription is in the wrong language** — `/voice-language`, or set `language` in the config. If it is already pinned, the audio may simply not be in that language.
- **Slow** — `/voice-status` shows the backend. If it says `CPU` on an AMD or Intel GPU, the Vulkan runtime is missing or in the wrong folder.
- **The result is plausible but wrong** — that is a mis-detected language, not a bad recording. Pin it; see [the language problem](#the-language-problem).
- **Diagnostics** — `%LOCALAPPDATA%\opencode-listen-stt\listen-stt.log`.

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT — see [LICENSE](LICENSE).

This plugin drives [whisper.cpp](https://github.com/ggml-org/whisper.cpp), which
is MIT-licensed and is not redistributed here — it is downloaded at install
time. ggml models carry their own licences; check the model card.