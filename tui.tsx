/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { configFromOptions, LANGUAGES, type Voice99Config } from "./lib/config.ts";
import { WhisperServer } from "./lib/server.ts";
import { listDevices, pcmToWav, startRecording, type RecorderHandle } from "./lib/recorder.ts";

const ID = "opencode-voice-99";

interface Settings {
  language: string;
  mic: string;
  hotkey: string;
  autoSend: boolean;
}

const DEFAULTS: Settings = {
  language: "",
  mic: "",
  hotkey: "ctrl+y",
  autoSend: false,
};

export default Plugin.define({
  id: ID,
  async setup(context) {
    const cfg: Voice99Config = configFromOptions({});
    const [settings, save] = context.storage.store<Settings>(ID, {
      initial: {
        ...DEFAULTS,
        language: cfg.language,
        mic: cfg.mic,
        hotkey: cfg.hotkey,
      },
    });
    const [state, setState] = context.storage.memory<{ recording: boolean; working: boolean }>(
      `${ID}.state`,
      { initial: { recording: false, working: false } },
    );

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant, duration: 3000 });

    const server = new WhisperServer(cfg);
    let recorder: RecorderHandle | null = null;

    const busy = () => state.recording || state.working;

    /**
     * Asks for a microphone when none is chosen.
     *
     * Recording without a device cannot work, and making the user discover
     * /voice-mic first is a dead end for anyone who just hit the hotkey. This
     * returns the chosen device, or undefined when the dialog is dismissed.
     */
    const chooseMicrophone = async (): Promise<string | undefined> => {
      const devices = await listDevices(cfg.ffmpeg);
      if (devices.length === 0) {
        toast(
          "No input devices found. Install ffmpeg with DirectShow support, and check Windows Privacy → Microphone.",
          "warning",
        );
        return undefined;
      }
      const picked = await context.ui.dialog.select({
        title: "Select microphone",
        options: devices.map((d) => ({ title: d.label, value: d.name })),
        search: (query, options) =>
          options.filter((o) => o.title.toLowerCase().includes(query.toLowerCase())),
      });
      if (!picked) return undefined;
      await save((d) => {
        d.mic = picked;
      });
      toast(`Mic: ${picked}`);
      return picked;
    };

    const start = async () => {
      if (busy()) {
        toast("Busy, please wait…", "warning");
        return;
      }
      // No device yet? Open the picker instead of refusing to record.
      const mic = settings.mic || (await chooseMicrophone());
      if (!mic) return;
      try {
        recorder = startRecording({
          ffmpeg: cfg.ffmpeg,
          mic,
          sampleRate: cfg.sampleRate,
          maxSeconds: cfg.maxSeconds,
          output: "",
        });
        setState((d) => {
          d.recording = true;
        });
        toast(`Recording… press ${settings.hotkey} again to stop`);
      } catch (err) {
        toast(`Cannot start recording: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    };

    const stopAndTranscribe = async (submit: boolean) => {
      if (!recorder) {
        toast("Not recording", "warning");
        return;
      }
      setState((d) => {
        d.recording = false;
        d.working = true;
      });

      const pcm = await recorder.stop();
      recorder = null;

      if (pcm.length < 3200) {
        toast("Nothing was recorded", "warning");
        setState((d) => {
          d.working = false;
        });
        return;
      }

      try {
        toast("Transcribing…");
        // Warm the server while the user is still releasing the key.
        await server.ensure((m) => toast(m));
        const wav = pcmToWav(pcm, cfg.sampleRate);
        const text = await server.transcribe(wav);
        if (!text) {
          toast("No speech detected", "warning");
          return;
        }

        await insertIntoComposer(context, text);
        if (submit) {
          // V2 exposes no submit API to plugins (`client.tui.submitPrompt` was
          // V1-only), so the text lands in the composer for the user to send.
          toast("Added to prompt — press Enter to send");
        } else {
          toast("Added to prompt", "success");
        }
      } catch (err) {
        toast(`STT failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        setState((d) => {
          d.working = false;
        });
      }
    };

    /**
     * Puts text into the focused composer.
     *
     * V2 has no composer API for plugins, so this reaches for the focused
     * editor the renderer exposes. When that is unavailable the text is not
     * dropped silently — it goes to the clipboard and the user is told.
     */
    const insertIntoComposer = async (
      ctx: typeof context,
      text: string,
    ): Promise<void> => {
      const editor = (ctx.renderer as unknown as {
        currentFocusedEditor?: { insertText?: (t: string) => void };
      }).currentFocusedEditor;
      if (editor?.insertText) {
        editor.insertText(`${text} `);
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast("Composer not focused — text copied to clipboard", "warning");
      } catch {
        toast("Could not reach the composer. See voice-99.log", "error");
      }
    };

    const toggle = async (): Promise<void> => {
      if (state.recording) await stopAndTranscribe(false);
      else await start();
    };

    const backend = server.backend;

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: `${ID}.record`,
          title: "Record / transcribe",
          description: "Start or stop dictation",
          group: "Voice",
          palette: true,
          slash: { name: "voice-record" },
          suggested: true,
          // Without this the command exists in the palette but no key reaches
          // it, which is why the hotkey appeared to do nothing.
          bind: settings.hotkey,
          run: toggle,
        },
        {
          id: `${ID}.submit`,
          title: "Record and send",
          description: "Dictate, transcribe and submit in one step",
          group: "Voice",
          palette: true,
          slash: { name: "voice-submit" },
          run: async () => {
            if (state.recording) await stopAndTranscribe(true);
            else await start();
          },
        },
        {
          id: `${ID}.stop`,
          title: "Cancel recording",
          description: "Discard the current recording",
          group: "Voice",
          palette: true,
          slash: { name: "voice-cancel" },
          enabled: () => state.recording,
          run: () => {
            recorder?.stop();
            recorder = null;
            setState((d) => {
              d.recording = false;
            });
            toast("Cancelled");
          },
        },
        {
          id: `${ID}.mic`,
          title: "Choose microphone",
          description: "Pick the audio input device",
          group: "Voice",
          palette: true,
          slash: { name: "voice-mic" },
          run: async () => {
            await chooseMicrophone();
          },
        },
        {
          id: `${ID}.language`,
          title: "Dictation language",
          description: "Spoken language hint passed to whisper",
          group: "Voice",
          palette: true,
          slash: { name: "voice-language" },
          run: async () => {
            const picked = await context.ui.dialog.select({
              title: "Dictation language",
              options: Object.entries(LANGUAGES).map(([value, label]) => ({ title: label, value })),
              search: (query, options) =>
                options.filter((o) => o.title.toLowerCase().includes(query.toLowerCase())),
            });
            if (!picked) return;
            await save((d) => {
              d.language = picked;
            });
            cfg.language = picked;
            toast(`Language: ${picked}`);
          },
        },
        {
          id: `${ID}.status`,
          title: "Voice status",
          description: "Show backend, model, language and device",
          group: "Voice",
          palette: true,
          slash: { name: "voice-status" },
          run: () => {
            const lang = settings.language || cfg.language;
            toast(
              `${backend.backend.toUpperCase()} · ${backend.detail} · lang=${lang} · mic=${
                settings.mic || "unset"
              }`,
            );
          },
        },
      ],
    }));

    // `bind` is assigned from settings so the user can change the key without
    // editing OpenCode's own keybinds.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 11,
      commands: [
        { id: `${ID}.hotkey`, title: "Dictation hotkey", group: "Voice", palette: true, slash: { name: "voice-hotkey" },
          run: async () => {
            const picked = await context.ui.dialog.select({
              title: "Dictation hotkey",
              options: ["ctrl+y", "ctrl+shift+y", "ctrl+alt+y", "alt+y", "f9"].map((k) => ({ title: k, value: k })),
            });
            if (!picked) return;
            await save((d) => {
              d.hotkey = picked;
            });
            toast(`Hotkey: ${picked}`);
          },
        },
      ],
    }));

    return () => {
      recorder?.stop();
      recorder = null;
      void server.dispose();
    };
  },
});