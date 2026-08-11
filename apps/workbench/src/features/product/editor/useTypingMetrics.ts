import { useEffect, useRef, useState } from "react";

export type TypingMetrics = {
  ready: boolean;
  realtimeCharsPerMinute: number;
  averageCharsPerMinute: number;
  totalTypedChars: number;
  recordTypedCharacters: (count: number, at?: number) => void;
};

export type TypingSample = { at: number; count: number };

export type TypingMetricSnapshot = Omit<TypingMetrics, "recordTypedCharacters">;

const WINDOW_MS = 60_000;
const IDLE_MS = 30_000;
const MIN_ACTIVE_MS = 5_000;
const MIN_CHARS = 5;

function activeDuration(samples: TypingSample[], now: number): number {
  if (!samples.length) return 0;
  let duration = 0;
  for (let index = 1; index < samples.length; index += 1) {
    duration += Math.min(IDLE_MS, Math.max(0, samples[index]!.at - samples[index - 1]!.at));
  }
  duration += Math.min(IDLE_MS, Math.max(0, now - samples.at(-1)!.at));
  return duration;
}

function charsPerMinute(chars: number, duration: number): number {
  if (duration <= 0 || chars <= 0) return 0;
  return Math.round(chars * 60_000 / duration);
}

export function typedCharacterCount(
  input: { inputType: string; isComposing?: boolean; data?: string | null },
  previousValue: string,
  nextValue: string
): number {
  if (input.isComposing || input.inputType === "insertCompositionText") return 0;
  if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph") return 1;
  if (input.inputType !== "insertText") return 0;
  if (input.data) return Array.from(input.data).length;
  return Math.max(0, Array.from(nextValue).length - Array.from(previousValue).length);
}

export function calculateTypingMetrics(samples: TypingSample[], now: number): TypingMetricSnapshot {
  const totalTypedChars = samples.reduce((total, sample) => total + sample.count, 0);
  const allActiveMs = activeDuration(samples, now);
  const recentSamples = samples.filter((sample) => sample.at >= now - WINDOW_MS);
  const recentChars = recentSamples.reduce((total, sample) => total + sample.count, 0);
  const idle = !samples.length || now - samples.at(-1)!.at >= IDLE_MS;
  const ready = totalTypedChars >= MIN_CHARS && allActiveMs >= MIN_ACTIVE_MS;
  return {
    ready,
    realtimeCharsPerMinute: ready && !idle ? charsPerMinute(recentChars, activeDuration(recentSamples, now)) : 0,
    averageCharsPerMinute: ready ? charsPerMinute(totalTypedChars, allActiveMs) : 0,
    totalTypedChars
  };
}

export function useTypingMetrics(documentKey: string): TypingMetrics {
  const samplesRef = useRef<TypingSample[]>([]);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    samplesRef.current = [];
    setRevision((value) => value + 1);
    setNow(Date.now());
  }, [documentKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  function recordTypedCharacters(count: number, at = Date.now()) {
    if (!Number.isFinite(count) || count <= 0) return;
    samplesRef.current.push({ at, count: Math.floor(count) });
    setNow(at);
    setRevision((value) => value + 1);
  }

  void revision;
  const metrics = calculateTypingMetrics(samplesRef.current, now);

  return {
    ...metrics,
    recordTypedCharacters
  };
}
