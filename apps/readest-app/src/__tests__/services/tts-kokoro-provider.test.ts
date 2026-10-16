import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  KokoroSpeechProvider,
  kokoroBoundaries,
  kokoroVoice,
} from '@/services/tts/providers/kokoro';
import { SpeechSynthesisPermanentError } from '@/services/tts/providers/types';

// A WAV of `samples` silent samples, base64-encoded as the plugin sends it.
const wav = (samples: number) => btoa(String.fromCharCode(...new Uint8Array(44 + samples * 2)));

const req = (text: string, voice = 'kokoro:af_heart') => ({ lang: 'en', text, voice, pitch: 1 });

type Pending = { text: string; id: string; resolve: () => void; reject: (e: Error) => void };

describe('KokoroSpeechProvider', () => {
  let pending: Pending[];
  let cancelled: string[];
  let provider: KokoroSpeechProvider;

  // Lets the provider's promise chains settle.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Completes the synthesis in flight.
  const finish = async () => {
    pending.shift()!.resolve();
    await flush();
  };

  beforeEach(() => {
    pending = [];
    cancelled = [];
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string, args: Record<string, string>) => {
      if (cmd === 'plugin:native-tts|kokoro_voices') {
        return Promise.resolve({
          voices: ['af_heart', 'bm_george', 'zz'],
          defaultVoice: 'bm_george',
        });
      }
      if (cmd === 'plugin:native-tts|kokoro_cancel') {
        cancelled.push(args['id']!);
        return Promise.resolve();
      }
      if (cmd === 'plugin:native-tts|kokoro_synthesize') {
        return new Promise((resolve, reject) => {
          pending.push({
            text: args['text']!,
            id: args['id']!,
            resolve: () => resolve({ audio: wav(2400), words: [[0, 0, 5]] }),
            reject,
          });
        });
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    provider = new KokoroSpeechProvider();
  });

  it('lists the Kokoro voices with accent and gender', async () => {
    expect(await provider.init()).toBe(true);
    const voices = await provider.getAllVoices();
    expect(voices).toEqual([
      { id: 'kokoro:af_heart', name: 'Heart (American female)', lang: 'en-US' },
      { id: 'kokoro:bm_george', name: 'George (British male)', lang: 'en-GB' },
    ]);
    expect(provider.pickDefaultVoice(voices)).toBe('kokoro:bm_george');
    expect(provider.pickDefaultVoice([voices[0]!])).toBe('kokoro:af_heart');
    expect(kokoroVoice('zz')).toBeNull();
  });

  it('is unavailable without the Kokoro app', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('not installed')));
    expect(await provider.init()).toBe(false);
    expect(await provider.getAllVoices()).toEqual([]);
  });

  it('turns word starts into boundaries', () => {
    expect(
      kokoroBoundaries(
        'Hello there',
        [
          [0, 0, 5],
          [12000, 6, 11],
        ],
        36000,
      ),
    ).toEqual([
      { offset: 0, duration: 5_000_000, text: 'Hello' },
      { offset: 5_000_000, duration: 10_000_000, text: 'there' },
    ]);
  });

  it('synthesizes a requested sentence with the bare voice id', async () => {
    const result = provider.synthesize(req('Hello.'), new AbortController().signal);
    await flush();
    expect(invokeMock).toHaveBeenCalledWith('plugin:native-tts|kokoro_synthesize', {
      id: '1',
      text: 'Hello.',
      voice: 'af_heart',
    });
    await finish();
    const { audio, boundaries } = await result;
    expect(audio.byteLength).toBe(44 + 4800);
    expect(boundaries).toEqual([{ offset: 0, duration: 1_000_000, text: 'Hello' }]);
  });

  it('skips sentences without a voice', async () => {
    await expect(
      provider.synthesize(req('Bonjour.', ''), new AbortController().signal),
    ).rejects.toBeInstanceOf(SpeechSynthesisPermanentError);
  });

  it('synthesizes hints ahead in order, a few at most, current paragraph first', async () => {
    const paragraph = new AbortController().signal;
    const preload = new AbortController().signal;
    provider.prefetch([req('a'), req('b'), req('c')], 'listen', paragraph);
    provider.prefetch([req('n1'), req('n2')], 'listen', preload, { background: true });
    provider.prefetch([req('a'), req('b'), req('c'), req('d')], 'listen', paragraph);
    await flush();
    const order: string[] = [];
    while (pending.length) {
      order.push(pending[0]!.text);
      await finish();
    }
    // Three ready and unclaimed: the rest waits.
    expect(order).toEqual(['a', 'b', 'c']);

    // Claiming one frees a slot; the paragraph's last sentence, then the next one's.
    await provider.synthesize(req('a'), paragraph);
    await flush();
    expect(pending.map((p) => p.text)).toEqual(['d']);
    await finish();
    await provider.synthesize(req('b'), paragraph);
    await flush();
    expect(pending.map((p) => p.text)).toEqual(['n1']);
  });

  it('puts the sentence playback waits for first', async () => {
    const signal = new AbortController().signal;
    provider.prefetch([req('a'), req('b'), req('c')], 'listen', signal);
    await flush();
    const due = provider.synthesize(req('z'), signal);
    await finish(); // 'a' was already running
    expect(pending.map((p) => p.text)).toEqual(['z']);
    await finish();
    await expect(due).resolves.toBeTruthy();
  });

  it('drops withdrawn sentences and cancels the one in flight', async () => {
    const paragraph = new AbortController();
    provider.prefetch([req('a'), req('b')], 'listen', paragraph.signal);
    await flush();
    expect(pending.map((p) => p.text)).toEqual(['a']);
    paragraph.abort();
    await flush();
    expect(cancelled).toEqual(['1']);
    pending.shift()!.reject(new Error('Kokoro TTS stream ended early'));
    await flush();
    // 'b' was withdrawn too.
    expect(pending).toEqual([]);
  });

  it('rejects a request whose caller aborts', async () => {
    const controller = new AbortController();
    const result = provider.synthesize(req('a'), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow('Aborted');
  });

  it('forgets failed sentences so a retry synthesizes again', async () => {
    const signal = new AbortController().signal;
    const first = provider.synthesize(req('a'), signal);
    await flush();
    pending.shift()!.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    const retry = provider.synthesize(req('a'), signal);
    await flush();
    expect(pending.map((p) => p.text)).toEqual(['a']);
    await finish();
    await expect(retry).resolves.toBeTruthy();
  });
});
