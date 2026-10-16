// Kokoro TTS (io.github.kazeevn.kokorotts): Kokoro-82M on the device, reached
// through the Kokoro app's synthesis content provider (Android only) rather
// than the system TTS API. The system engine queue only synthesizes the next
// utterance once the one before has nearly finished playing, so a slow
// on-device model leaves a pause between sentences; here readest asks for
// sentences ahead and plays them through the buffered pipeline.
//
// The engine is a single on-device model that runs one sentence at a time, so
// the provider schedules it itself (a windowed provider, though every window
// is one sentence): a sentence playback is waiting on always goes first; then,
// while fewer than READY_AHEAD synthesized sentences wait to be played, the
// hinted ones in reading order, the current paragraph's before background
// preloads of later ones. A sentence nobody wants any more is dropped, and
// cancelled in the engine when it is being synthesized. Audio is 24 kHz 16-bit
// mono WAV, kept in memory only until played: nothing is cached.

import { invoke } from '@tauri-apps/api/core';
import type { TTSWordBoundary } from '@/libs/edgeTTS';
import type { TTSVoice } from '../types';
import {
  type PrefetchOptions,
  type SpeechProvider,
  SpeechSynthesisPermanentError,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
  type TTSLane,
} from './types';

export const KOKORO_PROVIDER_ID = 'kokoro';
const VOICE_PREFIX = 'kokoro:';
const SAMPLE_RATE = 24000;
const WAV_HEADER_BYTES = 44;
const TICKS_PER_SECOND = 10_000_000;
// Synthesized sentences that may wait to be played, beyond the one playback
// is waiting on (the player holds a couple more of its own).
const READY_AHEAD = 3;

// Kokoro voice ids spell accent and gender: af_heart = American female.
const ACCENTS: Record<string, { lang: string; label: string }> = {
  a: { lang: 'en-US', label: 'American' },
  b: { lang: 'en-GB', label: 'British' },
};

export const kokoroVoice = (id: string): TTSVoice | null => {
  const accent = ACCENTS[id[0] ?? ''];
  const gender = id[1] === 'f' ? 'female' : id[1] === 'm' ? 'male' : '';
  const name = id.slice(3);
  if (!accent || !gender || !name) return null;
  return {
    id: VOICE_PREFIX + id,
    name: `${name[0]!.toUpperCase()}${name.slice(1)} (${accent.label} ${gender})`,
    lang: accent.lang,
  };
};

// Word starts (sample, char start, char end) to Edge-shaped boundaries.
export const kokoroBoundaries = (
  text: string,
  words: number[][],
  totalSamples: number,
): TTSWordBoundary[] =>
  words.map(([sample, start, end], i) => {
    const next = words[i + 1]?.[0] ?? totalSamples;
    return {
      offset: Math.round((sample! / SAMPLE_RATE) * TICKS_PER_SECOND),
      duration: Math.round(((next - sample!) / SAMPLE_RATE) * TICKS_PER_SECOND),
      text: text.slice(start, end),
    };
  });

const decodeBase64 = (data: string): ArrayBuffer => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const abortError = () => new DOMException('Aborted', 'AbortError');

interface Entry {
  key: string;
  req: SpeechSynthesisRequest;
  // Reading order of hints; for due entries, the order they fell due.
  seq: number;
  due: boolean;
  background: boolean;
  // Signals of the callers still interested in this sentence.
  wanted: Set<AbortSignal>;
  state: 'queued' | 'running' | 'done';
  // The engine's request id while running.
  id?: string;
  delivered: Set<NonNullable<PrefetchOptions['onDelivered']>>;
  promise: Promise<SpeechSynthesisResult>;
  resolve: (result: SpeechSynthesisResult) => void;
  reject: (error: unknown) => void;
}

export class KokoroSpeechProvider implements SpeechProvider {
  readonly id = KOKORO_PROVIDER_ID;
  readonly label = 'Kokoro TTS';
  readonly sameLanguageVoicesOnly = true;
  readonly cacheable = false;

  #voices: Promise<TTSVoice[]> | null = null;
  // The voice chosen in the Kokoro app.
  #defaultVoice = '';
  #entries = new Map<string, Entry>();
  #seq = 0;
  #requestId = 0;
  #running = false;

  #loadVoices() {
    this.#voices ??= invoke<{ voices: string[]; defaultVoice: string }>(
      'plugin:native-tts|kokoro_voices',
    )
      .then(({ voices, defaultVoice }) => {
        this.#defaultVoice = VOICE_PREFIX + defaultVoice;
        return voices.map(kokoroVoice).filter((v): v is TTSVoice => !!v);
      })
      .catch((err) => {
        console.warn('Kokoro TTS unavailable', err);
        this.#voices = null;
        return [];
      });
    return this.#voices;
  }

  async init(): Promise<boolean> {
    return (await this.#loadVoices()).length > 0;
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return this.#loadVoices();
  }

  pickDefaultVoice(voices: TTSVoice[]): string | undefined {
    // The Kokoro app's own choice, when it speaks this language.
    return voices.find((v) => v.id === this.#defaultVoice)?.id ?? voices[0]?.id;
  }

  synthesize(req: SpeechSynthesisRequest, signal: AbortSignal): Promise<SpeechSynthesisResult> {
    if (!req.voice) {
      return Promise.reject(new SpeechSynthesisPermanentError('No Kokoro voice for this language'));
    }
    if (signal.aborted) return Promise.reject(abortError());
    const entry = this.#entry(req, false);
    if (!entry.due) {
      entry.due = true;
      entry.seq = ++this.#seq;
    }
    this.#want(entry, signal);
    this.#pump();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (result) => {
          signal.removeEventListener('abort', onAbort);
          // Played now: no longer held here.
          if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
          this.#pump();
          // Callers own the buffer (decodeAudioData detaches it).
          resolve({ audio: result.audio.slice(0), boundaries: result.boundaries });
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  prefetch(
    reqs: SpeechSynthesisRequest[],
    lane: TTSLane,
    signal: AbortSignal,
    options?: PrefetchOptions,
  ): void {
    if (lane !== 'listen' || signal.aborted) return;
    for (const req of reqs) {
      if (!req.voice) continue;
      const entry = this.#entry(req, !!options?.background);
      if (!options?.background) entry.background = false;
      if (options?.onDelivered) entry.delivered.add(options.onDelivered);
      this.#want(entry, signal);
    }
    this.#pump();
  }

  async shutdown(): Promise<void> {
    for (const entry of [...this.#entries.values()]) this.#drop(entry);
  }

  #entry(req: SpeechSynthesisRequest, background: boolean): Entry {
    const key = `${req.voice}\n${req.text}`;
    const existing = this.#entries.get(key);
    if (existing) return existing;
    let resolve!: Entry['resolve'];
    let reject!: Entry['reject'];
    const promise = new Promise<SpeechSynthesisResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Rejections nobody waits for (dropped hints) are not errors.
    promise.catch(() => {});
    const entry: Entry = {
      key,
      req,
      seq: ++this.#seq,
      due: false,
      background,
      wanted: new Set(),
      state: 'queued',
      delivered: new Set(),
      promise,
      resolve,
      reject,
    };
    this.#entries.set(key, entry);
    return entry;
  }

  #want(entry: Entry, signal: AbortSignal) {
    if (entry.wanted.has(signal)) return;
    entry.wanted.add(signal);
    signal.addEventListener(
      'abort',
      () => {
        entry.wanted.delete(signal);
        if (entry.wanted.size === 0) this.#drop(entry);
      },
      { once: true },
    );
  }

  #drop(entry: Entry) {
    if (this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    entry.reject(abortError());
    if (entry.state === 'running' && entry.id) {
      invoke('plugin:native-tts|kokoro_cancel', { id: entry.id }).catch(() => {});
    }
    this.#pump();
  }

  #next(): Entry | undefined {
    const entries = [...this.#entries.values()];
    const queued = entries.filter((e) => e.state === 'queued');
    const due = queued.filter((e) => e.due).sort((a, b) => a.seq - b.seq)[0];
    if (due) return due;
    const ready = entries.filter((e) => e.state === 'done').length;
    if (ready >= READY_AHEAD) return undefined;
    return queued.sort((a, b) => Number(a.background) - Number(b.background) || a.seq - b.seq)[0];
  }

  #pump() {
    if (this.#running) return;
    const entry = this.#next();
    if (!entry) return;
    this.#running = true;
    void this.#run(entry).finally(() => {
      this.#running = false;
      this.#pump();
    });
  }

  async #run(entry: Entry) {
    entry.state = 'running';
    entry.id = `${++this.#requestId}`;
    const { text, voice } = entry.req;
    try {
      const { audio: data, words } = await invoke<{ audio: string; words: number[][] }>(
        'plugin:native-tts|kokoro_synthesize',
        { id: entry.id, text, voice: voice.slice(VOICE_PREFIX.length) },
      );
      const audio = decodeBase64(data);
      const samples = (audio.byteLength - WAV_HEADER_BYTES) / 2;
      if (samples <= 0) throw new SpeechSynthesisPermanentError('Kokoro TTS produced no audio');
      const result = { audio, boundaries: kokoroBoundaries(text, words, samples) };
      entry.resolve(result);
      // Unless dropped meanwhile, it waits here to be played.
      if (this.#entries.get(entry.key) !== entry) return;
      entry.state = 'done';
      for (const onDelivered of entry.delivered) onDelivered(entry.req, result);
    } catch (error) {
      // Failed sentences are forgotten: a retry synthesizes them again.
      if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
      entry.reject(error);
    }
  }
}
