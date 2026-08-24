import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  AudioLines,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  Download,
  FileVideo,
  FolderOpen,
  Gauge,
  Info,
  LaptopMinimal,
  Pause,
  Play,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

type Stage = 'empty' | 'selected' | 'analyzing' | 'complete' | 'error';
type SignalSample = { time: number; energy: number; flux: number };
type ActivityHit = {
  id: number;
  start: number;
  end: number;
  score: number;
  peak: number;
  label: string;
};

const queryClient = new QueryClient();

const formatTime = (seconds: number, precise = false) => {
  if (!Number.isFinite(seconds)) return precise ? '00:00.0' : '00:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return precise
    ? `${String(minutes).padStart(2, '0')}:${remainder.toFixed(1).padStart(4, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder)).padStart(2, '0')}`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const analyzeSamples = (samples: SignalSample[], sensitivity: number, duration: number): ActivityHit[] => {
  if (!samples.length || !duration) return [];
  const sortedEnergies = samples.map((sample) => sample.energy).sort((a, b) => a - b);
  const sortedFlux = samples.map((sample) => sample.flux).sort((a, b) => a - b);
  const percentile = (values: number[], point: number) => values[Math.min(values.length - 1, Math.floor(values.length * point))];
  const energyMedian = percentile(sortedEnergies, .5);
  const energyUpper = percentile(sortedEnergies, .75);
  const fluxMedian = percentile(sortedFlux, .5);
  const fluxUpper = percentile(sortedFlux, .8);
  const energySpread = Math.max(energyUpper - energyMedian, .018);
  const fluxSpread = Math.max(fluxUpper - fluxMedian, .018);
  const threshold = .67 - sensitivity * .0039;
  const candidates = samples.map((sample) => {
    const energyScore = Math.max(0, Math.min(1, (sample.energy - energyMedian) / (energySpread * 2.2)));
    const fluxScore = Math.max(0, Math.min(1, (sample.flux - fluxMedian) / (fluxSpread * 2)));
    const score = energyScore * .67 + fluxScore * .33;
    return { ...sample, score };
  }).filter((sample) => sample.score >= threshold);

  const hits: ActivityHit[] = [];
  candidates.forEach((sample) => {
    const start = Math.max(0, sample.time - .42);
    const end = Math.min(duration, sample.time + .42);
    const previous = hits[hits.length - 1];
    if (previous && start - previous.end <= .62) {
      previous.end = Math.max(previous.end, end);
      previous.score = Math.max(previous.score, sample.score);
      previous.peak = Math.max(previous.peak, sample.score);
    } else {
      hits.push({ id: hits.length + 1, start, end, score: sample.score, peak: sample.score, label: 'Elevated activity' });
    }
  });
  return hits.map((hit) => ({
    ...hit,
    label: hit.peak > .86 ? 'Dense / intense' : hit.peak > .68 ? 'Layered texture' : 'Rising motion',
  }));
};

function Home() {
  const [stage, setStage] = useState<Stage>('empty');
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [samples, setSamples] = useState<SignalSample[]>([]);
  const [hits, setHits] = useState<ActivityHit[]>([]);
  const [sensitivity, setSensitivity] = useState(54);
  const [selectedHit, setSelectedHit] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [isPlaying, setIsPlaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const cancelRef = useRef(false);
  const oldUrlRef = useRef('');

  const hitSeconds = useMemo(() => hits.reduce((total, hit) => total + hit.end - hit.start, 0), [hits]);
  const mapSamples = useMemo(() => samples.filter((_, index) => index % Math.max(1, Math.ceil(samples.length / 130)) === 0), [samples]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (oldUrlRef.current) URL.revokeObjectURL(oldUrlRef.current);
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    void audioContextRef.current?.close();
  }, []);

  const reset = () => {
    cancelRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    videoRef.current?.pause();
    if (oldUrlRef.current) URL.revokeObjectURL(oldUrlRef.current);
    oldUrlRef.current = '';
    setFile(null);
    setVideoUrl('');
    setDuration(0);
    setCurrentTime(0);
    setProgress(0);
    setSamples([]);
    setHits([]);
    setSelectedHit(null);
    setErrorMessage('');
    setCopyState('idle');
    setIsPlaying(false);
    setStage('empty');
  };

  const selectFile = (nextFile?: File) => {
    if (!nextFile) return;
    if (!nextFile.type.startsWith('video/')) {
      setErrorMessage('That file does not look like a video. Choose an MP4, MOV, WebM, or another browser-readable video.');
      setStage('error');
      return;
    }
    cancelRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (oldUrlRef.current) URL.revokeObjectURL(oldUrlRef.current);
    const nextUrl = URL.createObjectURL(nextFile);
    oldUrlRef.current = nextUrl;
    setFile(nextFile);
    setVideoUrl(nextUrl);
    setDuration(0);
    setCurrentTime(0);
    setProgress(0);
    setSamples([]);
    setHits([]);
    setSelectedHit(null);
    setErrorMessage('');
    setCopyState('idle');
    setStage('selected');
  };

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0]);
    event.target.value = '';
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0]);
  };

  const finishAnalysis = (captured: SignalSample[]) => {
    const nextHits = analyzeSamples(captured, sensitivity, duration);
    setSamples(captured);
    setHits(nextHits);
    setProgress(1);
    setCurrentTime(duration);
    setStage('complete');
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.playbackRate = 1;
      videoRef.current.currentTime = 0;
    }
  };

  const startAnalysis = async () => {
    const video = videoRef.current;
    if (!video || !duration) {
      setErrorMessage('This video could not report a duration. Try opening it again in a supported format.');
      setStage('error');
      return;
    }
    cancelRef.current = false;
    setStage('analyzing');
    setProgress(0);
    setSamples([]);
    setHits([]);
    setSelectedHit(null);
    const captured: SignalSample[] = [];
    let lastCapturedAt = -1;
    try {
      const audioContext = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = audioContext;
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (!sourceRef.current) {
        sourceRef.current = audioContext.createMediaElementSource(video);
        analyserRef.current = audioContext.createAnalyser();
        analyserRef.current.fftSize = 1024;
        analyserRef.current.smoothingTimeConstant = .18;
        sourceRef.current.connect(analyserRef.current);
        analyserRef.current.connect(audioContext.destination);
      }
      const analyser = analyserRef.current;
      if (!analyser) throw new Error('The browser could not create an audio analyzer.');
      const timeData = new Uint8Array(analyser.fftSize);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);
      let previousSpectrum = new Uint8Array(analyser.frequencyBinCount);
      video.currentTime = 0;
      video.muted = true;
      video.playbackRate = 6;
      await video.play();
      setIsPlaying(true);
      const readFrame = () => {
        if (cancelRef.current) return;
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(frequencyData);
        if (video.currentTime - lastCapturedAt >= .14) {
          let squareSum = 0;
          let spectralDelta = 0;
          for (let index = 0; index < timeData.length; index += 2) {
            const normalized = (timeData[index] - 128) / 128;
            squareSum += normalized * normalized;
          }
          for (let index = 0; index < frequencyData.length; index += 3) {
            spectralDelta += Math.max(0, frequencyData[index] - previousSpectrum[index]) / 255;
          }
          const energy = Math.sqrt(squareSum / (timeData.length / 2));
          const flux = spectralDelta / Math.ceil(frequencyData.length / 3);
          captured.push({ time: video.currentTime, energy, flux });
          previousSpectrum = frequencyData.slice();
          lastCapturedAt = video.currentTime;
        }
        const ratio = Math.min(1, video.currentTime / duration);
        setProgress(ratio);
        setCurrentTime(video.currentTime);
        if (video.ended || video.currentTime >= duration - .04) {
          finishAnalysis(captured);
          return;
        }
        rafRef.current = requestAnimationFrame(readFrame);
      };
      rafRef.current = requestAnimationFrame(readFrame);
    } catch (error) {
      setIsPlaying(false);
      setStage('error');
      setErrorMessage(error instanceof Error ? error.message : 'The browser could not read audio from this video.');
    }
  };

  const stopAnalysis = () => {
    cancelRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    videoRef.current?.pause();
    if (videoRef.current) videoRef.current.playbackRate = 1;
    setIsPlaying(false);
    setStage('selected');
    setProgress(0);
    setCurrentTime(0);
  };

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime = Math.max(0, Math.min(duration, seconds));
    setCurrentTime(video.currentTime);
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.muted = false;
      try {
        await video.play();
        setIsPlaying(true);
      } catch {
        setErrorMessage('Playback was blocked. Press play again to start the local preview.');
      }
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const recomputeSensitivity = (value: number) => {
    setSensitivity(value);
    if (samples.length && duration) setHits(analyzeSamples(samples, value, duration));
  };

  const copyTimestamps = async () => {
    const text = hits.map((hit) => `${formatTime(hit.start)} – ${formatTime(hit.end)}  ${hit.label}  (${Math.round(hit.score * 100)}%)`).join('\n');
    try {
      await navigator.clipboard.writeText(text || 'No elevated activity found.');
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1800);
    } catch {
      setErrorMessage('Clipboard access was blocked by the browser. Select the timestamps and copy them manually.');
      setStage('error');
    }
  };

  const exportResults = () => {
    const rows = ['start,end,duration,score,label', ...hits.map((hit) => `${hit.start.toFixed(2)},${hit.end.toFixed(2)},${(hit.end - hit.start).toFixed(2)},${Math.round(hit.score * 100)}%,${hit.label}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${file?.name.replace(/\.[^/.]+$/, '') ?? 'activity'}-moments.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleVideoMetadata = () => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) setDuration(video.duration);
  };

  const handleVideoError = () => {
    setErrorMessage('The browser could not decode this video. Try a standard H.264 MP4 or WebM file.');
    setStage('error');
  };

  const renderEmpty = () => (
    <>
      <div className="intro">
        <div className="eyebrow">Local analysis // no upload</div>
        <h1>Find the moments that <em>ask to be heard.</em></h1>
        <p>Drop in a video and SCOPE will map unusual audio density, movement, and impact into timestamped moments you can jump to, copy, or carry into your edit.</p>
      </div>
      <div className="empty-layout">
        <div
          className={`drop-card ${dragging ? 'dragging' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={onDrop}
          data-testid="dropzone-video"
        >
          <div className="drop-content">
            <div className="drop-icon"><Upload size={24} strokeWidth={1.8} /></div>
            <h2>Bring a video into the room</h2>
            <p>Nothing leaves this browser. MP4, MOV, WebM, and more.</p>
            <button className="button-primary" onClick={() => inputRef.current?.click()} data-testid="button-choose-video">
              <FolderOpen size={15} /> Choose video
            </button>
            <div className="privacy-line"><ShieldCheck size={13} /> Private by design · analysis happens on-device</div>
          </div>
        </div>
        <div className="info-card">
          <h3>What SCOPE listens for</h3>
          <div className="step"><div className="step-num">01</div><div><strong>Energy</strong><p>Short-window loudness against the video's own baseline.</p></div></div>
          <div className="step"><div className="step-num">02</div><div><strong>Spectral change</strong><p>New frequency activity — hits, transitions, and texture.</p></div></div>
          <div className="step"><div className="step-num">03</div><div><strong>Useful moments</strong><p>Nearby hits merge into clean spans you can search.</p></div></div>
        </div>
      </div>
    </>
  );

  const renderError = () => (
    <div className="error-panel" data-testid="panel-error">
      <div className="error-icon"><AlertTriangle size={21} /></div>
      <div className="eyebrow">Analysis interrupted</div>
      <h2>That signal did not come through.</h2>
      <p>{errorMessage || 'Something unexpected stopped the local analysis. Your file stays on this device; nothing was uploaded.'}</p>
      <div className="flex flex-wrap gap-2">
        <button className="button-primary" onClick={() => file ? setStage('selected') : reset()} data-testid="button-recover">
          <RotateCcw size={14} /> Try again
        </button>
        <button className="button-ghost danger" onClick={reset} data-testid="button-reset-error"><X size={14} /> Start over</button>
      </div>
    </div>
  );

  const renderWorkspace = () => {
    const analyzing = stage === 'analyzing';
    const complete = stage === 'complete';
    return (
      <>
        <div className="workspace-heading">
          <div>
            <div className="eyebrow">{analyzing ? 'Listening // pass in progress' : complete ? 'Listening // pass complete' : 'Ready to listen'}</div>
            <h1>{file?.name}</h1>
            <p>{file ? `${formatBytes(file.size)} · ${duration ? formatTime(duration) : 'Reading duration…'} · local-only workspace` : ''}</p>
          </div>
          <div className="heading-actions">
            {complete && <span className="stage-pill"><Check size={13} /> {hits.length} moments found</span>}
            {analyzing && <button className="button-ghost danger" onClick={stopAnalysis} data-testid="button-stop-analysis"><X size={14} /> Stop pass</button>}
            {!analyzing && <button className="button-ghost" onClick={reset} data-testid="button-new-video"><Upload size={14} /> New video</button>}
            {!analyzing && !complete && <button className="button-primary" onClick={startAnalysis} disabled={!duration} data-testid="button-start-analysis"><ScanSearch size={15} /> Analyze soundtrack</button>}
            {complete && <button className="button-primary" onClick={startAnalysis} data-testid="button-run-again"><RotateCcw size={14} /> Run again</button>}
          </div>
        </div>
        <div className="video-signal-grid">
          <div className="panel" data-testid="panel-video-preview">
            <div className="panel-head"><div className="panel-title"><FileVideo size={15} /> Source preview</div><span className="small-muted">ON DEVICE</span></div>
            <div className="video-wrap">
              <video ref={videoRef} src={videoUrl} onLoadedMetadata={handleVideoMetadata} onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onError={handleVideoError} preload="metadata" data-testid="video-source" />
              {analyzing && <div className="video-loading"><div className="progress-ring"><span className="mono text-xs">{Math.round(progress * 100)}%</span></div><div className="video-overlay-note">Capturing audio frames at {formatTime(currentTime)}</div></div>}
            </div>
            <div className="video-controls">
              <div className="seek-row">
                <button className="play-button" onClick={togglePlay} aria-label={isPlaying ? 'Pause preview' : 'Play preview'} data-testid="button-toggle-preview">{isPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
                <input className="seek-slider" type="range" min="0" max={duration || 1} step=".1" value={Math.min(currentTime, duration || 1)} onChange={(event) => seekTo(Number(event.target.value))} aria-label="Video position" data-testid="input-video-position" />
                <span className="time-readout">{formatTime(currentTime)} / {formatTime(duration)}</span>
              </div>
              <div className="video-meta"><strong title={file?.name}>{file?.name}</strong><span>{analyzing ? 'Preview muted during capture' : 'Preview audio enabled'}</span></div>
            </div>
          </div>
          <div className="panel" data-testid="panel-activity-results">
            <div className="panel-head"><div className="panel-title"><Activity size={15} /> Activity map</div><span className="small-muted">{complete ? 'RELATIVE TO VIDEO' : 'WAITING FOR PASS'}</span></div>
            <div className="signal-body">
              {analyzing && (
                <div className="analysis-banner" data-testid="status-analysis-progress">
                  <strong>Building a baseline from your soundtrack</strong>
                  <p>Comparing short windows of energy and spectral change. This stays inside the tab.</p>
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${progress * 100}%` }} /></div>
                  <div className="progress-detail"><span>{formatTime(currentTime)} of {formatTime(duration)}</span><span>{Math.round(progress * 100)}%</span></div>
                </div>
              )}
              {complete && (
                <div className="stat-grid">
                  <div className="stat-box"><dt>Moments</dt><dd data-testid="text-moment-count">{hits.length}</dd></div>
                  <div className="stat-box"><dt>Flagged time</dt><dd data-testid="text-flagged-duration">{formatTime(hitSeconds)} <small>total</small></dd></div>
                  <div className="stat-box"><dt>Windows</dt><dd data-testid="text-window-count">{samples.length}</dd></div>
                </div>
              )}
              <div className="map-label-row"><strong>{complete ? 'Relative activity' : 'Activity preview'}</strong>{complete && <span className="small-muted">low → high</span>}</div>
              <div className="activity-map" role="img" aria-label="Audio activity map" data-testid="activity-map">
                {complete ? mapSamples.map((sample, index) => {
                  const activity = Math.max(.08, Math.min(1, sample.energy * 1.6 + sample.flux * 1.1));
                  const matchingHit = hits.find((hit) => sample.time >= hit.start && sample.time <= hit.end);
                  return <button key={`${index}-${sample.time}`} className={`activity-bar ${matchingHit ? 'hit' : ''} ${matchingHit?.id === selectedHit ? 'selected' : ''}`} style={{ height: `${Math.max(12, activity * 76)}%` }} onClick={() => matchingHit && (setSelectedHit(matchingHit.id), seekTo(matchingHit.start))} aria-label={matchingHit ? `Jump to ${formatTime(matchingHit.start)}` : 'Quiet audio window'} data-testid={`bar-activity-${index}`} />;
                }) : <div className="map-placeholder"><BarChart3 size={18} /><span>Run a pass to reveal the signal</span></div>}
                <div className="map-ticks"><span>00:00</span><span>{formatTime(duration / 2)}</span><span>{formatTime(duration)}</span></div>
              </div>
              <div className="sensitivity-row">
                <div className="sensitivity-label"><span><SlidersHorizontal size={13} className="inline mr-1" /> Sensitivity</span><span data-testid="text-sensitivity">{sensitivity}%</span></div>
                <input className="sensitivity-slider" type="range" min="10" max="90" value={sensitivity} onChange={(event) => recomputeSensitivity(Number(event.target.value))} aria-label="Analysis sensitivity" data-testid="input-sensitivity" />
                <div className="flex justify-between mt-2 text-[10px] text-[var(--ink-soft)]"><span>Fewer, stronger moments</span><span>More subtle moments</span></div>
              </div>
              <div className="result-head"><strong>{complete ? 'Timestamped moments' : 'Moments will appear here'}</strong>{complete && <span className="small-muted">{hits.length ? 'SELECT TO JUMP' : 'NO FLAGS'}</span>}</div>
              {complete && hits.length > 0 ? (
                <div className="result-list" data-testid="list-activity-moments">
                  {hits.map((hit) => (
                    <button key={hit.id} className={`result-row ${selectedHit === hit.id ? 'selected' : ''}`} onClick={() => { setSelectedHit(hit.id); seekTo(hit.start); }} data-testid={`row-activity-${hit.id}`}>
                      <span className="result-time">{formatTime(hit.start)}<br /><span className="text-[var(--ink-soft)]">→ {formatTime(hit.end)}</span></span>
                      <span><strong>{hit.label}</strong><p>{formatTime(hit.end - hit.start, true)} span · peak {Math.round(hit.peak * 100)}%</p></span>
                      <span><div className="score-meter"><span style={{ width: `${Math.round(hit.score * 100)}%` }} /></div><div className="score-label">{Math.round(hit.score * 100)}%</div></span>
                    </button>
                  ))}
                </div>
              ) : complete ? <div className="no-results" data-testid="empty-activity-results">No windows crossed the current sensitivity threshold. Move the slider right to catch subtler movement.</div> : <div className="no-results">Run an analysis pass to turn the soundtrack into searchable moments.</div>}
            </div>
            {complete && <div className="panel-footer"><span><Clock3 size={13} /> {formatTime(hitSeconds)} flagged across {formatTime(duration)}</span><div className="footer-actions"><button className="button-ghost" onClick={copyTimestamps} data-testid="button-copy-timestamps">{copyState === 'copied' ? <Check size={13} /> : <Clipboard size={13} />} {copyState === 'copied' ? 'Copied' : 'Copy timestamps'}</button><button className="button-ghost" onClick={exportResults} data-testid="button-export-csv"><Download size={13} /> Export CSV</button></div></div>}
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <div className="brand-lockup"><div className="brand-mark"><AudioLines size={20} strokeWidth={2.4} /></div><div className="brand-copy"><div className="brand-name">SCOPE</div><div className="brand-subtitle">audio activity detector</div></div></div>
        <div className="rail-label">WORKSPACE</div>
        <nav className="rail-nav" aria-label="Workspace navigation">
          <button className="rail-item active" onClick={() => stage === 'empty' ? undefined : setStage(stage)} aria-current="page" data-testid="nav-activity"><Activity size={16} /><span>Activity pass</span></button>
          <button className="rail-item" onClick={() => file ? setStage('selected') : inputRef.current?.click()} data-testid="nav-source"><FileVideo size={16} /><span>Source video</span></button>
        </nav>
        <div className="rail-note"><Gauge size={16} color="var(--ember)" /><p>Built for the first listen — before the edit gets complicated.</p></div>
        <div className="rail-foot">v1.0 · LOCAL MODE</div>
      </aside>
      <main className="main-stage">
        <div className="topbar">
          <div className="crumb"><BarChart3 size={14} color="var(--ember-deep)" /><strong>Activity detector</strong>{file && <><ChevronRight size={12} /><span className="max-w-[220px] truncate">{file.name}</span></>}</div>
          <div className="local-pill"><span className="local-dot" /> browser-only analysis</div>
        </div>
        {stage === 'empty' && renderEmpty()}
        {stage === 'error' && renderError()}
        {stage !== 'empty' && stage !== 'error' && renderWorkspace()}
        <div className="screen-footer"><span><LaptopMinimal size={13} /> Runs in your browser with Web Audio API</span><span><Info size={13} /> Nothing is uploaded or stored</span></div>
      </main>
      <input ref={inputRef} className="hide-input" type="file" accept="video/*" onChange={onInputChange} data-testid="input-video-file" />
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;