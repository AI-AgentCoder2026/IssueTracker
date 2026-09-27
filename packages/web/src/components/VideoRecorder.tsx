/**
 * Video recording feedback.
 *
 * Captures the screen or a camera through `MediaRecorder`, previews the result,
 * and uploads it as an issue attachment.
 *
 * The single most important property here is that **the capture stream is
 * always released**. A leaked camera stream is the worst bug this component can
 * have: the indicator light stays on and the user has to close the tab. So the
 * tracks are stopped in a helper called from every exit path — explicit stop,
 * discard, re-take, unmount, and upload completion — and the effect cleanup
 * covers the cases a user cannot trigger deliberately.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';
import { cx } from '../lib/format';

/** Hard ceiling so a forgotten recording cannot fill the disk. */
const MAX_SECONDS = 120;
const MAX_BYTES = 200 * 1024 * 1024;

type CaptureKind = 'screen' | 'camera';

interface VideoRecorderProps {
  /** Called with the finished recording so the caller can upload it. */
  onRecorded: (file: File) => Promise<void> | void;
  onError: (message: string) => void;
  disabled?: boolean;
}

/** Why recording is unavailable, or `null` when it is. */
function detectSupport(): string | null {
  if (typeof window === 'undefined') return 'Recording needs a browser.';
  if (!window.isSecureContext) {
    // getUserMedia and getDisplayMedia are both gated on a secure context.
    return 'Recording needs HTTPS, or localhost during development.';
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot record.';
  }
  if (typeof window.MediaRecorder === 'undefined') {
    return 'This browser cannot record video.';
  }
  return null;
}

/** Prefer VP9, fall back to plain WebM, else let the browser choose. */
function chooseMimeType(): { mimeType: string; label: string } | null {
  const candidates: Array<[string, string]> = [
    ['video/webm;codecs=vp9', 'VP9'],
    ['video/webm;codecs=vp8', 'VP8'],
    ['video/webm', 'WebM'],
    ['video/mp4', 'MP4'],
  ];
  for (const [mimeType, label] of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, label };
    } catch {
      // isTypeSupported is absent in some browsers; keep trying.
    }
  }
  return null;
}

export function VideoRecorder({ onRecorded, onError, disabled }: VideoRecorderProps) {
  const unsupported = detectSupport();
  const [kind, setKind] = useState<CaptureKind>('screen');
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'preview'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipSize, setClipSize] = useState(0);
  const [format, setFormat] = useState<string>('');
  const [uploading, setUploading] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // A revoked object URL must not outlive the component.
  const clipUrlRef = useRef<string | null>(null);

  /** Stop every track and clear the timer. Safe to call more than once. */
  const releaseStream = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Already inactive; nothing to do.
      }
    }
    recorderRef.current = null;
  }, []);

  const discardClip = useCallback(() => {
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
    setClipUrl(null);
    setClipSize(0);
  }, []);

  // Unmount must leave nothing running.
  useEffect(() => {
    return () => {
      releaseStream();
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    };
  }, [releaseStream]);

  const finishRecording = useCallback(() => {
    releaseStream();
    const blob = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType || 'video/webm' });
    chunksRef.current = [];

    if (blob.size === 0) {
      onError('Nothing was recorded. Check that the tab or window was allowed to capture.');
      setState('idle');
      return;
    }
    if (blob.size > MAX_BYTES) {
      onError('That recording is too large to attach. Try a shorter one.');
      setState('idle');
      return;
    }

    const url = URL.createObjectURL(blob);
    clipUrlRef.current = url;
    setClipUrl(url);
    setClipSize(blob.size);
    setState('preview');
  }, [onError, releaseStream]);

  const startRecording = useCallback(async () => {
    setState('requesting');
    setElapsed(0);
    chunksRef.current = [];

    try {
      let stream: MediaStream;
      if (kind === 'screen') {
        const getDisplay = navigator.mediaDevices.getDisplayMedia;
        if (typeof getDisplay !== 'function') {
          onError('This browser cannot record the screen.');
          setState('idle');
          return;
        }
        // Capture the display's own audio plus the microphone.
        stream = await getDisplay.call(navigator.mediaDevices, {
          video: { frameRate: 30 },
          audio: true,
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: true,
        });
      }

      streamRef.current = stream;

      // If the user hits "Stop sharing" in the browser's own bar, honour it.
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (recorderRef.current?.state === 'recording') finishRecording();
        });
      }

      const chosen = chooseMimeType();
      const recorder = chosen
        ? new MediaRecorder(stream, { mimeType: chosen.mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      setFormat(chosen?.label ?? 'the browser default');

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        finishRecording();
      };
      recorder.onerror = () => {
        releaseStream();
        onError('Recording failed unexpectedly.');
        setState('idle');
      };

      recorder.start(1000);
      setState('recording');

      timerRef.current = setInterval(() => {
        setElapsed((previous) => {
          const next = previous + 1;
          if (next >= MAX_SECONDS) {
            if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
          }
          return next;
        });
      }, 1000);
    } catch (error) {
      releaseStream();
      setState('idle');
      const name = (error as { name?: string })?.name;
      if (name === 'NotAllowedError') {
        // Declining the picker is a choice, not a fault.
        return;
      }
      onError(error instanceof Error ? error.message : 'Could not start recording');
    }
  }, [finishRecording, kind, onError, releaseStream]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const retake = useCallback(() => {
    releaseStream();
    discardClip();
    setElapsed(0);
    setState('idle');
  }, [discardClip, releaseStream]);

  const upload = useCallback(async () => {
    if (!clipUrl) return;
    setUploading(true);
    try {
      const blob = await (await fetch(clipUrl)).blob();
      const extension = format === 'MP4' ? 'mp4' : 'webm';
      const file = new File(
        [blob],
        `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
        { type: blob.type || `video/${extension}` },
      );
      await onRecorded(file);
      retake();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not attach the recording');
    } finally {
      setUploading(false);
    }
  }, [clipUrl, format, onError, onRecorded, retake]);

  if (unsupported) {
    return <EmptyState title="Recording unavailable" description={unsupported} />;
  }

  const remaining = MAX_SECONDS - elapsed;

  return (
    <div className="stack-sm" data-testid="video-recorder">
      {state === 'idle' ? (
        <div className="row gap-xs">
          <label className="sr-only" htmlFor="recorder-kind">
            What to record
          </label>
          <select
            id="recorder-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as CaptureKind)}
          >
            <option value="screen">This screen</option>
            <option value="camera">Camera and microphone</option>
          </select>
          <Button size="sm" onClick={() => void startRecording()} disabled={disabled}>
            Record
          </Button>
        </div>
      ) : null}

      {state === 'requesting' ? <Spinner label="Waiting for permission" /> : null}

      {state === 'recording' ? (
        <div className="row gap-sm" role="status" aria-live="polite">
          <span className={cx('badge', 'badge--danger', 'badge--dot')}>Recording</span>
          <span className="tabular">
            {formatElapsed(elapsed)} / {formatElapsed(MAX_SECONDS)}
          </span>
          <span className="subtle">stops at {formatElapsed(remaining)} remaining</span>
          <Button size="sm" variant="danger" onClick={stopRecording}>
            Stop
          </Button>
          <Button size="sm" variant="ghost" onClick={retake}>
            Discard
          </Button>
        </div>
      ) : null}

      {state === 'preview' && clipUrl ? (
        <div className="stack-sm">
          {/* The user must review before it becomes part of the issue record. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={clipUrl}
            controls
            playsInline
            preload="metadata"
            style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)' }}
            aria-label="Recorded video preview"
          />
          <p className="subtle">
            {formatBytes(clipSize)} · {format} · {formatElapsed(elapsed)}
          </p>
          <div className="row gap-xs">
            <Button size="sm" onClick={() => void upload()} disabled={uploading}>
              {uploading ? 'Attaching…' : 'Attach to issue'}
            </Button>
            <Button size="sm" variant="ghost" onClick={retake} disabled={uploading}>
              Re-record
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default VideoRecorder;
