"use client";

import { useEffect, useRef, useState } from "react";

export default function AudioTranslate() {
  const [isActive, setIsActive] = useState(false);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [volume, setVolume] = useState(0);
  const [threshold, setThreshold] = useState(0.12);
  const [transcript, setTranscript] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [logs, setLogs] = useState<string[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const recognitionRef = useRef<any>(null);
  const isRecognitionSupportedRef = useRef<boolean>(true);
  const wasAboveThresholdRef = useRef(false);
  const thresholdRef = useRef(threshold);

  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  useEffect(() => {
    return () => {
      stopAll();
    };
  }, []);

  const stopAll = () => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch (_) {}
      recognitionRef.current = null;
    }

    setIsActive(false);
    setIsRecognizing(false);
    wasAboveThresholdRef.current = false;
  };

  const addLog = (message: string) => {
    setLogs((prev: string[]) => {
      const next = [...prev, message];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  };

  const ensureRecognition = () => {
    if (recognitionRef.current) return true;

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      isRecognitionSupportedRef.current = false;
      setErrorMessage(
        "Trình duyệt không hỗ trợ Speech Recognition (Web Speech API). Hãy dùng Chrome."
      );
      return false;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "vi-VN";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let nextTranscript = "";
      let nextConfidence: number | null = null;

      for (
        let i = event.resultIndex, len = event.results.length;
        i < len;
        i++
      ) {
        const res = event.results[i];
        const alt = res?.[0];
        const text = alt?.transcript ?? "";

        if (res?.isFinal) {
          nextTranscript += text;
          if (typeof alt?.confidence === "number") {
            nextConfidence = alt.confidence;
          }
        } else {
          nextTranscript += text;
        }
      }

      setTranscript(nextTranscript);
      setConfidence(nextConfidence);
    };

    recognition.onerror = (event: any) => {
      const msg = event?.message || event?.error || "unknown";
      setErrorMessage("Lỗi nhận dạng giọng nói: " + msg);
      setIsRecognizing(false);
    };

    recognition.onend = () => {
      setIsRecognizing(false);
    };

    recognitionRef.current = recognition;
    return true;
  };

  const startRecognitionIfNeeded = () => {
    if (!isRecognitionSupportedRef.current) return;
    if (isRecognizing) return;

    const ok = ensureRecognition();
    if (!ok || !recognitionRef.current) return;

    recognitionRef.current.lang = "vi-VN";
    recognitionRef.current.continuous = false;
    recognitionRef.current.interimResults = true;

    try {
      recognitionRef.current.start();
      setIsRecognizing(true);
      setErrorMessage("");
      addLog("SpeechRecognition started");
    } catch (e: any) {
      const msg = e?.message || e?.error || "unknown";
      setErrorMessage("Không thể bắt đầu nhận dạng giọng nói: " + msg);
      addLog("SpeechRecognition start error: " + msg);
      setIsRecognizing(false);
    }
  };

  const loopAudio = () => {
    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;
    if (!analyser || !dataArray) return;

    analyser.getByteTimeDomainData(dataArray as Uint8Array<ArrayBuffer>);

    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);
    setVolume(rms);

    const above = rms >= thresholdRef.current;
    if (above && !wasAboveThresholdRef.current) {
      startRecognitionIfNeeded();
    }
    wasAboveThresholdRef.current = above;

    rafIdRef.current = window.requestAnimationFrame(loopAudio);
  };

  const start = async () => {
    if (isActive) return;
    setErrorMessage("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      dataArrayRef.current = dataArray;
      mediaStreamRef.current = stream;

      setIsActive(true);
      wasAboveThresholdRef.current = false;
      addLog("Microphone started");
      loopAudio();
    } catch (error: any) {
      const msg = error?.message ?? String(error);
      setErrorMessage("Không thể truy cập micro: " + msg);
      addLog("Microphone error: " + msg);
      stopAll();
    }
  };

  const stop = () => {
    addLog("Stopped");
    stopAll();
  };

  const volumePercent = Math.round(Math.min(1, volume) * 100);
  const thresholdPercent = Math.round(threshold * 100);

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1">
        <p className="text-lg font-semibold text-gray-800">
          🎤 Dịch giọng nói gần micro
        </p>
        <p className="text-sm text-gray-500">
          Chỉ khi âm thanh đủ lớn (gần micro) thì mới bắt đầu nhận dạng và hiển
          thị text.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={isActive ? stop : start}
          className={`flex-1 py-3 px-4 rounded-xl font-semibold text-white shadow-md transition-all ${
            isActive
              ? "bg-red-500 hover:bg-red-600"
              : "bg-green-500 hover:bg-green-600"
          }`}
        >
          {isActive ? "Dừng nghe" : "Bắt đầu nghe"}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>Cường độ hiện tại</span>
          <span className="font-semibold">{volumePercent}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
          <div
            className="h-2 rounded-full bg-blue-500 transition-all"
            style={{ width: `${volumePercent}%` }}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>Ngưỡng kích hoạt (gần micro hơn → ngưỡng cao hơn)</span>
          <span className="font-semibold">{thresholdPercent}%</span>
        </div>
        <input
          type="range"
          min={5}
          max={40}
          value={Math.round(threshold * 100)}
          onChange={(e) => setThreshold(Number(e.target.value) / 100)}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-flex h-2 w-2 rounded-full ${
              isActive ? "bg-green-500" : "bg-gray-400"
            }`}
          />
          <span className="text-gray-600">
            {isActive
              ? isRecognizing
                ? "Đang nghe và có thể dịch khi âm lượng đủ lớn..."
                : "Đang nghe âm thanh, chờ đủ lớn để bắt đầu dịch..."
              : 'Nhấn "Bắt đầu nghe" để sử dụng micro.'}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold text-gray-700">Kết quả text</p>
        <div className="min-h-[80px] max-h-40 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-800 whitespace-pre-wrap">
          {transcript || "Chưa có nội dung."}
        </div>
      </div>

      <div className="text-xs text-gray-500 text-center">
        Độ tin cậy:{" "}
        {confidence === null ? "-" : `${Math.round(confidence * 100)}%`}
      </div>

      {errorMessage && (
        <p className="text-xs text-red-500 text-center">{errorMessage}</p>
      )}
    </div>
  );
}
