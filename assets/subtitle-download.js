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

  const YT_STATE_LABELS = {
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
    hls: null,
    ytPlayer: null,
    ytHostSeq: 0,
    ytApiPromise: null,
    mediaReadyForCapture: false,
    recorder: null,
    chunks: [],
    captureTimer: null,
    stopTimer: null,
    transcribeTimer: null,
    captureStartedAt: 0,
    capturedSeconds: 0,
    captureTargetSeconds: 0,
    captureHardLimitSeconds: 0,
    capturedBlob: null,
    capturedUrl: '',
    displayStream: null,
    captureMode: '',
    transcriptText: '',
    transcriptSrt: '',
    transcriber: null,
    transcriberKey: '',
    transcriberCache: new Map(),
    transcriberPromises: new Map(),
    isTranscribing: false,
    isWarmingModel: false,
    warmupTimer: null,
    serviceWorkerReady: false,
    asrRunId: 0,
    segmentSessionId: 0,
    segmentMode: true,
    segmentSeconds: 10,
    segmentRecorder: null,
    segmentTimer: null,
    segmentStartedAt: 0,
    segmentIndex: 0,
    segmentQueue: [],
    segmentProcessing: false,
    segmentStopRequested: false,
    segmentCaptureStream: null,
    segmentMime: '',
    segmentResults: [],
    audioParts: [],
    capturedSegmentCount: 0,
    transcribedSegmentCount: 0,
    transcribedSeconds: 0,
    captureBaseMediaTime: 0,
    capturePlaybackRate: 1,
    pcmContext: null,
    pcmSource: null,
    pcmProcessor: null,
    pcmGain: null,
    pcmBuffer: [],
    pcmBufferedSamples: 0,
    pcmSampleRate: 16000,
    pcmSegmentVideoStart: 0,
    oneClickAwaitingTabCapture: false,
    recoveringSegments: false,
    transcriptBySegment: new Map(),
    srtDisabled: true
  };

  function timeNow() {
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
    line.textContent = '[' + timeNow() + '] ' + message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = $('diagnostics-log');
    if (!box) return;
    box.dataset.empty = 'true';
    box.innerHTML = '<div class="line">[等待] 粘贴链接后点击“开始检测、捕获并转文字”。</div>';
  }


  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      log('当前浏览器不支持 Service Worker，模型只能依赖浏览器默认缓存。', 'warn');
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      app.serviceWorkerReady = true;
      log('离线缓存服务已就绪：模型文件会尽量持久缓存，避免每次重复下载。', 'success');
      if (registration && registration.update) registration.update().catch(() => {});
    } catch (error) {
      log('离线缓存服务注册失败：' + error.message, 'warn');
    }
  }

  function setStatus(id, text, state = 'pending') {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'status-value ' + state;
  }

  function setButton(id, enabled) {
    const el = $(id);
    if (!el) return;
    el.disabled = !enabled;
  }

  function setProgress(kind, percent, label, detail) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = $(kind + '-bar');
    const pct = $(kind + '-percent');
    const name = $(kind + '-label');
    const text = $(kind + '-detail');
    if (bar) bar.style.width = safe + '%';
    if (pct) pct.textContent = Math.round(safe) + '%';
    if (name && label) name.textContent = label;
    if (text && detail) text.textContent = detail;
  }

  function resetProgress() {
    setProgress('overall', 0, '总进度', '等待检测。');
    setProgress('audio', 0, '音频提取', '等待捕获。');
    setProgress('asr', 0, 'ASR 识别', '等待捕获完成；模型会在后台预热缓存。');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i += 1;
    }
    return size.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  function resetChecks() {
    setStatus('check-type', '检测中', 'pending');
    setStatus('check-connect', '等待', 'pending');
    setStatus('check-control', '等待', 'pending');
    setStatus('check-play', '等待', 'pending');
    setStatus('check-capture', '等待', 'pending');
  }

  function resetOutputs() {
    app.asrRunId += 1;
    app.segmentSessionId += 1;
    app.isTranscribing = false;
    app.segmentProcessing = false;
    app.segmentStopRequested = false;
    clearInterval(app.transcribeTimer);
    clearTimeout(app.segmentTimer);
    app.transcribeTimer = null;
    app.segmentTimer = null;
    if (app.capturedUrl) URL.revokeObjectURL(app.capturedUrl);
    app.captureMode = '';
    app.oneClickAwaitingTabCapture = false;
    app.capturedUrl = '';
    app.capturedBlob = null;
    app.chunks = [];
    app.audioParts = [];
    app.segmentQueue = [];
    app.segmentResults = [];
    app.recoveringSegments = false;
    app.transcriptBySegment = new Map();
    stopPcmSegmenter(false);
    app.segmentRecorder = null;
    app.segmentCaptureStream = null;
    app.segmentIndex = 0;
    app.capturedSegmentCount = 0;
    app.transcribedSegmentCount = 0;
    app.transcribedSeconds = 0;
    app.capturedSeconds = 0;
    app.transcriptText = '';
    app.transcriptSrt = '';
    const transcript = $('transcript-output');
    const srt = $('srt-output');
    if (transcript) transcript.value = '';
    if (srt) srt.value = '';
    ['download-audio-btn', 'download-txt-btn', 'download-srt-btn', 'transcribe-btn', 'capture-tab-btn'].forEach((id) => setButton(id, false));
  }

  function teardownNativeMedia() {
    const media = $('media-element');
    if (app.hls) {
      app.hls.destroy();
      app.hls = null;
    }
    if (media) {
      try { media.pause(); } catch (_) {}
      media.removeAttribute('src');
      media.load();
    }
    app.mediaReadyForCapture = false;
  }

  function teardownYouTube() {
    if (app.ytPlayer && typeof app.ytPlayer.destroy === 'function') {
      try { app.ytPlayer.destroy(); } catch (_) {}
    }
    app.ytPlayer = null;
    const host = $('youtube-player');
    if (host) host.innerHTML = '';
  }

  function stopDisplayCaptureTracks() {
    if (!app.displayStream) return;
    app.displayStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (_) {}
    });
    app.displayStream = null;
  }

  function showNative() {
    $('native-panel')?.classList.remove('hidden');
    $('youtube-panel')?.classList.add('hidden');
  }

  function showYouTube() {
    $('native-panel')?.classList.add('hidden');
    $('youtube-panel')?.classList.remove('hidden');
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
      const pathname = decodeURIComponent(url.pathname).toLowerCase();
      if (/\.m3u8($|\?)/i.test(pathname) || /m3u8/i.test(input)) return { kind: 'hls', label: 'HLS / M3U8 媒体流' };
      if (/\.(mp4|webm|mov|m4v|ogg|ogv)($|\?)/i.test(pathname)) return { kind: 'video', label: '视频直链' };
      if (/\.(mp3|wav|m4a|aac|flac|opus|oga)($|\?)/i.test(pathname)) return { kind: 'audio', label: '音频直链' };
      return { kind: 'page', label: '普通网页 / 未知媒体' };
    } catch (_) {
      return { kind: 'invalid', label: '无效链接' };
    }
  }

  async function probeHttp(input, kind) {
    if (kind === 'youtube') {
      return { ok: true, state: 'ok', message: 'YouTube 使用 IFrame API 诊断，不读取网页源码。' };
    }
    if (kind === 'invalid') {
      return { ok: false, state: 'bad', message: 'URL 格式无效。' };
    }
    if (kind === 'page') {
      return { ok: false, state: 'warn', message: '这不是媒体直链；浏览器不能从普通网页拆出音频。' };
    }
    try {
      const method = kind === 'hls' ? 'GET' : 'HEAD';
      const res = await fetch(input, { method, mode: 'cors', cache: 'no-store' });
      if (!res.ok) return { ok: false, state: 'bad', message: 'HTTP ' + res.status + ' ' + res.statusText };
      const type = res.headers.get('content-type') || '未知 Content-Type';
      const size = Number(res.headers.get('content-length'));
      if (kind === 'hls') {
        const text = await res.clone().text();
        if (!/^#EXTM3U/m.test(text.trim())) return { ok: false, state: 'warn', message: '可连接，但返回内容不像 HLS 清单。' };
        const segments = (text.match(/#EXTINF/g) || []).length;
        return { ok: true, state: 'ok', message: 'HLS 清单可读，片段标记 ' + segments + ' 个。' };
      }
      return { ok: true, state: 'ok', message: 'HTTP 可连接：' + type + (size ? '，' + formatBytes(size) : '') };
    } catch (error) {
      return { ok: false, state: 'warn', message: 'fetch/CORS 检测失败：' + error.message + '。继续尝试媒体元素播放。' };
    }
  }

  function waitForMedia(media, timeoutMs = 15000) {
    if (media.readyState >= 1) return Promise.resolve({ ok: true, event: 'readyState' });
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
      const onReady = (event) => finish({ ok: true, event: event.type });
      const onError = () => {
        const map = { 1: '加载被中止', 2: '网络错误', 3: '解码失败', 4: '格式不支持或跨域受限' };
        const reason = media.error ? (map[media.error.code] || '错误码 ' + media.error.code) : '未知错误';
        finish({ ok: false, event: 'error', reason });
      };
      const timer = setTimeout(() => finish({ ok: false, event: 'timeout', reason: '媒体元数据加载超时' }), timeoutMs);
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
    const list = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4'
    ];
    if (!window.MediaRecorder) return '';
    return list.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  function detectCaptureCapability(media) {
    const stream = getCaptureStream(media);
    if (!stream) return { ok: false, state: 'warn', message: '浏览器不支持 captureStream()。' };
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return { ok: false, state: 'warn', message: '已创建捕获流，但没有检测到音轨。' };
    const mime = pickAudioMime();
    if (!mime) return { ok: false, state: 'warn', message: '检测到音轨，但 MediaRecorder 没有可用音频编码。' };
    return { ok: true, state: 'ok', message: '可捕获音频，音轨 ' + tracks.length + ' 条，格式 ' + mime + '。' };
  }

  async function loadNativeMedia(input, kind) {
    showNative();
    teardownYouTube();
    teardownNativeMedia();
    app.currentKind = kind;
    app.currentUrl = input;
    const media = $('media-element');
    if (!media) throw new Error('页面缺少媒体元素。');
    media.crossOrigin = 'anonymous';
    media.controls = true;
    media.muted = false;
    setStatus('check-control', 'HTMLMediaElement 可操作', 'ok');
    log('媒体元素已创建，可执行 play / pause / seek 等操作。', 'success');
    setProgress('overall', 18, '播放检测', '正在加载媒体。');

    if (kind === 'hls') {
      if (window.Hls && window.Hls.isSupported()) {
        app.hls = new window.Hls({ enableWorker: true, backBufferLength: 30 });
        app.hls.loadSource(input);
        app.hls.attachMedia(media);
        log('hls.js 已接管媒体加载，开始解析 HLS 清单。');
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (ok, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ok ? resolve(value) : reject(value);
          };
          const timer = setTimeout(() => done(false, new Error('HLS 清单解析超时。')), 15000);
          app.hls.on(window.Hls.Events.MANIFEST_PARSED, (_event, data) => {
            const levels = data && data.levels ? data.levels.length : 0;
            log('HLS 清单解析完成，清晰度层级 ' + levels + ' 个。', 'success');
            done(true, data);
          });
          app.hls.on(window.Hls.Events.ERROR, (_event, data) => {
            if (data && data.fatal) done(false, new Error(data.details || data.type || 'HLS fatal error'));
          });
        });
      } else if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = input;
        media.load();
        log('浏览器原生 HLS 能力可用。', 'success');
      } else {
        throw new Error('当前浏览器不能播放 HLS；hls.js 未加载或不可用。');
      }
    } else {
      media.src = input;
      media.load();
      log('媒体直链已赋给播放器。');
    }

    setProgress('overall', 30, '播放检测', '等待媒体元数据。');
    const metadata = await waitForMedia(media, 15000);
    if (!metadata.ok) throw new Error(metadata.reason || '媒体无法加载。');
    const duration = Number.isFinite(media.duration) ? media.duration.toFixed(1) + ' 秒' : '直播/未知时长';
    log('元数据已加载：' + duration + '。', 'success');

    setProgress('overall', 42, '播放检测', '正在尝试播放。');
    try {
      await media.play();
      setStatus('check-play', '可播放', 'ok');
      log('play() 成功，媒体正在播放。', 'success');
    } catch (error) {
      setStatus('check-play', '需手动播放', 'warn');
      log('浏览器阻止自动播放：' + error.message + '。请手动点击播放器播放。', 'warn');
      setProgress('overall', 48, '播放检测', '已加载，但需要手动播放后再捕获。');
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
    const capture = detectCaptureCapability(media);
    setStatus('check-capture', capture.ok ? '可捕获' : '不可捕获', capture.state);
    log(capture.message, capture.ok ? 'success' : 'warn');
    app.mediaReadyForCapture = capture.ok;
    setProgress('overall', capture.ok ? 58 : 50, '检测完成', capture.ok ? '媒体可播放且可捕获音频。' : capture.message);
    return capture.ok;
  }

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (app.ytApiPromise) return app.ytApiPromise;
    app.ytApiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      const timer = setTimeout(() => reject(new Error('YouTube IFrame API 加载超时，可能被网络或扩展拦截。')), 15000);
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

  async function inspectYouTube(input, id) {
    showYouTube();
    teardownNativeMedia();
    teardownYouTube();
    app.currentKind = 'youtube';
    app.currentUrl = input;
    app.mediaReadyForCapture = false;
    setStatus('check-connect', '加载 API 中', 'pending');
    setStatus('check-control', '等待播放器', 'pending');
    setStatus('check-play', '等待事件', 'pending');
    setStatus('check-capture', '需授权标签页音频', 'warn');
    setButton('capture-tab-btn', false);
    setProgress('overall', 10, 'YouTube 检测', '正在加载 YouTube IFrame API。');
    log('YouTube 视频 ID：' + id + '。');
    log('YouTube 是跨源 iframe 播放器；不能直接读取 iframe 内部音频，但可以在用户授权后捕获当前标签页音频。', 'warn');

    const api = await loadYouTubeApi();
    setStatus('check-connect', 'IFrame API 已连接', 'ok');
    setProgress('overall', 22, 'YouTube 检测', 'API 已连接，正在创建播放器。');
    log('YouTube IFrame API 已连接。', 'success');

    const host = $('youtube-player');
    app.ytHostSeq += 1;
    const hostId = 'youtube-player-inner-' + app.ytHostSeq;
    host.innerHTML = '<div id="' + hostId + '"></div>';

    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) reject(new Error('YouTube 播放器 ready 超时。'));
      }, 15000);
      app.ytPlayer = new api.Player(hostId, {
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, origin: window.location.origin, rel: 0 },
        events: {
          onReady: (event) => {
            ready = true;
            clearTimeout(timer);
            setStatus('check-control', '可操作', 'ok');
            setProgress('overall', 36, 'YouTube 播放', '播放器 ready，正在尝试播放。');
            log('YouTube 播放器 ready：可调用 playVideo / pauseVideo / seekTo。', 'success');
            try {
              const data = event.target.getVideoData ? event.target.getVideoData() : null;
              if (data && data.title) log('视频标题：' + data.title, 'success');
            } catch (_) {}
            try { event.target.playVideo(); } catch (error) { log('playVideo 调用失败：' + error.message, 'warn'); }
            resolve();
          },
          onStateChange: (event) => {
            const label = YT_STATE_LABELS[String(event.data)] || ('状态码 ' + event.data);
            log('YouTube 播放状态：' + label + '。');
            if (event.data === 1) {
              setStatus('check-play', '可播放', 'ok');
              setProgress('overall', 52, 'YouTube 播放', 'YouTube 正在播放；iframe 不能直接捕获，需使用标签页音频授权。');
            } else if (event.data === 0) {
              setStatus('check-play', '已结束', 'ok');
              if (app.recorder && app.recorder.state !== 'inactive' && app.captureMode === '当前标签页音频捕获') {
                log('YouTube 视频已结束，自动停止标签页音频捕获。', 'success');
                stopCapture();
              }
            } else if (event.data === 3) {
              setStatus('check-play', '缓冲中', 'pending');
              setProgress('overall', 44, 'YouTube 播放', 'YouTube 正在缓冲。');
            } else if (event.data === 2) {
              setStatus('check-play', '已暂停', 'warn');
            }
          },
          onError: (event) => {
            const reason = 'YouTube 错误码 ' + event.data;
            setStatus('check-play', '播放失败', 'bad');
            setProgress('overall', 100, 'YouTube 失败', reason);
            log(reason, 'error');
          }
        }
      });
    });

    setStatus('check-capture', '可授权捕获标签页', 'warn');
    setButton('capture-tab-btn', true);
    setProgress('audio', 0, '音频提取', '等待点击“捕获当前标签页音频”。默认会录到视频结束或手动停止；也可以填写指定秒数。');
    setProgress('asr', 0, 'ASR 识别', '捕获完成后会自动开始本地转文字。');
    log('结论：该 YouTube 链接可连接、可操作；下一步点击“捕获当前标签页音频”，授权后即可录制标签页声音并转文字。', 'success');
    return false;
  }

  function currentSettings() {
    const rawSeconds = Number($('capture-seconds')?.value);
    const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0
      ? Math.max(5, Math.min(14400, rawSeconds))
      : 0;
    const rawSegmentSeconds = Number($('segment-seconds')?.value);
    const segmentSeconds = Number.isFinite(rawSegmentSeconds) && rawSegmentSeconds > 0
      ? Math.max(5, Math.min(120, rawSegmentSeconds))
      : 10;
    return {
      language: $('language-select')?.value || 'auto',
      model: $('model-select')?.value || 'tiny',
      seconds,
      unlimitedCapture: seconds === 0,
      segmentSeconds,
      timestampMode: $('timestamp-mode')?.value || 'fast',
      playbackRate: Math.max(1, Math.min(2, Number($('playback-rate')?.value) || 1))
    };
  }

  function getCurrentMediaPositionSeconds() {
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

  function getMediaDurationSeconds() {
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

  function applyCapturePlaybackRate() {
    const settings = currentSettings();
    const rate = settings.playbackRate || 1;
    app.capturePlaybackRate = rate;
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer) {
        if (typeof app.ytPlayer.getAvailablePlaybackRates === 'function' && typeof app.ytPlayer.setPlaybackRate === 'function') {
          const available = app.ytPlayer.getAvailablePlaybackRates() || [];
          const selected = available.length ? available.reduce((best, x) => Math.abs(x - rate) < Math.abs(best - rate) ? x : best, available[0]) : rate;
          app.ytPlayer.setPlaybackRate(selected);
          app.capturePlaybackRate = Number(selected) || rate;
          log('捕获播放倍速已设置为 ' + app.capturePlaybackRate + 'x。', 'success');
          return app.capturePlaybackRate;
        }
      }
      const media = $('media-element');
      if (media) {
        media.playbackRate = rate;
        app.capturePlaybackRate = rate;
        log('媒体捕获播放倍速已设置为 ' + rate + 'x。', 'success');
        return rate;
      }
    } catch (error) {
      log('设置播放倍速失败，继续使用当前倍速：' + error.message, 'warn');
    }
    return app.capturePlaybackRate || 1;
  }

  function currentCaptureTimelineSeconds() {
    const mediaElapsed = getCurrentMediaPositionSeconds() - app.captureBaseMediaTime;
    if (Number.isFinite(mediaElapsed) && mediaElapsed > 0) return mediaElapsed;
    const elapsedWall = Math.max(0, (Date.now() - app.captureStartedAt) / 1000);
    return elapsedWall * (app.capturePlaybackRate || 1);
  }

  function makeCaptureProgressText(elapsedWall, mediaElapsed, target, bytes) {
    if (target > 0) {
      return '正在捕获音频：已覆盖视频 ' + mediaElapsed.toFixed(1) + ' / ' + target.toFixed(1) + ' 秒，实际耗时 ' + elapsedWall.toFixed(1) + ' 秒，已缓存 ' + formatBytes(bytes) + '。';
    }
    return '正在捕获音频：实际 ' + elapsedWall.toFixed(1) + ' 秒，约覆盖视频 ' + mediaElapsed.toFixed(1) + ' 秒，已缓存 ' + formatBytes(bytes) + '。';
  }

  function getRemainingMediaSeconds() {
    try {
      if (app.currentKind === 'youtube' && app.ytPlayer && typeof app.ytPlayer.getDuration === 'function') {
        const duration = Number(app.ytPlayer.getDuration());
        const current = typeof app.ytPlayer.getCurrentTime === 'function' ? Number(app.ytPlayer.getCurrentTime()) : 0;
        if (Number.isFinite(duration) && duration > 0) return Math.max(0, duration - (Number.isFinite(current) ? current : 0));
      }
      const media = $('media-element');
      if (media && Number.isFinite(media.duration) && media.duration > 0) {
        return Math.max(0, media.duration - (Number.isFinite(media.currentTime) ? media.currentTime : 0));
      }
    } catch (_) {}
    return 0;
  }

  async function inspect(autoCapture = false) {
    const input = ($('source-url')?.value || '').trim();
    if (!input) {
      alert('请输入 YouTube 链接、视频直链或音频直链。');
      return;
    }
    if (app.recorder && app.recorder.state !== 'inactive') {
      alert('正在捕获音频，请先停止。');
      return;
    }
    clearLog();
    stopDisplayCaptureTracks();
    resetChecks();
    resetProgress();
    resetOutputs();
    setButton('capture-start-btn', false);
    setButton('capture-tab-btn', false);
    setButton('capture-stop-btn', false);
    setProgress('overall', 3, '链接检测', '开始检测链接。');
    log('开始检测：' + input);

    const info = classifyUrl(input);
    setStatus('check-type', info.label, info.kind === 'invalid' ? 'bad' : info.kind === 'page' ? 'warn' : 'ok');
    log('链接类型：' + info.label + '。');

    const probe = await probeHttp(input, info.kind);
    setStatus('check-connect', probe.ok ? '可连接' : (info.kind === 'page' ? '不是媒体' : '需播放验证'), probe.state);
    log(probe.message, probe.ok ? 'success' : probe.state === 'bad' ? 'error' : 'warn');

    try {
      if (info.kind === 'invalid') throw new Error('URL 格式无效。');
      if (info.kind === 'page') {
        setStatus('check-control', '不可操作', 'warn');
        setStatus('check-play', '不可播放', 'warn');
        setStatus('check-capture', '不可捕获', 'warn');
        setProgress('overall', 100, '检测结束', '普通网页不能直接作为媒体源。');
        log('普通网页不是 <video>/<audio> 可直接播放的媒体源；请粘贴真实视频/音频直链。', 'warn');
        return;
      }
      if (info.kind === 'youtube') {
        await inspectYouTube(input, info.youtubeId);
        app.oneClickAwaitingTabCapture = true;
        updateOneClickButton();
        return;
      }
      const canCapture = await loadNativeMedia(input, info.kind);
      setButton('capture-start-btn', canCapture);
      if (canCapture && autoCapture) {
        await startCapture();
      }
      updateOneClickButton();
    } catch (error) {
      setStatus('check-control', '失败', 'bad');
      setStatus('check-play', '失败', 'bad');
      setStatus('check-capture', '失败', 'bad');
      setProgress('overall', 100, '检测失败', error.message);
      log('检测失败：' + error.message, 'error');
    }
  }

  function startCaptureTimer(targetSeconds, hardLimitSeconds) {
    app.captureTargetSeconds = Number(targetSeconds) || 0;
    app.captureHardLimitSeconds = Number(hardLimitSeconds) || 0;
    app.captureTimer = setInterval(() => {
      const elapsed = (Date.now() - app.captureStartedAt) / 1000;
      const bytes = app.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      const mediaElapsed = currentCaptureTimelineSeconds();
      const target = app.captureTargetSeconds > 0 ? app.captureTargetSeconds : 0;
      const pct = target > 0 ? Math.min(100, (mediaElapsed / target) * 100) : Math.min(95, 8 + mediaElapsed / 18);
      setProgress('audio', pct, app.captureMode || '音频提取', makeCaptureProgressText(elapsed, mediaElapsed, target, bytes));
      setProgress('overall', Math.min(72, 58 + pct * 0.14), '音频提取', '音频捕获进行中。');
    }, 500);
  }

  function recorderStopHandler(mime) {
    return async () => {
      clearInterval(app.captureTimer);
      clearTimeout(app.stopTimer);
      app.captureTimer = null;
      app.stopTimer = null;
      const type = mime || 'audio/webm';
      app.capturedBlob = new Blob(app.chunks, { type });
      app.capturedUrl = URL.createObjectURL(app.capturedBlob);
      app.capturedSeconds = Math.max(0.1, (Date.now() - app.captureStartedAt) / 1000);
      app.captureTargetSeconds = 0;
      app.captureHardLimitSeconds = 0;
      stopDisplayCaptureTracks();
      setButton('capture-start-btn', app.currentKind !== 'youtube' && app.mediaReadyForCapture);
      setButton('capture-tab-btn', app.currentKind === 'youtube');
      setButton('capture-stop-btn', false);
      setButton('download-audio-btn', app.capturedBlob.size > 0);
      setButton('transcribe-btn', app.capturedBlob.size > 0);
      setProgress('audio', 100, '音频提取', '音频捕获完成：' + formatBytes(app.capturedBlob.size) + '，约 ' + app.capturedSeconds.toFixed(1) + ' 秒。');
      setProgress('overall', 72, '音频完成', '开始转文字。');
      log('音频捕获完成：' + formatBytes(app.capturedBlob.size) + '，约 ' + app.capturedSeconds.toFixed(1) + ' 秒。', 'success');
      if (app.capturedBlob.size > 0) await transcribe();
    };
  }

  function enqueueSegment(segment) {
    if (!segment || !segment.blob || segment.blob.size <= 0) return;
    app.segmentQueue.push(segment);
    app.capturedSegmentCount += 1;
    const target = app.captureTargetSeconds > 0 ? app.captureTargetSeconds : 0;
    const pct = target > 0 ? Math.min(96, (segment.end / target) * 100) : Math.min(96, 8 + segment.end / 18);
    setProgress('audio', pct, app.captureMode || '音频提取', '已切出第 ' + segment.index + ' 段：累计覆盖到 ' + segment.end.toFixed(1) + ' 秒，正在持续追加文字。');
    log('音频第 ' + segment.index + ' 段进入转写队列：' + formatBytes(segment.blob.size) + '，覆盖 ' + segment.start.toFixed(1) + '-' + segment.end.toFixed(1) + ' 秒。', 'success');
    processSegmentQueue();
  }

  function mergeFloat32Chunks(chunks, totalSamples) {
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function resampleLinear(input, inputRate, outputRate) {
    if (!input || !input.length) return new Float32Array(0);
    if (!inputRate || !outputRate || Math.abs(inputRate - outputRate) < 1) return input;
    const ratio = inputRate / outputRate;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const src = i * ratio;
      const left = Math.floor(src);
      const right = Math.min(input.length - 1, left + 1);
      const t = src - left;
      output[i] = input[left] * (1 - t) + input[right] * t;
    }
    return output;
  }

  function audioBufferToMono(buffer) {
    const length = buffer.length || 0;
    const channels = buffer.numberOfChannels || 1;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channels; ch += 1) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
    }
    return mono;
  }

  async function decodeCapturedBlobToSegments(sessionId) {
    if (sessionId !== app.segmentSessionId || !app.capturedBlob || app.capturedBlob.size <= 0) return;
    const settings = currentSettings();
    const expected = Math.max(1, Math.floor((app.capturedSeconds || 0) / Math.max(5, settings.segmentSeconds || 10)));
    if (app.capturedSegmentCount >= Math.max(2, Math.floor(expected * 0.8))) return;

    app.recoveringSegments = true;
    try {
      setProgress('asr', Math.max(12, Number(($('asr-percent')?.textContent || '0').replace('%', '')) || 12), '补全音频分段', '实时分段不足，正在从完整音频重新切分，确保不是只转第一句。');
      log('检测到实时分段不足：已有 ' + app.capturedSegmentCount + ' 段，预计约 ' + expected + ' 段；开始从完整音频补充分段。', 'warn');
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('当前浏览器不支持 AudioContext，无法补全分段。');
      const context = new AudioContextCtor();
      const arrayBuffer = await app.capturedBlob.arrayBuffer();
      const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
      const mono = audioBufferToMono(decoded);
      const sampleRate = 16000;
      const pcm = resampleLinear(mono, decoded.sampleRate || sampleRate, sampleRate);
      try { await context.close(); } catch (_) {}

      const segmentSamples = Math.max(sampleRate * 5, Math.floor((settings.segmentSeconds || 10) * sampleRate));
      const already = app.capturedSegmentCount;
      let index = 0;
      for (let offset = 0; offset < pcm.length; offset += segmentSamples) {
        index += 1;
        if (index <= already) continue;
        const end = Math.min(pcm.length, offset + segmentSamples);
        const samples = pcm.slice(offset, end);
        if (samples.length < sampleRate * 0.5) continue;
        const audioStart = offset / sampleRate;
        const audioEnd = end / sampleRate;
        enqueueSegment({
          index,
          start: audioStart * (app.capturePlaybackRate || 1),
          end: audioEnd * (app.capturePlaybackRate || 1),
          duration: audioEnd - audioStart,
          blob: encodeWav(samples, sampleRate)
        });
      }
      log('完整音频补充分段完成：当前累计 ' + app.capturedSegmentCount + ' 段。', 'success');
    } catch (error) {
      log('完整音频补充分段失败：' + error.message + '。仍继续处理已获得的分段。', 'error');
    } finally {
      app.recoveringSegments = false;
      processSegmentQueue();
      finishSegmentTranscriptionIfDone();
    }
  }

  function clearPcmBuffer() {
    app.pcmBuffer = [];
    app.pcmBufferedSamples = 0;
  }

  function cutPcmSegment(sampleCount) {
    let remaining = sampleCount;
    const out = [];
    let outSamples = 0;
    while (remaining > 0 && app.pcmBuffer.length) {
      const first = app.pcmBuffer[0];
      if (first.length <= remaining) {
        out.push(first);
        outSamples += first.length;
        remaining -= first.length;
        app.pcmBuffer.shift();
      } else {
        out.push(first.slice(0, remaining));
        outSamples += remaining;
        app.pcmBuffer[0] = first.slice(remaining);
        remaining = 0;
      }
    }
    app.pcmBufferedSamples = Math.max(0, app.pcmBufferedSamples - outSamples);
    return mergeFloat32Chunks(out, outSamples);
  }

  function flushPcmSegment(force = false) {
    if (!app.pcmBufferedSamples) return;
    const settings = currentSettings();
    const sampleRate = app.pcmSampleRate || 16000;
    const segmentSamples = Math.max(1, Math.floor((settings.segmentSeconds || 10) * sampleRate));
    while (app.pcmBufferedSamples >= segmentSamples || (force && app.pcmBufferedSamples > sampleRate * 0.5)) {
      const wanted = app.pcmBufferedSamples >= segmentSamples ? segmentSamples : app.pcmBufferedSamples;
      const samples = cutPcmSegment(wanted);
      if (!samples.length) break;
      const audioSeconds = samples.length / sampleRate;
      const videoSeconds = audioSeconds * (app.capturePlaybackRate || 1);
      const start = app.pcmSegmentVideoStart;
      const end = start + videoSeconds;
      app.pcmSegmentVideoStart = end;
      const index = app.segmentIndex + 1;
      app.segmentIndex = index;
      enqueueSegment({
        index,
        start,
        end,
        duration: audioSeconds,
        blob: encodeWav(samples, sampleRate)
      });
    }
  }

  async function startPcmSegmenter(audioStream) {
    stopPcmSegmenter(false);
    clearPcmBuffer();
    app.pcmSegmentVideoStart = Math.max(0, currentCaptureTimelineSeconds());
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('当前浏览器不支持 Web Audio，无法分段转写。');
    const context = new AudioContextCtor({ sampleRate: 16000 });
    if (context.state === 'suspended') {
      try { await context.resume(); } catch (_) {}
    }
    app.pcmContext = context;
    app.pcmSampleRate = context.sampleRate || 16000;
    app.pcmSource = context.createMediaStreamSource(audioStream);
    app.pcmProcessor = context.createScriptProcessor(4096, 1, 1);
    app.pcmGain = context.createGain();
    app.pcmGain.gain.value = 0;
    app.pcmProcessor.onaudioprocess = (event) => {
      if (app.segmentStopRequested) return;
      const input = event.inputBuffer;
      const channels = input.numberOfChannels || 1;
      const length = input.length || 0;
      const mono = new Float32Array(length);
      for (let ch = 0; ch < channels; ch += 1) {
        const data = input.getChannelData(ch);
        for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
      }
      app.pcmBuffer.push(mono);
      app.pcmBufferedSamples += mono.length;
      flushPcmSegment(false);
    };
    app.pcmSource.connect(app.pcmProcessor);
    app.pcmProcessor.connect(app.pcmGain);
    app.pcmGain.connect(context.destination);
    log('已启用 Web Audio PCM 分段：每段输出独立 WAV，避免长音频只转第一句。', 'success');
  }

  function stopPcmSegmenter(flush = true) {
    if (flush) {
      try { flushPcmSegment(true); } catch (_) {}
    }
    if (app.pcmProcessor) {
      try { app.pcmProcessor.disconnect(); } catch (_) {}
      app.pcmProcessor.onaudioprocess = null;
    }
    if (app.pcmSource) {
      try { app.pcmSource.disconnect(); } catch (_) {}
    }
    if (app.pcmGain) {
      try { app.pcmGain.disconnect(); } catch (_) {}
    }
    if (app.pcmContext) {
      try { app.pcmContext.close(); } catch (_) {}
    }
    app.pcmProcessor = null;
    app.pcmSource = null;
    app.pcmGain = null;
    app.pcmContext = null;
    clearPcmBuffer();
  }

  function startSegmentRecorder(sessionId) {
    if (sessionId !== app.segmentSessionId || !app.segmentCaptureStream) return;
    const recorder = new MediaRecorder(app.segmentCaptureStream, { mimeType: app.segmentMime, audioBitsPerSecond: 24000 });
    app.segmentRecorder = recorder;
    app.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        app.audioParts.push(event.data);
        app.chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      log('MediaRecorder 错误：' + (event.error ? event.error.message : '未知错误'), 'error');
    };
    recorder.onstop = () => {
      if (sessionId !== app.segmentSessionId) return;
      finalizeSegmentCapture(sessionId);
    };
    recorder.start(1000);
  }

  function finalizeSegmentCapture(sessionId) {
    if (sessionId !== app.segmentSessionId) return;
    app.segmentStopRequested = true;
    clearInterval(app.captureTimer);
    clearTimeout(app.stopTimer);
    clearTimeout(app.segmentTimer);
    app.captureTimer = null;
    app.stopTimer = null;
    app.segmentTimer = null;
    stopPcmSegmenter(true);
    const type = app.segmentMime || 'audio/webm';
    app.capturedBlob = new Blob(app.audioParts, { type });
    if (app.capturedUrl) URL.revokeObjectURL(app.capturedUrl);
    app.capturedUrl = app.capturedBlob.size ? URL.createObjectURL(app.capturedBlob) : '';
    app.capturedSeconds = Math.max(0.1, (Date.now() - app.captureStartedAt) / 1000);
    app.captureTargetSeconds = 0;
    app.captureHardLimitSeconds = 0;
    app.segmentRecorder = null;
    app.recorder = null;
    stopDisplayCaptureTracks();
    setButton('capture-start-btn', app.currentKind !== 'youtube' && app.mediaReadyForCapture);
    setButton('capture-tab-btn', app.currentKind === 'youtube');
    setButton('capture-stop-btn', false);
    setButton('download-audio-btn', app.capturedBlob.size > 0);
    setButton('transcribe-btn', app.capturedBlob.size > 0 || app.segmentQueue.length > 0);
    setButton('download-txt-btn', Boolean(app.transcriptText));
    updateOneClickButton();
    setProgress('audio', 100, '音频提取', '音频捕获完成：' + formatBytes(app.capturedBlob.size) + '，约 ' + app.capturedSeconds.toFixed(1) + ' 秒，已切出 ' + app.capturedSegmentCount + ' 段。');
    log('音频捕获完成：' + formatBytes(app.capturedBlob.size) + '，约 ' + app.capturedSeconds.toFixed(1) + ' 秒，已切出 ' + app.capturedSegmentCount + ' 段；剩余分段会继续转写并追加到纯文本结果。', 'success');
    decodeCapturedBlobToSegments(sessionId);
    processSegmentQueue();
    finishSegmentTranscriptionIfDone();
  }

  async function startRecorderFromAudioStream(audioStream, mime, seconds, modeLabel, expectedSeconds = 0) {
    if (!audioStream || !audioStream.getAudioTracks().length) throw new Error('没有可录制的音轨。');
    resetOutputs();
    const sessionId = app.segmentSessionId;
    setProgress('asr', 0, 'ASR 分段识别', '边捕获边转文字：不再等完整 40 分钟音频录完才开始识别。');
    app.chunks = [];
    app.audioParts = [];
    app.capturedBlob = null;
    app.captureStartedAt = Date.now();
    app.captureBaseMediaTime = getCurrentMediaPositionSeconds();
    app.capturePlaybackRate = applyCapturePlaybackRate();
    app.captureMode = modeLabel;
    app.segmentCaptureStream = audioStream;
    app.segmentMime = mime || 'audio/webm';
    app.segmentStopRequested = false;
    app.oneClickAwaitingTabCapture = false;
    const hardLimitSeconds = Number(seconds) || 0;
    const targetSeconds = hardLimitSeconds > 0 ? hardLimitSeconds * (app.capturePlaybackRate || 1) : (Number(expectedSeconds) || 0);
    app.captureHardLimitSeconds = hardLimitSeconds;
    app.captureTargetSeconds = targetSeconds;

    audioStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        log('音频轨道已结束。', 'warn');
        stopCapture();
      };
    });

    setButton('capture-start-btn', false);
    setButton('capture-tab-btn', false);
    setButton('capture-stop-btn', true);
    const settings = currentSettings();
    const limitText = hardLimitSeconds > 0
      ? '0.0 / 约 ' + (hardLimitSeconds * (app.capturePlaybackRate || 1)).toFixed(1) + ' 秒视频'
      : (targetSeconds > 0 ? '0.0 / 全长约 ' + targetSeconds.toFixed(1) + ' 秒视频' : '0.0 秒视频 / 全长或手动停止');
    setProgress('audio', 0, '音频提取', '正在捕获音频：' + limitText + '。分段长度：' + settings.segmentSeconds + ' 秒，播放倍速：' + app.capturePlaybackRate + 'x。');
    setProgress('asr', 0, 'ASR 分段识别', '模型预热后会边录边识别，每完成一段就追加到结果。');
    log('开始' + modeLabel + '，' + (hardLimitSeconds > 0 ? '最长 ' + hardLimitSeconds + ' 秒' : '不按秒数截断，直到视频结束或手动停止') + '，录制格式：' + app.segmentMime + '，分段 ' + settings.segmentSeconds + ' 秒，播放倍速 ' + app.capturePlaybackRate + 'x。');
    scheduleWarmup(50);
    await startPcmSegmenter(audioStream);
    startCaptureTimer(targetSeconds, hardLimitSeconds);
    if (hardLimitSeconds > 0) app.stopTimer = setTimeout(() => stopCapture(), hardLimitSeconds * 1000);
    startSegmentRecorder(sessionId);
    updateOneClickButton();
  }

  async function startCapture() {
    if (app.currentKind === 'youtube') {
      log('YouTube 需要使用“捕获当前标签页音频”按钮；媒体元素 captureStream 不能读取 iframe 内部音频。', 'warn');
      alert('YouTube 请点击“捕获当前标签页音频”，并在浏览器弹窗中选择当前标签页、勾选共享音频。');
      return;
    }
    const media = $('media-element');
    if (!media || !app.currentUrl) {
      alert('请先检测并加载媒体链接。');
      return;
    }
    if (!window.MediaRecorder) {
      alert('当前浏览器不支持 MediaRecorder。');
      return;
    }
    if (media.paused) {
      try { await media.play(); } catch (_) { alert('请先手动播放媒体后再捕获。'); return; }
    }
    const stream = getCaptureStream(media);
    if (!stream) { alert('当前浏览器不支持 captureStream()。'); return; }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) { alert('没有检测到可捕获音轨。'); return; }
    const mime = pickAudioMime();
    if (!mime) { alert('没有可用音频录制编码。'); return; }

    const settings = currentSettings();
    const expectedSeconds = settings.unlimitedCapture ? getRemainingMediaSeconds() : settings.seconds;
    media.addEventListener('ended', () => {
      if (app.recorder && app.recorder.state !== 'inactive') {
        log('媒体播放已结束，自动停止音频捕获。', 'success');
        stopCapture();
      }
    }, { once: true });
    await startRecorderFromAudioStream(new MediaStream(tracks), mime, settings.seconds, '媒体音频捕获', expectedSeconds);
  }

  async function startTabCapture() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      alert('当前浏览器不支持 getDisplayMedia。请用 Chrome 桌面端测试。');
      log('当前浏览器不支持 getDisplayMedia，不能捕获当前标签页音频。', 'error');
      return;
    }
    if (!window.MediaRecorder) {
      alert('当前浏览器不支持 MediaRecorder。');
      return;
    }
    const settings = currentSettings();
    const mime = pickAudioMime();
    if (!mime) { alert('没有可用音频录制编码。'); return; }
    stopDisplayCaptureTracks();
    scheduleWarmup(50);

    log('即将请求浏览器授权：请选择“当前标签页/This Tab”，并勾选“共享标签页音频/Share tab audio”。', 'warn');
    setStatus('check-capture', '等待浏览器授权', 'pending');
    setProgress('audio', 2, '标签页音频捕获', '等待用户在浏览器弹窗中选择当前标签页并共享音频。');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        systemAudio: 'include',
        surfaceSwitching: 'exclude'
      });
      app.displayStream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && videoTrack.getSettings) {
        const settings = videoTrack.getSettings();
        if (settings.displaySurface && settings.displaySurface !== 'browser') {
          log('当前捕获的不是浏览器标签页，而是：' + settings.displaySurface + '。仍会尝试读取其中音频。', 'warn');
        } else {
          log('已获得浏览器标签页捕获流。', 'success');
        }
      }
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stopDisplayCaptureTracks();
        setStatus('check-capture', '未共享音频', 'bad');
        setProgress('audio', 0, '标签页音频捕获', '没有拿到音频轨。请重新点击并勾选共享标签页音频。');
        log('授权完成，但没有音频轨。通常是没有勾选“共享标签页音频”。', 'error');
        alert('没有捕获到音频轨。请重新点击，并在弹窗里勾选“共享标签页音频”。');
        return;
      }

      if (app.ytPlayer && typeof app.ytPlayer.playVideo === 'function') {
        try {
          app.ytPlayer.playVideo();
          log('已请求 YouTube 播放器开始播放。');
        } catch (error) {
          log('YouTube playVideo 调用失败：' + error.message, 'warn');
        }
      }
      setStatus('check-capture', '正在捕获标签页音频', 'ok');
      setProgress('audio', 4, '标签页音频捕获', '已获得音频轨，开始录制当前标签页声音。');
      const expectedSeconds = settings.unlimitedCapture ? getRemainingMediaSeconds() : settings.seconds;
      await startRecorderFromAudioStream(new MediaStream(audioTracks), mime, settings.seconds, '当前标签页音频捕获', expectedSeconds);
    } catch (error) {
      stopDisplayCaptureTracks();
      setStatus('check-capture', '授权失败', 'bad');
      setProgress('audio', 0, '标签页音频捕获失败', error.message);
      log('标签页音频捕获失败：' + error.message, 'error');
      alert('标签页音频捕获失败：' + error.message);
    }
  }

  function stopCapture() {
    app.segmentStopRequested = true;
    if (!app.recorder || app.recorder.state === 'inactive') {
      finalizeSegmentCapture(app.segmentSessionId);
      return;
    }
    setProgress('audio', 98, '音频提取', '正在封装当前分段并停止捕获。');
    log('停止捕获，正在封装当前分段。');
    try { app.recorder.stop(); } catch (_) { finalizeSegmentCapture(app.segmentSessionId); }
  }

  function languageOptions(language) {
    if (language === 'zh') return { language: 'chinese', task: 'transcribe' };
    if (language === 'en') return { language: 'english', task: 'transcribe' };
    return { task: 'transcribe' };
  }

  function candidateModelNames() {
    const settings = currentSettings();
    return MODEL_MAP[settings.model + ':' + settings.language] || MODEL_MAP['tiny:auto'];
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
        if (runId === app.asrRunId) {
          setProgress('asr', 6, 'ASR 运行库', '正在加载 Transformers.js 运行库。');
          log('加载识别运行库：' + url);
        }
        const mod = await import(url);
        configureTransformers(mod);
        window.__subtitleDownloadTransformers = mod;
        return mod;
      } catch (error) {
        lastError = error;
        log('识别运行库加载失败：' + error.message, 'warn');
      }
    }
    throw lastError || new Error('无法加载 Transformers.js。');
  }

  async function ensureTranscriber(runId) {
    const mod = await loadTransformers(runId);
    if (!mod || typeof mod.pipeline !== 'function') throw new Error('Transformers.js 加载异常，未找到 pipeline。');

    const modelCandidates = candidateModelNames();
    const deviceCandidates = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    let lastError;

    for (const device of deviceCandidates) {
      for (const model of modelCandidates) {
        const key = model + '@' + device;
        if (app.transcriberCache.has(key)) {
          app.transcriber = app.transcriberCache.get(key);
          app.transcriberKey = key;
          if (runId === app.asrRunId) {
            setProgress('asr', 35, 'ASR 模型已预热', '复用内存模型：' + model + ' / ' + device + '。');
            log('复用内存模型：' + model + '；设备：' + device + '。', 'success');
          }
          return app.transcriber;
        }

        if (app.transcriberPromises.has(key)) {
          if (runId === app.asrRunId) {
            setProgress('asr', 18, 'ASR 模型预热中', '已有同模型加载任务，正在复用，不会重复下载。');
            log('复用正在进行的模型加载任务：' + key + '。');
          }
          const pipe = await app.transcriberPromises.get(key);
          app.transcriber = pipe;
          app.transcriberKey = key;
          return pipe;
        }

        const loadPromise = (async () => {
          try {
            if (runId === app.asrRunId) {
              setProgress('asr', 10, '模型缓存/预热', '正在加载模型：' + model + '（' + device + '）。首次打开会下载；之后优先走浏览器缓存。');
              setProgress('overall', 74, 'ASR 模型加载', '准备加载识别模型。');
              log('加载模型：' + model + '；设备：' + device + '。');
            }
            const pipe = await mod.pipeline('automatic-speech-recognition', model, {
              device,
              progress_callback: (data) => {
                if (runId !== app.asrRunId || !data) return;
                if (data.status === 'progress' && typeof data.progress === 'number') {
                  const pct = Math.max(0, Math.min(100, data.progress));
                  const scaled = 10 + pct * 0.25;
                  setProgress('asr', scaled, '模型缓存/下载', '正在缓存模型文件：' + Math.round(pct) + '%。已缓存后同浏览器不会重复下载。');
                  setProgress('overall', 74 + pct * 0.08, '模型缓存/下载', '模型文件缓存中。');
                } else if (data.status === 'ready') {
                  setProgress('asr', 35, '模型已预热', '模型已加载到内存，并写入浏览器缓存。');
                  log('模型已预热。', 'success');
                }
              }
            });
            app.transcriberCache.set(key, pipe);
            app.transcriber = pipe;
            app.transcriberKey = key;
            try { localStorage.setItem('subtitle-download:last-model-key', key); } catch (_) {}
            if (runId === app.asrRunId) setProgress('asr', 35, '模型已预热', '模型已加载；后续同模型会直接复用。');
            return pipe;
          } catch (error) {
            throw error;
          } finally {
            app.transcriberPromises.delete(key);
          }
        })();

        app.transcriberPromises.set(key, loadPromise);
        try {
          return await loadPromise;
        } catch (error) {
          lastError = error;
          log('模型加载失败，尝试下一个候选：' + model + ' / ' + device + '：' + error.message, 'warn');
        }
      }
    }
    throw lastError || new Error('模型加载失败。');
  }

  async function warmupModel(reason = 'auto') {
    if (app.isTranscribing || app.isWarmingModel) return;
    app.isWarmingModel = true;
    const runId = app.asrRunId;
    try {
      setProgress('asr', 2, '模型预热', reason === 'manual' ? '正在手动预热模型缓存。' : '正在后台预热模型缓存，捕获结束后可直接识别。');
      log((reason === 'manual' ? '手动' : '后台') + '预热 ASR 模型。');
      await ensureTranscriber(runId);
      if (runId === app.asrRunId && !app.isTranscribing) {
        setProgress('asr', 35, '模型已预热', '当前模型已在内存/浏览器缓存中；再次识别不会重复下载。');
      }
    } catch (error) {
      if (!app.isTranscribing) {
        setProgress('asr', 0, '模型预热失败', '稍后识别时会重试：' + error.message);
      }
      log('模型预热失败：' + error.message, 'warn');
    } finally {
      app.isWarmingModel = false;
    }
  }

  function scheduleWarmup(delay = 900) {
    clearTimeout(app.warmupTimer);
    app.warmupTimer = setTimeout(() => warmupModel('auto'), delay);
  }

  function secondsToSrtTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = Math.floor(safe % 60);
    const ms = Math.floor((safe - Math.floor(safe)) * 1000);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
  }

  function normalizeChunks(output) {
    const chunks = Array.isArray(output && output.chunks) ? output.chunks : [];
    return chunks.map((chunk, index) => {
      const ts = chunk.timestamp || chunk.timestamps || [index * 4, index * 4 + 4];
      let start = Array.isArray(ts) ? ts[0] : ts.start;
      let end = Array.isArray(ts) ? ts[1] : ts.end;
      if (!Number.isFinite(start)) start = index * 4;
      if (!Number.isFinite(end) || end <= start) end = start + 4;
      return { start, end, text: String(chunk.text || '').trim() };
    }).filter((chunk) => chunk.text);
  }

  function chunksToSrt(chunks, fallbackText) {
    if (!chunks.length && fallbackText) {
      const end = Math.max(2, app.capturedSeconds || 2);
      return '1\n' + secondsToSrtTime(0) + ' --> ' + secondsToSrtTime(end) + '\n' + fallbackText.trim() + '\n';
    }
    return chunks.map((chunk, index) => {
      return (index + 1) + '\n' + secondsToSrtTime(chunk.start) + ' --> ' + secondsToSrtTime(chunk.end) + '\n' + chunk.text + '\n';
    }).join('\n');
  }

  function makeTranscribeOptions(settings) {
    const baseOptions = languageOptions(settings.language);
    const stabilityOptions = {
      condition_on_previous_text: false
    };
    if (settings.timestampMode === 'accurate') {
      return Object.assign({
        return_timestamps: true,
        chunk_length_s: 15,
        stride_length_s: 2
      }, stabilityOptions, baseOptions);
    }
    return Object.assign({}, stabilityOptions, baseOptions);
  }

  function renderTranscriptOnly() {
    const parts = Array.from(app.transcriptBySegment.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => String(entry[1] || '').trim())
      .filter(Boolean);
    app.transcriptText = parts.join('\n');
    const transcript = $('transcript-output');
    if (transcript) {
      transcript.value = app.transcriptText;
      transcript.scrollTop = transcript.scrollHeight;
    }
    setButton('download-txt-btn', Boolean(app.transcriptText));
    updateOneClickButton();
  }

  function appendSegmentTranscript(segment, output, settings) {
    const rawChunks = settings.timestampMode === 'accurate' ? normalizeChunks(output) : [];
    let text = String(output && output.text ? output.text : rawChunks.map((x) => x.text).join(' ')).trim();
    if (!text) text = '';

    if (text) {
      app.transcriptBySegment.set(segment.index, text);
      if (settings.language === 'auto' && app.transcribedSegmentCount === 0) {
        const hasCjk = /[\u3400-\u9fff]/.test(text);
        const hasLatin = /[A-Za-z]/.test(text);
        log('首段语言输出检测：' + (hasCjk ? '包含中文' : hasLatin ? '主要为英文/拉丁字符' : '未检测到明显中英文字符') + '。自动模式会保持原文转写；如果语言判断错误，请切换为“强制中文原文”或“强制英文原文”后重跑。');
      }
    }

    // 产品当前只显示纯文本：不再生成或展示时间戳，避免用户看到 SRT 时间轴。
    renderTranscriptOnly();
  }

  function finishSegmentTranscriptionIfDone() {
    const captureActive = app.recorder && app.recorder.state !== 'inactive';
    if (app.recoveringSegments || app.segmentProcessing || app.segmentQueue.length) return;
    if (captureActive && !app.segmentStopRequested) {
      const doneText = app.transcribedSegmentCount > 0
        ? '已转写 ' + app.transcribedSegmentCount + ' 段，等待下一段音频。'
        : '模型已准备，等待第一段音频。';
      setProgress('asr', Math.max(35, Math.min(92, Number($('asr-percent')?.textContent?.replace('%', '')) || 35)), 'ASR 分段识别', doneText);
      return;
    }
    if (app.capturedSegmentCount > 0 && app.transcribedSegmentCount >= app.capturedSegmentCount) {
      setButton('transcribe-btn', true);
      setButton('capture-start-btn', app.currentKind !== 'youtube' && app.mediaReadyForCapture);
      setButton('capture-tab-btn', app.currentKind === 'youtube');
      setProgress('asr', 100, '转文字完成', '已完成 ' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段，文本长度 ' + app.transcriptText.length + ' 字符。');
      setProgress('overall', 100, '完成', '音频捕获和分段转文字完成。');
      log('分段转文字完成：' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段，文本长度 ' + app.transcriptText.length + ' 字符。', 'success');
      updateOneClickButton();
    }
  }

  async function processSegmentQueue() {
    if (app.segmentProcessing) return;
    if (!app.segmentQueue.length) {
      finishSegmentTranscriptionIfDone();
      return;
    }
    const runId = app.asrRunId;
    app.segmentProcessing = true;
    app.isTranscribing = true;
    setButton('transcribe-btn', false);
    try {
      const pipe = await ensureTranscriber(runId);
      if (runId !== app.asrRunId) return;
      while (app.segmentQueue.length && runId === app.asrRunId) {
        const segment = app.segmentQueue.shift();
        const settings = currentSettings();
        const options = makeTranscribeOptions(settings);
        const audioUrl = URL.createObjectURL(segment.blob);
        const started = Date.now();
        clearInterval(app.transcribeTimer);
        app.transcribeTimer = setInterval(() => {
          if (runId !== app.asrRunId) return;
          const elapsed = (Date.now() - started) / 1000;
          const localPct = Math.min(98, 35 + elapsed / Math.max(3, segment.duration * (navigator.gpu ? 0.7 : 1.8)) * 55);
          const target = app.captureTargetSeconds > 0 ? app.captureTargetSeconds : Math.max(app.capturedSeconds, segment.end, app.transcribedSeconds + segment.duration);
          const globalPct = target > 0 ? Math.min(98, 35 + ((app.transcribedSeconds + Math.min(segment.duration, elapsed)) / target) * 60) : localPct;
          setProgress('asr', Math.max(localPct, globalPct), 'ASR 分段识别', '正在转写第 ' + segment.index + ' 段：' + segment.start.toFixed(1) + '-' + segment.end.toFixed(1) + ' 秒；已完成 ' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段。');
          setProgress('overall', Math.min(98, 72 + Math.max(localPct, globalPct) * 0.26), '边录边转文字', 'ASR 队列处理中。');
        }, 700);
        try {
          log('开始转写第 ' + segment.index + ' 段：' + formatBytes(segment.blob.size) + '，' + segment.start.toFixed(1) + '-' + segment.end.toFixed(1) + ' 秒。');
          const output = await pipe(audioUrl, options);
          appendSegmentTranscript(segment, output, settings);
          app.transcribedSegmentCount += 1;
          app.transcribedSeconds = Math.max(app.transcribedSeconds, segment.end);
          const target = app.captureTargetSeconds > 0 ? app.captureTargetSeconds : Math.max(app.capturedSeconds, app.transcribedSeconds);
          const pct = target > 0 ? Math.min(99, 35 + (app.transcribedSeconds / target) * 60) : Math.min(96, 35 + app.transcribedSegmentCount * 4);
          setProgress('asr', pct, 'ASR 分段识别', '第 ' + segment.index + ' 段完成；累计完成 ' + app.transcribedSegmentCount + ' / ' + app.capturedSegmentCount + ' 段。');
          log('第 ' + segment.index + ' 段转写完成。', 'success');
        } catch (error) {
          log('第 ' + segment.index + ' 段转写失败：' + error.message, 'error');
        } finally {
          URL.revokeObjectURL(audioUrl);
          clearInterval(app.transcribeTimer);
          app.transcribeTimer = null;
        }
      }
    } catch (error) {
      setProgress('asr', 100, '转文字失败', error.message);
      setProgress('overall', 100, '失败', error.message);
      log('转文字失败：' + error.message, 'error');
      alert('转文字失败：' + error.message + '。可以先确认模型缓存是否预热成功，或把分段长度调到 30 秒再试。');
    } finally {
      if (runId === app.asrRunId) {
        app.segmentProcessing = false;
        app.isTranscribing = false;
        finishSegmentTranscriptionIfDone();
        if (app.segmentQueue.length) processSegmentQueue();
      }
    }
  }

  async function transcribe() {
    if (app.segmentQueue.length || app.segmentProcessing) {
      processSegmentQueue();
      return;
    }
    if (app.capturedBlob && app.capturedBlob.size > 0 && !app.transcriptText) {
      const duration = app.capturedSeconds || 0;
      app.segmentQueue.push({ index: 1, start: 0, end: duration, duration, blob: app.capturedBlob });
      app.capturedSegmentCount = Math.max(app.capturedSegmentCount, 1);
      processSegmentQueue();
      return;
    }
    if (app.transcriptText) {
      alert('当前音频已经转写完成。');
      return;
    }
    alert('还没有可转写的音频分段。');
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
    if (!app.capturedBlob) return alert('没有可下载的音频。');
    const ext = app.capturedBlob.type.includes('mp4') ? 'm4a' : 'webm';
    download('subtitle-download-audio-' + Date.now() + '.' + ext, app.capturedBlob);
    log('已触发音频下载。', 'success');
  }

  function downloadTxt() {
    if (!app.transcriptText) return alert('没有可下载的文本。');
    download('subtitle-download-transcript-' + Date.now() + '.txt', new Blob([app.transcriptText], { type: 'text/plain;charset=utf-8' }));
    log('已触发 TXT 下载。', 'success');
  }

  function downloadSrt() {
    if (!app.transcriptSrt) return alert('没有可下载的 SRT。');
    download('subtitle-download-transcript-' + Date.now() + '.srt', new Blob([app.transcriptSrt], { type: 'application/x-subrip;charset=utf-8' }));
    log('已触发 SRT 下载。', 'success');
  }

  function updateOneClickButton() {
    const btn = $('one-click-btn');
    if (!btn) return;
    const active = app.recorder && app.recorder.state !== 'inactive';
    btn.disabled = false;
    if (active) {
      btn.textContent = '停止捕获并完成转文字';
      btn.className = 'btn btn-dark';
      return;
    }
    if (app.oneClickAwaitingTabCapture) {
      btn.textContent = '授权捕获当前标签页音频并转文字';
      btn.className = 'btn btn-amber';
      return;
    }
    if (app.segmentProcessing || app.segmentQueue.length) {
      btn.textContent = '正在转写，点击可重新开始';
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

  async function runOneClick() {
    const active = app.recorder && app.recorder.state !== 'inactive';
    if (active) {
      stopCapture();
      updateOneClickButton();
      return;
    }
    const input = ($('source-url')?.value || '').trim();
    if (!input) {
      alert('请输入 YouTube 链接、视频直链或音频直链。');
      return;
    }
    if (app.oneClickAwaitingTabCapture && app.currentKind === 'youtube' && app.currentUrl === input) {
      await startTabCapture();
      updateOneClickButton();
      return;
    }
    const info = classifyUrl(input);
    if (info.kind === 'youtube') {
      await inspect(false);
      app.oneClickAwaitingTabCapture = true;
      updateOneClickButton();
      await startTabCapture();
      updateOneClickButton();
      return;
    }
    app.oneClickAwaitingTabCapture = false;
    await inspect(true);
    updateOneClickButton();
  }

  function wire() {
    $('one-click-btn')?.addEventListener('click', () => runOneClick());
    $('inspect-btn')?.addEventListener('click', () => inspect(false));
    $('auto-btn')?.addEventListener('click', () => inspect(true));
    $('capture-start-btn')?.addEventListener('click', () => startCapture());
    $('capture-tab-btn')?.addEventListener('click', () => startTabCapture());
    $('capture-stop-btn')?.addEventListener('click', () => stopCapture());
    $('prewarm-btn')?.addEventListener('click', () => warmupModel('manual'));
    $('transcribe-btn')?.addEventListener('click', () => transcribe());
    $('download-audio-btn')?.addEventListener('click', () => downloadAudio());
    $('download-txt-btn')?.addEventListener('click', () => downloadTxt());
    $('download-srt-btn')?.addEventListener('click', () => downloadSrt());
    ['language-select', 'model-select', 'playback-rate'].forEach((id) => {
      $(id)?.addEventListener('change', () => {
        if (id === 'playback-rate') { log('捕获播放倍速已变化，下一次捕获生效。'); return; }
        log('识别设置已变化，将预热新模型。');
        scheduleWarmup(250);
      });
    });
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
    setButton('capture-start-btn', false);
    setButton('capture-tab-btn', false);
    setButton('capture-stop-btn', false);
    updateOneClickButton();
    registerServiceWorker().finally(() => scheduleWarmup(1200));
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
