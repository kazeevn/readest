import { invoke } from '@tauri-apps/api/core';
import { addPluginListener, PluginListener } from '@tauri-apps/api/core';
import { getOSPlatform, getUserLocale } from '@/utils/misc';
import { isSameLang } from '@/utils/lang';
import { parseSSMLMarks } from '@/utils/ssml';
import { stubTranslation as _ } from '@/utils/misc';
import { TTSCapabilities, TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSMark, TTSVoice, TTSVoicesGroup } from './types';
import { TTSUtils } from './TTSUtils';
import { DEFAULT_PARAGRAPH_GAP_SEC, TTSController } from './TTSController';

type TTSEventPayload = {
  utteranceId: string;
} & TTSMessageEvent;

// A sentence of the Android queue, in reading order. `id` is set once it has
// been handed to the engine and resolves to its utterance id (null when a stop
// or flush overtook it).
type QueuedMark = {
  mark: TTSMark;
  silenceMs: number;
  voiceId?: string;
  id?: Promise<string | null>;
};

// Utterances the Android engine holds at once: the one playing and the next,
// which the engine synthesizes while the first plays.
const QUEUE_DEPTH = 2;

const TTSEngines = {
  default: 'System TTS',
  msctts: 'Msc TTS',
  mstrans: 'MSTrans TTS',
  microsoft: 'Microsoft TTS',
  bytedance: 'ByteDance TTS',
  peiyinya: 'PeiYinYa TTS',
  huoshan: 'HuoShan TTS',
  sougou: 'Sougou TTS',
  xiaomi: 'XiaoMi TTS',
  bdetts: 'BDeTTS',
  bdotts: 'BDoTTS',
  vcstts: 'VcsTTS',
  isstts: 'IssTTS',
  xfpeiyin: 'XFPeiYin',
  azure: 'Azure TTS',
  edgetts: 'Edge TTS',
  google: 'Google TTS',
  gemini: 'Gemini TTS',
  weread: 'WeRead TTS',
  aispeech: 'Aispeech',
} as Record<string, string>;

export class NativeTTSClient implements TTSClient {
  name = 'native-tts';
  initialized = false;
  controller?: TTSController;

  #voices: TTSVoice[] = [];
  #primaryLang = 'en';
  #speakingLang = '';
  #currentVoiceId = '';
  #rate = 1.0;
  #pitch = 1.0;
  #paragraphGapSec = DEFAULT_PARAGRAPH_GAP_SEC;

  // Android keeps the next sentence queued in the engine (QUEUE_ADD) while one
  // plays, across paragraph boundaries too, so a slow on-device engine
  // synthesizes it during playback rather than in a pause after it. The
  // paragraph after the current one comes from the controller's preloads.
  // iOS speaks one sentence at a time as before.
  #queueAhead = getOSPlatform() === 'android';
  #queue: QueuedMark[] = [];
  #upcoming: string[] = [];
  #currentSsml: string | null = null;
  #plannedSsml: string | null = null;
  #endedNaturally = false;
  #inFlight = new Set<string>();
  #submitting = 0;
  #generation = 0;
  #submitChain: Promise<unknown> = Promise.resolve();

  #eventListener: PluginListener | null = null;
  #activeUtterances = new Map<
    string,
    {
      eventQueue: TTSMessageEvent[];
      resolver: ((value: IteratorResult<TTSMessageEvent>) => void) | null;
      finished: boolean;
    }
  >();

  constructor(controller?: TTSController) {
    this.controller = controller;
  }

  private async setupEventListener(): Promise<void> {
    try {
      if (this.#eventListener) return;
      this.#eventListener = await addPluginListener<TTSEventPayload>(
        'native-tts',
        'tts_events',
        (event) => {
          const { utteranceId, code, message, mark } = event;

          if ((code === 'end' || code === 'error') && this.#inFlight.delete(utteranceId)) {
            this.#fillAhead();
          }

          const utteranceData = this.#activeUtterances.get(utteranceId);
          if (!utteranceData) return;

          const ttsEvent: TTSMessageEvent = { code, message, mark };
          utteranceData.eventQueue.push(ttsEvent);
          if (code === 'end' || code === 'error') {
            utteranceData.finished = true;
            if (utteranceData.resolver) {
              utteranceData.resolver({ value: undefined, done: true });
            }
          } else if (utteranceData.resolver) {
            utteranceData.resolver({ value: ttsEvent, done: false });
            utteranceData.resolver = null;
          }
        },
      );
    } catch (error) {
      console.error('Failed to setup TTS event listener:', error);
    }
  }

  async init(): Promise<boolean> {
    const result = await invoke<{ success: boolean }>('plugin:native-tts|init');
    this.initialized = result.success;
    if (this.initialized) {
      this.setupEventListener();
    }
    return this.initialized;
  }

  #track(utteranceId: string) {
    this.#activeUtterances.set(utteranceId, {
      eventQueue: [],
      resolver: null,
      finished: false,
    });
  }

  async *speakMark(mark: TTSMark, signal: AbortSignal) {
    const { language: voiceLang } = mark;
    const voiceId = await this.getVoiceIdFromLang(voiceLang);
    this.#currentVoiceId = voiceId;
    this.#speakingLang = voiceLang;
    await this.setVoice(voiceId);
    try {
      const result = await invoke<{ utteranceId: string }>('plugin:native-tts|speak', {
        payload: { text: mark.text },
      });
      this.#track(result.utteranceId);
      yield* this.#utteranceEvents(result.utteranceId, mark, signal);
    } catch (error) {
      console.error('Failed to speak:', error);
      throw error;
    }
  }

  async *#utteranceEvents(utteranceId: string, mark: TTSMark, signal: AbortSignal) {
    const abortHandler = () => {
      const utteranceData = this.#activeUtterances.get(utteranceId);
      if (utteranceData && utteranceData.resolver) {
        const error = { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        utteranceData.resolver({ value: error, done: true });
        utteranceData.resolver = null;
      }
      this.stop();
    };

    signal.addEventListener('abort', abortHandler);

    try {
      while (true) {
        const utteranceData = this.#activeUtterances.get(utteranceId);
        if (!utteranceData) break;

        if (utteranceData.eventQueue.length > 0) {
          const event = utteranceData.eventQueue.shift()!;
          event.mark = mark.name;
          yield event;

          if (event.code === 'end' || event.code === 'error') {
            break;
          }
        } else if (utteranceData.finished) {
          break;
        } else {
          const eventPromise = new Promise<TTSMessageEvent | void>((resolve) => {
            const utteranceData = this.#activeUtterances.get(utteranceId);
            if (!utteranceData) return resolve();
            utteranceData.resolver = (res) =>
              resolve(res.value?.code === 'error' ? res.value : undefined);
          });
          const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 100),
          );
          const result = await Promise.race([eventPromise, timeoutPromise]);
          if (result) yield result;
        }

        if (signal.aborted) {
          break;
        }
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
      this.#activeUtterances.delete(utteranceId);
    }
  }

  // Hand a sentence to the engine. Submissions run one after another so each
  // voice switch lands before its own speak; a stop or flush in the meantime
  // (a new generation) drops the ones not yet sent.
  #submit(entry: QueuedMark, queue: boolean) {
    const generation = this.#generation;
    this.#submitting++;
    const id = this.#submitChain.then(async () => {
      try {
        if (generation !== this.#generation) return null;
        entry.voiceId = await this.getVoiceIdFromLang(entry.mark.language);
        await this.setVoice(entry.voiceId);
        if (generation !== this.#generation) return null;
        const { utteranceId } = await invoke<{ utteranceId: string }>('plugin:native-tts|speak', {
          payload: { text: entry.mark.text, queue, silenceMs: entry.silenceMs },
        });
        if (generation !== this.#generation) return null;
        this.#track(utteranceId);
        this.#inFlight.add(utteranceId);
        return utteranceId;
      } finally {
        if (generation === this.#generation) this.#submitting--;
      }
    });
    this.#submitChain = id.catch(() => {});
    entry.id = id;
  }

  // Keep the engine one sentence ahead of the one playing. Past the current
  // paragraph, the next preloaded one is queued behind it, after a silence of
  // the paragraph gap. Never while a step mode has to stop after a sentence.
  #fillAhead() {
    if (this.controller?.stepsBySentence()) return;
    while (this.#inFlight.size + this.#submitting < QUEUE_DEPTH) {
      const next = this.#queue.find((entry) => !entry.id);
      if (next) {
        this.#submit(next, true);
        continue;
      }
      if (this.#currentSsml === null || this.#plannedSsml !== null) return;
      const ssml = this.#upcoming.shift();
      if (!ssml) return;
      const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
      if (marks.length === 0) continue;
      this.#plannedSsml = ssml;
      const gapMs = Math.round(this.#paragraphGapSec * 1000);
      this.#queue.push(...marks.map((mark, i) => ({ mark, silenceMs: i === 0 ? gapMs : 0 })));
    }
  }

  #resetQueue(clearUpcoming: boolean) {
    this.#generation++;
    for (const id of this.#inFlight) this.#activeUtterances.delete(id);
    this.#inFlight.clear();
    this.#submitting = 0;
    this.#queue = [];
    this.#currentSsml = null;
    this.#plannedSsml = null;
    this.#endedNaturally = false;
    if (clearUpcoming) this.#upcoming = [];
  }

  async *#speakQueued(ssml: string, marks: TTSMark[], signal: AbortSignal) {
    const consumed = this.#upcoming.indexOf(ssml);
    if (consumed >= 0) this.#upcoming.splice(0, consumed + 1);

    // The paragraph queued behind the last one is already in the engine,
    // likely already playing: carry on with it instead of starting over.
    const head = this.#queue[0];
    const adopt =
      ssml === this.#plannedSsml &&
      head?.mark.text === marks[0]?.text &&
      (!head?.voiceId || head.voiceId === (await this.getVoiceIdFromLang(marks[0]!.language)));
    if (!adopt) {
      this.#resetQueue(false);
      this.#queue = marks.map((mark) => ({ mark, silenceMs: 0 }));
      // QUEUE_FLUSH: drops whatever the engine still holds.
      if (this.#queue[0]) this.#submit(this.#queue[0], false);
    }
    this.#currentSsml = ssml;
    this.#plannedSsml = null;
    this.#endedNaturally = false;

    for (const [i, mark] of marks.entries()) {
      if (signal.aborted) return;
      const entry = this.#queue.shift();
      if (!entry) return;
      if (!entry.id) this.#submit(entry, true);
      this.controller?.dispatchSpeakMark(mark);
      this.#fillAhead();
      const utteranceId = await entry.id;
      if (!utteranceId) return;
      this.#speakingLang = mark.language;
      this.#currentVoiceId = entry.voiceId ?? this.#currentVoiceId;
      let lastCode: string | undefined;
      for await (const ev of this.#utteranceEvents(utteranceId, mark, signal)) {
        lastCode = ev.code;
        yield ev;
      }
      if (i === marks.length - 1 && lastCode === 'end') this.#endedNaturally = true;
    }
  }

  async *speak(ssml: string, signal: AbortSignal, preload: boolean = false) {
    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);

    if (preload) {
      // Remembered in reading order: the paragraph after the current one is
      // queued behind its last sentence.
      if (this.#queueAhead && ssml !== this.#plannedSsml && !this.#upcoming.includes(ssml)) {
        this.#upcoming.push(ssml);
        this.#fillAhead();
      }
      for (const _ of marks) {
        yield { code: 'end', message: 'Dummy preload finished' } as TTSMessageEvent;
      }
      return;
    }

    const events = this.#queueAhead
      ? this.#speakQueued(ssml, marks, signal)
      : this.#speakEach(marks, signal);
    for await (const ev of events) {
      if (signal.aborted) {
        yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
        return;
      }
      yield ev;
    }
  }

  async *#speakEach(marks: TTSMark[], signal: AbortSignal) {
    for (const mark of marks) {
      this.controller?.dispatchSpeakMark(mark);
      yield* this.speakMark(mark, signal);
    }
  }

  async getVoiceIdFromLang(lang: string) {
    const preferredVoiceId = TTSUtils.getPreferredVoice(this.name, lang);
    const preferredVoice = this.#voices.find((v) => v.id === preferredVoiceId);
    const defaultVoice = preferredVoice
      ? preferredVoice
      : (await this.getVoices(lang))[0]?.voices[0] || null;
    return defaultVoice?.id || '';
  }

  async pause() {
    // A native pause is a stop: the engine drops whatever was queued.
    this.#resetQueue(false);
    await invoke('plugin:native-tts|pause');
    return false;
  }

  async resume() {
    // No-op for Android TextToSpeech
    await invoke('plugin:native-tts|resume');
    return false;
  }

  async stop(handover = false) {
    // Handing over to the paragraph already queued behind the one that just
    // ended: keep the engine playing it.
    if (handover && this.#endedNaturally && this.#plannedSsml !== null) return;
    this.#resetQueue(!handover);
    // Bound the native stop so teardown (controller.stop / shutdown, and thus
    // the TTS icon turning off) can never hang if the native side is slow to
    // resolve — e.g. iOS AVSpeechSynthesizer / audio-session teardown. See #4676.
    try {
      await Promise.race([
        invoke('plugin:native-tts|stop'),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch (error) {
      console.warn('Native TTS stop failed:', error);
    }
    this.#activeUtterances.clear();
  }

  async setRate(rate: number) {
    // Power the rate to match the EdgeTTS behavior
    this.#rate = parseFloat(Math.pow(rate, 2.5).toFixed(2));
    await invoke('plugin:native-tts|set_rate', { payload: { rate: this.#rate } });
  }

  async setPitch(pitch: number) {
    this.#pitch = pitch;
    await invoke('plugin:native-tts|set_pitch', { payload: { pitch: this.#pitch } });
  }

  async setVoice(voice: string) {
    this.#currentVoiceId = voice;
    await invoke('plugin:native-tts|set_voice', { payload: { voice } });
  }

  async getAllVoices() {
    if (this.#voices.length > 0) {
      return this.#voices;
    }
    try {
      const result = await invoke<{ voices: TTSVoice[] }>('plugin:native-tts|get_all_voices');
      // Match Web Speech's Apple voice-family exclusions. iOS also exposes
      // novelty and legacy Eloquence voices through the native API.
      this.#voices = result.voices.filter(
        (voice) =>
          !voice.id.startsWith('com.apple.eloquence.') &&
          !voice.id.startsWith('com.apple.speech.synthesis.voice.'),
      );
      return this.#voices;
    } catch (error) {
      console.error('Failed to get all voices:', error);
      return [];
    }
  }

  async getVoices(lang: string) {
    const locale = lang === 'en' ? getUserLocale(lang) || lang : lang;
    const voices = await this.getAllVoices();
    // Match by primary language so the voice set stays the same across a book
    // whose sections mix region variants (e.g. en-US front matter and en-GB
    // body text); the requested locale's voices sort first. See #4033.
    const filteredVoices = voices.filter((v) => isSameLang(v.lang, lang));
    const voiceGroups = new Map<string, TTSVoice[]>();
    filteredVoices.forEach((voice) => {
      const { name, lang } = voice;
      let groupId = voice.id.split('_')[0]!;
      if (groupId in TTSEngines) {
        voice.name = name
          .replace(`${groupId}_`, '')
          .replace(`${lang}-`, '')
          .replace('Neural', '')
          .trim();
      } else {
        groupId = 'default';
      }
      voice.name = voice.name.replace('NOT_SET', _('Default'));
      if (!voiceGroups.has(groupId)) {
        voiceGroups.set(groupId, []);
      }
      voiceGroups.get(groupId)!.push(voice);
    });

    return Array.from(voiceGroups.entries())
      .map(
        ([groupId, voices]) =>
          ({
            id: groupId,
            name: TTSEngines[groupId] || groupId,
            voices: voices.sort(TTSUtils.sortVoicesPreferLocaleFunc(locale)),
            disabled: !this.initialized || voices.length === 0,
          }) as TTSVoicesGroup,
      )
      .sort((a, b) => {
        if (a.id === 'default') return -1;
        if (b.id === 'default') return 1;
        return a.id.localeCompare(b.id);
      });
  }

  setParagraphGap(sec: number) {
    this.#paragraphGapSec = sec;
  }

  setPrimaryLang(lang: string) {
    this.#primaryLang = lang;
  }

  getCapabilities(): TTSCapabilities {
    // Direct-speak engine: the OS renders the audio, so there is no media
    // clock, no word boundaries, and no gap or live-rate control.
    return { wordBoundaries: false, mediaClock: false, gapControl: false, liveRateChange: false };
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId() {
    return this.#currentVoiceId;
  }

  getSpeakingLang() {
    return this.#speakingLang;
  }

  async shutdown() {
    if (this.#eventListener) {
      this.#eventListener.unregister();
      this.#eventListener = null;
    }
    await this.stop();
  }
}
