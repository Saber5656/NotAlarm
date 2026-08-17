const SAMPLE_RATE = 16_000;
const DURATION_SECONDS = 2;

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

/** Creates a short two-tone PCM WAV that can be looped without network access. */
export function createAlarmToneBytes(): Uint8Array {
  const sampleCount = SAMPLE_RATE * DURATION_SECONDS;
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const wav = new Uint8Array(44 + dataSize);

  writeAscii(wav, 0, 'RIFF');
  writeUint32(wav, 4, 36 + dataSize);
  writeAscii(wav, 8, 'WAVE');
  writeAscii(wav, 12, 'fmt ');
  writeUint32(wav, 16, 16);
  writeUint16(wav, 20, 1);
  writeUint16(wav, 22, 1);
  writeUint32(wav, 24, SAMPLE_RATE);
  writeUint32(wav, 28, SAMPLE_RATE * bytesPerSample);
  writeUint16(wav, 32, bytesPerSample);
  writeUint16(wav, 34, 16);
  writeAscii(wav, 36, 'data');
  writeUint32(wav, 40, dataSize);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / SAMPLE_RATE;
    const pulsePosition = time % 0.5;
    const isAudible = pulsePosition < 0.34;
    const frequency = Math.floor(time / 0.5) % 2 === 0 ? 880 : 660;
    const envelope = Math.min(
      1,
      pulsePosition / 0.02,
      (0.34 - pulsePosition) / 0.03,
    );
    const sample = isAudible
      ? Math.sin(2 * Math.PI * frequency * time) *
        0.72 *
        Math.max(0, envelope)
      : 0;
    const signed = Math.max(-1, Math.min(1, sample)) * 0x7fff;
    const value =
      signed < 0 ? Math.round(signed + 0x10000) : Math.round(signed);
    writeUint16(wav, 44 + index * bytesPerSample, value);
  }

  return wav;
}
