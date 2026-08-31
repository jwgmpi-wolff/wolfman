import { useEffect, useRef, useState } from 'react'

type RecognitionResult = {
  isFinal: boolean
  0: { transcript: string }
}

type RecognitionEvent = Event & {
  results: ArrayLike<RecognitionResult>
}

type RecognitionErrorEvent = Event & {
  error: string
}

type SpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognition

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

export function extractWolfmanCommand(transcript: string) {
  const match = transcript.trim().match(/(?:^|\s)wolfman[,.]?\s*(.*)$/i)
  return match?.[1]?.trim() ?? null
}

export function markdownToSpeech(markdown: string) {
  return markdown
    .replace(/\|/g, ' ')
    .replace(/^[-#]+\s*/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(markdownToSpeech(text))
  utterance.rate = 1
  utterance.pitch = 0.95
  window.speechSynthesis.speak(utterance)
}

export function useWakeWord(onCommand: (command: string) => void) {
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const enabledRef = useRef(false)
  const commandRef = useRef(onCommand)
  const [enabled, setEnabled] = useState(false)
  const [listening, setListening] = useState(false)
  const [status, setStatus] = useState('Voice is off')
  const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    commandRef.current = onCommand
  }, [onCommand])

  useEffect(() => () => recognitionRef.current?.stop(), [])

  const startRecognition = () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) {
      setStatus('Voice recognition is not supported in this browser')
      return
    }

    if (!recognitionRef.current) {
      const recognition = new Recognition()
      recognition.continuous = true
      recognition.interimResults = false
      recognition.lang = 'en-US'
      recognition.onresult = (event) => {
        for (const result of Array.from(event.results)) {
          if (!result.isFinal) continue
          const command = extractWolfmanCommand(result[0].transcript)
          if (command === null) {
            setStatus('Say “Wolfman” followed by a request')
          } else if (!command) {
            setStatus('I’m listening. What do you need?')
          } else {
            setStatus(`Heard: ${command}`)
            commandRef.current(command)
          }
        }
      }
      recognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          enabledRef.current = false
          setEnabled(false)
          setStatus('Microphone permission is required')
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setStatus(`Voice error: ${event.error}`)
        }
      }
      recognition.onend = () => {
        setListening(false)
        if (enabledRef.current) {
          window.setTimeout(() => {
            try { recognition.start() } catch { setStatus('Tap the microphone to resume') }
          }, 250)
        }
      }
      recognitionRef.current = recognition
    }

    try {
      recognitionRef.current.start()
      setListening(true)
      setStatus('Listening for “Wolfman”')
    } catch {
      setStatus('Voice is already listening')
    }
  }

  const toggle = () => {
    if (enabledRef.current) {
      enabledRef.current = false
      setEnabled(false)
      setListening(false)
      setStatus('Voice is off')
      recognitionRef.current?.stop()
      window.speechSynthesis?.cancel()
      return
    }
    enabledRef.current = true
    setEnabled(true)
    startRecognition()
  }

  return { supported, enabled, listening, status, toggle }
}