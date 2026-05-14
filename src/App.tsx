/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Send, 
  Bot, 
  RefreshCcw, 
  MessageCircle, 
  Volume2,
  Mic,
  MicOff,
  Menu,
  X,
  MessageSquare,
  ArrowLeft
} from 'lucide-react';

let activeSpeechSession = 0;
let speechKeepAliveTimer: number | undefined;
let speechPrimed = false;
let activeAudioElement: HTMLAudioElement | null = null;
let activeSpeechAbortController: AbortController | null = null;

type SpeechOutcome = 'completed' | 'cancelled' | 'unsupported' | 'failed';
type CachedAudio = {
  data: string;
  mimeType: string;
  createdAt: number;
};
type GeneratedAudio = Pick<CachedAudio, 'data' | 'mimeType'>;

const CHAT_STORAGE_KEY = 'sehat-mand-ghar-chat-v1';
const AUDIO_DB_NAME = 'sehat-mand-ghar-audio';
const AUDIO_STORE_NAME = 'tts-audio';
const MAX_STORED_MESSAGES = 80;

const canUseSpeech = () =>
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  'SpeechSynthesisUtterance' in window;

const stopSpeechKeepAlive = () => {
  if (speechKeepAliveTimer) {
    window.clearInterval(speechKeepAliveTimer);
    speechKeepAliveTimer = undefined;
  }
};

const cancelSpeech = () => {
  activeSpeechSession += 1;
  stopSpeechKeepAlive();
  activeSpeechAbortController?.abort();
  activeSpeechAbortController = null;

  if (activeAudioElement) {
    activeAudioElement.pause();
    activeAudioElement.src = '';
    activeAudioElement = null;
  }

  if (canUseSpeech()) {
    window.speechSynthesis.cancel();
  }
};

const primeSpeech = () => {
  if (!canUseSpeech() || speechPrimed) return;
  speechPrimed = true;

  try {
    window.speechSynthesis.resume();
    void loadVoices();
  } catch (error) {
    console.warn('Speech priming failed:', error);
  }
};

const loadVoices = () => {
  if (!canUseSpeech()) return Promise.resolve<SpeechSynthesisVoice[]>([]);

  const synth = window.speechSynthesis;
  const voices = synth.getVoices();
  if (voices.length) return Promise.resolve(voices);

  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(synth.getVoices());
    };

    synth.addEventListener?.('voiceschanged', finish, { once: true });
    window.setTimeout(finish, 700);
  });
};

const scoreVoice = (voice: SpeechSynthesisVoice) => {
  const lang = voice.lang.toLowerCase();
  const name = voice.name.toLowerCase();

  if (lang === 'ur-pk') return 100;
  if (lang.startsWith('ur')) return 90;
  if (name.includes('urdu')) return 85;
  if (name.includes('google') && (lang.startsWith('hi') || lang.startsWith('ar'))) return 70;
  if (lang.startsWith('ar')) return 60;
  if (lang.startsWith('hi') || lang.startsWith('pa')) return 50;
  if (lang.startsWith('en')) return 20;
  return 0;
};

const selectBestVoice = (voices: SpeechSynthesisVoice[]) => {
  return [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0];
};

const canReadUrduScript = (voice?: SpeechSynthesisVoice) => {
  if (!voice) return false;
  const lang = voice.lang.toLowerCase();
  const name = voice.name.toLowerCase();
  return lang.startsWith('ur') || name.includes('urdu') || name.includes('pakistan');
};

const normalizeSpeechText = (text: string) =>
  text
    .replace(/IUD|IUCD/gi, 'آئی یو ڈی')
    .replace(/FP/gi, 'ایف پی')
    .replace(/\bAI\b/gi, 'اے آئی')
    .replace(/[.!?]/g, '۔ ')
    .replace(/\n+/g, '۔ ')
    .replace(/\s+/g, ' ')
    .trim();

const splitSpeechText = (text: string, maxLength = 220) => {
  const chunks: string[] = [];
  let current = '';

  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }

    if (current.length > 80 && /[۔؟]$/.test(word)) {
      chunks.push(current);
      current = '';
    }
  }

  if (current) chunks.push(current);
  return chunks;
};

const getAudioCacheKey = (text: string) => {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return `ur-gemini-v2-${hash >>> 0}-${text.length}`;
};

const openAudioDb = () =>
  new Promise<IDBDatabase | null>((resolve) => {
    if (!('indexedDB' in window)) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(AUDIO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(AUDIO_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('Audio cache unavailable:', request.error);
      resolve(null);
    };
  });

const getCachedAudio = async (key: string) => {
  const db = await openAudioDb();
  if (!db) return null;

  return new Promise<CachedAudio | null>((resolve) => {
    const transaction = db.transaction(AUDIO_STORE_NAME, 'readonly');
    const request = transaction.objectStore(AUDIO_STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as CachedAudio | undefined) || null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
};

const saveCachedAudio = async (key: string, audio: CachedAudio) => {
  const db = await openAudioDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(AUDIO_STORE_NAME, 'readwrite');
    transaction.objectStore(AUDIO_STORE_NAME).put(audio, key);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
  });
};

const createWavUrlFromBase64Pcm = (base64Audio: string, mimeType = 'audio/pcm;rate=24000') => {
  const rateMatch = mimeType.match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const raw = window.atob(base64Audio);
  const pcm = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    pcm[index] = raw.charCodeAt(index);
  }

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, pcm.length, true);

  return URL.createObjectURL(new Blob([header, pcm], { type: 'audio/wav' }));
};

const createAudioUrl = (base64Audio: string, mimeType: string) => {
  if (mimeType.includes('wav') || mimeType.includes('mpeg') || mimeType.includes('mp3')) {
    return URL.createObjectURL(new Blob([Uint8Array.from(window.atob(base64Audio), char => char.charCodeAt(0))], { type: mimeType }));
  }

  return createWavUrlFromBase64Pcm(base64Audio, mimeType);
};

const generateGeminiUrduAudio = async (processedText: string, signal?: AbortSignal): Promise<GeneratedAudio | null> => {
  if (!process.env.GEMINI_API_KEY) return null;

  const response = await genAI.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: [
      {
        role: 'user',
        parts: [{
          text: `Read the following Urdu text clearly, naturally, and professionally. Do not add, remove, translate, or explain anything. Text: ${processedText}`
        }]
      }
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: 'Kore'
          }
        }
      },
      abortSignal: signal
    }
  });

  const responseAny = response as any;
  const part = responseAny.candidates?.[0]?.content?.parts?.find((item: any) => item.inlineData?.data);
  const data = responseAny.data || part?.inlineData?.data;
  const mimeType = part?.inlineData?.mimeType || 'audio/pcm;rate=24000';

  return data ? { data, mimeType } : null;
};

// Speech Utility
const playAudioUrl = (audioUrl: string, sessionId: number, onStart?: () => void, onEnd?: () => void) =>
  new Promise<SpeechOutcome>((resolve) => {
    const audio = new Audio(audioUrl);
    let started = false;
    let settled = false;
    activeAudioElement = audio;

    const finish = (outcome: SpeechOutcome) => {
      if (settled) return;
      settled = true;
      if (activeAudioElement === audio) {
        activeAudioElement = null;
      }
      URL.revokeObjectURL(audioUrl);
      if (outcome !== 'cancelled') {
        onEnd?.();
      }
      resolve(outcome);
    };

    audio.onplaying = () => {
      if (sessionId !== activeSpeechSession) {
        finish('cancelled');
        return;
      }
      if (!started) {
        started = true;
        onStart?.();
      }
    };

    audio.onended = () => finish(sessionId === activeSpeechSession ? 'completed' : 'cancelled');
    audio.onerror = () => finish(sessionId === activeSpeechSession ? 'failed' : 'cancelled');

    audio.play().catch((error) => {
      console.error('Audio playback error:', error);
      finish(sessionId === activeSpeechSession ? 'failed' : 'cancelled');
    });
  });

const speakWithGeminiUrdu = async (processedText: string, sessionId: number, onStart?: () => void, onEnd?: () => void): Promise<SpeechOutcome> => {
  if (!process.env.GEMINI_API_KEY) return 'unsupported';

  const cacheKey = getAudioCacheKey(processedText);
  const cachedAudio = await getCachedAudio(cacheKey);
  if (sessionId !== activeSpeechSession) return 'cancelled';
  if (cachedAudio?.data) {
    return playAudioUrl(createAudioUrl(cachedAudio.data, cachedAudio.mimeType), sessionId, onStart, onEnd);
  }

  activeSpeechAbortController = new AbortController();

  try {
    const generatedAudio = await generateGeminiUrduAudio(processedText, activeSpeechAbortController.signal);
    if (sessionId !== activeSpeechSession) return 'cancelled';

    if (!generatedAudio?.data) return 'failed';

    void saveCachedAudio(cacheKey, {
      data: generatedAudio.data,
      mimeType: generatedAudio.mimeType,
      createdAt: Date.now()
    });

    return playAudioUrl(createAudioUrl(generatedAudio.data, generatedAudio.mimeType), sessionId, onStart, onEnd);
  } catch (error: any) {
    if (error?.name === 'AbortError' || sessionId !== activeSpeechSession) {
      return 'cancelled';
    }
    console.error('Gemini TTS error:', error);
    return 'failed';
  } finally {
    if (activeSpeechAbortController?.signal.aborted || sessionId === activeSpeechSession) {
      activeSpeechAbortController = null;
    }
  }
};

const prefetchUrduAudio = async (text: string) => {
  const processedText = normalizeSpeechText(text);
  if (!processedText || !process.env.GEMINI_API_KEY) return;

  try {
    const voices = await loadVoices();
    const voice = selectBestVoice(voices);
    if (canUseSpeech() && canReadUrduScript(voice)) return;

    const cacheKey = getAudioCacheKey(processedText);
    const cachedAudio = await getCachedAudio(cacheKey);
    if (cachedAudio?.data) return;

    const generatedAudio = await generateGeminiUrduAudio(processedText);
    if (!generatedAudio?.data) return;

    void saveCachedAudio(cacheKey, {
      data: generatedAudio.data,
      mimeType: generatedAudio.mimeType,
      createdAt: Date.now()
    });
  } catch (error) {
    console.warn('Could not prefetch Urdu audio:', error);
  }
};

const speakUrdu = async (text: string, onStart?: () => void, onEnd?: () => void): Promise<SpeechOutcome> => {
  const processedText = normalizeSpeechText(text);
  if (!processedText) {
    onEnd?.();
    return 'unsupported';
  }

  activeSpeechSession += 1;
  const sessionId = activeSpeechSession;
  stopSpeechKeepAlive();
    if (canUseSpeech()) {
      window.speechSynthesis.cancel();
    }
    activeAudioElement?.pause();
    activeAudioElement = null;

    const voices = await loadVoices();
  if (sessionId !== activeSpeechSession) return 'cancelled';

  const voice = selectBestVoice(voices);
  const useNativeUrdu = canUseSpeech() && canReadUrduScript(voice);

  if (!useNativeUrdu) {
    return speakWithGeminiUrdu(processedText, sessionId, onStart, onEnd);
  }

  const chunks = splitSpeechText(processedText);
  let started = false;
  let hadSpeechError = false;

  speechKeepAliveTimer = window.setInterval(() => {
    if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  }, 8000);

  for (const chunk of chunks) {
    if (sessionId !== activeSpeechSession) return 'cancelled';

    await new Promise<void>((resolve) => {
      let settled = false;
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = voice?.lang || 'ur-PK';
      utterance.voice = voice || null;
      utterance.rate = 0.88;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        resolve();
      };

      const watchdog = window.setTimeout(finish, Math.max(5000, chunk.length * 140));

      utterance.onstart = () => {
        if (!started) {
          started = true;
          onStart?.();
        }
      };

      utterance.onend = finish;
      utterance.onerror = (event) => {
        console.error('Speech error:', event);
        hadSpeechError = true;
        finish();
      };

      window.speechSynthesis.speak(utterance);
      window.setTimeout(() => window.speechSynthesis.resume(), 0);
    });
  }

  if (sessionId === activeSpeechSession) {
    stopSpeechKeepAlive();
    if (hadSpeechError) {
      return speakWithGeminiUrdu(processedText, sessionId, onStart, onEnd);
    }
    onEnd?.();
    return 'completed';
  }

  return 'cancelled';
};

// Web Speech API interfaces
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognition extends EventTarget {
  start(): void;
  stop(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: any) => void;
  onend: () => void;
  lang: string;
}
declare var webkitSpeechRecognition: {
  new (): SpeechRecognition;
};
import { GoogleGenAI } from '@google/genai';
import { CHAT_TREE } from './constants';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Message {
  id: string;
  text: string;
  sender: 'bot' | 'user';
  timestamp: Date;
  type?: 'ai' | 'static';
}

const createWelcomeMessage = (): Message => ({
  id: 'welcome-ai',
  text: 'اسلام علیکم! میں آپ کا ڈیجیٹل ہیلتھ مشیر ہوں۔ میں بچوں میں وقفہ، صحت اور خاندانی بہبود کے بارے میں آپ کے سوالات کے جواب دے سکتا ہوں۔\n\nآپ مجھ سے ان موضوعات پر پوچھ سکتے ہیں:\n- وقفہ کے مختلف طریقے\n- اسلام میں وقفہ کی اہمیت\n- غلط فہمیاں اور ان کی حقیقت\n- اعظم بستی اور مٹیاری میں سروسز\n\nآپ اپنا سوال لکھیں یا نیچے والا مائیک دبا کر بولیں۔',
  sender: 'bot',
  timestamp: new Date(),
  type: 'ai'
});

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeTab, setActiveTab] = useState<'topics' | 'chat'>('topics');
  const [breadcrumb, setBreadcrumb] = useState<string[]>(['start']);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [showVoiceConfirm, setShowVoiceConfirm] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [pendingSpeechId, setPendingSpeechId] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);
  const [isAutoVoiceEnabled, setIsAutoVoiceEnabled] = useState(true);
  const [isSpeechSupported, setIsSpeechSupported] = useState(true);
  const [isRecognitionSupported, setIsRecognitionSupported] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const isProcessingVoiceRef = useRef(false);
  const hasHydratedMessagesRef = useRef(false);

  const toggleSpeech = async (id: string, text: string) => {
    if (speakingMessageId === id || pendingSpeechId === id) {
      cancelSpeech();
      setSpeakingMessageId(null);
      setPendingSpeechId(null);
      return;
    }

    cancelSpeech();
    setSpeakingMessageId(null);
    setPendingSpeechId(id);

    try {
      primeSpeech();
      const outcome = await speakUrdu(
        text,
        () => {
          setPendingSpeechId(current => current === id ? null : current);
          setSpeakingMessageId(id);
        },
        () => {
          setPendingSpeechId(current => current === id ? null : current);
          setSpeakingMessageId(current => current === id ? null : current);
        }
      );

      if (outcome === 'unsupported' || outcome === 'failed') {
        setPendingSpeechId(current => current === id ? null : current);
        setSpeakingMessageId(current => current === id ? null : current);
      }
    } catch (error) {
      console.error('Speech toggle error:', error);
      setPendingSpeechId(current => current === id ? null : current);
      setSpeakingMessageId(current => current === id ? null : current);
    }
  };

  const testVoice = () => {
    toggleSpeech('test', 'خوش آمدید! یہ آواز چیک کرنے کے لیے ہے۔');
  };

  const addBotMessage = (text: string, type: 'ai' | 'static' = 'ai', speak: boolean = false) => {
    const id = Math.random().toString(36).substr(2, 9);
    setMessages(prev => [...prev, {
      id,
      text,
      sender: 'bot',
      timestamp: new Date(),
      type
    }]);
    if (speak) toggleSpeech(id, text);
  };

  const handleTopicClick = (nodeId: string, isBreadcrumbClick: boolean = false) => {
    const node = CHAT_TREE[nodeId];
    if (node) {
      if (isBreadcrumbClick) {
        const index = breadcrumb.indexOf(nodeId);
        if (index !== -1) {
          setBreadcrumb(prev => prev.slice(0, index + 1));
        }
      } else {
        if (!breadcrumb.includes(nodeId)) {
          setBreadcrumb(prev => [...prev, nodeId]);
        }
      }
      setActiveTopicId(nodeId);
      toggleSpeech(nodeId, node.text);
    }
  };
  const startListening = async () => {
    primeSpeech();

    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsRecognitionSupported(false);
      alert('یہ براؤزر آواز سے سوال پوچھنے کو سپورٹ نہیں کرتا۔ براہ کرم سوال لکھ کر بھیجیں، یا مائیک کے لیے Chrome / Edge استعمال کریں۔');
      return;
    }

    try {
      const isIpAddress = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(window.location.hostname);
      const isSecure = window.isSecureContext;
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

      if (!isSecure && !isLocal) {
        if (isIpAddress) {
          alert('آئی پی ایڈریس (IP Address) پر مائیکروفون کام نہیں کرتا۔ براہ کرم ایپ کا "Shared URL" استعمال کریں جو کہ محفوظ (HTTPS) ہے تاکہ مائیکروفون استعمال کیا جا سکے۔');
        } else {
          alert('آئی پی ایڈریس یا غیر محفوظ کنکشن پر مائیکروفون استعمال نہیں کیا جا سکتا۔ براہ کرم محفوظ (HTTPS) لنک کا استعمال کریں۔');
        }
        return;
      }

      // Explicitly check/prime microphone permission using getUserMedia
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
        } catch (err: any) {
          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.message?.includes('denied')) {
            alert('مائیکروفون تک رسائی بلاک ہے۔ براہ کرم براؤزر کی سیٹینگ میں جا کر مائیکروفون کو "Allow" کریں اور ریفریش کریں۔');
            return;
          }
          if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError' || err.message?.includes('not found') || err.message?.includes('device not found')) {
            alert('آپ کے فون یا کمپیوٹر میں مائیکروفون نہیں ملا۔ براہ کرم چیک کریں کہ مائیکروفون کام کر رہا ہے یا ہیڈ فون استعمال کریں۔');
            return;
          }
          // Only log unexpected errors
          console.error('Microphone access unexpected error:', err);
          return;
        }
      }
      
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.lang = 'ur-PK';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
        isProcessingVoiceRef.current = false;
        setShowVoiceConfirm(false);
        setInterimTranscript('');
        console.log('Speech recognition started');
      };

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        let interim = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }

        if (finalTranscript && !isProcessingVoiceRef.current) {
          isProcessingVoiceRef.current = true;
          console.log('Final Transcript detected:', finalTranscript);
          setInputValue(finalTranscript);
          setInterimTranscript('');
          
          // Small delay to ensure state is synchronized and user sees the text
          setTimeout(() => {
            sendMessage(finalTranscript);
          }, 500);

          if (recognitionRef.current) {
            recognitionRef.current.stop();
          }
        } else if (!isProcessingVoiceRef.current) {
          setInterimTranscript(interim);
        }
      };

      recognition.onerror = (event: any) => {
        setIsListening(false);
        setInterimTranscript('');
        
        if (event.error === 'not-allowed') {
          const isSecure = window.isSecureContext;
          const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
          
          if (!isSecure && !isLocal) {
            alert('براہ کرم محفوظ لنک (HTTPS) کا استعمال کریں کیونکہ مائیکروفون کی اجازت نہیں دی جا سکتی۔');
          } else {
            alert('مائیکروفون تک رسائی بلاک ہے۔ براہ کرم براؤزر کی سیٹینگ میں جا کر مائیکروفون کو "Allow" کریں اور ریفریش کریں۔');
          }
        } else if (event.error === 'no-speech') {
          console.log('No speech detected');
        } else if (event.error === 'aborted') {
          console.log('Recognition aborted');
        } else if (event.error === 'network') {
          alert('انٹرنیٹ کا مسئلہ ہے۔ براہ کرم اپنا کنکشن چیک کریں۔');
        } else {
          console.error('Speech recognition error:', event.error);
        }
      };

      recognition.onend = () => {
        console.log('Speech recognition session ended');
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognition.start();
    } catch (e) {
      console.error('Failed to start recognition:', e);
      setIsListening(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.style.height = '0px';
    inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 112)}px`;
  }, [inputValue]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setIsSpeechSupported(canUseSpeech() || Boolean(process.env.GEMINI_API_KEY));
    setIsRecognitionSupported(Boolean(SpeechRecognition));

    if (canUseSpeech()) {
      void loadVoices();
    }

    const unlockSpeech = () => primeSpeech();
    window.addEventListener('pointerdown', unlockSpeech, { passive: true });
    window.addEventListener('keydown', unlockSpeech);

    return () => {
      window.removeEventListener('pointerdown', unlockSpeech);
      window.removeEventListener('keydown', unlockSpeech);
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      cancelSpeech();
    };
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CHAT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Array<Omit<Message, 'timestamp'> & { timestamp: string }>;
        const restored = parsed
          .filter((message) => message?.id && message?.text && (message.sender === 'bot' || message.sender === 'user'))
          .map((message) => ({
            ...message,
            timestamp: new Date(message.timestamp || Date.now())
          }));

        setMessages(restored.length ? restored : [createWelcomeMessage()]);
      } else {
        setMessages([createWelcomeMessage()]);
      }
    } catch (error) {
      console.warn('Could not restore chat history:', error);
      setMessages([createWelcomeMessage()]);
    } finally {
      hasHydratedMessagesRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedMessagesRef.current || messages.length === 0) return;

    try {
      const compactMessages = messages.slice(-MAX_STORED_MESSAGES);
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(compactMessages));
    } catch (error) {
      console.warn('Could not save chat history:', error);
    }
  }, [messages]);

  const handleFeedbackSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedbackText.trim()) return;

    setIsSubmittingFeedback(true);
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    setIsSubmittingFeedback(false);
    setFeedbackSuccess(true);
    setFeedbackText('');
    
    // Auto close after 2 seconds
    setTimeout(() => {
      setIsFeedbackOpen(false);
      setFeedbackSuccess(false);
    }, 2000);
  };

  const sendMessage = async (userText: string) => {
    if (!userText.trim() || isTyping) return;

    setInputValue('');
    setShowVoiceConfirm(false);

    const botMessageId = Math.random().toString(36).substr(2, 9);
    
    // Check if we are coming from a topic for context
    const currentTopicContext = activeTopicId ? CHAT_TREE[activeTopicId] : null;

    setMessages(prev => [
      ...prev,
      {
        id: Math.random().toString(36).substr(2, 9),
        text: userText,
        sender: 'user',
        timestamp: new Date()
      }
    ]);

    setIsTyping(true);
    try {
      const modelName = "gemini-3-flash-preview"; 
      
      // Extract knowledge base from CHAT_TREE for context
      const knowledgeBase = Object.values(CHAT_TREE)
        .map(node => `موضوع: ${node.id}\nمواد: ${node.text}`)
        .join('\n---\n');

      const responseStream = await genAI.models.generateContentStream({
        model: modelName,
        contents: [
          {
            role: "user",
            parts: [{ text: userText }]
          }
        ],
        config: {
          systemInstruction: `آپ 'صحت مند گھر' (Sehat Mand Ghar) نامی ایک جدید ہیلتھ مشیر ہیں۔ آپ کا ہدف پاکستانی خاندانوں کو بچوں کی پیدائش میں مناسب وقفے، صحت، غذائیت اور خاندانی خوشحالی کے بارے میں اردو میں رہنمائی فراہم کرنا ہے۔

ایپ کا موجودہ ڈیٹا جس پر آپ کا جواب مبنی ہونا چاہیے:
${knowledgeBase}

${currentTopicContext ? `صارف فی الحال اس موضوع کو پڑھ رہا ہے: "${currentTopicContext.text}"۔ اگر ان کا سوال اس سے متعلق ہے تو اسے خاص طور پر مدنظر رکھیں۔` : ''}

قوانین:
1. ہمیشہ 'اردو' میں بات کریں۔
2. اگر معلومات اوپر دیے گئے ڈیٹا میں موجود ہے، تو اسے ترجیح دیں۔
3. جواب بہت مختصر، سادہ، دوستانہ اور مددگار ہونا چاہیے (زیادہ تر 2-3 جملے)۔ طبی اصطلاحات کو آسان اردو میں سمجھائیں۔
4. اگر کوئی ایسا سوال ہو جو ڈیٹا میں نہیں ہے، تو ایک عام ماہرانہ لیکن احتیاطی جواب دیں اور ڈاکٹر سے رجوع کرنے کا مشورہ دیں۔ 
5. آپ کا لہجہ ایک ہمدرد اور سمجھدار ماہر جیسا ہونا چاہیے۔
6. ہر جواب کے آخر میں (یا مناسب جگہ پر) یہ واضح کریں کہ حتمی فیصلہ ماہرِ صحت کے مشورے سے ہونا چاہیے۔`
        }
      });
      
      // Initialize empty bot message for streaming
      setMessages(prev => [
        ...prev,
        {
          id: botMessageId,
          text: '',
          sender: 'bot',
          timestamp: new Date(),
          type: 'ai'
        }
      ]);

      let fullText = '';
      for await (const chunk of responseStream) {
        const chunkText = chunk.text;
        if (chunkText) {
          fullText += chunkText;
          // Update the message text incrementally
          setMessages(prev => prev.map(msg => 
            msg.id === botMessageId ? { ...msg, text: fullText } : msg
          ));
        }
      }

      // Prepare audio as soon as the text is complete. This keeps repeat playback fast in the installed PWA.
      if (fullText && isSpeechSupported) {
        if (isAutoVoiceEnabled) {
          setPendingSpeechId(botMessageId);
          void speakUrdu(
            fullText,
            () => {
              setPendingSpeechId(current => current === botMessageId ? null : current);
              setSpeakingMessageId(botMessageId);
            },
            () => {
              setPendingSpeechId(current => current === botMessageId ? null : current);
              setSpeakingMessageId(current => current === botMessageId ? null : current);
            }
          ).then((outcome) => {
            if (outcome === 'unsupported') {
              setIsSpeechSupported(false);
            }
            if (outcome === 'failed' || outcome === 'unsupported') {
              setPendingSpeechId(current => current === botMessageId ? null : current);
              setSpeakingMessageId(current => current === botMessageId ? null : current);
            }
          });
        } else {
          void prefetchUrduAudio(fullText);
        }
      }
      
      if (!fullText) {
        setMessages(prev => prev.map(msg => 
          msg.id === botMessageId ? { ...msg, text: 'معذرت، میں ابھی جواب نہیں دے پا رہا۔' } : msg
        ));
      }
    } catch (error) {
      console.error('AI Error:', error);
      let errorMessage = 'معذرت، ابھی میں جواب نہیں دے پا رہا۔ براہ کرم تھوڑی دیر بعد کوشش کریں۔';
      const errStr = String(error);
      
      if (errStr.includes('403') || errStr.includes('API key')) {
        errorMessage = 'اے آئی سروس بند ہے۔ براہ کرم بعد میں چیک کریں۔';
      } else if (errStr.includes('fetch') || !window.navigator.onLine) {
        errorMessage = 'انٹرنیٹ چیک کریں اور دوبارہ کوشش کریں۔';
      }
      addBotMessage(errorMessage);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendMessage(inputValue);
  };

  const resetChat = () => {
    cancelSpeech();
    localStorage.removeItem(CHAT_STORAGE_KEY);
    setPendingSpeechId(null);
    setSpeakingMessageId(null);
    setMessages([createWelcomeMessage()]);
    setActiveTopicId(null);
    setBreadcrumb(['start']);
  };

  const getTopicTitle = (id: string) => {
    if (id === 'start') return 'ہوم';
    
    for (const node of Object.values(CHAT_TREE)) {
      const option = node.options.find(opt => opt.nextId === id);
      if (option) return option.label;
    }
    
    return 'معلومات';
  };

  return (
    <div className="fixed inset-0 h-[100dvh] max-h-[100dvh] flex flex-col bg-[#fdfdfd] text-slate-900 font-urdu overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: `
        :root {
          --safe-bottom: env(safe-area-inset-bottom, 0px);
        }
        @supports (-webkit-touch-callout: none) {
          .h-screen-ios { height: -webkit-fill-available; }
        }
      `}} />
      {/* Side Menu Drawer */}
      <AnimatePresence>
        {isMenuOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMenuOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed top-0 right-0 h-full w-[calc(100vw-1rem)] max-w-sm bg-white z-[101] shadow-2xl p-5 sm:p-8 flex flex-col gap-6 sm:gap-10 overflow-y-auto app-scroll"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black text-teal-900">مینیو</h2>
                <button onClick={() => setIsMenuOpen(false)} className="p-3 bg-slate-50 rounded-full">
                  <X className="w-6 h-6 text-slate-400" />
                </button>
              </div>

              <nav className="flex-1 space-y-4">
                <button 
                  onClick={() => { setIsMenuOpen(false); resetChat(); setActiveTab('topics'); }}
                  className="w-full flex items-center gap-4 p-5 bg-teal-50 text-teal-700 rounded-3xl font-black transition-all active:scale-95"
                >
                  <RefreshCcw className="w-6 h-6" />
                  ایپ ری سیٹ کریں
                </button>
                <button 
                  onClick={() => { setIsMenuOpen(false); setIsFeedbackOpen(true); }}
                  className="w-full flex items-center gap-4 p-5 bg-slate-50 text-slate-600 rounded-3xl font-black transition-all active:scale-95"
                >
                  <MessageSquare className="w-6 h-6" />
                  رائے دیں یا مسئلہ بتائیں
                </button>
                <div className="bg-orange-600 p-6 rounded-[32px] shadow-xl shadow-orange-900/20 active:scale-95 transition-all cursor-pointer" onClick={() => window.location.reload()}>
                   <p className="text-white text-md font-black flex items-center justify-center gap-2">
                     <RefreshCcw className="w-5 h-5 animate-spin-slow" />
                     تازہ ترین ورژن انسٹال کریں
                   </p>
                   <p className="text-orange-100 text-[10px] text-center mt-1">(Force Hard Refresh)</p>
                </div>
                <div className="pt-10 space-y-4">
                  <p className="text-[10px] text-slate-300 font-black uppercase tracking-widest px-2">Contact Us</p>
                  <div className="bg-slate-50 p-6 rounded-[32px] space-y-3">
                    <p className="text-sm font-bold text-slate-600">کسی بھی مدد کے لیے رابطہ کریں:</p>
                    <p className="text-lg font-black text-teal-800">0800-44444</p>
                  </div>
                </div>
              </nav>

              <div className="text-center pt-8 border-t border-slate-100">
                <p className="text-[10px] text-slate-400 font-sans font-black uppercase tracking-widest">Sehat Mand Ghar v7.2.0 (Expert Mic Calibration)</p>

              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className={cn(
        "flex-1 flex flex-col min-h-0 relative",
        activeTab === 'topics' && !activeTopicId ? "overflow-y-auto app-scroll" : "overflow-hidden"
      )}>
        {/* Persistent Header - Becomes compact on detail views */}
        <header className={cn(
          "bg-[#1a103d] text-white shadow-2xl relative overflow-hidden transition-all duration-700 shrink-0",
          (activeTopicId || activeTab === 'chat') ? "py-3 px-4 sm:py-4 sm:px-6" : "px-4 py-7 sm:p-10 md:p-14 lg:p-16 text-center"
        )}>
          <button 
            onClick={() => setIsMenuOpen(true)}
            className="absolute top-4 right-4 md:top-6 md:right-6 p-3 bg-white/10 hover:bg-white/20 rounded-xl backdrop-blur-md z-20 transition-all active:scale-90"
          >
            <Menu className="w-5 h-5 md:w-6 md:h-6" />
          </button>
          
          <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute top-[-10%] right-[-10%] w-96 h-96 bg-white rounded-full blur-3xl" />
            <div className="absolute bottom-[-10%] left-[-10%] w-64 h-64 bg-indigo-500 rounded-full blur-3xl" />
          </div>

          <div className={cn(
            "max-w-4xl mx-auto relative z-10 flex flex-col items-center gap-6 transition-all",
            (activeTopicId || activeTab === 'chat') && "flex-row items-center justify-start gap-4"
          )}>
            <motion.div 
              layout
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className={cn(
                "bg-white rounded-[28px] sm:rounded-[40px] overflow-hidden shadow-2xl border-4 border-white/20 transition-all shrink-0",
                (activeTopicId || activeTab === 'chat') ? "w-12 h-12 sm:w-14 sm:h-14 p-0.5 rounded-2xl" : "w-36 h-36 sm:w-52 sm:h-52 md:w-72 md:h-72 lg:w-80 lg:h-80 p-1.5 sm:p-2"
              )}
            >
              <img 
                src="/header_family.png" 
                alt="Family" 
                onError={(e) => {
                  e.currentTarget.onerror = null;
                  e.currentTarget.src = '/assets/images/family_comparison_pakistan.png';
                }}
                className="w-full h-full object-cover rounded-[32px] transition-all"
                style={{ borderRadius: (activeTopicId || activeTab === 'chat') ? '12px' : '32px' }}
                referrerPolicy="no-referrer"
              />
            </motion.div>
            
            <div className={cn("space-y-1 transition-all", (!activeTopicId && activeTab !== 'chat') && "space-y-2")}>
              <h1 className={cn("font-black text-white transition-all", (activeTopicId || activeTab === 'chat') ? "text-lg sm:text-xl md:text-2xl" : "text-3xl sm:text-4xl md:text-6xl")}>صحت مند گھر</h1>
              {(!activeTopicId && activeTab !== 'chat') && (
                <>
                  <p className="text-indigo-100 text-base sm:text-xl md:text-2xl font-medium opacity-90">آپ کا خاندان – آپ کا فیصلہ</p>
                  <p className="text-[10px] text-indigo-200/50 font-sans mt-2 bg-white/10 inline-block px-3 py-1 rounded-full border border-white/20">Build v7.2.0 • Expert Mic Calibration</p>
                </>
              )}
            </div>

            {(!activeTopicId && activeTab !== 'chat') && (
              <div className="pt-4 flex flex-col items-center gap-2">
                <button 
                  onClick={testVoice}
                  disabled={!isSpeechSupported}
                  className="group relative inline-flex items-center gap-3 px-6 sm:px-10 py-4 sm:py-5 bg-white text-teal-900 rounded-2xl sm:rounded-[24px] font-bold text-lg sm:text-xl md:text-2xl shadow-2xl hover:bg-teal-50 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Volume2 className="w-7 h-7" />
                  ٹیسٹ آواز (مفت) 🔊
                </button>
              </div>
            )}
          </div>
        </header>

        <main className={cn(
          "max-w-4xl mx-auto w-full flex-1 relative flex flex-col min-h-0",
          activeTab === 'topics' && !activeTopicId ? "px-3 sm:px-4 py-7 sm:py-10 pb-44 sm:pb-52" : "overflow-hidden px-3 sm:px-4 md:px-6 py-3 sm:py-4"
        )}>

          {activeTab === 'topics' ? (
            <AnimatePresence mode="wait">
              {!activeTopicId ? (
                <motion.section 
                  key="topic-list"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="space-y-8 sm:space-y-12"
                >

                  <div className="flex flex-col items-center text-center space-y-3 sm:space-y-4">
                    <h3 className="font-black text-2xl sm:text-3xl md:text-4xl text-slate-800">صحت کے اہم موضوعات</h3>
                    <div className="h-2 w-20 bg-teal-600 rounded-full"></div>
                    <p className="text-slate-500 text-base sm:text-lg md:text-xl font-medium leading-relaxed">نیچے دیے گئے کسی بھی کارڈ پر کلک کر کے معلومات حاصل کریں</p>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                    {[
                      { id: 'healthy_comparison', label: 'وقفہ کے فوائد (موازنہ)', icon: '🌟', color: 'bg-blue-600', sub: 'خاندان کی خوشحالی' },
                      { id: 'ai_chat_link', label: 'اے آئی مشیر سے پوچھیں', icon: '🤖', color: 'bg-indigo-600', sub: 'فوری سوال و جواب', special: true },
                      { id: 'methods', label: 'وقفہ کے طریقے', icon: 'pill', color: 'bg-teal-600', sub: 'محفوظ اور آسان طریقے' },
                      { id: 'religion', label: 'اسلام اور وقفہ', icon: '🌙', color: 'bg-emerald-600', sub: 'شرعی رہنمائی' },
                      { id: 'fp_services', label: 'وقفہ کی سروسز (سہولیات)', icon: '🏥', color: 'bg-cyan-600', sub: 'اعظم بستی اور مٹیاری' },
                      { id: 'myths', label: 'حقائق بمقابلہ غلط فہمیاں', icon: '🔍', color: 'bg-orange-600', sub: 'سچائی جانیے' },
                      { id: 'mens_role', label: 'خاندان کی خوشی اور مرد', icon: '🤝', color: 'bg-cyan-600', sub: 'ذمہ دارانہ کردار' },
                      { id: 'faq', label: 'عام پوچھے جانے والے سوالات', icon: '❓', color: 'bg-purple-600', sub: 'آپ کے سوالات' }
                    ].map((item) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          if (item.id === 'ai_chat_link') {
                            setActiveTab('chat');
                          } else {
                            handleTopicClick(item.id);
                          }
                        }}
                        className={cn(
                          "flex flex-col min-h-44 sm:min-h-56 p-5 sm:p-6 md:p-8 bg-white rounded-3xl md:rounded-[40px] border-2 border-slate-100 shadow-sm text-right transition-all group relative hover:shadow-xl hover:border-slate-200 active:scale-95",
                          item.id === 'ai_chat_link' ? "border-indigo-100 bg-indigo-50/30" : "",
                          activeTopicId === item.id ? "ring-4 ring-teal-500 border-teal-500" : ""
                        )}
                      >
                        <div className={cn(
                          "w-14 h-14 sm:w-16 sm:h-16 md:w-20 md:h-20 rounded-2xl md:rounded-[28px] flex items-center justify-center text-2xl sm:text-3xl md:text-4xl mb-4 sm:mb-6 shadow-lg group-hover:scale-105 transition-transform",
                          item.id === 'ai_chat_link' ? "bg-indigo-600 text-white" : "bg-white border-2 border-slate-50"
                        )}>
                          {item.id === 'methods' ? '💊' : item.icon}
                        </div>
                        <div className="space-y-2">
                          <h4 className={cn(
                            "font-black text-xl sm:text-2xl text-slate-800 leading-tight",
                            item.id === 'ai_chat_link' ? "text-indigo-900" : "group-hover:text-teal-900"
                          )}>{item.label}</h4>
                          <p className={cn(
                            "text-xs sm:text-sm font-bold opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity uppercase tracking-widest",
                            item.id === 'ai_chat_link' ? "text-indigo-400 opacity-100" : "text-slate-400"
                          )}>{item.sub}</p>
                        </div>
                        <div className="absolute top-5 left-5 sm:top-8 sm:left-8">
                          <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                            item.id === 'ai_chat_link' ? "bg-indigo-100 text-indigo-600" : (activeTopicId === item.id ? "bg-teal-600 text-white" : "bg-slate-50 text-slate-300")
                          )}>
                            {item.id === 'ai_chat_link' ? <MessageSquare className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  <footer className="bg-slate-50 border-t border-slate-200 py-8 sm:py-12 md:py-16 px-4 sm:px-6 text-center space-y-8 sm:space-y-12 rounded-3xl md:rounded-[40px] mt-8 sm:mt-12">
                    <div className="max-w-3xl mx-auto space-y-8 sm:space-y-12">
                      <div className="space-y-4 sm:space-y-6">
                        <div className="inline-flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-sm border border-slate-200">
                          <span className="w-3 h-3 bg-teal-500 rounded-full"></span>
                          <h4 className="font-black text-slate-800 text-base sm:text-lg italic">آف لائن موڈ (Offline Mode)</h4>
                        </div>
                        <p className="text-slate-600 leading-relaxed text-sm text-right">
                          یہ ایپ کی آواز (TTS) آپ کے موبائل کے اندر لگے اردو TTS انجن سے آتی ہے – انٹرنیٹ سے نہیں۔ Samsung اور Google TTS دونوں سپورٹڈ ہیں۔
                        </p>
                      </div>
                      <div className="bg-orange-50 border border-orange-100 p-4 sm:p-6 rounded-2xl sm:rounded-3xl text-[12px] text-orange-900 leading-relaxed shadow-sm">
                        <strong>ضروری نوٹ:</strong> یہ پلیٹ فارم صرف بچوں میں وقفہ کی بنیادی معلومات فراہم کرتا ہے۔ کوئی بھی طریقہ شروع کرنے سے پہلے ہمیشہ ڈاکٹر یا مستند لیڈی ہیلتھ ورکر سے رجوع کریں۔
                      </div>
                    </div>
                  </footer>
                </motion.section>
              ) : (
                <motion.div
                  key="topic-detail"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="bg-white border-2 sm:border-4 border-teal-600 rounded-3xl md:rounded-[48px] p-4 sm:p-6 md:p-10 shadow-2xl relative overflow-y-auto app-scroll min-h-0"
                >
                  <div className="flex items-center justify-between gap-3 mb-5 sm:mb-8 pb-4 sm:pb-6 border-b border-slate-100">
                    <button 
                      onClick={() => { setActiveTopicId(null); setBreadcrumb(['start']); }}
                      className="flex items-center gap-2 sm:gap-3 px-4 sm:px-6 py-3 sm:py-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black rounded-2xl transition-all active:scale-90 text-sm sm:text-base"
                    >
                      <ArrowLeft className="w-6 h-6" />
                      <span>واپس جائیں</span>
                    </button>
                    
                    <button 
                      onClick={() => { setActiveTopicId(null); setBreadcrumb(['start']); }}
                      className="p-3 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors shrink-0"
                    >
                      <X className="w-6 h-6 text-slate-400" />
                    </button>
                  </div>

                  <div className="space-y-6 sm:space-y-8">
                    {/* Breadcrumbs */}
                    <nav className="flex items-center gap-2 text-sm font-bold text-slate-400 overflow-x-auto no-scrollbar pb-2">
                      {breadcrumb.map((id, index) => (
                        <React.Fragment key={id}>
                          <button
                            onClick={() => handleTopicClick(id, true)}
                            className={cn(
                              "whitespace-nowrap transition-colors",
                              index === breadcrumb.length - 1 ? "text-teal-600 font-black" : "hover:text-slate-600"
                            )}
                          >
                            {getTopicTitle(id)}
                          </button>
                          {index < breadcrumb.length - 1 && <span className="text-slate-300">/</span>}
                        </React.Fragment>
                      ))}
                    </nav>

                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 sm:gap-6">
                      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                        <div className="w-12 h-12 sm:w-16 sm:h-16 bg-teal-50 rounded-2xl flex items-center justify-center text-2xl sm:text-3xl shrink-0">
                          📖
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-slate-800 leading-tight break-words">{getTopicTitle(activeTopicId)}</h2>
                      </div>
                      
                      <button 
                        onClick={() => toggleSpeech(activeTopicId, CHAT_TREE[activeTopicId].text)}
                        disabled={!isSpeechSupported}
                        className={cn(
                          "flex items-center justify-center gap-3 px-4 sm:px-6 py-3 sm:py-4 rounded-2xl sm:rounded-3xl transition-all font-black text-base sm:text-lg disabled:opacity-50 disabled:cursor-not-allowed",
                          speakingMessageId === activeTopicId ? "bg-teal-600 text-white shadow-lg animate-pulse" :
                          pendingSpeechId === activeTopicId ? "bg-teal-200 text-teal-900 shadow-sm animate-pulse" :
                          "bg-teal-100 text-teal-700 hover:bg-teal-200"
                        )}
                      >
                        <Volume2 className="w-6 h-6" />
                        <span>
                          {speakingMessageId === activeTopicId ? 'روکیں' :
                           pendingSpeechId === activeTopicId ? 'آواز تیار ہو رہی ہے...' :
                           'آواز میں سنیں'}
                        </span>
                      </button>
                    </div>

                    {CHAT_TREE[activeTopicId].image && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="w-full rounded-2xl sm:rounded-[32px] overflow-hidden border-4 border-slate-50 shadow-lg"
                      >
                        <img 
                          src={CHAT_TREE[activeTopicId].image} 
                          alt={CHAT_TREE[activeTopicId].imageAlt || "Topic Visual"} 
                          className="w-full h-auto object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </motion.div>
                    )}

                    <div className="text-lg sm:text-xl md:text-2xl leading-loose text-slate-800 font-bold whitespace-pre-line border-r-4 sm:border-r-8 border-teal-600 pr-4 sm:pr-6 break-words">
                      {CHAT_TREE[activeTopicId].text}
                    </div>

                    {/* Sub-topics / Related Links */}
                    {CHAT_TREE[activeTopicId].options && CHAT_TREE[activeTopicId].options.length > 0 && (
                      <div className="pt-6 sm:pt-10 border-t border-slate-100 space-y-4 sm:space-y-6">
                        <p className="text-sm font-black text-slate-400 uppercase tracking-widest px-2">مزید متعلقہ معلومات:</p>
                        <div className="flex flex-wrap gap-3 sm:gap-4">
                          {CHAT_TREE[activeTopicId].options.map((opt) => (
                            <button
                              key={opt.id}
                              onClick={() => {
                                if (opt.nextId === 'start') {
                                  setActiveTopicId(null);
                                } else if (opt.nextId === 'ai_chat') {
                                  setActiveTab('chat');
                                  setActiveTopicId(null);
                                } else if (opt.nextId) {
                                  handleTopicClick(opt.nextId);
                                }
                              }}
                              className="w-full sm:w-auto justify-between sm:justify-start px-5 sm:px-8 py-4 sm:py-5 bg-slate-50 text-teal-800 rounded-2xl sm:rounded-[28px] font-black border-2 border-slate-100 hover:bg-teal-50 hover:border-teal-200 transition-all active:scale-95 text-base sm:text-xl shadow-sm flex items-center gap-3"
                            >
                              <span>{opt.label}</span>
                              <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-sm">
                                <Volume2 className="w-4 h-4 text-teal-400" />
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          ) : (
            <section id="chat" className="flex flex-col flex-1 min-h-0 bg-white relative overflow-hidden rounded-t-3xl sm:rounded-none">
              <div className={cn(
                "flex-1 overflow-y-auto chat-scroll p-3 sm:p-4 md:p-6 space-y-4 sm:space-y-6 scroll-smooth",
                messages.length === 0 ? "flex flex-col items-center justify-center text-center" : "pb-4 sm:pb-6"
              )}>

                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center space-y-4 animate-in fade-in zoom-in duration-500 px-3">
                    <div className="w-20 h-20 sm:w-24 sm:h-24 bg-indigo-600 text-white rounded-[28px] sm:rounded-[32px] flex items-center justify-center shadow-2xl shadow-indigo-200 rotate-3">
                      <Bot className="w-10 h-10 sm:w-12 sm:h-12" />
                    </div>
                    <div className="space-y-4">
                      <h3 className="text-2xl sm:text-3xl font-black text-slate-800 italic">سوال پوچھیں (AI Assistant)</h3>
                      <p className="text-slate-500 text-base sm:text-lg leading-relaxed">اپنا سوال لکھیں یا نیچے والے مائیک بٹن سے بولیں</p>
                      
                      <button 
                        onClick={() => setIsAutoVoiceEnabled(!isAutoVoiceEnabled)}
                        disabled={!isSpeechSupported}
                        className={cn(
                          "inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed",
                          isAutoVoiceEnabled ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"
                        )}
                      >
                        <Volume2 className={cn("w-4 h-4", isAutoVoiceEnabled && "animate-pulse")} />
                        <span>{isAutoVoiceEnabled ? "خودکار آواز آن ہے" : "آواز بند ہے"}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <AnimatePresence mode="popLayout">
                    {messages.map((msg) => (
                      <motion.div
                        key={msg.id}
                        layout
                        initial={{ opacity: 0, x: msg.sender === 'user' ? -20 : 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        className={cn(
                          "flex gap-3",
                          msg.sender === 'user' ? "justify-start" : "justify-end"
                        )}
                      >
                        <div className={cn(
                          "max-w-[92%] sm:max-w-[85%] p-3 sm:p-4 rounded-2xl sm:rounded-3xl text-base sm:text-lg md:text-xl leading-relaxed shadow-sm border break-words",
                          msg.sender === 'user' ? "bg-white border-slate-100" : "bg-indigo-600 text-white border-indigo-500"
                        )}>

                          {msg.text.split('\n').map((line, i) => (
                            <p key={i} className={i > 0 ? "mt-2" : ""}>{line}</p>
                          ))}
                          
                          {msg.sender === 'bot' && (
                            <button 
                              onClick={() => toggleSpeech(msg.id, msg.text)}
                              disabled={!isSpeechSupported || !msg.text}
                              className={cn(
                                "mt-3 flex items-center gap-2 px-3 py-1.5 rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed",
                                speakingMessageId === msg.id ? "bg-white text-indigo-700" :
                                pendingSpeechId === msg.id ? "bg-white/80 text-indigo-700 animate-pulse" :
                                "bg-indigo-700/30 text-white hover:bg-indigo-700/50"
                              )}
                            >
                              <Volume2 className={cn("w-4 h-4", (speakingMessageId === msg.id || pendingSpeechId === msg.id) && "animate-pulse")} />
                              <span className="text-[10px] uppercase font-black">
                                {speakingMessageId === msg.id ? "Stop" : pendingSpeechId === msg.id ? "Loading" : "Listen"}
                              </span>
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}

                {isTyping && (
                   <div className="flex justify-end pr-4">
                     <div className="flex gap-1.5 pt-2">
                       <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                       <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                       <div className="w-2.5 h-2.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
                     </div>
                   </div>
                )}
                <div ref={messagesEndRef} className="h-4" />
              </div>

              {/* Chat Input Area */}
              <div className="shrink-0 border-t border-slate-100 bg-white/95 backdrop-blur p-3 sm:p-4 pb-[calc(0.75rem+var(--safe-bottom))] z-10 shadow-[0_-12px_32px_rgba(15,23,42,0.06)]">
                <div className="max-w-4xl mx-auto">
                    <form 
                      onSubmit={handleSendMessage} 
                      className="flex items-end gap-1.5 sm:gap-2 p-1.5 sm:p-2 bg-white shadow-[0_10px_40px_rgba(0,0,0,0.1)] rounded-2xl sm:rounded-[32px] border border-slate-100 focus-within:border-indigo-400 transition-all pl-2 sm:pl-3"
                    >
                      <button
                        type="submit"
                        disabled={!inputValue.trim()}
                        className={cn(
                          "w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all bg-indigo-600 text-white shadow-lg active:scale-90 shrink-0",
                          !inputValue.trim() && "opacity-20 scale-90 grayscale"
                        )}
                      >
                        <Send className="w-5 h-5 -rotate-45" />
                      </button>

                      <textarea
                        ref={inputRef}
                        rows={1}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void sendMessage(inputValue);
                          }
                        }}
                        placeholder="اپنا سوال لکھیں..."
                        className="flex-1 min-h-10 sm:min-h-12 max-h-28 resize-none overflow-y-auto bg-transparent border-none focus:ring-0 text-base sm:text-lg md:text-xl font-bold leading-loose py-1.5 sm:py-2 px-2 text-right dir-rtl outline-none min-w-0"
                      />

                      <button
                        type="button"
                        onClick={() => setIsAutoVoiceEnabled(!isAutoVoiceEnabled)}
                        disabled={!isSpeechSupported}
                        className={cn(
                          "w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all shrink-0 disabled:opacity-50 disabled:cursor-not-allowed",
                          isAutoVoiceEnabled ? "bg-teal-50 text-teal-600" : "bg-slate-50 text-slate-400"
                        )}
                      >
                        <Volume2 className={cn("w-5 h-5", isAutoVoiceEnabled && "animate-pulse")} />
                      </button>

                      <button
                        type="button"
                        onClick={startListening}
                        disabled={isTyping || !isRecognitionSupported}
                        className={cn(
                          "w-10 h-10 sm:w-12 sm:h-12 rounded-full flex items-center justify-center transition-all shrink-0",
                          isListening ? "bg-red-500 text-white animate-pulse" : 
                          (isTyping || !isRecognitionSupported) ? "bg-slate-50 text-slate-300 cursor-not-allowed" : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
                        )}
                      >
                        {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                      </button>
                    </form>
                    {isListening && (
                      <div className="mt-2 text-center">
                        <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest animate-pulse">سن رہا ہوں...</p>
                        {interimTranscript && <p className="text-slate-400 text-sm mt-1">"{interimTranscript}"</p>}
                      </div>
                    )}
                </div>
              </div>
            </section>
          )}
        </main>
      </div>


      {/* Floating Action Button (Ask AI) */}
      <AnimatePresence>
        {activeTab === 'topics' && (
          <motion.button
            initial={{ scale: 0, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0, opacity: 0, y: 20 }}
            onClick={() => setActiveTab('chat')}
            className="fixed bottom-[calc(5.75rem+var(--safe-bottom))] sm:bottom-[calc(6.75rem+var(--safe-bottom))] right-4 sm:right-6 w-14 h-14 sm:w-16 sm:h-16 bg-indigo-600 text-white rounded-full shadow-2xl z-[55] flex flex-col items-center justify-center gap-1 active:scale-90 transition-all border-4 border-white shadow-indigo-200"
          >
            <Bot className="w-7 h-7 sm:w-8 sm:h-8" />
          </motion.button>
        )}
      </AnimatePresence>


      {/* Persistent Bottom Nav Tab Bar */}
      <nav className="h-[calc(4.75rem+var(--safe-bottom))] sm:h-[calc(5.75rem+var(--safe-bottom))] shrink-0 bg-white border-t border-slate-100 px-4 sm:px-8 pb-[calc(0.5rem+var(--safe-bottom))] sm:pb-[calc(1rem+var(--safe-bottom))] flex justify-around items-center z-[60] shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
        <button 
          onClick={() => setActiveTab('topics')}
          className={cn(
            "flex flex-col items-center gap-0.5 group transition-all",
            activeTab === 'topics' ? "text-teal-600" : "text-slate-400 opacity-60"
          )}
        >
          <div className={cn(
            "p-2 rounded-xl transition-colors",
            activeTab === 'topics' ? "bg-teal-50" : "group-hover:bg-slate-50"
          )}>
            <Menu className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-widest leading-none">موضوعات</span>
        </button>
        
        <div className="relative">
          <button 
            onClick={() => setActiveTab('chat')}
            className={cn(
              "w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center -mt-10 sm:-mt-16 border-4 sm:border-8 border-[#fdfdfd] shadow-xl transition-all active:scale-90",
              activeTab === 'chat' ? "bg-indigo-600 shadow-indigo-200" : "bg-slate-400 shadow-slate-200"
            )}
          >
            <Bot className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
          </button>
        </div>

        <button 
          onClick={() => setActiveTab('chat')}
          className={cn(
            "flex flex-col items-center gap-0.5 group transition-all",
            activeTab === 'chat' ? "text-indigo-600" : "text-slate-400 opacity-60"
          )}
        >
          <div className={cn(
            "p-2 rounded-xl transition-colors",
            activeTab === 'chat' ? "bg-indigo-50" : "group-hover:bg-slate-50"
          )}>
            <MessageCircle className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-widest leading-none">چیٹ</span>
        </button>
      </nav>

      {/* Feedback Modal */}
      <AnimatePresence>
        {isFeedbackOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !isSubmittingFeedback && setIsFeedbackOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-md z-[110]"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-1.5rem)] max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto app-scroll bg-white rounded-3xl md:rounded-[48px] p-5 sm:p-8 md:p-12 z-[111] shadow-2xl border-4 border-slate-50"
            >
              {feedbackSuccess ? (
                  <div className="text-center py-8 sm:py-12 space-y-6">
                    <div className="w-20 h-20 sm:w-24 sm:h-24 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center text-4xl sm:text-5xl mx-auto animate-bounce">
                      ✅
                    </div>
                    <h2 className="text-2xl sm:text-3xl font-black text-slate-800">شکریہ!</h2>
                    <p className="text-base sm:text-xl text-slate-500 font-bold leading-relaxed">آپ کی رائے ہمیں موصول ہو گئی ہے اور یہ ہماری بہت مدد کرے گی۔</p>
                </div>
              ) : (
                <form onSubmit={handleFeedbackSubmit} className="space-y-6 sm:space-y-8">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-5 sm:pb-6">
                    <div className="flex items-center gap-3 sm:gap-4">
                      <div className="w-12 h-12 sm:w-14 sm:h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center shrink-0">
                        <MessageSquare className="w-6 h-6 sm:w-7 sm:h-7" />
                      </div>
                      <h2 className="text-xl sm:text-2xl font-black text-slate-800">آپ کی رائے</h2>
                    </div>
                    <button 
                      type="button"
                      disabled={isSubmittingFeedback}
                      onClick={() => setIsFeedbackOpen(false)}
                      className="p-3 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors"
                    >
                      <X className="w-6 h-6 text-slate-400" />
                    </button>
                  </div>

                  <div className="space-y-3">
                    <label className="text-sm font-black text-slate-400 uppercase tracking-widest block px-2">Suggestions or Issues</label>
                    <textarea 
                      required
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      disabled={isSubmittingFeedback}
                      placeholder="اپنا پیغام یہاں لکھیں..."
                      className="w-full h-40 sm:h-48 p-4 sm:p-6 bg-slate-50 border-2 border-slate-100 rounded-2xl sm:rounded-[32px] outline-none focus:border-indigo-200 focus:bg-white transition-all text-base sm:text-xl md:text-2xl font-bold resize-none scroll-smooth"
                    />
                  </div>

                  <button 
                    type="submit"
                    disabled={isSubmittingFeedback || !feedbackText.trim()}
                    className="w-full py-4 sm:py-6 bg-indigo-600 text-white rounded-2xl sm:rounded-[32px] font-black text-xl sm:text-2xl shadow-2xl shadow-indigo-200 hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-4 group"
                  >
                    {isSubmittingFeedback ? (
                      <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>
                        <span>پیغام بھیجیں</span>
                        <Send className="w-7 h-7 -rotate-90 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                      </>
                    )}
                  </button>
                </form>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
