import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  addPluginListener: vi.fn().mockResolvedValue({ unregister: vi.fn() }),
}));

// Avoid pulling in the heavy TTSController module graph (foliate-js, etc.) — the
// native client only needs its paragraph-gap default.
vi.mock('@/services/tts/TTSController', () => ({
  TTSController: class {},
  DEFAULT_PARAGRAPH_GAP_SEC: 0.3,
}));

vi.mock('@/utils/misc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/misc')>()),
  getOSPlatform: vi.fn(() => 'android'),
}));

import { NativeTTSClient } from '@/services/tts/NativeTTSClient';
import type { TTSController } from '@/services/tts/TTSController';
import type { TTSMessageEvent } from '@/services/tts/TTSClient';
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { getOSPlatform } from '@/utils/misc';

describe('NativeTTSClient.stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('resolves promptly when the native stop resolves', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const client = new NativeTTSClient();

    await client.stop();

    expect(invoke).toHaveBeenCalledWith('plugin:native-tts|stop');
  });

  test('still resolves (bounded) when the native stop never resolves', async () => {
    // Regression for #4676: a hung native stop must not hang teardown
    // (controller.stop / shutdown), which would leave the TTS icon stuck.
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    const client = new NativeTTSClient();

    let settled = false;
    const p = client.stop().then(() => {
      settled = true;
    });

    // Pending until the timeout fires.
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    await p;
    expect(settled).toBe(true);
  });
});

describe('NativeTTSClient voice filtering', () => {
  test('excludes Apple novelty and Eloquence voices, retaining normal and non-Apple voices', async () => {
    const voices = [
      { id: 'com.apple.speech.synthesis.voice.BadNews', name: 'Bad News', lang: 'en-US' },
      { id: 'com.apple.eloquence.en-US.Eddy', name: 'Eddy (United States)', lang: 'en-US' },
      { id: 'com.apple.voice.super-compact.en-US.Samantha', name: 'Samantha', lang: 'en-US' },
      { id: 'com.apple.voice.enhanced.en-US.Samantha', name: 'Samantha (Enhanced)', lang: 'en-US' },
      { id: 'com.apple.ttsbundle.siri_Aaron_en-US_compact', name: 'Aaron', lang: 'en-US' },
      { id: 'android-voice-1', name: 'Eddy', lang: 'en-US' },
    ];
    vi.mocked(invoke).mockResolvedValue({ voices });
    const client = new NativeTTSClient();
    expect((await client.getAllVoices()).map((voice) => voice.id)).toEqual(
      voices.slice(2).map((voice) => voice.id),
    );
    const groups = await client.getVoices('en');
    expect(groups.flatMap((group) => group.voices)).toHaveLength(4);
  });
});

type SpeakPayload = { text: string; queue?: boolean; silenceMs?: number };
type NativeEvent = { utteranceId: string } & TTSMessageEvent;

const ssmlOf = (...sentences: string[]) =>
  `<speak xml:lang="en">${sentences.map((s, i) => `<mark name="${i}"/>${s}`).join('')}</speak>`;

// Drives NativeTTSClient against a fake Android TextToSpeech: records every
// speak it submits and lets the test fire the engine's per-utterance events.
const setupNative = async (stepsBySentence = false) => {
  const speaks: Array<SpeakPayload & { id: string }> = [];
  let emit: (event: NativeEvent) => void = () => {};
  vi.mocked(addPluginListener).mockImplementation(async (_plugin, _event, cb) => {
    emit = cb as (event: NativeEvent) => void;
    return { unregister: vi.fn() } as unknown as Awaited<ReturnType<typeof addPluginListener>>;
  });
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    switch (cmd) {
      case 'plugin:native-tts|init':
        return { success: true };
      case 'plugin:native-tts|get_all_voices':
        return { voices: [{ id: 'en-US', name: 'en-US', lang: 'en-US' }] };
      case 'plugin:native-tts|speak': {
        const id = `u${speaks.length + 1}`;
        speaks.push({ ...(args as { payload: SpeakPayload }).payload, id });
        return { utteranceId: id };
      }
      default:
        return undefined;
    }
  });
  const controller = {
    dispatchSpeakMark: vi.fn(),
    stepsBySentence: () => stepsBySentence,
  } as unknown as TTSController;
  const client = new NativeTTSClient(controller);
  await client.init();
  await vi.waitFor(() => expect(addPluginListener).toHaveBeenCalled());
  client.setParagraphGap(0.3);

  const play = (ssml: string) => {
    const events: TTSMessageEvent[] = [];
    const done = (async () => {
      for await (const ev of client.speak(ssml, new AbortController().signal)) events.push(ev);
    })();
    return { events, done };
  };
  const preload = async (ssml: string) => {
    for await (const _ of client.speak(ssml, new AbortController().signal, true));
  };
  const finish = (id: string) => {
    emit({ utteranceId: id, code: 'boundary', message: 'start' });
    emit({ utteranceId: id, code: 'end' });
  };
  const nativeStops = () =>
    vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'plugin:native-tts|stop').length;
  return { client, speaks, play, preload, finish, nativeStops };
};

describe('NativeTTSClient queue-ahead (Android)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOSPlatform).mockReturnValue('android');
  });

  test('queues the next sentence while the current one plays', async () => {
    const { speaks, play, finish } = await setupNative();
    const { done } = play(ssmlOf('First sentence.', 'Second sentence.'));

    await vi.waitFor(() => expect(speaks).toHaveLength(2));
    expect(speaks[0]).toMatchObject({ text: 'First sentence.', queue: false });
    expect(speaks[1]).toMatchObject({ text: 'Second sentence.', queue: true });

    finish('u1');
    finish('u2');
    await done;
    expect(speaks).toHaveLength(2);
  });

  test('queues the next paragraph behind the last sentence and adopts it on handover', async () => {
    const { client, speaks, play, preload, finish, nativeStops } = await setupNative();
    const p0 = ssmlOf('Alpha one.');
    const p1 = ssmlOf('Beta one.', 'Beta two.');
    const first = play(p0);
    await vi.waitFor(() => expect(speaks).toHaveLength(1));
    await preload(p1);

    await vi.waitFor(() => expect(speaks).toHaveLength(2));
    expect(speaks[1]).toMatchObject({ text: 'Beta one.', queue: true, silenceMs: 300 });

    finish('u1');
    await first.done;
    expect(first.events.at(-1)?.code).toBe('end');
    // The engine is playing the next paragraph: its second sentence goes in behind it.
    await vi.waitFor(() => expect(speaks).toHaveLength(3));
    expect(speaks[2]).toMatchObject({ text: 'Beta two.', queue: true });

    await client.stop(true);
    expect(nativeStops()).toBe(0);

    const second = play(p1);
    finish('u2');
    finish('u3');
    await second.done;
    expect(speaks.filter((s) => s.text === 'Beta one.')).toHaveLength(1);
    expect(second.events.filter((e) => e.code === 'end')).toHaveLength(2);
  });

  test('flushes when the handover goes somewhere other than the queued paragraph', async () => {
    const { client, speaks, play, preload, finish } = await setupNative();
    const first = play(ssmlOf('Alpha one.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(1));
    await preload(ssmlOf('Beta one.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(2));
    finish('u1');
    await first.done;

    await client.stop(true);
    const other = play(ssmlOf('Gamma one.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(3));
    expect(speaks[2]).toMatchObject({ text: 'Gamma one.', queue: false });
    finish('u3');
    await other.done;
  });

  test('a real stop silences the queue and the next speak flushes', async () => {
    const { client, speaks, play, preload, nativeStops, finish } = await setupNative();
    const first = play(ssmlOf('Alpha one.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(1));
    await preload(ssmlOf('Beta one.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(2));

    await client.stop();
    await first.done;
    expect(nativeStops()).toBe(1);

    const next = play(ssmlOf('Beta one.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(3));
    expect(speaks[2]).toMatchObject({ text: 'Beta one.', queue: false });
    finish('u3');
    await next.done;
  });

  test('queues nothing ahead while a step mode is on', async () => {
    const { speaks, play, preload, finish } = await setupNative(true);
    const { done } = play(ssmlOf('First sentence.', 'Second sentence.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(1));
    await preload(ssmlOf('Beta one.'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(speaks).toHaveLength(1);

    finish('u1');
    await vi.waitFor(() => expect(speaks).toHaveLength(2));
    expect(speaks[1]).toMatchObject({ text: 'Second sentence.' });
    finish('u2');
    await done;
    expect(speaks).toHaveLength(2);
  });

  test('speaks one sentence at a time on iOS', async () => {
    vi.mocked(getOSPlatform).mockReturnValue('ios');
    const { speaks, play, finish } = await setupNative();
    const { done } = play(ssmlOf('First sentence.', 'Second sentence.'));
    await vi.waitFor(() => expect(speaks).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(speaks).toHaveLength(1);

    finish('u1');
    await vi.waitFor(() => expect(speaks).toHaveLength(2));
    finish('u2');
    await done;
  });
});
