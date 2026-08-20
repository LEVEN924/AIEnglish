function mixToMono(buffer: AudioBuffer) {
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel)
    for (let index = 0; index < input.length; index += 1) output[index] += input[index] / buffer.numberOfChannels
  }
  return output
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const fraction = position - left
    output[index] = input[left] * (1 - fraction) + input[right] * fraction
  }
  return output
}

function encodeWav(samples: Float32Array, sampleRate = 16_000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolveDataUrl, rejectDataUrl) => {
    const reader = new FileReader()
    reader.onload = () => resolveDataUrl(String(reader.result))
    reader.onerror = () => rejectDataUrl(new Error('录音读取失败'))
    reader.readAsDataURL(blob)
  })
}

export async function convertRecordingToTencentWav(blob: Blob) {
  const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) throw new Error('当前浏览器不能转换录音格式，请升级手机浏览器。')
  const context = new AudioContextConstructor()
  try {
    const decoded = await context.decodeAudioData((await blob.arrayBuffer()).slice(0))
    const mono = mixToMono(decoded)
    const resampled = resampleLinear(mono, decoded.sampleRate, 16_000)
    const wav = encodeWav(resampled)
    return { blob: wav, dataUrl: await blobToDataUrl(wav), durationSeconds: decoded.duration }
  } finally {
    await context.close().catch(() => undefined)
  }
}

export function preferredRecordingOptions(): MediaRecorderOptions | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
  const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported?.(candidate))
  return mimeType ? { mimeType } : undefined
}
