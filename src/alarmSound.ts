import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { createAlarmToneBytes } from './alarmTone';

const ALARM_TONE_FILENAME = 'already-up-alarm-v1.wav';

let activePlayer: AudioPlayer | null = null;
let startPromise: Promise<void> | null = null;
let lifecycleGeneration = 0;

function ensureAlarmToneUri(): string {
  const file = new File(Paths.cache, ALARM_TONE_FILENAME);
  if (!file.exists) {
    file.create();
    file.write(createAlarmToneBytes());
  }
  return file.uri;
}

export async function startForegroundAlarmSound(): Promise<void> {
  if (Platform.OS === 'web' || activePlayer) {
    return;
  }

  if (startPromise) {
    return startPromise;
  }

  const generation = ++lifecycleGeneration;
  const pendingStart = (async () => {
    await setAudioModeAsync({
      interruptionMode: 'doNotMix',
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });

    const player = createAudioPlayer(ensureAlarmToneUri());
    if (generation !== lifecycleGeneration) {
      player.release();
      return;
    }

    player.loop = true;
    player.volume = 1;
    activePlayer = player;
    player.play();
  })();

  startPromise = pendingStart;
  try {
    await pendingStart;
  } finally {
    if (startPromise === pendingStart) {
      startPromise = null;
    }
  }
}

export function stopForegroundAlarmSound(): void {
  lifecycleGeneration += 1;
  const player = activePlayer;
  activePlayer = null;
  if (!player) {
    return;
  }

  try {
    player.pause();
  } finally {
    player.release();
  }
}
