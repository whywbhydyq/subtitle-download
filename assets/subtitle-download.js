(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const MODEL_MAP = {
    'tiny:auto': ['onnx-community/whisper-tiny', 'Xenova/whisper-tiny'],
    'tiny:zh': ['onnx-community/whisper-tiny', 'Xenova/whisper-tiny'],
    'tiny:en': ['onnx-community/whisper-tiny.en', 'Xenova/whisper-tiny.en'],
    'base:auto': ['onnx-community/whisper-base', 'Xenova/whisper-base'],
    'base:zh': ['onnx-community/whisper-base', 'Xenova/whisper-base'],
    'base:en': ['onnx-community/whisper-base.en', 'Xenova/whisper-base.en']
  };

  const YT_STATE = {
    '-1': '未开始',
    '0': '已结束',
    '1': '播放中',
    '2': '已暂停',
    '3': '缓冲中',
    '5': '已就绪'
  };

  const app = {
    currentKind: 'none',
    currentUrl: '',
    youtubeId: '',
    youtubeTitle: '',
    languageHint: '',
    hls: null,
    ytPlayer: null,
    ytApiPromise: null,
    mediaReady: false,
    displayStream: null,
    captureStream: null,
    recorder: null,
    recorderMime: '',
    currentChunks: [],
    allAudioParts: [],
    completedAudioBytes: 0,
    failedSegmentCount: 0,
    currentSegmentIndex: 0,
    currentSegmentStartMedia: 0,
    currentSegmentActiveMs: 0,
    currentSegmentLastTick: 0,
    captureActive: false,
    captureStopping: false,
    capturePaused: false,
    captureStartWall: 0,
    captureBaseMediaTime: 0,
    captureTargetSeconds: 0,
    captureWallLimitSeconds: 0,
    capturePlaybackRate: 1,
    lastMediaTime: 0,
    lastMediaAdvanceAt: 0,
    watchdogTimer: null,
    captureTimer: null,
    hardStopTimer: null,
    segmentQueue: [],
    segmentProcessing: false,
    capturedSegmentCount: 0,
    transcribedSegmentCount: 0,
    transcribedMediaSeconds: 0,
    transcriptBySegment: new Map(),
    transcriptText: '',
    capturedBlob: null,
    capturedUrl: '',
    asrRunId: 0,
    transcriber: null,
    transcriberKey: '',
    transcriberCache: new Map(),
    transcriberPromises: new Map(),
    isWarming: false,
    isTranscribing: false,
    warmupTimer: null,
    serviceWorkerReady: false,
    oneClickState: 'idle',
    captionFastPathUsed: false,
    firstSegmentLanguageDecisionDone: false,
    resetSerial: 0,
    lastCaptionTracks: [],
    lastCaptureError: ''
  };

  function nowLabel() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function log(message, type = 'info') {
    const box = $('diagnostics-log');
    if (!box) return;
    if (box.dataset.empty === 'true') {
      box.innerHTML = '';
      box.dataset.empty = 'false';
    }
    const line = document.createElement('div');
    line.className = 'line ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : type === 'warn' ? 'warning' : '');
    line.textContent = '[' + nowLabel() + '] ' + message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = $('diagnostics-log');
    if (!box) return;
    box.dataset.empty = 'true';
    box.innerHTML = '<div class="line">[等待] 粘贴链接后点击“开始检测、捕获并转文字”。</div>';
  }

  function setStatus(id, text, state = 'pending') {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'status-value ' + state;
  }

  function setProgress(kind, percent, label, detail) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = $(kind + '-bar');
    const pct = $(kind + '-percent');
    const title = $(kind + '-label');
    const text = $(kind + '-detail');
    if (bar) bar.style.width = safe + '%';
    if (pct) pct.textContent = Math.round(safe) + '%';
    if (title && label) title.textContent = label;
    if (text && detail) text.textContent = detail;
  }

  function setButton(id, enabled) {
    const el = $(id);
    if (el) el.disabled = !enabled;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return value.toFixed(index === 0 ? 0 : 2) + ' ' + units[index];
  }

  function resetChecks() {
    setStatus('check-type', '未检测', 'pending');
    setStatus('check-connect', '未检测', 'pending');
    setStatus('check-control', '未检测', 'pending');
    setStatus('check-play', '未检测', 'pending');
    setStatus('check-capture', '未检测', 'pending');
  }

  function resetProgress() {
    setProgress('overall', 0, '总进度', '等待开始。');
    setProgress('audio', 0, '音频提取', '等待捕获。');
    setProgress('asr', 0, '转文字', 'YouTube 会先尝试直取已有字幕；没有字幕才走标签页音频捕获和本地 ASR。');
  }

  function resetOutputs() {
    app.asrRunId += 1;
    app.resetSerial += 1;
    app.oneClickState = 'idle';
    app.captionFastPathUsed = false;
    app.firstSegmentLanguageDecisionDone = false;
    app.lastCaptionTracks = [];
    app.lastCaptureError = '';
    app.segmentQueue = [];
    app.segmentProcessing = false;
    app.isTranscribing = false;
    app.isWarming = false;
    app.capturedSegmentCount = 0;
    app.transcribedSegmentCount = 0;
    app.transcribedMediaSeconds = 0;
    app.transcriptBySegment = new Map();
    app.transcriptText = '';
    app.capturedBlob = null;
    if (app.capturedUrl) URL.revokeObjectURL(app.capturedUrl);
    app.capturedUrl = '';
    app.allAudioParts = [];
    app.completedAudioBytes = 0;
    app.failedSegmentCount = 0;
    app.currentChunks = [];
    const transcript = $('transcript-output');
    if (transcript) transcript.value = '';
    setButton('download-audio-btn', false);
    setButton('download-txt-btn', false);
  }

  function resetForNewRun() {
    stopTimers();
    const recorder = app.recorder;
    app.recorder = null;
    app.captureActive = false;
    app.captureStopping = false;
    app.capturePaused = false;
    if (recorder) {
      try { recorder.ondataavailable = null; } catch (_) {}
      try { recorder.onerror = null; } catch (_) {}
      try { recorder.onstop = null; } catch (_) {}
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
    }
    stopDisplayCaptureTracks();
    stopCaptureStreamTracks();
    pauseSourcePlayback();
    stopNativeMedia();
    stopYouTubePlayer();
    resetChecks();
    resetProgress();
    resetOutputs();
    clearLog();
    updateOneClickButton();
  }

  function stopTimers() {
    clearInterval(app.watchdogTimer);
    clearInterval(app.captureTimer);
    clearTimeout(app.hardStopTimer);
    app.watchdogTimer = null;
    app.captureTimer = null;
    app.hardStopTimer = null;
  }

  function stopDisplayCaptureTracks() {
    if (!app.displayStream) return;
    app.displayStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (_) {}
    });
    app.displayStream = null;
  }

  function stopCaptureStreamTracks() {
    if (!app.captureStream) return;
    app.captureStream.getTracks().forEach((track) => {
      try { track.onended = null; } catch (_) {}
      try { track.stop(); } catch (_) {}
    });
    app.captureStream = null;
  }

  function pauseSourcePlayback() {
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer && typeof app.ytPlayer.pauseVideo === 'function') {
        app.ytPlayer.pauseVideo();
        return;
      }
      const media = $('media-element');
      if (media && !media.paused) media.pause();
    } catch (_) {}
  }

  function stopNativeMedia() {
    const media = $('media-element');
    if (app.hls) {
      try { app.hls.destroy(); } catch (_) {}
      app.hls = null;
    }
    if (media) {
      try { media.pause(); } catch (_) {}
      media.removeAttribute('src');
      media.load();
    }
    app.mediaReady = false;
  }

  function stopYouTubePlayer() {
    if (app.ytPlayer && typeof app.ytPlayer.destroy === 'function') {
      try { app.ytPlayer.destroy(); } catch (_) {}
    }
    app.ytPlayer = null;
    const host = $('youtube-player');
    if (host) host.innerHTML = '';
  }

  function parseYouTubeId(input) {
    try {
      const url = new URL(input);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
      if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
        const direct = url.searchParams.get('v');
        if (direct) return direct;
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(parts[0]) && parts[1]) return parts[1];
      }
    } catch (_) {}
    return '';
  }

  function classifyUrl(input) {
    const youtubeId = parseYouTubeId(input);
    if (youtubeId) return { kind: 'youtube', label: 'YouTube 页面链接', youtubeId };
    try {
      const url = new URL(input);
      const path = decodeURIComponent(url.pathname).toLowerCase();
      if (/\.m3u8($|\?)/i.test(path) || /m3u8/i.test(input)) return { kind: 'hls', label: 'HLS / M3U8 媒体流' };
      if (/\.(mp4|webm|mov|m4v|ogg|ogv)($|\?)/i.test(path)) return { kind: 'video', label: '视频直链' };
      if (/\.(mp3|wav|m4a|aac|flac|opus|oga)($|\?)/i.test(path)) return { kind: 'audio', label: '音频直链' };
      return { kind: 'page', label: '普通网页 / 未知媒体' };
    } catch (_) {
      return { kind: 'invalid', label: '无效链接' };
    }
  }

  function currentSettings() {
    const rawSeconds = Number($('capture-seconds')?.value);
    const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.max(5, Math.min(14400, rawSeconds)) : 0;
    const rawSegment = Number($('segment-seconds')?.value);
    const segmentSeconds = Number.isFinite(rawSegment) && rawSegment > 0 ? Math.max(5, Math.min(90, rawSegment)) : 20;
    const rawRate = Number($('playback-rate')?.value);
    const playbackRate = Number.isFinite(rawRate) ? Math.max(1, Math.min(2, rawRate)) : 1.5;
    return {
      language: $('language-select')?.value || 'auto',
      model: $('model-select')?.value || 'tiny',
      seconds,
      segmentSeconds,
      playbackRate
    };
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      app.serviceWorkerReady = true;
      log('缓存服务已就绪：页面、运行库和模型文件会尽量复用缓存。', 'success');
      if (registration && registration.update) registration.update().catch(() => {});
    } catch (error) {
      log('缓存服务注册失败：' + error.message, 'warn');
    }
  }

  function openPlayerPage() {
    const input = ($('source-url')?.value || '').trim();
    if (!input) {
      alert('请输入链接。');
      return;
    }
    window.open('play.html?url=' + encodeURIComponent(input), '_blank', 'noopener,noreferrer');
  }

  async function probeHttp(input, kind) {
    if (kind === 'youtube') return { ok: true, state: 'ok', message: 'YouTube 走 IFrame API 和字幕接口，不读取 iframe 音频流。' };
    if (kind === 'invalid') return { ok: false, state: 'bad', message: 'URL 格式无效。' };
    if (kind === 'page') return { ok: false, state: 'warn', message: '普通网页不是可直接解码的媒体源。' };
    try {
      const method = kind === 'hls' ? 'GET' : 'HEAD';
      const response = await fetch(input, { method, mode: 'cors', cache: 'no-store' });
      if (!response.ok) return { ok: false, state: 'bad', message: 'HTTP ' + response.status + ' ' + response.statusText };
      const type = response.headers.get('content-type') || '未知 Content-Type';
      if (kind === 'hls') {
        const text = await response.clone().text();
        const ok = /^#EXTM3U/m.test(text.trim());
        return { ok, state: ok ? 'ok' : 'warn', message: ok ? 'HLS 清单可读。' : '可连接，但返回内容不像 HLS 清单。' };
      }
      return { ok: true, state: 'ok', message: 'HTTP 可连接：' + type };
    } catch (error) {
      return { ok: false, state: 'warn', message: 'fetch/CORS 检测失败：' + error.message + '。继续尝试媒体元素。' };
    }
  }

  function waitForMediaMetadata(media, timeoutMs = 15000) {
    if (media.readyState >= 1) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        media.removeEventListener('loadedmetadata', onReady);
        media.removeEventListener('canplay', onReady);
        media.removeEventListener('error', onError);
        resolve(result);
      };
      const onReady = () => finish({ ok: true });
      const onError = () => {
        const map = { 1: '加载被中止', 2: '网络错误', 3: '解码失败', 4: '格式不支持或跨域受限' };
        const reason = media.error ? (map[media.error.code] || ('错误码 ' + media.error.code)) : '未知错误';
        finish({ ok: false, reason });
      };
      const timer = setTimeout(() => finish({ ok: false, reason: '媒体元数据加载超时' }), timeoutMs);
      media.addEventListener('loadedmetadata', onReady, { once: true });
      media.addEventListener('canplay', onReady, { once: true });
      media.addEventListener('error', onError, { once: true });
    });
  }

  function getCaptureStream(media) {
    if (typeof media.captureStream === 'function') return media.captureStream();
    if (typeof media.mozCaptureStream === 'function') return media.mozCaptureStream();
    return null;
  }

  function pickAudioMime() {
    if (!window.MediaRecorder) return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  async function inspectNative(input, kind) {
    stopYouTubePlayer();
    stopNativeMedia();
    app.currentKind = kind;
    app.currentUrl = input;
    app.mediaReady = false;
    const media = $('media-element');
    if (!media) throw new Error('页面缺少媒体元素。');
    media.crossOrigin = 'anonymous';
    media.muted = true;
    media.controls = false;
    setStatus('check-control', 'HTMLMediaElement 可操作', 'ok');
    setStatus('check-play', '检测中', 'pending');
    setProgress('overall', 20, '媒体检测', '正在加载元数据，默认不会自动播放。');

    if (kind === 'hls') {
      if (window.Hls && window.Hls.isSupported()) {
        app.hls = new window.Hls({ enableWorker: true, backBufferLength: 30 });
        app.hls.loadSource(input);
        app.hls.attachMedia(media);
      } else if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = input;
      } else {
        throw new Error('当前浏览器不能播放 HLS。');
      }
    } else {
      media.src = input;
    }
    media.load();
    const metadata = await waitForMediaMetadata(media, 15000);
    if (!metadata.ok) throw new Error(metadata.reason || '媒体无法加载。');
    setStatus('check-play', '可播放（默认暂停）', 'ok');
    const duration = Number.isFinite(media.duration) ? media.duration.toFixed(1) + ' 秒' : '直播/未知时长';
    log('媒体元数据加载完成：' + duration + '。默认保持暂停，不在首页播放。', 'success');

    const stream = getCaptureStream(media);
    if (!stream) {
      setStatus('check-capture', '浏览器不支持 captureStream', 'warn');
      app.mediaReady = false;
      return false;
    }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) {
      setStatus('check-capture', '未检测到音轨', 'warn');
      app.mediaReady = false;
      return false;
    }
    const mime = pickAudioMime();
    if (!mime) {
      setStatus('check-capture', '无可用录制编码', 'warn');
      app.mediaReady = false;
      return false;
    }
    setStatus('check-capture', '可捕获媒体音频', 'ok');
    app.mediaReady = true;
    setProgress('overall', 46, '媒体检测完成', '媒体可播放并可捕获音频；点击主按钮会开始播放、捕获、转文字。');
    return true;
  }

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (app.ytApiPromise) return app.ytApiPromise;
    app.ytApiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      const timer = setTimeout(() => reject(new Error('YouTube IFrame API 加载超时。')), 15000);
      window.onYouTubeIframeAPIReady = function() {
        clearTimeout(timer);
        if (typeof previous === 'function') {
          try { previous(); } catch (_) {}
        }
        resolve(window.YT);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error('YouTube IFrame API 脚本加载失败。'));
      };
      document.head.appendChild(script);
    });
    return app.ytApiPromise;
  }

  function inferLanguageHintFromText(text) {
    const value = String(text || '');
    if (/[\u3400-\u9fff]/.test(value)) return 'zh';
    if (/[A-Za-z]/.test(value)) return 'en';
    return '';
  }

  async function inspectYouTube(input, youtubeId) {
    stopNativeMedia();
    stopYouTubePlayer();
    app.currentKind = 'youtube';
    app.currentUrl = input;
    app.youtubeId = youtubeId;
    app.youtubeTitle = '';
    app.languageHint = '';
    setStatus('check-connect', '加载 IFrame API', 'pending');
    setStatus('check-control', '等待播放器', 'pending');
    setStatus('check-play', '默认暂停', 'pending');
    setStatus('check-capture', '优先直取字幕', 'pending');
    setProgress('overall', 12, 'YouTube 检测', '正在加载 YouTube IFrame API，默认不会自动播放。');
    log('YouTube 视频 ID：' + youtubeId + '。');

    const api = await loadYouTubeApi();
    setStatus('check-connect', 'IFrame API 已连接', 'ok');
    const host = $('youtube-player');
    const innerId = 'youtube-player-hidden-' + Date.now();
    host.innerHTML = '<div id="' + innerId + '"></div>';

    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) reject(new Error('YouTube 播放器 ready 超时。'));
      }, 15000);
      app.ytPlayer = new api.Player(innerId, {
        videoId: youtubeId,
        width: '1',
        height: '1',
        playerVars: { playsinline: 1, origin: window.location.origin, rel: 0, controls: 0, disablekb: 1 },
        events: {
          onReady: (event) => {
            ready = true;
            clearTimeout(timer);
            setStatus('check-control', '可操作', 'ok');
            setStatus('check-play', '可播放（默认暂停）', 'ok');
            setStatus('check-capture', '字幕优先 / 可授权标签页音频', 'warn');
            setProgress('overall', 28, 'YouTube 检测完成', '播放器 ready。默认保持暂停；需要捕获时才开始播放。');
            try {
              const data = event.target.getVideoData ? event.target.getVideoData() : null;
              if (data && data.title) {
                app.youtubeTitle = data.title;
                app.languageHint = inferLanguageHintFromText(data.title);
                log('视频标题：' + data.title, 'success');
                if (app.languageHint === 'zh') log('标题包含中文：自动模式会优先按中文原文识别。', 'success');
              }
            } catch (_) {}
            resolve();
          },
          onStateChange: (event) => {
            const label = YT_STATE[String(event.data)] || ('状态码 ' + event.data);
            log('YouTube 播放状态：' + label + '。');
            if (event.data === 0 && app.captureActive) stopCapture();
          },
          onError: (event) => {
            setStatus('check-play', '播放错误 ' + event.data, 'bad');
            log('YouTube 播放错误：' + event.data, 'error');
          }
        }
      });
    });
    return true;
  }

  function captionCacheKey(videoId, track) {
    return 'subtitle-download:caption:v2:' + [videoId, track.lang || '', track.name || '', track.kind || ''].join(':');
  }

  function readCaptionCache(videoId, track) {
    try {
      const raw = localStorage.getItem(captionCacheKey(videoId, track));
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.text) return '';
      return String(parsed.text || '');
    } catch (_) {
      return '';
    }
  }

  function writeCaptionCache(videoId, track, text) {
    try {
      const value = String(text || '');
      if (!value.trim() || value.length > 600000) return;
      localStorage.setItem(captionCacheKey(videoId, track), JSON.stringify({ t: Date.now(), text: value }));
    } catch (_) {}
  }

  async function tryYouTubeCaptions(youtubeId) {
    const settings = currentSettings();
    const browserPrefersZh = /^zh/i.test(navigator.language || '');
    const preferred = settings.language === 'zh' ? ['zh', 'zh-Hans', 'zh-CN', 'zh-Hant']
      : settings.language === 'en' ? ['en']
      : app.languageHint === 'zh' || browserPrefersZh ? ['zh', 'zh-Hans', 'zh-CN', 'zh-Hant', 'en']
      : ['en', 'zh', 'zh-Hans', 'zh-CN', 'zh-Hant'];
    setProgress('asr', 4, 'YouTube 字幕直取', '正在检查 YouTube 是否已有字幕/自动字幕。');
    log('优先尝试 YouTube 已有字幕；成功时无需录音、无需本地 ASR，速度最快。');
    try {
      const tracks = await fetchYouTubeCaptionTracks(youtubeId);
      app.lastCaptionTracks = tracks;
      if (!tracks.length) throw new Error('没有返回可读字幕轨。');
      const selected = chooseCaptionTrack(tracks, preferred);
      if (!selected) throw new Error('没有匹配的中英文字幕轨。');
      log('找到字幕轨：' + selected.display + ' / ' + selected.lang + (selected.kind ? ' / ' + selected.kind : '') + '。', 'success');
      let text = readCaptionCache(youtubeId, selected);
      if (text) {
        log('命中本地字幕缓存：直接复用，不重新下载字幕轨。', 'success');
      } else {
        setProgress('asr', 18, 'YouTube 字幕直取', '正在下载字幕轨：' + selected.display + '。');
        text = await fetchCaptionText(youtubeId, selected);
        writeCaptionCache(youtubeId, selected, text);
      }
      if (!text || text.trim().length < 2) throw new Error('字幕轨为空。');
      app.captionFastPathUsed = true;
      app.transcriptText = cleanTranscriptText(text);
      const output = $('transcript-output');
      if (output) output.value = app.transcriptText;
      setButton('download-txt-btn', true);
      setStatus('check-capture', '已直取字幕，无需捕获音频', 'ok');
      setProgress('audio', 100, '音频提取跳过', '已直接读取 YouTube 字幕，不需要捕获标签页音频。');
      setProgress('asr', 100, '字幕已完成', '已输出纯文本：' + app.transcriptText.length + ' 字符。');
      setProgress('overall', 100, '完成', 'YouTube 已有字幕直取完成。');
      log('YouTube 字幕直取完成：' + app.transcriptText.length + ' 字符。', 'success');
      updateOneClickButton();
      return true;
    } catch (error) {
      log('YouTube 字幕直取不可用：' + error.message + '。将改用当前标签页音频捕获。', 'warn');
      setProgress('asr', 0, '等待音频捕获', '没有可直取字幕，下一步需要授权捕获当前标签页音频。');
      return false;
    }
  }

  async function fetchYouTubeCaptionTracks(youtubeId) {
    const endpoints = [
      'https://video.google.com/timedtext',
      'https://www.youtube.com/api/timedtext'
    ];
    const hls = ['zh-CN', 'zh-Hans', 'en', navigator.language || 'en'];
    const seen = new Set();
    const errors = [];
    for (const endpoint of endpoints) {
      for (const hl of hls) {
        const url = new URL(endpoint);
        url.searchParams.set('type', 'list');
        url.searchParams.set('v', youtubeId);
        url.searchParams.set('hl', hl);
        const key = url.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const response = await fetch(key, { mode: 'cors', cache: 'no-store' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const xmlText = await response.text();
          const tracks = parseCaptionTrackList(xmlText);
          if (tracks.length) return tracks;
        } catch (error) {
          errors.push(endpoint + ': ' + error.message);
        }
      }
    }
    if (errors.length) throw new Error(errors.slice(0, 2).join('；'));
    return [];
  }

  function parseCaptionTrackList(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText || '', 'application/xml');
    const tracks = Array.from(doc.querySelectorAll('track')).map((node) => ({
      lang: node.getAttribute('lang_code') || '',
      name: node.getAttribute('name') || '',
      kind: node.getAttribute('kind') || '',
      display: node.getAttribute('lang_translated') || node.getAttribute('lang_original') || node.getAttribute('lang_code') || ''
    })).filter((track) => track.lang);
    const seen = new Set();
    return tracks.filter((track) => {
      const key = [track.lang, track.name, track.kind].join('\u0001');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function chooseCaptionTrack(tracks, preferredLangs) {
    const normalized = tracks.map((track) => Object.assign({}, track, { langLower: track.lang.toLowerCase() }));
    const preferHuman = (items) => items.find((track) => track.kind !== 'asr') || items[0];
    for (const lang of preferredLangs) {
      const lower = lang.toLowerCase();
      const exacts = normalized.filter((track) => track.langLower === lower);
      if (exacts.length) return preferHuman(exacts);
      const prefixes = normalized.filter((track) => track.langLower.startsWith(lower + '-') || track.langLower.startsWith(lower));
      if (prefixes.length) return preferHuman(prefixes);
    }
    const zh = normalized.filter((track) => /^zh/i.test(track.lang));
    if (zh.length) return preferHuman(zh);
    const en = normalized.filter((track) => /^en/i.test(track.lang));
    if (en.length) return preferHuman(en);
    return normalized[0];
  }

  async function fetchCaptionText(videoId, track) {
    const endpoints = ['https://video.google.com/timedtext', 'https://www.youtube.com/api/timedtext'];
    const formats = ['json3', 'vtt', ''];
    let lastError;
    for (const endpoint of endpoints) {
      for (const fmt of formats) {
        const url = new URL(endpoint);
        url.searchParams.set('v', videoId);
        url.searchParams.set('lang', track.lang);
        if (track.name) url.searchParams.set('name', track.name);
        if (track.kind) url.searchParams.set('kind', track.kind);
        if (fmt) url.searchParams.set('fmt', fmt);
        try {
          const response = await fetch(url.toString(), { mode: 'cors', cache: 'no-store' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          if (fmt === 'json3') {
            const json = await response.json();
            const text = parseJson3Captions(json);
            if (text.trim()) return text;
          } else {
            const raw = await response.text();
            const text = fmt === 'vtt' ? parseVttCaptions(raw) : parseXmlCaptions(raw);
            if (text.trim()) return text;
          }
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError || new Error('字幕下载失败。');
  }

  function parseVttCaptions(vtt) {
    return String(vtt || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !/^WEBVTT/i.test(line) && !/^Kind:/i.test(line) && !/^Language:/i.test(line) && !/-->/i.test(line) && !/^\d+$/.test(line))
      .map((line) => line.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .join('\n');
  }

  function parseXmlCaptions(xml) {
    const doc = new DOMParser().parseFromString(xml || '', 'application/xml');
    return Array.from(doc.querySelectorAll('text')).map((node) => node.textContent || '').join('\n');
  }

  function parseJson3Captions(json) {
    const events = Array.isArray(json && json.events) ? json.events : [];
    return events.map((event) => {
      const segs = Array.isArray(event.segs) ? event.segs : [];
      return segs.map((seg) => seg.utf8 || '').join('');
    }).join('\n');
  }

  function cleanTranscriptText(text) {
    const lines = String(text || '')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const deduped = [];
    for (const line of lines) {
      if (line && line !== deduped[deduped.length - 1]) deduped.push(line);
    }
    return deduped.join('\n').trim();
  }

  function getMediaTime() {
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer && typeof app.ytPlayer.getCurrentTime === 'function') {
        const t = Number(app.ytPlayer.getCurrentTime());
        if (Number.isFinite(t) && t >= 0) return t;
      }
      const media = $('media-element');
      if (media && Number.isFinite(media.currentTime) && media.currentTime >= 0) return media.currentTime;
    } catch (_) {}
    return 0;
  }

  function getMediaDuration() {
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer && typeof app.ytPlayer.getDuration === 'function') {
        const d = Number(app.ytPlayer.getDuration());
        if (Number.isFinite(d) && d > 0) return d;
      }
      const media = $('media-element');
      if (media && Number.isFinite(media.duration) && media.duration > 0) return media.duration;
    } catch (_) {}
    return 0;
  }

  function isMediaPaused() {
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer && typeof app.ytPlayer.getPlayerState === 'function') {
        const state = app.ytPlayer.getPlayerState();
        return state === 2 || state === 0 || state === -1;
      }
      const media = $('media-element');
      return !media || media.paused || media.ended;
    } catch (_) {
      return false;
    }
  }

  function applyPlaybackRate() {
    const settings = currentSettings();
    const wanted = settings.playbackRate || 1;
    app.capturePlaybackRate = wanted;
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer) {
        const rates = typeof app.ytPlayer.getAvailablePlaybackRates === 'function' ? app.ytPlayer.getAvailablePlaybackRates() : [];
        const selected = rates && rates.length ? rates.reduce((best, item) => Math.abs(item - wanted) < Math.abs(best - wanted) ? item : best, rates[0]) : wanted;
        if (typeof app.ytPlayer.setPlaybackRate === 'function') app.ytPlayer.setPlaybackRate(selected);
        app.capturePlaybackRate = Number(selected) || wanted;
        log('播放倍速设置为 ' + app.capturePlaybackRate + 'x。', 'success');
        return;
      }
      const media = $('media-element');
      if (media) {
        media.playbackRate = wanted;
        app.capturePlaybackRate = wanted;
        log('媒体倍速设置为 ' + wanted + 'x。', 'success');
      }
    } catch (error) {
      log('设置倍速失败，继续使用当前倍速：' + error.message, 'warn');
    }
  }

  async function startMediaPlaybackForCapture() {
    applyPlaybackRate();
    if (app.currentKind === 'youtube') {
      if (app.ytPlayer && typeof app.ytPlayer.playVideo === 'function') {
        app.ytPlayer.playVideo();
        log('已请求 YouTube 开始播放，用于捕获标签页音频。');
      }
      return;
    }
    const media = $('media-element');
    if (!media) return;
    media.muted = false;
    try {
      await media.play();
      log('媒体开始播放，用于捕获音频。', 'success');
    } catch (error) {
      throw new Error('浏览器阻止媒体播放：' + error.message + '。请用独立播放页确认链接可播放，或降低浏览器自动播放限制。');
    }
  }

  function mediaCoverageSeconds() {
    const t = getMediaTime();
    return Math.max(0, t - app.captureBaseMediaTime);
  }

  function totalCachedBytes() {
    return app.completedAudioBytes + app.currentChunks.reduce((sum, blob) => sum + blob.size, 0);
  }

  function updateCaptureProgress() {
    if (!app.captureActive) return;
    const coverage = mediaCoverageSeconds();
    const elapsed = (Date.now() - app.captureStartWall) / 1000;
    const target = app.captureTargetSeconds || 0;
    const pct = target > 0 ? Math.min(99, (coverage / target) * 100) : Math.min(98, 8 + coverage / 36);
    const pausedText = app.capturePaused ? '，视频暂停中：录制器已暂停，不再缓存静音' : '';
    const targetText = target > 0 ? ' / ' + target.toFixed(1) + ' 秒' : ' 秒 / 全长或手动停止';
    setProgress('audio', pct, '音频提取', '正在捕获音频：已覆盖视频 ' + coverage.toFixed(1) + targetText + '，实际耗时 ' + elapsed.toFixed(1) + ' 秒，已缓存 ' + formatBytes(totalCachedBytes()) + pausedText + '。');
    setProgress('overall', Math.min(76, 38 + pct * 0.38), '捕获与转写', app.capturePaused ? '视频暂停，音频捕获暂停。' : '正在边捕获边转文字。');
  }

  function enqueueSegment(blob, start, end) {
    if (!blob || blob.size <= 0) return;
    const index = app.currentSegmentIndex;
    app.capturedSegmentCount += 1;
    app.completedAudioBytes += blob.size;
    app.segmentQueue.push({ index, start, end, duration: Math.max(0.1, end - start), blob });
    log('音频分段入队：第 ' + index + ' 段，覆盖 ' + start.toFixed(1) + '-' + end.toFixed(1) + ' 秒，大小 ' + formatBytes(blob.size) + '。');
    processSegmentQueue();
  }

  function beginRecorderSegment() {
    if (!app.captureStream || app.captureStopping) return;
    const mime = app.recorderMime || pickAudioMime();
    if (!mime) throw new Error('没有可用 MediaRecorder 音频编码。');
    app.currentChunks = [];
    app.currentSegmentIndex += 1;
    app.currentSegmentStartMedia = mediaCoverageSeconds();
    app.currentSegmentActiveMs = 0;
    app.currentSegmentLastTick = performance.now();
    const recorder = new MediaRecorder(app.captureStream, { mimeType: mime, audioBitsPerSecond: 24000 });
    app.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) app.currentChunks.push(event.data);
    };
    recorder.onerror = (event) => log('MediaRecorder 错误：' + (event.error ? event.error.message : '未知错误'), 'error');
    recorder.onstop = () => {
      const blob = new Blob(app.currentChunks, { type: mime });
      const start = app.currentSegmentStartMedia;
      const end = Math.max(start + 0.1, mediaCoverageSeconds());
      const shouldKeep = blob.size > 0 && end - start > 0.2;
      if (shouldKeep) enqueueSegment(blob, start, end);
      app.currentChunks = [];
      app.recorder = null;
      if (app.captureActive && !app.captureStopping && !app.capturePaused) {
        try { beginRecorderSegment(); } catch (error) { log('启动下一段录制失败：' + error.message, 'error'); stopCapture(); }
      } else if (app.captureStopping) {
        finishCapture();
      }
    };
    recorder.start();
  }

  function pauseRecorderBecauseMediaPaused() {
    if (app.capturePaused) return;
    app.capturePaused = true;
    if (app.recorder && app.recorder.state === 'recording') {
      try { app.recorder.pause(); } catch (_) {}
    }
    setStatus('check-capture', '视频暂停，录制已暂停', 'warn');
    log('检测到视频暂停或播放时间不前进：已暂停录制器，不再缓存静音。', 'warn');
    updateCaptureProgress();
  }

  function resumeRecorderBecauseMediaPlaying() {
    if (!app.capturePaused) return;
    app.capturePaused = false;
    app.currentSegmentLastTick = performance.now();
    if (app.recorder && app.recorder.state === 'paused') {
      try { app.recorder.resume(); } catch (_) {}
    } else if (!app.recorder && app.captureActive && !app.captureStopping) {
      beginRecorderSegment();
    }
    setStatus('check-capture', '正在捕获音频', 'ok');
    log('检测到视频继续播放：已恢复音频捕获。', 'success');
  }

  function rotateRecorderSegment() {
    if (!app.recorder || app.recorder.state === 'inactive') return;
    try { app.recorder.stop(); } catch (error) { log('切分音频段失败：' + error.message, 'error'); }
  }

  function startPlaybackWatchdog() {
    const settings = currentSettings();
    app.lastMediaTime = getMediaTime();
    app.lastMediaAdvanceAt = performance.now();
    app.currentSegmentLastTick = performance.now();
    clearInterval(app.watchdogTimer);
    app.watchdogTimer = setInterval(() => {
      if (!app.captureActive) return;
      const now = performance.now();
      const t = getMediaTime();
      const advanced = t > app.lastMediaTime + 0.03;
      if (advanced) {
        app.lastMediaTime = t;
        app.lastMediaAdvanceAt = now;
      }
      const stalledMs = now - app.lastMediaAdvanceAt;
      const paused = isMediaPaused() || stalledMs > 1800;
      if (paused) {
        pauseRecorderBecauseMediaPaused();
      } else {
        resumeRecorderBecauseMediaPlaying();
      }
      if (!app.capturePaused && app.recorder && app.recorder.state === 'recording') {
        const delta = Math.max(0, now - app.currentSegmentLastTick);
        app.currentSegmentActiveMs += delta;
        app.currentSegmentLastTick = now;
        if (app.currentSegmentActiveMs >= settings.segmentSeconds * 1000) rotateRecorderSegment();
      } else {
        app.currentSegmentLastTick = now;
      }
      updateCaptureProgress();
      const duration = getMediaDuration();
      if (duration > 0 && t >= duration - 0.3) stopCapture();
      if (app.captureWallLimitSeconds > 0 && (Date.now() - app.captureStartWall) / 1000 >= app.captureWallLimitSeconds) stopCapture();
    }, 350);
  }

  async function startAudioCaptureFromStream(stream, label, expectedSeconds = 0) {
    if (!stream || !stream.getAudioTracks().length) throw new Error('没有可捕获的音轨。');
    const mime = pickAudioMime();
    if (!mime) throw new Error('当前浏览器没有可用音频录制编码。');

    app.asrRunId += 1;
    app.captureStream = stream;
    app.recorderMime = mime;
    app.captureActive = true;
    app.captureStopping = false;
    app.capturePaused = false;
    app.currentSegmentIndex = 0;
    app.currentChunks = [];
    app.allAudioParts = [];
    app.completedAudioBytes = 0;
    app.failedSegmentCount = 0;
    app.segmentQueue = [];
    app.segmentProcessing = false;
    app.isTranscribing = false;
    app.isWarming = false;
    app.capturedSegmentCount = 0;
    app.transcribedSegmentCount = 0;
    app.transcribedMediaSeconds = 0;
    app.transcriptBySegment = new Map();
    app.transcriptText = '';
    app.firstSegmentLanguageDecisionDone = false;
    if ($('transcript-output')) $('transcript-output').value = '';

    const settings = currentSettings();
    app.captureStartWall = Date.now();
    app.captureBaseMediaTime = getMediaTime();
    app.captureTargetSeconds = settings.seconds > 0 ? settings.seconds * app.capturePlaybackRate : expectedSeconds;
    app.captureWallLimitSeconds = settings.seconds > 0 ? settings.seconds : 0;
    app.lastMediaTime = getMediaTime();
    app.lastMediaAdvanceAt = performance.now();

    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (app.captureActive) {
          log('捕获轨道已结束。', 'warn');
          stopCapture();
        }
      };
    });

    setStatus('check-capture', '正在捕获音频', 'ok');
    setProgress('audio', 2, '音频提取', label + '已开始。');
    setProgress('asr', 0, '转文字', '模型会并行预热；每完成一个独立音频段就立即追加文本。');
    log('开始' + label + '：独立分段录制，视频暂停时录制器会暂停，避免缓存静音。录制格式：' + mime + '。', 'success');
    updateOneClickButton();
    scheduleWarmup(50);
    beginRecorderSegment();
    startPlaybackWatchdog();
    updateCaptureProgress();
  }

  async function startNativeCapture() {
    const media = $('media-element');
    if (!media || !app.mediaReady) throw new Error('媒体尚未准备好。');
    await startMediaPlaybackForCapture();
    const rawStream = getCaptureStream(media);
    if (!rawStream || !rawStream.getAudioTracks().length) throw new Error('没有检测到媒体音轨。');
    const stream = new MediaStream(rawStream.getAudioTracks());
    const expected = currentSettings().seconds > 0 ? currentSettings().seconds : Math.max(0, getMediaDuration() - getMediaTime());
    await startAudioCaptureFromStream(stream, '媒体音频捕获', expected);
  }

  async function startTabCapture() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') throw new Error('当前浏览器不支持标签页音频捕获，请使用 Chrome 桌面版。');
    setStatus('check-capture', '等待浏览器授权', 'pending');
    setProgress('audio', 2, '标签页音频捕获', '请选择当前标签页，并勾选共享标签页音频。');
    log('请求浏览器授权：请选择当前标签页，并勾选“共享标签页音频”。', 'warn');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        systemAudio: 'include',
        surfaceSwitching: 'exclude'
      });
      app.displayStream = stream;
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stopDisplayCaptureTracks();
        throw new Error('没有捕获到音频轨。请重新点击，并勾选“共享标签页音频”。');
      }
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack && typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
      if (settings && settings.displaySurface && settings.displaySurface !== 'browser') {
        log('当前捕获的可能不是浏览器标签页：' + settings.displaySurface + '。如需准确进度，请选择当前标签页。', 'warn');
      }
      await startMediaPlaybackForCapture();
      const expected = currentSettings().seconds > 0 ? currentSettings().seconds : Math.max(0, getMediaDuration() - getMediaTime());
      await startAudioCaptureFromStream(new MediaStream(audioTracks), '当前标签页音频捕获', expected);
    } catch (error) {
      if (!app.captureActive) stopDisplayCaptureTracks();
      throw error;
    }
  }

  function stopCapture() {
    if (!app.captureActive || app.captureStopping) return;
    app.captureStopping = true;
    setProgress('audio', 98, '音频提取', '正在停止捕获并封装最后一段音频。');
    log('停止捕获，正在封装最后一段。');
    clearInterval(app.watchdogTimer);
    clearInterval(app.captureTimer);
    clearTimeout(app.hardStopTimer);
    app.watchdogTimer = null;
    app.captureTimer = null;
    app.hardStopTimer = null;
    if (app.recorder && app.recorder.state !== 'inactive') {
      try {
        if (app.recorder.state === 'paused') app.recorder.resume();
        app.recorder.stop();
      } catch (_) {
        finishCapture();
      }
    } else {
      finishCapture();
    }
  }

  function finishCapture() {
    if (!app.captureActive && !app.captureStopping) return;
    app.captureActive = false;
    app.captureStopping = false;
    stopTimers();
    stopDisplayCaptureTracks();
    stopCaptureStreamTracks();
    pauseSourcePlayback();
    app.capturedBlob = null;
    if (app.capturedUrl) URL.revokeObjectURL(app.capturedUrl);
    app.capturedUrl = '';
    setButton('download-audio-btn', false);
    setProgress('audio', 100, '音频提取', '音频捕获完成：已处理 ' + formatBytes(app.completedAudioBytes) + '，共切出 ' + app.capturedSegmentCount + ' 段。剩余队列会继续转文字。');
    log('音频捕获完成：已处理 ' + formatBytes(app.completedAudioBytes) + '，共切出 ' + app.capturedSegmentCount + ' 段；已自动暂停源视频。', 'success');
    updateOneClickButton();
    processSegmentQueue();
    finishIfDone();
  }

  function configureTransformers(mod) {
    if (!mod || !mod.env) return;
    try { mod.env.allowRemoteModels = true; } catch (_) {}
    try { mod.env.allowLocalModels = false; } catch (_) {}
    try { mod.env.useBrowserCache = true; } catch (_) {}
    try { mod.env.useFSCache = false; } catch (_) {}
  }

  async function loadTransformers(runId) {
    if (window.__subtitleDownloadTransformers) {
      configureTransformers(window.__subtitleDownloadTransformers);
      return window.__subtitleDownloadTransformers;
    }
    const urls = [
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/dist/transformers.min.js',
      'https://unpkg.com/@huggingface/transformers@3.7.0/dist/transformers.min.js'
    ];
    let lastError;
    for (const url of urls) {
      try {
        if (runId === app.asrRunId) setProgress('asr', 4, '运行库加载', '正在加载 Transformers.js。');
        const mod = await import(url);
        configureTransformers(mod);
        window.__subtitleDownloadTransformers = mod;
        return mod;
      } catch (error) {
        lastError = error;
        log('Transformers.js 加载失败：' + error.message, 'warn');
      }
    }
    throw lastError || new Error('无法加载 Transformers.js。');
  }

  function selectedModelKeyForLanguage(languageOverride = '') {
    const settings = currentSettings();
    const lang = languageOverride || settings.language || 'auto';
    if (settings.language === 'auto' && languageOverride === 'zh') return settings.model + ':zh';
    if (settings.language === 'auto' && languageOverride === 'en') return settings.model + ':en';
    return settings.model + ':' + lang;
  }

  function modelCandidates(languageOverride = '') {
    const key = selectedModelKeyForLanguage(languageOverride);
    return MODEL_MAP[key] || MODEL_MAP['tiny:auto'];
  }

  async function ensureTranscriber(runId, languageOverride = '') {
    const mod = await loadTransformers(runId);
    if (!mod || typeof mod.pipeline !== 'function') throw new Error('Transformers.js pipeline 不可用。');
    const candidates = modelCandidates(languageOverride);
    const devices = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    let lastError;
    for (const device of devices) {
      for (const model of candidates) {
        const key = model + '@' + device;
        if (app.transcriberCache.has(key)) {
          app.transcriber = app.transcriberCache.get(key);
          app.transcriberKey = key;
          return app.transcriber;
        }
        if (app.transcriberPromises.has(key)) return await app.transcriberPromises.get(key);
        const promise = (async () => {
          log('加载模型：' + model + ' / ' + device + '。');
          const pipe = await mod.pipeline('automatic-speech-recognition', model, {
            device,
            dtype: device === 'webgpu' ? 'fp16' : 'q8',
            progress_callback: (event) => {
              if (runId !== app.asrRunId || !event) return;
              if (event.status === 'progress' && Number.isFinite(event.progress)) {
                const pct = Math.max(6, Math.min(34, Number(event.progress) * 0.28 + 6));
                setProgress('asr', pct, '模型下载', '正在下载模型文件：' + Math.round(event.progress) + '%。');
              } else if (event.status === 'ready') {
                setProgress('asr', 34, '模型已就绪', '模型已进入内存缓存。');
              }
            }
          });
          app.transcriberCache.set(key, pipe);
          app.transcriber = pipe;
          app.transcriberKey = key;
          return pipe;
        })();
        app.transcriberPromises.set(key, promise);
        try {
          return await promise;
        } catch (error) {
          lastError = error;
          log('模型加载失败：' + key + '：' + error.message, 'warn');
        } finally {
          app.transcriberPromises.delete(key);
        }
      }
    }
    throw lastError || new Error('模型加载失败。');
  }

  async function warmupModel(reason = 'auto') {
    if (app.isWarming || app.isTranscribing || app.captionFastPathUsed) return;
    app.isWarming = true;
    const runId = app.asrRunId;
    try {
      setProgress('asr', 2, '模型预热', reason === 'manual' ? '正在手动预热模型。' : '正在后台预热模型。');
      const settings = currentSettings();
      let override = '';
      if (settings.language === 'zh' || (settings.language === 'auto' && app.languageHint === 'zh')) override = 'zh';
      if (settings.language === 'en') override = 'en';
      await ensureTranscriber(runId, override);
      if (runId === app.asrRunId && !app.isTranscribing) setProgress('asr', 34, '模型已预热', '当前模型已缓存；后续分段会直接识别。');
    } catch (error) {
      if (!app.isTranscribing) setProgress('asr', 0, '模型预热失败', error.message);
      log('模型预热失败：' + error.message, 'warn');
    } finally {
      app.isWarming = false;
    }
  }

  function scheduleWarmup(delay = 800) {
    clearTimeout(app.warmupTimer);
    app.warmupTimer = setTimeout(() => warmupModel('auto'), delay);
  }

  function transcribeOptions(languageOverride = '') {
    const settings = currentSettings();
    let language = languageOverride;
    if (!language) {
      if (settings.language === 'zh') language = 'zh';
      else if (settings.language === 'en') language = 'en';
      else if (app.languageHint === 'zh') language = 'zh';
    }
    const options = { task: 'transcribe', return_timestamps: false, condition_on_previous_text: false };
    if (language === 'zh') options.language = 'chinese';
    if (language === 'en') options.language = 'english';
    return options;
  }

  function looksEnglish(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
    return latin >= 8 && cjk === 0;
  }

  function looksChinese(text) {
    return /[\u3400-\u9fff]/.test(String(text || ''));
  }

  function normalizeAsrText(text) {
    return String(text || '')
      .replace(/\s+([,.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function runAsrOnBlob(pipe, blob, options) {
    const url = URL.createObjectURL(blob);
    try {
      const result = await pipe(url, options);
      return normalizeAsrText(result && result.text ? result.text : '');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function transcribeSegment(segment, runId) {
    const settings = currentSettings();
    let languageOverride = '';
    if (settings.language === 'zh') languageOverride = 'zh';
    if (settings.language === 'en') languageOverride = 'en';
    if (settings.language === 'auto' && app.languageHint === 'zh') languageOverride = 'zh';

    let pipe = await ensureTranscriber(runId, languageOverride);
    let text = await runAsrOnBlob(pipe, segment.blob, transcribeOptions(languageOverride));

    if (settings.language === 'auto' && !app.firstSegmentLanguageDecisionDone) {
      app.firstSegmentLanguageDecisionDone = true;
      if (!app.languageHint && looksEnglish(text)) {
        log('首段自动识别成英文；开始中文纠错试跑，防止中文视频被误识别成英文。', 'warn');
        try {
          const zhPipe = await ensureTranscriber(runId, 'zh');
          const zhText = await runAsrOnBlob(zhPipe, segment.blob, transcribeOptions('zh'));
          if (looksChinese(zhText)) {
            app.languageHint = 'zh';
            text = zhText;
            log('中文纠错成功：后续分段将强制中文原文识别。', 'success');
          } else {
            app.languageHint = 'en';
            log('中文纠错未检测到中文，后续按自动/英文路径继续。');
          }
        } catch (error) {
          log('中文纠错试跑失败：' + error.message, 'warn');
        }
      } else if (looksChinese(text)) {
        app.languageHint = 'zh';
        log('首段检测到中文：后续分段将优先中文原文识别。', 'success');
      } else if (looksEnglish(text)) {
        app.languageHint = 'en';
        log('首段检测到英文：后续分段将优先英文原文识别。', 'success');
      }
    }
    return text;
  }

  function renderTranscript() {
    const parts = Array.from(app.transcriptBySegment.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => String(entry[1] || '').trim())
      .filter(Boolean);
    app.transcriptText = parts.join('\n');
    const output = $('transcript-output');
    if (output) {
      output.value = app.transcriptText;
      output.scrollTop = output.scrollHeight;
    }
    setButton('download-txt-btn', Boolean(app.transcriptText));
    updateOneClickButton();
  }

  function finishIfDone() {
    if (app.captureActive || app.captureStopping || app.segmentProcessing || app.segmentQueue.length) return;
    if (app.capturedSegmentCount > 0 && app.transcribedSegmentCount >= app.capturedSegmentCount) {
      const failedText = app.failedSegmentCount ? '，失败跳过 ' + app.failedSegmentCount + ' 段' : '';
      setProgress('asr', 100, '转文字完成', '已完成 ' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段' + failedText + '，文本长度 ' + app.transcriptText.length + ' 字符。');
      setProgress('overall', 100, '完成', '全部音频分段已经转成纯文本。' + failedText);
      log('全部转写完成：' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段' + failedText + '。', 'success');
    }
    updateOneClickButton();
  }

  async function processSegmentQueue() {
    if (app.segmentProcessing) return;
    if (!app.segmentQueue.length) {
      finishIfDone();
      return;
    }
    const runId = app.asrRunId;
    app.segmentProcessing = true;
    app.isTranscribing = true;
    try {
      while (app.segmentQueue.length && runId === app.asrRunId) {
        const segment = app.segmentQueue.shift();
        const startTime = Date.now();
        const progressTimer = setInterval(() => {
          const elapsed = (Date.now() - startTime) / 1000;
          const local = Math.min(98, 34 + elapsed / Math.max(4, segment.duration * (navigator.gpu ? 0.7 : 1.6)) * 52);
          const target = app.captureTargetSeconds > 0 ? app.captureTargetSeconds : Math.max(mediaCoverageSeconds(), segment.end, 1);
          const global = target > 0 ? Math.min(98, 34 + (Math.max(app.transcribedMediaSeconds, segment.start) / target) * 60) : local;
          setProgress('asr', Math.max(local, global), '转文字', '正在识别第 ' + segment.index + ' 段；已完成 ' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段。');
        }, 500);
        try {
          log('开始识别第 ' + segment.index + ' 段，覆盖 ' + segment.start.toFixed(1) + '-' + segment.end.toFixed(1) + ' 秒。');
          const text = await transcribeSegment(segment, runId);
          if (runId !== app.asrRunId) break;
          if (text) app.transcriptBySegment.set(segment.index, text);
          app.transcribedSegmentCount += 1;
          app.transcribedMediaSeconds = Math.max(app.transcribedMediaSeconds, segment.end);
          renderTranscript();
          const target = app.captureTargetSeconds > 0 ? app.captureTargetSeconds : Math.max(mediaCoverageSeconds(), app.transcribedMediaSeconds, 1);
          const pct = Math.min(99, 34 + (app.transcribedMediaSeconds / target) * 60);
          setProgress('asr', pct, '转文字', '第 ' + segment.index + ' 段完成；累计 ' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段。');
          log('第 ' + segment.index + ' 段识别完成。', 'success');
        } catch (error) {
          if (runId !== app.asrRunId) break;
          app.failedSegmentCount += 1;
          app.transcribedSegmentCount += 1;
          app.transcribedMediaSeconds = Math.max(app.transcribedMediaSeconds, segment.end);
          log('第 ' + segment.index + ' 段识别失败，已跳过并继续后续分段：' + error.message, 'error');
          setProgress('asr', 60, '转文字', '第 ' + segment.index + ' 段失败并跳过；继续处理后续分段。');
        } finally {
          clearInterval(progressTimer);
        }
      }
    } catch (error) {
      setProgress('asr', 100, '转文字失败', error.message);
      setProgress('overall', 100, '失败', error.message);
      log('转文字失败：' + error.message, 'error');
      if (runId === app.asrRunId) alert('转文字失败：' + error.message);
    } finally {
      if (runId === app.asrRunId) {
        app.segmentProcessing = false;
        app.isTranscribing = false;
        if (app.segmentQueue.length) processSegmentQueue();
        else finishIfDone();
      }
    }
  }

  async function inspectLink(input) {
    const info = classifyUrl(input);
    setStatus('check-type', info.label, info.kind === 'invalid' ? 'bad' : info.kind === 'page' ? 'warn' : 'ok');
    log('链接类型：' + info.label + '。');
    const probe = await probeHttp(input, info.kind);
    setStatus('check-connect', probe.ok ? '可连接' : (info.kind === 'page' ? '不是媒体' : '需播放验证'), probe.state);
    log(probe.message, probe.ok ? 'success' : probe.state === 'bad' ? 'error' : 'warn');
    if (info.kind === 'invalid') throw new Error('URL 格式无效。');
    if (info.kind === 'page') {
      setStatus('check-control', '不可操作', 'warn');
      setStatus('check-play', '不可播放', 'warn');
      setStatus('check-capture', '不可捕获', 'warn');
      throw new Error('普通网页不是媒体直链；请输入 YouTube 链接、MP4/MP3/WAV/HLS 直链。');
    }
    if (info.kind === 'youtube') {
      await inspectYouTube(input, info.youtubeId);
      return info;
    }
    await inspectNative(input, info.kind);
    return info;
  }

  async function runOneClick() {
    if (app.captureActive || app.captureStopping) {
      stopCapture();
      updateOneClickButton();
      return;
    }
    if (app.segmentProcessing || app.segmentQueue.length) {
      const restart = confirm('当前仍在转写队列中。确定要中断并重新开始吗？');
      if (!restart) return;
    }
    const input = ($('source-url')?.value || '').trim();
    if (!input) return alert('请输入链接。');
    resetForNewRun();
    app.currentUrl = input;
    updateOneClickButton('running');
    setProgress('overall', 3, '链接检测', '开始检测链接。');
    try {
      const info = await inspectLink(input);
      if (info.kind === 'youtube') {
        const captionOk = await tryYouTubeCaptions(info.youtubeId);
        if (captionOk) return;
        setStatus('check-capture', '需要标签页音频授权', 'warn');
        setProgress('audio', 2, '标签页音频捕获', '准备请求浏览器授权。');
        await startTabCapture();
        return;
      }
      await startNativeCapture();
    } catch (error) {
      stopDisplayCaptureTracks();
      stopCaptureStreamTracks();
      pauseSourcePlayback();
      app.captureActive = false;
      app.captureStopping = false;
      setProgress('overall', 100, '失败', error.message);
      log('流程失败：' + error.message, 'error');
      alert(error.message);
    } finally {
      updateOneClickButton();
    }
  }

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function downloadAudio() {
    if (!app.capturedBlob || app.capturedBlob.size <= 0) return alert('当前版本为长视频低内存文本模式，不再聚合完整音频文件；请下载 TXT。');
    const ext = app.capturedBlob.type.includes('mp4') ? 'm4a' : 'webm';
    download('subtitle-download-audio-' + Date.now() + '.' + ext, app.capturedBlob);
  }

  function downloadTxt() {
    if (!app.transcriptText) return alert('没有可下载的文本。');
    download('subtitle-download-transcript-' + Date.now() + '.txt', new Blob([app.transcriptText], { type: 'text/plain;charset=utf-8' }));
  }

  function updateOneClickButton(forcedState = '') {
    const btn = $('one-click-btn');
    if (!btn) return;
    btn.disabled = false;
    if (app.captureActive || app.captureStopping) {
      btn.textContent = '停止捕获并完成转文字';
      btn.className = 'btn btn-dark';
      return;
    }
    if (forcedState === 'running') {
      btn.textContent = '正在检测并准备捕获';
      btn.className = 'btn btn-primary';
      return;
    }
    if (app.segmentProcessing || app.segmentQueue.length) {
      btn.textContent = '正在转文字，点击可重新开始';
      btn.className = 'btn btn-primary';
      return;
    }
    if (app.transcriptText) {
      btn.textContent = '重新开始检测、捕获并转文字';
      btn.className = 'btn btn-green';
      return;
    }
    btn.textContent = '开始检测、捕获并转文字';
    btn.className = 'btn btn-green';
  }

  function wire() {
    $('one-click-btn')?.addEventListener('click', () => runOneClick());
    $('download-audio-btn')?.addEventListener('click', () => downloadAudio());
    $('download-txt-btn')?.addEventListener('click', () => downloadTxt());
    $('open-player-btn')?.addEventListener('click', () => openPlayerPage());
    $('prewarm-btn')?.addEventListener('click', () => warmupModel('manual'));
    ['language-select', 'model-select'].forEach((id) => {
      $(id)?.addEventListener('change', () => {
        log('识别设置已变化；不会自动下载模型，下一次本地 ASR 或手动预热时生效。');
      });
    });
    $('playback-rate')?.addEventListener('change', () => log('播放倍速已变化，下一次捕获生效。'));
    document.querySelectorAll('[data-example]').forEach((button) => {
      button.addEventListener('click', () => {
        const input = $('source-url');
        if (input) input.value = button.getAttribute('data-example') || '';
      });
    });
    resetChecks();
    resetProgress();
    resetOutputs();
    clearLog();
    updateOneClickButton();
    registerServiceWorker();
    log('模型不会在打开页面时自动下载；优先直取 YouTube 字幕，只有需要本地 ASR 时才加载模型。');
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
