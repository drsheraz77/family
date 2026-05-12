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
  MessageSquare,
  ArrowLeft
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
  
  // Function to set voice
  const setBestVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    const urVoices = voices.filter(v => v.lang.toLowerCase().includes('ur'));
    
    // Preference: Google Urdu, then Samsung Urdu, then any ur-PK, then first available ur
    const bestVoice = urVoices.find(v => v.name.includes('Google')) || 
                      urVoices.find(v => v.name.includes('Samsung')) || 
                      urVoices.find(v => v.lang === 'ur-PK') || 
                      urVoices[0];
                      
    if (bestVoice) {
      utterance.voice = bestVoice;
    }
  };

  setBestVoice();
  // voices can be loaded async
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = setBestVoice;
  }
  
  utterance.rate = 0.9; 
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  utterance.onstart = () => {
    if (onStart) onStart();
  };

  utterance.onend = () => {
    if (onEnd) onEnd();
  };

  utterance.onerror = (event) => {
    console.error('Speech error:', event);
    if (onEnd) onEnd();
  };

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

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

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
  const [isAutoVoiceEnabled, setIsAutoVoiceEnabled] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const isProcessingVoiceRef = useRef(false);

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
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsListening(false);
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('براہ کرم گوگل کروم (Chrome) استعمال کریں، آپ کا براؤزر آواز پہچاننے کی صلاحیت نہیں رکھتا۔');
      return;
    }

    try {
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
        console.error('Speech recognition error:', event.error);
        setIsListening(false);
        setInterimTranscript('');
        
        if (event.error === 'not-allowed') {
          alert('براہ کرم مائیکروفون کے استعمال کی اجازت دیں۔ آپ کی آواز نہیں سنی جا رہی۔');
        } else if (event.error === 'no-speech') {
          console.log('No speech detected');
        } else if (event.error === 'aborted') {
          console.log('Recognition aborted');
        } else {
          console.warn('Recognition problem:', event.error);
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

  const sendMessage = async (userText: string) => {
    if (!userText.trim() || isTyping) return;

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
      const modelName = "gemini-3-flash-preview"; 
      
      const responseStream = await genAI.models.generateContentStream({
        model: modelName,
        contents: [
          {
            role: "user",
            parts: [{ text: `صرف اردو میں بہت مختصر اور فوری جواب دیں: ${userText}` }]
          }
        ],
        config: {
          systemInstruction: "صرف اردو میں بہت مختصر، سادہ اور فوری جواب دیں۔ آپ 'صحت مند گھر' کے مشیر ہیں۔"
        }
      });
      
      const botMessageId = Math.random().toString(36).substr(2, 9);
      
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

      // Auto-speak when streaming completes
      if (fullText && isAutoVoiceEnabled) {
        speakUrdu(
          fullText,
          () => setSpeakingMessageId(botMessageId),
          () => setSpeakingMessageId(null)
        );
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
    <div className="flex flex-col h-screen bg-[#fdfdfd] text-slate-900 font-urdu relative">
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
                <p className="text-[10px] text-slate-400 font-sans font-black uppercase tracking-widest">Sehat Mand Ghar v5.5.0 (UX & Scroll Optimized)</p>

              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className={cn(
        "flex-1 flex flex-col min-h-0 relative",
        activeTab === 'topics' && !activeTopicId ? "overflow-y-auto" : "overflow-hidden"
      )}>
        {/* Persistent Header - Becomes compact on detail views */}
        <header className={cn(
          "bg-[#1a103d] text-white shadow-2xl relative overflow-hidden transition-all duration-700 shrink-0",
          (activeTopicId || activeTab === 'chat') ? "py-4 px-6" : "p-10 md:p-16 text-center"
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
                "bg-white rounded-[40px] overflow-hidden shadow-2xl border-4 border-white/20 transition-all",
                (activeTopicId || activeTab === 'chat') ? "w-14 h-14 p-0.5 rounded-2xl" : "w-56 h-56 md:w-80 md:h-80 p-2"
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
              <h1 className={cn("font-black tracking-tighter text-white transition-all", (activeTopicId || activeTab === 'chat') ? "text-xl md:text-2xl" : "text-4xl md:text-6xl")}>صحت مند گھر</h1>
              {(!activeTopicId && activeTab !== 'chat') && (
                <>
                  <p className="text-indigo-100 text-xl md:text-2xl font-medium opacity-90">آپ کا خاندان – آپ کا فیصلہ</p>
                  <p className="text-[10px] text-indigo-200/50 font-sans mt-2 bg-white/10 inline-block px-3 py-1 rounded-full border border-white/20">Build v5.5.0 • UX Refinement & Scroll Fix</p>
                </>
              )}
            </div>

            {(!activeTopicId && activeTab !== 'chat') && (
              <div className="pt-4 flex flex-col items-center gap-2">
                <button 
                  onClick={testVoice}
                  className="group relative inline-flex items-center gap-3 px-10 py-5 bg-white text-teal-900 rounded-[24px] font-bold text-2xl shadow-2xl hover:bg-teal-50 transition-all active:scale-95"
                >
                  <Volume2 className="w-7 h-7" />
                  ٹیسٹ آواز (مفت) 🔊
                </button>
              </div>
            )}
          </div>
        </header>

        <main className={cn(
          "max-w-4xl mx-auto w-full flex-1 relative flex flex-col",
          activeTab === 'topics' && !activeTopicId ? "px-4 py-10 pb-40" : "overflow-hidden"
        )}>

          {activeTab === 'topics' ? (
            <AnimatePresence mode="wait">
              {!activeTopicId ? (
                <motion.section 
                  key="topic-list"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="space-y-12"
                >

                  <div className="flex flex-col items-center text-center space-y-4">
                    <h3 className="font-black text-4xl text-slate-800 tracking-tight">صحت کے اہم موضوعات</h3>
                    <div className="h-2 w-20 bg-teal-600 rounded-full"></div>
                    <p className="text-slate-500 text-xl font-medium">نیچے دیے گئے کسی بھی کارڈ پر کلک کر کے معلومات حاصل کریں</p>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
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
                          "flex flex-col p-8 bg-white rounded-[40px] border-2 border-slate-100 shadow-sm text-right transition-all group relative hover:shadow-xl hover:border-slate-200 active:scale-95",
                          item.id === 'ai_chat_link' ? "border-indigo-100 bg-indigo-50/30" : "",
                          activeTopicId === item.id ? "ring-4 ring-teal-500 border-teal-500" : ""
                        )}
                      >
                        <div className={cn(
                          "w-20 h-20 rounded-[28px] flex items-center justify-center text-4xl mb-6 shadow-lg group-hover:scale-110 transition-transform",
                          item.id === 'ai_chat_link' ? "bg-indigo-600 text-white" : "bg-white border-2 border-slate-50"
                        )}>
                          {item.id === 'methods' ? '💊' : item.icon}
                        </div>
                        <div className="space-y-2">
                          <h4 className={cn(
                            "font-black text-2xl text-slate-800 leading-tight",
                            item.id === 'ai_chat_link' ? "text-indigo-900" : "group-hover:text-teal-900"
                          )}>{item.label}</h4>
                          <p className={cn(
                            "text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-widest",
                            item.id === 'ai_chat_link' ? "text-indigo-400 opacity-100" : "text-slate-400"
                          )}>{item.sub}</p>
                        </div>
                        <div className="absolute top-8 left-8">
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

                  <footer className="bg-slate-50 border-t border-slate-200 py-16 px-6 text-center space-y-12 rounded-[40px] mt-12">
                    <div className="max-w-3xl mx-auto space-y-12">
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
                </motion.section>
              ) : (
                <motion.div
                  key="topic-detail"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  className="bg-white border-4 border-teal-600 rounded-[48px] p-6 md:p-10 shadow-2xl relative overflow-y-auto"
                >
                  <div className="flex items-center justify-between mb-8 pb-6 border-b border-slate-100">
                    <button 
                      onClick={() => { setActiveTopicId(null); setBreadcrumb(['start']); }}
                      className="flex items-center gap-3 px-6 py-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black rounded-2xl transition-all active:scale-90"
                    >
                      <ArrowLeft className="w-6 h-6" />
                      <span>واپس جائیں</span>
                    </button>
                    
                    <button 
                      onClick={() => { setActiveTopicId(null); setBreadcrumb(['start']); }}
                      className="p-3 bg-slate-50 rounded-full hover:bg-slate-100 transition-colors"
                    >
                      <X className="w-6 h-6 text-slate-400" />
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

                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 bg-teal-50 rounded-2xl flex items-center justify-center text-3xl">
                          📖
                        </div>
                        <h2 className="text-3xl font-black text-slate-800">{getTopicTitle(activeTopicId)}</h2>
                      </div>
                      
                      <button 
                        onClick={() => toggleSpeech(activeTopicId, CHAT_TREE[activeTopicId].text)}
                        className={cn(
                          "flex items-center justify-center gap-3 px-6 py-4 rounded-3xl transition-all font-black text-lg",
                          speakingMessageId === activeTopicId ? "bg-teal-600 text-white shadow-lg animate-pulse" : "bg-teal-100 text-teal-700 hover:bg-teal-200"
                        )}
                      >
                        <Volume2 className="w-6 h-6" />
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
          ) : (
            <section id="chat" className="flex flex-col flex-1 min-h-0 bg-white relative overflow-hidden">
              <div className={cn(
                "flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth",
                messages.length === 0 ? "flex flex-col items-center justify-center text-center pb-20" : "pb-32"
              )}>

                {messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center space-y-4 animate-in fade-in zoom-in duration-500">
                    <div className="w-24 h-24 bg-indigo-600 text-white rounded-[32px] flex items-center justify-center shadow-2xl shadow-indigo-200 rotate-3">
                      <Bot className="w-12 h-12" />
                    </div>
                    <div className="space-y-4">
                      <h3 className="text-3xl font-black text-slate-800 italic">سوال پوچھیں (AI Assistant)</h3>
                      <p className="text-slate-500 text-lg">اپنا سوال لکھیں یا نیچے والے مائیک بٹن سے بولیں</p>
                      
                      <button 
                        onClick={() => setIsAutoVoiceEnabled(!isAutoVoiceEnabled)}
                        className={cn(
                          "inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold transition-all",
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
                          "max-w-[85%] p-4 rounded-3xl text-lg md:text-xl leading-relaxed shadow-sm border",
                          msg.sender === 'user' ? "bg-white border-slate-100" : "bg-indigo-600 text-white border-indigo-500"
                        )}>

                          {msg.text.split('\n').map((line, i) => (
                            <p key={i} className={i > 0 ? "mt-2" : ""}>{line}</p>
                          ))}
                          
                          {msg.sender === 'bot' && (
                            <button 
                              onClick={() => toggleSpeech(msg.id, msg.text)}
                              className={cn(
                                "mt-3 flex items-center gap-2 px-3 py-1.5 rounded-full transition-all",
                                speakingMessageId === msg.id ? "bg-white text-indigo-700" : "bg-indigo-700/30 text-white hover:bg-indigo-700/50"
                              )}
                            >
                              <Volume2 className={cn("w-4 h-4", speakingMessageId === msg.id && "animate-pulse")} />
                              <span className="text-[10px] uppercase font-black">{speakingMessageId === msg.id ? "Stop" : "Listen"}</span>
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

              {/* Chat Input Area - Overlayed but nicely integrated */}
              <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-white via-white/95 to-transparent pt-10 z-10">
                <div className="max-w-4xl mx-auto">
                    <form 
                      onSubmit={handleSendMessage} 
                      className="flex items-center gap-2 p-2 bg-white shadow-[0_10px_40px_rgba(0,0,0,0.1)] rounded-[32px] border border-slate-100 focus-within:border-indigo-400 transition-all pl-3"
                    >
                      <button
                        type="submit"
                        disabled={!inputValue.trim()}
                        className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center transition-all bg-indigo-600 text-white shadow-lg active:scale-90 shrink-0",
                          !inputValue.trim() && "opacity-20 scale-90 grayscale"
                        )}
                      >
                        <Send className="w-5 h-5 -rotate-45" />
                      </button>

                      <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder="اپنا سوال لکھیں..."
                        className="flex-1 bg-transparent border-none focus:ring-0 text-lg md:text-xl font-bold py-3 px-2 text-right dir-rtl outline-none min-w-0"
                      />

                      <button
                        type="button"
                        onClick={() => setIsAutoVoiceEnabled(!isAutoVoiceEnabled)}
                        className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center transition-all shrink-0",
                          isAutoVoiceEnabled ? "bg-teal-50 text-teal-600" : "bg-slate-50 text-slate-400"
                        )}
                      >
                        <Volume2 className={cn("w-5 h-5", isAutoVoiceEnabled && "animate-pulse")} />
                      </button>

                      <button
                        type="button"
                        onClick={startListening}
                        disabled={isTyping}
                        className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center transition-all shrink-0",
                          isListening ? "bg-red-500 text-white animate-pulse" : 
                          isTyping ? "bg-slate-50 text-slate-300 cursor-not-allowed" : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
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
            className="fixed bottom-24 right-6 w-16 h-16 bg-indigo-600 text-white rounded-full shadow-2xl z-[55] flex flex-col items-center justify-center gap-1 active:scale-90 transition-all border-4 border-white shadow-indigo-200"
          >
            <Bot className="w-8 h-8" />
          </motion.button>
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
