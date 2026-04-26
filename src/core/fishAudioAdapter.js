import { readFile, writeFile } from "node:fs/promises";

const FISH_TTS_AUDIO = {
  format: "mp3",
  sample_rate: 32000,
  mp3_bitrate: 64,
  latency: "balanced",
  chunk_length: 100,
  normalize: true,
};

export class FishAudioAdapter {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }

  async transcribe(filePath) {
    const settings = this.getSettings();
    if (!settings.fishApiKey) return "";

    const { FishAudioClient } = await import("fish-audio");
    const client = new FishAudioClient({ apiKey: settings.fishApiKey });
    const audio = await readFile(filePath);
    const result = await client.speechToText.convert({
      audio: new File([audio], "aibi-audio.bin", { type: "application/octet-stream" }),
      language: settings.language || "en",
      ignore_timestamps: true,
    });
    return result?.text || "";
  }

  async synthesizeToFile({ text, filePath }) {
    const buffer = await this.synthesizeToBuffer({ text });
    if (!buffer) return null;
    await writeFile(filePath, buffer);
    return buffer;
  }

  async synthesizeToBuffer({ text }) {
    const stream = await this.synthesizeToStream({ text });
    if (!stream) return null;
    return Buffer.from(await new Response(stream).arrayBuffer());
  }

  async synthesizeToStream({ text }) {
    const settings = this.getSettings();
    if (!settings.fishApiKey) return null;
    const { FishAudioClient } = await import("fish-audio");
    const client = new FishAudioClient({ apiKey: settings.fishApiKey });
    const request = {
      text,
      ...FISH_TTS_AUDIO,
    };
    if (settings.fishVoiceId) request.reference_id = settings.fishVoiceId;
    return client.textToSpeech.convert(request, settings.fishModel);
  }
}
