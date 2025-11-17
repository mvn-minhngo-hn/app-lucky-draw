"use client";

import { useEffect, useRef, useState } from "react";

export default function BlowDetection() {
  const [isActive, setIsActive] = useState(false);
  const [phase, setPhase] = useState<"idle" | "calibrating" | "detecting">(
    "idle"
  );
  const [blowLevel, setBlowLevel] = useState(0);
  const [isBlowing, setIsBlowing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [balloonFill, setBalloonFill] = useState(0); // 0..1

  const [calibrationDurationMs, setCalibrationDurationMs] = useState(7000); // ~7s
  const [blowThreshold, setBlowThreshold] = useState(0.25); // ngưỡng thổi
  const [requiredBlowDurationMs, setRequiredBlowDurationMs] = useState(1000); // phải giữ 1s

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const baselineEnergyRef = useRef(0);
  const baselineSumRef = useRef(0);
  const baselineCountRef = useRef(0);
  const calibrationStartRef = useRef(0);
  const bandRangeRef = useRef<{ lowIndex: number; highIndex: number } | null>(
    null
  );
  const phaseRef = useRef<"idle" | "calibrating" | "detecting">("idle");
  const blowStartTimeRef = useRef<number | null>(null);
  const isBlowingRef = useRef(false);

  const BALLOON_INCREMENT = 0.2; // mỗi 1s thổi tăng 20%

  const cleanup = () => {
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
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    dataArrayRef.current = null;
    baselineEnergyRef.current = 0;
    baselineSumRef.current = 0;
    baselineCountRef.current = 0;
    bandRangeRef.current = null;
    phaseRef.current = "idle";
    blowStartTimeRef.current = null;
    isBlowingRef.current = false;
  };

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const computeBandEnergy = (data: Uint8Array) => {
    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) return 0;

    let bandRange = bandRangeRef.current;
    if (!bandRange) {
      const nyquist = audioContext.sampleRate / 2;
      const binCount = analyser.frequencyBinCount;
      const freqPerBin = nyquist / binCount;

      const lowFreq = 300;
      const highFreq = 4000;

      const lowIndex = Math.max(0, Math.round(lowFreq / freqPerBin));
      const highIndex = Math.min(
        binCount - 1,
        Math.round(highFreq / freqPerBin)
      );

      bandRange = { lowIndex, highIndex };
      bandRangeRef.current = bandRange;
    }

    const { lowIndex, highIndex } = bandRange;
    let sum = 0;
    for (let i = lowIndex; i <= highIndex; i++) {
      sum += data[i];
    }
    const count = highIndex - lowIndex + 1;
    return count > 0 ? sum / count : 0;
  };

  const startDetection = async () => {
    setErrorMessage("");
    setBlowLevel(0);
    setIsBlowing(false);
    setCalibrationProgress(0);
    setBalloonFill(0);
    blowStartTimeRef.current = null;
    isBlowingRef.current = false;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErrorMessage("Microphone not supported in this browser.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      mediaStreamRef.current = stream;

      const AudioContextClass =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      await audioContext.resume();

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      dataArrayRef.current = dataArray;

      source.connect(analyser);

      baselineEnergyRef.current = 0;
      baselineSumRef.current = 0;
      baselineCountRef.current = 0;
      bandRangeRef.current = null;
      calibrationStartRef.current = performance.now();

      setIsActive(true);
      setPhase("calibrating");
      phaseRef.current = "calibrating";

      const loop = () => {
        if (!analyserRef.current || !dataArrayRef.current) return;

        analyserRef.current.getByteFrequencyData(dataArrayRef.current);
        const energy = computeBandEnergy(dataArrayRef.current);
        const now = performance.now();
        const elapsed = now - calibrationStartRef.current;

        if (phaseRef.current === "calibrating") {
          baselineSumRef.current += energy;
          baselineCountRef.current += 1;

          const progress = Math.min(1, elapsed / calibrationDurationMs);
          setCalibrationProgress(progress);

          if (elapsed >= calibrationDurationMs) {
            const avg =
              baselineCountRef.current > 0
                ? baselineSumRef.current / baselineCountRef.current
                : energy;
            baselineEnergyRef.current = avg;
            setPhase("detecting");
            phaseRef.current = "detecting";
          }
        } else if (phaseRef.current === "detecting") {
          const baseline = baselineEnergyRef.current;
          const diff = Math.max(0, energy - baseline);
          const normalized = Math.max(
            0,
            Math.min(1, diff / (baseline * 2 + 15))
          );

          setBlowLevel(normalized);

          const isCurrentlyBlowing = normalized > blowThreshold;
          const nowMs = now;

          if (isCurrentlyBlowing) {
            setIsBlowing(true);

            if (!isBlowingRef.current) {
              isBlowingRef.current = true;
              blowStartTimeRef.current = nowMs;
            } else if (
              blowStartTimeRef.current !== null &&
              nowMs - blowStartTimeRef.current >= requiredBlowDurationMs
            ) {
              setBalloonFill((prev) =>
                prev >= 1 ? 1 : Math.min(1, prev + BALLOON_INCREMENT)
              );
              blowStartTimeRef.current = nowMs;
            }
          } else {
            setIsBlowing(false);
            isBlowingRef.current = false;
            blowStartTimeRef.current = null;
          }
        }

        rafIdRef.current = requestAnimationFrame(loop);
      };

      rafIdRef.current = requestAnimationFrame(loop);
    } catch (error) {
      setErrorMessage(
        "Failed to access microphone. Please allow microphone permission."
      );
      cleanup();
      setIsActive(false);
      setPhase("idle");
      phaseRef.current = "idle";
    }
  };

  const stopDetection = () => {
    cleanup();
    setIsActive(false);
    setPhase("idle");
    phaseRef.current = "idle";
    setBlowLevel(0);
    setIsBlowing(false);
    setCalibrationProgress(0);
    setBalloonFill(0);
  };

  const calibrationSecondsLeft =
    phase === "calibrating"
      ? Math.ceil((calibrationDurationMs * (1 - calibrationProgress)) / 1000)
      : 0;

  const balloonScale = 0.6 + balloonFill * 0.8;
  const balloonPercent = Math.round(balloonFill * 100);
  const blowPercent = Math.round(blowLevel * 100);

  return (
    <>
      <div className="bg-gradient-to-br from-blue-500 to-sky-500 rounded-2xl p-8 text-center shadow-lg space-y-6">
        <p className="text-white text-sm font-medium">Blow the Balloon</p>

        <div className="flex justify-center items-center">
          <div
            className="relative flex items-center justify-center"
            style={{ height: 180 }}
          >
            <div
              className="flex flex-col items-center justify-center transition-transform duration-150"
              style={{ transform: `scale(${balloonScale})` }}
            >
              <div className="w-32 h-32 rounded-full bg-gradient-to-br from-pink-400 via-red-400 to-amber-300 shadow-lg" />
              <div className="w-3 h-4 bg-amber-200 rounded-b-full -mt-1" />
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-1">
          <div className="flex justify-between text-[11px] text-white/80">
            <span>Blow intensity</span>
            <span>{blowPercent}%</span>
          </div>
          <div className="w-full h-2 bg-white/20 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-150 ${
                blowPercent > 70
                  ? "bg-emerald-400"
                  : blowPercent > 40
                  ? "bg-yellow-300"
                  : "bg-white"
              }`}
              style={{ width: `${blowPercent}%` }}
            />
          </div>
        </div>

        <p className="text-white text-xs opacity-80">
          {phase === "idle" &&
            "Press Start, wait for calibration, then blow continuously to inflate the balloon."}
          {phase === "calibrating" &&
            `Calibrating environment noise... ~${calibrationSecondsLeft}s`}
          {phase === "detecting" &&
            (isBlowing
              ? "Keep blowing! Holding your blow for 1 second will grow the balloon."
              : "Blow into the microphone to inflate the balloon.")}
        </p>

        <p className="text-white text-xs opacity-70">
          Balloon size: {balloonPercent}%
        </p>
      </div>

      {phase === "calibrating" && (
        <div className="space-y-2 mt-3">
          <div className="flex justify-between text-xs text-gray-600">
            <span>Calibration</span>
            <span>{Math.round(calibrationProgress * 100)}%</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-150"
              style={{ width: `${Math.round(calibrationProgress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 text-center">
            Stay quiet while we measure background noise.
          </p>
        </div>
      )}

      <div className="bg-white/90 rounded-xl p-4 space-y-4 mt-4 text-left">
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium text-gray-700">
              Blow Threshold
            </label>
            <span className="text-xs font-semibold text-blue-600">
              {blowThreshold.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min="0.1"
            max="0.8"
            step="0.05"
            value={blowThreshold}
            onChange={(e) => setBlowThreshold(Number(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            disabled={isActive}
          />
          <div className="flex justify-between text-[11px] text-gray-500">
            <span>More sensitive</span>
            <span>Less sensitive</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium text-gray-700">
              Calibration Duration
            </label>
            <span className="text-xs font-semibold text-blue-600">
              {(calibrationDurationMs / 1000).toFixed(1)}s
            </span>
          </div>
          <input
            type="range"
            min="3000"
            max="10000"
            step="1000"
            value={calibrationDurationMs}
            onChange={(e) => setCalibrationDurationMs(Number(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            disabled={isActive}
          />
          <div className="flex justify-between text-[11px] text-gray-500">
            <span>3s</span>
            <span>10s</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium text-gray-700">
              Required Blow Duration
            </label>
            <span className="text-xs font-semibold text-blue-600">
              {(requiredBlowDurationMs / 1000).toFixed(1)}s
            </span>
          </div>
          <input
            type="range"
            min="300"
            max="2000"
            step="100"
            value={requiredBlowDurationMs}
            onChange={(e) => setRequiredBlowDurationMs(Number(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            disabled={isActive}
          />
          <div className="flex justify-between text-[11px] text-gray-500">
            <span>Shorter (0.3s)</span>
            <span>Longer (2s)</span>
          </div>
        </div>
      </div>

      <div className="space-y-3 mt-3">
        {!isActive ? (
          <button
            onClick={startDetection}
            className="w-full bg-gradient-to-r from-blue-600 to-sky-500 text-white font-bold py-4 px-6 rounded-xl shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200"
          >
            🌬️ Start Blow Game
          </button>
        ) : (
          <button
            onClick={stopDetection}
            className="w-full bg-gradient-to-r from-gray-600 to-gray-700 text-white font-bold py-4 px-6 rounded-xl shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200"
          >
            ⏸️ Stop
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mt-3">
          <p className="text-sm text-red-700">{errorMessage}</p>
        </div>
      )}
    </>
  );
}
