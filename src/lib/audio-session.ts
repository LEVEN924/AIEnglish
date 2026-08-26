type AudioStopHandler = () => void

const stopHandlers = new Map<string, AudioStopHandler>()
let recordingOwner: string | null = null

export function registerAudioSession(id: string, stop: AudioStopHandler) {
  stopHandlers.set(id, stop)
  return () => {
    if (stopHandlers.get(id) === stop) stopHandlers.delete(id)
  }
}

export function stopOtherAudio(activeId?: string) {
  for (const [id, stop] of stopHandlers) {
    if (id !== activeId) stop()
  }
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
}

export function stopAllAudio() {
  stopOtherAudio()
}

export function beginRecordingSession(id: string) {
  stopAllAudio()
  recordingOwner = id
}

export function endRecordingSession(id: string) {
  if (recordingOwner === id) recordingOwner = null
}

export function requestAudioPlayback(id: string) {
  if (recordingOwner && recordingOwner !== id) return false
  stopOtherAudio(id)
  return true
}
