/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Send, 
  User, 
  Bot, 
  RefreshCcw, 
  Info, 
  MessageCircle, 
  Heart, 
  Volume2,
  Mic,
  MicOff,
  Menu,
  X,
  MessageSquare
} from 'lucide-react';

// Speech Utility
const speakUrdu = (text: string, onStart?: () => void, onEnd?: () => void) => {
  if (!window.speechSynthesis) return;
  
  // Stop any current speaking
  window.speechSynthesis.cancel();

  // Better phonetic mapping for Urdu TTS engines for medical terms and acronyms
  const processedText = text
    .replace(/IUD/gi, 'آئی یو ڈی')
    .replace(/ایف پی/gi, 'بچوں میں وقفہ') // Updated terminology
    .replace(/FP/gi, 'ایف پی')
    .replace(/\bAI\b/g, 'اے آئی')
    .replace(/\n/g, '۔ ') // Ensure pauses between lines
    .replace(/[.!?]/g, '۔ ');

  const utterance = new SpeechSynthesisUtterance(processedText);
  utterance.lang = 'ur-PK';
  
  // Try to find the best Urdu voice
  const voices = window.speechSynthesis.getVoices();
  const urVoices = voices.filter(v => v.lang.startsWith('ur'));
  
  // Preference: Google Urdu (high quality), then any ur-PK, then first available ur
  const bestVoice = urVoices.find(v => v.name.includes('Google')) || urVoices.find(v => v.lang === 'ur-PK') || urVoices[0];
  if (bestVoice) utterance.voice = bestVoice;
  
  // Adjusted for medical context and clarity
  utterance.rate = 0.85; 
  utterance.pitch = 1.05;
  utterance.volume = 1.0;

  if (onStart) utterance.onstart = onStart;
  if (onEnd) {
    utterance.onend = onEnd;
    utterance.onerror = onEnd;
  }

  window.speechSynthesis.speak(utterance);
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
import { CHAT_TREE, ChatNode } from './constants';
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

const INITIAL_NODE = 'start';

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string>(INITIAL_NODE);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeTab, setActiveTab] = useState<'topics' | 'chat'>('topics');
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<string[]>(['start']);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [showVoiceConfirm, setShowVoiceConfirm] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const toggleSpeech = (id: string, text: string) => {
    if (speakingMessageId === id) {
      window.speechSynthesis.cancel();
      setSpeakingMessageId(null);
    } else {
      speakUrdu(
        text, 
        () => setSpeakingMessageId(id),
        () => setSpeakingMessageId(null)
      );
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
  const startListening = () => {
    if (isListening) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('براہ کرم گوگل کروم (Chrome) استعمال کریں، آپ کا براؤزر آواز پہچاننے کی صلاحیت نہیں رکھتا۔');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'ur-PK';
      recognition.interimResults = true;
      recognition.continuous = false;

      recognition.onstart = () => {
        setIsListening(true);
        setShowVoiceConfirm(false);
        setInterimTranscript('');
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

        if (finalTranscript) {
          setInputValue(finalTranscript);
          setInterimTranscript('');
          setShowVoiceConfirm(true);
        } else {
          setInterimTranscript(interim);
        }
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
        setInterimTranscript('');
        
        if (event.error === 'not-allowed') {
          alert('براہ کرم مائیکروفون کے استعمال کی اجازت دیں۔');
        } else if (event.error === 'no-speech' || event.error === 'aborted') {
          // Normal cases
        } else {
          alert('آواز پہچاننے میں مسئلہ ہوا: ' + event.error);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
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
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Initial setup
    setMessages([
      {
        id: 'welcome',
        text: CHAT_TREE[INITIAL_NODE].text,
        sender: 'bot',
        timestamp: new Date(),
        type: 'static'
      }
    ]);
  }, []);

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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const userText = inputValue.trim();
    setInputValue('');
    setShowVoiceConfirm(false);

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
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      
      const prompt = `
        آپ بچوں میں وقفہ (Child Spacing) کے ماہر ہیں۔ 
        پاکستان کے مخصوص سماجی اور طبی تناظر میں مختصر اور جامع جواب اردو میں دیں۔ 
        اگر سوال بچوں میں وقفہ سے متعلق نہ ہو تو معذرت کریں۔
        صارف کا سوال: ${userText}
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt
      });
      
      const text = response.text || 'معذرت، میں ابھی جواب نہیں دے پا رہا۔';
      addBotMessage(text, 'ai');
    } catch (error) {
      console.error('AI Error:', error);
      let errorMessage = 'معذرت، ابھی میں جواب نہیں دے پا رہا۔ براہ کرم تھوڑی دیر بعد کوشش کریں۔';
      const errStr = String(error);
      if (errStr.includes('fetch') || !window.navigator.onLine) {
        errorMessage = 'انٹرنیٹ چیک کریں اور دوبارہ کوشش کریں۔';
      }
      addBotMessage(errorMessage);
    } finally {
      setIsTyping(false);
    }
  };

  const resetChat = () => {
    setMessages([{
      id: 'welcome',
      text: CHAT_TREE[INITIAL_NODE].text,
      sender: 'bot',
      timestamp: new Date(),
      type: 'static'
    }]);
    setCurrentNodeId(INITIAL_NODE);
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

  const currentNode = CHAT_TREE[currentNodeId];

  return (
    <div className="flex flex-col h-full bg-[#fdfdfd] text-slate-900 font-urdu relative overflow-hidden">
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
              className="fixed top-0 right-0 h-full w-[85%] max-w-sm bg-white z-[101] shadow-2xl p-8 flex flex-col gap-10"
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
                <p className="text-[10px] text-slate-400 font-sans font-black uppercase tracking-widest">Sehat Mand Ghar v4.1.0 (Deep Refresh)</p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto no-scrollbar">
        {/* Persistent Header */}
        <header className="bg-[#1a103d] text-white p-10 md:p-16 shadow-2xl relative overflow-hidden text-center">
          <button 
            onClick={() => setIsMenuOpen(true)}
            className="absolute top-8 right-8 p-4 bg-white/10 hover:bg-white/20 rounded-2xl backdrop-blur-md z-20 transition-all active:scale-90"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute top-[-10%] right-[-10%] w-96 h-96 bg-white rounded-full blur-3xl animate-pulse" />
            <div className="absolute bottom-[-10%] left-[-10%] w-64 h-64 bg-indigo-500 rounded-full blur-3xl" />
          </div>
          <div className="max-w-4xl mx-auto relative z-10 flex flex-col items-center gap-6">
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white/10 p-5 rounded-[40px] backdrop-blur-md border border-white/20 shadow-2xl"
            >
              <Heart className="w-12 h-12 text-white fill-white/80" />
            </motion.div>
            <div className="space-y-2">
            <h1 className="text-4xl md:text-6xl font-black tracking-tighter text-white">صحت مند گھر</h1>
            <p className="text-indigo-100 text-xl md:text-2xl font-medium opacity-90">آپ کا خاندان – آپ کا فیصلہ</p>
            <p className="text-[10px] text-indigo-200/50 font-sans mt-2 bg-white/10 inline-block px-3 py-1 rounded-full border border-white/20">Build v4.1.0 • Religious Content Verified</p>
          </div>
            <div className="pt-4 flex flex-col items-center gap-2">
              <button 
                onClick={testVoice}
                className="group relative inline-flex items-center gap-3 px-10 py-5 bg-white text-teal-900 rounded-[24px] font-bold text-2xl shadow-2xl hover:bg-teal-50 transition-all active:scale-95"
              >
                <Volume2 className="w-7 h-7" />
                ٹیسٹ آواز (مفت) 🔊
              </button>
              <span className="text-[10px] text-teal-200 font-sans uppercase font-black tracking-widest mt-2">Test Urdu Voice System</span>
            </div>
          </div>
        </header>

        <main className="max-w-4xl mx-auto w-full px-4 py-12 pb-32">
          {activeTab === 'topics' ? (
            <section id="topics" className="space-y-10 animate-in fade-in duration-500">
              <div className="flex flex-col items-center text-center space-y-4">
                <h3 className="font-black text-4xl text-slate-800 tracking-tight">صحت کے اہم موضوعات</h3>
                <div className="h-2 w-20 bg-teal-600 rounded-full"></div>
                <p className="text-slate-500 text-xl font-medium">نیچے دیے گئے کسی بھی کارڈ پر کلک کر کے معلومات حاصل کریں</p>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {[
                  { id: 'healthy_comparison', label: 'وقفہ کے فوائد (موازنہ)', icon: '🌟', color: 'bg-blue-600', sub: 'خاندان کی خوشحالی' },
                  { id: 'methods', label: 'وقفہ کے طریقے', icon: '💊', color: 'bg-teal-600', sub: 'محفوظ اور آسان طریقے' },
                  { id: 'religion', label: 'اسلام اور وقفہ', icon: '🌙', color: 'bg-emerald-600', sub: 'شرعی رہنمائی' },
                  { id: 'fp_services', label: 'وقفہ کی سروسز (سہولیات)', icon: '🏥', color: 'bg-cyan-600', sub: 'اعظم بستی اور مٹیاری' },
                  { id: 'myths', label: 'حقائق بمقابلہ غلط فہمیاں', icon: '🔍', color: 'bg-orange-600', sub: 'سچائی جانیے' },
                  { id: 'mens_role', label: 'خاندان کی خوشی اور مرد', icon: '🤝', color: 'bg-cyan-600', sub: 'ذمہ دارانہ کردار' },
                  { id: 'faq', label: 'عام پوچھے جانے والے سوالات', icon: '❓', color: 'bg-purple-600', sub: 'آپ کے سوالات' }
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => handleTopicClick(item.id)}
                    className={cn(
                      "flex flex-col p-8 bg-white rounded-[40px] border-2 border-slate-100 shadow-sm text-right transition-all group relative hover:shadow-xl hover:border-slate-200 active:scale-95",
                      activeTopicId === item.id ? "ring-4 ring-teal-500 border-teal-500" : ""
                    )}
                  >
                    <div className={cn(
                      "w-20 h-20 rounded-[28px] flex items-center justify-center text-4xl mb-6 shadow-lg group-hover:scale-110 transition-transform",
                      "bg-white border-2 border-slate-50"
                    )}>
                      {item.icon}
                    </div>
                    <div className="space-y-2">
                      <h4 className="font-black text-2xl text-slate-800 group-hover:text-teal-900 leading-tight">{item.label}</h4>
                      <p className="text-slate-400 text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-widest">{item.sub}</p>
                    </div>
                    <div className="absolute top-8 left-8">
                      <div className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                        activeTopicId === item.id ? "bg-teal-600 text-white" : "bg-slate-50 text-slate-300"
                      )}>
                        <Volume2 className="w-4 h-4" />
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Active Topic Detail View */}
              <AnimatePresence mode="wait">
                {activeTopicId && (
                  <motion.div
                    key={activeTopicId}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white border-4 border-teal-600 rounded-[48px] p-10 shadow-2xl relative overflow-hidden"
                  >
                    <div className="absolute top-0 right-0 p-6 flex gap-2">
                       <button 
                        onClick={() => { setActiveTopicId(null); setBreadcrumb(['start']); }}
                        className="p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors"
                       >
                         <X className="w-5 h-5 text-slate-500" />
                       </button>
                    </div>
                    <div className="space-y-8">
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

                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 bg-teal-50 rounded-2xl flex items-center justify-center text-3xl">
                          📖
                        </div>
                        <button 
                          onClick={() => toggleSpeech(activeTopicId, CHAT_TREE[activeTopicId].text)}
                          className={cn(
                            "flex items-center gap-3 px-6 py-3 rounded-full transition-all font-bold",
                            speakingMessageId === activeTopicId ? "bg-teal-600 text-white shadow-lg animate-pulse" : "bg-teal-100 text-teal-700 hover:bg-teal-200"
                          )}
                        >
                          <Volume2 className="w-5 h-5" />
                          <span>{speakingMessageId === activeTopicId ? 'آواز چل رہی ہے...' : 'آواز میں سنیں'}</span>
                        </button>
                      </div>

                      {CHAT_TREE[activeTopicId].image && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="w-full rounded-[32px] overflow-hidden border-4 border-slate-50 shadow-lg"
                        >
                          <img 
                            src={CHAT_TREE[activeTopicId].image} 
                            alt={CHAT_TREE[activeTopicId].imageAlt || "Topic Visual"} 
                            className="w-full h-auto object-cover"
                            referrerPolicy="no-referrer"
                          />
                        </motion.div>
                      )}

                      <div className="text-2xl md:text-3xl leading-relaxed text-slate-800 font-bold whitespace-pre-line border-r-8 border-teal-600 pr-6">
                        {CHAT_TREE[activeTopicId].text}
                      </div>

                      {/* Sub-topics / Related Links */}
                      {CHAT_TREE[activeTopicId].options && CHAT_TREE[activeTopicId].options.length > 0 && (
                        <div className="pt-10 border-t border-slate-100 space-y-6">
                          <p className="text-sm font-black text-slate-400 uppercase tracking-widest px-2">مزید متعلقہ معلومات:</p>
                          <div className="flex flex-wrap gap-4">
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
                                className="px-8 py-5 bg-slate-50 text-teal-800 rounded-[28px] font-black border-2 border-slate-100 hover:bg-teal-50 hover:border-teal-200 transition-all active:scale-95 text-xl shadow-sm flex items-center gap-3"
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

              {/* Footer inside topics for long scroll */}
              <footer className="bg-slate-50 border-t border-slate-200 py-16 px-6 text-center space-y-12 rounded-[40px]">
                <div className="max-w-3xl mx-auto space-y-12">
                  {/* Offline Mode Info */}
                  <div className="space-y-6">
                    <div className="inline-flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-sm border border-slate-200">
                      <span className="w-3 h-3 bg-teal-500 rounded-full"></span>
                      <h4 className="font-black text-slate-800 text-lg italic">آف لائن موڈ (Offline Mode)</h4>
                    </div>
                    <p className="text-slate-600 leading-relaxed text-sm text-right">
                      یہ ایپ کی آواز (TTS) آپ کے موبائل کے اندر لگے اردو TTS انجن سے آتی ہے – انٹرنیٹ سے نہیں۔ Samsung اور Google TTS دونوں سپورٹڈ ہیں۔
                    </p>
                  </div>
                  <div className="bg-orange-50 border border-orange-100 p-6 rounded-3xl text-[12px] text-orange-900 leading-relaxed shadow-sm">
                    <strong>ضروری نوٹ:</strong> یہ پلیٹ فارم صرف بچوں میں وقفہ کی بنیادی معلومات فراہم کرتا ہے۔ کوئی بھی طریقہ شروع کرنے سے پہلے ہمیشہ ڈاکٹر یا مستند لیڈی ہیلتھ ورکر سے رجوع کریں۔
                  </div>
                </div>
              </footer>
            </section>
          ) : (
            <section id="chat" className="space-y-12 animate-in fade-in duration-500 min-h-[60vh] pb-60">
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="w-24 h-24 bg-indigo-600 text-white rounded-[32px] flex items-center justify-center shadow-2xl shadow-indigo-200 rotate-3">
                  <Bot className="w-12 h-12" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-4xl font-black text-slate-800 italic">سوال پوچھیں (AI Assistant)</h3>
                  <p className="text-slate-500 text-lg">اپنا سوال لکھیں یا نیچے والے مائیک بٹن سے بولیں</p>
                </div>
              </div>

              {/* Chat Container */}
              <div className="bg-slate-50/50 rounded-[40px] p-4 md:p-8 min-h-[400px] border-2 border-slate-100 relative shadow-inner">
                <div className="space-y-6 pb-24">
                  {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-slate-400 opacity-60">
                       <MessageCircle className="w-12 h-12 mb-4" />
                       <p className="font-bold text-center">چیٹ شروع کریں، آپ کی بات خفیہ رہے گی</p>
                    </div>
                  )}
                  
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
                          "max-w-[85%] p-6 rounded-[32px] text-lg md:text-xl leading-relaxed shadow-xl border-2",
                          msg.sender === 'user' ? "bg-white border-slate-100" : "bg-[#0f766e] text-white border-teal-500"
                        )}>
                          {msg.text.split('\n').map((line, i) => (
                            <p key={i} className={i > 0 ? "mt-3" : ""}>{line}</p>
                          ))}
                          
                          {msg.sender === 'bot' && (
                            <button 
                              onClick={() => toggleSpeech(msg.id, msg.text)}
                              className={cn(
                                "mt-4 flex items-center gap-2 px-3 py-1.5 rounded-full transition-all",
                                speakingMessageId === msg.id ? "bg-white text-teal-700" : "bg-teal-700/30 text-white hover:bg-teal-700/50"
                              )}
                            >
                              <Volume2 className={cn("w-4 h-4", speakingMessageId === msg.id && "animate-pulse")} />
                              <span className="text-[10px] uppercase font-black">{speakingMessageId === msg.id ? "Playing" : "Listen"}</span>
                            </button>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>

                  {isTyping && (
                     <div className="flex justify-end pr-4">
                       <div className="flex gap-1.5 pt-2">
                         <div className="w-2.5 h-2.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                         <div className="w-2.5 h-2.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                         <div className="w-2.5 h-2.5 bg-teal-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
                       </div>
                     </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Floating Smart Input Dock (Only in Chat Tab) */}
      <AnimatePresence>
        {activeTab === 'chat' && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-24 left-0 right-0 p-4 z-50 pointer-events-auto"
          >
            <div className="max-w-4xl mx-auto">
              <AnimatePresence>
                {showVoiceConfirm && inputValue && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="mb-4 p-4 bg-teal-50 border-2 border-teal-200 rounded-[30px] flex items-center justify-between gap-4 shadow-2xl backdrop-blur-xl"
                  >
                    <span className="text-sm font-bold text-teal-800 pr-2">کیا آپ یہی کہنا چاہتے ہیں؟</span>
                    <div className="flex gap-2">
                      <button onClick={() => { setInputValue(''); setShowVoiceConfirm(false); startListening(); }} className="px-5 py-2.5 bg-white text-teal-700 text-xs font-black rounded-2xl border border-teal-100 shadow-sm">دوبارہ بولیں</button>
                      <button onClick={() => setShowVoiceConfirm(false)} className="px-5 py-2.5 bg-teal-600 text-white text-xs font-black rounded-2xl shadow-xl shadow-teal-600/30">ٹھیک ہے</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <form 
                onSubmit={handleSendMessage} 
                className="flex items-center gap-3 p-3 bg-white shadow-2xl rounded-[40px] border-4 border-slate-50 relative group focus-within:border-teal-100 transition-all"
              >
                <button
                  type="button"
                  onClick={startListening}
                  className={cn(
                    "w-14 h-14 flex items-center justify-center rounded-full transition-all focus:outline-none relative",
                    isListening ? "bg-red-500 text-white shadow-xl shadow-red-500/40" : "text-slate-400 bg-slate-50 hover:bg-teal-50 hover:text-teal-600"
                  )}
                >
                  {isListening && (
                    <span className="absolute inset-0 rounded-full border-4 border-red-400 animate-ping opacity-75" />
                  )}
                  {isListening ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                </button>
                <div className="flex-1 relative flex items-center">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => { setInputValue(e.target.value); if (showVoiceConfirm) setShowVoiceConfirm(false); }}
                    placeholder={isListening ? "سن رہا ہوں..." : "اردو میں کچھ بھی پوچھیں..."}
                    className={cn(
                      "flex-1 h-14 outline-none text-xl md:text-2xl font-bold placeholder-slate-300 bg-transparent px-2 min-w-0 transition-opacity",
                      isListening && !inputValue && "opacity-50"
                    )}
                  />
                  
                  {interimTranscript && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 font-urdu italic pointer-events-none whitespace-nowrap overflow-hidden max-w-[90%] pr-4 text-xl">
                      {interimTranscript}...
                    </span>
                  )}

                  {inputValue && !isListening && (
                    <button 
                      type="button"
                      onClick={() => { setInputValue(''); setShowVoiceConfirm(false); }}
                      className="p-3 text-slate-300 hover:text-slate-500 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!inputValue.trim() || isTyping || isListening}
                  className="w-14 h-14 flex items-center justify-center bg-[#0f766e] text-white rounded-full transition-all disabled:opacity-20 shadow-xl shadow-teal-900/10 active:scale-90"
                >
                  <Send className="w-7 h-7 -rotate-90" />
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Persistent Bottom Nav Tab Bar */}
      <nav className="h-20 bg-white border-t border-slate-100 px-8 flex justify-around items-center z-[60] shadow-[0_-10px_30px_rgba(0,0,0,0.05)]">
        <button 
          onClick={() => setActiveTab('topics')}
          className={cn(
            "flex flex-col items-center gap-1 group transition-all",
            activeTab === 'topics' ? "text-teal-600" : "text-slate-400 opacity-60"
          )}
        >
          <div className={cn(
            "p-2 rounded-xl transition-colors",
            activeTab === 'topics' ? "bg-teal-50" : "group-hover:bg-slate-50"
          )}>
            <Menu className="w-6 h-6" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest">موضوعات</span>
        </button>
        
        <div className="relative">
          <button 
            onClick={() => setActiveTab('chat')}
            className={cn(
              "w-16 h-16 rounded-full flex items-center justify-center -mt-12 border-8 border-[#fdfdfd] shadow-2xl transition-all active:scale-90",
              activeTab === 'chat' ? "bg-indigo-600 shadow-indigo-200" : "bg-slate-400 shadow-slate-200"
            )}
          >
            <Bot className="w-8 h-8 text-white" />
          </button>
        </div>

        <button 
          onClick={() => setActiveTab('chat')}
          className={cn(
            "flex flex-col items-center gap-1 group transition-all",
            activeTab === 'chat' ? "text-indigo-600" : "text-slate-400 opacity-60"
          )}
        >
          <div className={cn(
            "p-2 rounded-xl transition-colors",
            activeTab === 'chat' ? "bg-indigo-50" : "group-hover:bg-slate-50"
          )}>
            <MessageCircle className="w-6 h-6" />
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest">چیٹ</span>
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
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-lg bg-white rounded-[48px] p-8 md:p-12 z-[111] shadow-2xl border-4 border-slate-50"
            >
              {feedbackSuccess ? (
                <div className="text-center py-12 space-y-6">
                  <div className="w-24 h-24 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center text-5xl mx-auto animate-bounce">
                    ✅
                  </div>
                  <h2 className="text-3xl font-black text-slate-800 tracking-tight">شکریہ!</h2>
                  <p className="text-xl text-slate-500 font-bold leading-relaxed">آپ کی رائے ہمیں موصول ہو گئی ہے اور یہ ہماری بہت مدد کرے گی۔</p>
                </div>
              ) : (
                <form onSubmit={handleFeedbackSubmit} className="space-y-8">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-6">
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center">
                        <MessageSquare className="w-7 h-7" />
                      </div>
                      <h2 className="text-2xl font-black text-slate-800">آپ کی رائے</h2>
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
                      className="w-full h-48 p-6 bg-slate-50 border-2 border-slate-100 rounded-[32px] outline-none focus:border-indigo-200 focus:bg-white transition-all text-xl md:text-2xl font-bold resize-none scroll-smooth"
                    />
                  </div>

                  <button 
                    type="submit"
                    disabled={isSubmittingFeedback || !feedbackText.trim()}
                    className="w-full py-6 bg-indigo-600 text-white rounded-[32px] font-black text-2xl shadow-2xl shadow-indigo-200 hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-4 group"
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
