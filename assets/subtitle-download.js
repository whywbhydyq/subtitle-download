(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const MODEL_MAP = {
    'tiny:auto': 'onnx-community/whisper-tiny',
    'tiny:zh': 'onnx-community/whisper-tiny',
    'tiny:en': 'onnx-community/whisper-tiny.en',
    'tiny-timestamped:auto': 'onnx-community/whisper-tiny_timestamped',
    'tiny-timestamped:zh': 'onnx-community/whisper-tiny_timestamped',
    'tiny-timestamped:en': 'onnx-community/whisper-tiny.en',
    'base:auto': 'onnx-community/whisper-base',
    'base:zh': 'onnx-community/whisper-base',
    'base:en': 'onnx-community/whisper-base.en'
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
    capturedBlob: null,
    capturedUrl: '',
    displayStream: null,
    captureMode: '',
    transcriptText: '',
    transcriptSrt: '',
    transcriber: null,
    transcriberKey: ''
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
    box.innerHTML = '<div class="line">[等待] 粘贴链接后点击“检测链接并尝试播放”。</div>';
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
    setProgress('model', 0, '模型加载', '等待识别。');
    setProgress('text', 0, '转文字', '等待识别。');
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
    if (app.capturedUrl) URL.revokeObjectURL(app.capturedUrl);
    app.captureMode = '';
    app.capturedUrl = '';
    app.capturedBlob = null;
    app.chunks = [];
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
              setProgress('overall', 52, 'YouTube 播放', 'YouTube 正在播放；音频捕获不可用。');
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
    setProgress('audio', 0, '音频提取', '等待点击“捕获当前标签页音频”。请在浏览器弹窗里选择当前标签页并勾选共享音频。');
    setProgress('text', 0, '转文字', '捕获完成后会自动开始本地转文字。');
    log('结论：该 YouTube 链接可连接、可操作；下一步点击“捕获当前标签页音频”，授权后即可录制标签页声音并转文字。', 'success');
    return false;
  }

  function currentSettings() {
    return {
      language: $('language-select')?.value || 'auto',
      model: $('model-select')?.value || 'tiny',
      seconds: Math.max(5, Math.min(1800, Number($('capture-seconds')?.value) || 60))
    };
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
        return;
      }
      const canCapture = await loadNativeMedia(input, info.kind);
      setButton('capture-start-btn', canCapture);
      if (canCapture && autoCapture) {
        await startCapture();
      }
    } catch (error) {
      setStatus('check-control', '失败', 'bad');
      setStatus('check-play', '失败', 'bad');
      setStatus('check-capture', '失败', 'bad');
      setProgress('overall', 100, '检测失败', error.message);
      log('检测失败：' + error.message, 'error');
    }
  }

  function startCaptureTimer(seconds) {
    app.captureTimer = setInterval(() => {
      const elapsed = (Date.now() - app.captureStartedAt) / 1000;
      const bytes = app.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      const pct = Math.min(100, (elapsed / seconds) * 100);
      setProgress('audio', pct, app.captureMode || '音频提取', '正在捕获音频：' + elapsed.toFixed(1) + ' / ' + seconds + ' 秒，已缓存 ' + formatBytes(bytes) + '。');
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

  async function startRecorderFromAudioStream(audioStream, mime, seconds, modeLabel) {
    if (!audioStream || !audioStream.getAudioTracks().length) throw new Error('没有可录制的音轨。');
    resetOutputs();
    app.chunks = [];
    app.capturedBlob = null;
    app.captureStartedAt = Date.now();
    app.captureMode = modeLabel;
    app.recorder = new MediaRecorder(audioStream, { mimeType: mime });
    app.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) app.chunks.push(event.data);
    };
    app.recorder.onerror = (event) => {
      log('MediaRecorder 错误：' + (event.error ? event.error.message : '未知错误'), 'error');
    };
    app.recorder.onstop = recorderStopHandler(mime);
    audioStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        log('音频轨道已结束。', 'warn');
        if (app.recorder && app.recorder.state !== 'inactive') stopCapture();
      };
    });

    app.recorder.start(1000);
    setButton('capture-start-btn', false);
    setButton('capture-tab-btn', false);
    setButton('capture-stop-btn', true);
    setProgress('audio', 0, '音频提取', '正在捕获音频：0.0 / ' + seconds + ' 秒。');
    log('开始' + modeLabel + '，最长 ' + seconds + ' 秒，录制格式：' + mime + '。');
    startCaptureTimer(seconds);
    app.stopTimer = setTimeout(() => stopCapture(), seconds * 1000);
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

    const seconds = currentSettings().seconds;
    await startRecorderFromAudioStream(new MediaStream(tracks), mime, seconds, '媒体音频捕获');
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
      await startRecorderFromAudioStream(new MediaStream(audioTracks), mime, settings.seconds, '当前标签页音频捕获');
    } catch (error) {
      stopDisplayCaptureTracks();
      setStatus('check-capture', '授权失败', 'bad');
      setProgress('audio', 0, '标签页音频捕获失败', error.message);
      log('标签页音频捕获失败：' + error.message, 'error');
      alert('标签页音频捕获失败：' + error.message);
    }
  }

  function stopCapture() {
    if (!app.recorder || app.recorder.state === 'inactive') return;
    setProgress('audio', 98, '音频提取', '正在封装音频 Blob。');
    log('停止捕获，正在封装音频。');
    app.recorder.stop();
  }

  function languageOptions(language) {
    if (language === 'zh') return { language: 'chinese', task: 'transcribe' };
    if (language === 'en') return { language: 'english', task: 'transcribe' };
    return { task: 'transcribe' };
  }

  function modelName() {
    const settings = currentSettings();
    return MODEL_MAP[settings.model + ':' + settings.language] || 'onnx-community/whisper-tiny';
  }

  async function loadTransformers() {
    if (window.__subtitleDownloadTransformers) return window.__subtitleDownloadTransformers;
    const urls = [
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/dist/transformers.min.js',
      'https://unpkg.com/@huggingface/transformers@3.7.0/dist/transformers.min.js'
    ];
    let lastError;
    for (const url of urls) {
      try {
        log('加载识别运行库：' + url);
        const mod = await import(url);
        window.__subtitleDownloadTransformers = mod;
        return mod;
      } catch (error) {
        lastError = error;
        log('识别运行库加载失败：' + error.message, 'warn');
      }
    }
    throw lastError || new Error('无法加载 Transformers.js。');
  }

  async function ensureTranscriber() {
    const model = modelName();
    const device = navigator.gpu ? 'webgpu' : 'wasm';
    const key = model + '@' + device;
    if (app.transcriber && app.transcriberKey === key) return app.transcriber;
    setProgress('model', 8, '模型加载', '正在加载 Transformers.js 运行库。');
    setProgress('overall', 74, '模型加载', '准备加载识别模型。');
    const mod = await loadTransformers();
    if (!mod || typeof mod.pipeline !== 'function') throw new Error('Transformers.js 加载异常，未找到 pipeline。');
    setProgress('model', 12, '模型加载', '正在加载模型：' + model + '。首次使用会下载模型文件。');
    log('加载模型：' + model + '；设备：' + device + '。');
    app.transcriber = await mod.pipeline('automatic-speech-recognition', model, {
      device,
      progress_callback: (data) => {
        if (!data) return;
        if (data.status === 'progress' && typeof data.progress === 'number') {
          const pct = Math.max(0, Math.min(100, data.progress));
          setProgress('model', pct, '模型下载', '正在下载模型文件：' + Math.round(pct) + '%。');
          setProgress('overall', 74 + pct * 0.12, '模型下载', '模型文件下载中。');
        } else if (data.status === 'ready') {
          setProgress('model', 100, '模型加载', '模型已加载。');
          log('模型已加载。', 'success');
        }
      }
    });
    app.transcriberKey = key;
    setProgress('model', 100, '模型加载', '模型已加载。');
    return app.transcriber;
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

  async function transcribe() {
    if (!app.capturedBlob) {
      alert('还没有捕获到音频。');
      return;
    }
    clearInterval(app.transcribeTimer);
    setButton('transcribe-btn', false);
    setProgress('text', 0, '转文字', '准备音频并启动本地识别。');
    try {
      const pipe = await ensureTranscriber();
      const audioUrl = URL.createObjectURL(app.capturedBlob);
      const started = Date.now();
      const estimateTotal = Math.max(18, app.capturedSeconds * (navigator.gpu ? 1.4 : 5));
      app.transcribeTimer = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000;
        const pct = Math.min(96, (elapsed / estimateTotal) * 96);
        setProgress('text', pct, '转文字', '正在转文字：已运行 ' + elapsed.toFixed(1) + ' 秒，估算进度 ' + Math.round(pct) + '%。');
        setProgress('overall', Math.min(98, 86 + pct * 0.12), '转文字', '本地识别进行中。');
      }, 700);

      log('开始本地转文字：' + formatBytes(app.capturedBlob.size) + '。');
      const settings = currentSettings();
      const options = Object.assign({
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5
      }, languageOptions(settings.language));
      let output;
      try {
        output = await pipe(audioUrl, options);
      } catch (error) {
        log('带时间戳识别失败，改用纯文本识别：' + error.message, 'warn');
        output = await pipe(audioUrl, languageOptions(settings.language));
      } finally {
        URL.revokeObjectURL(audioUrl);
        clearInterval(app.transcribeTimer);
        app.transcribeTimer = null;
      }
      const chunks = normalizeChunks(output);
      app.transcriptText = String(output && output.text ? output.text : chunks.map((x) => x.text).join(' ')).trim();
      app.transcriptSrt = chunksToSrt(chunks, app.transcriptText);
      $('transcript-output').value = app.transcriptText;
      $('srt-output').value = app.transcriptSrt;
      setButton('download-txt-btn', Boolean(app.transcriptText));
      setButton('download-srt-btn', Boolean(app.transcriptSrt));
      setButton('transcribe-btn', true);
      setProgress('text', 100, '转文字', '识别完成，文本长度 ' + app.transcriptText.length + ' 字符。');
      setProgress('overall', 100, '完成', '音频和文字处理完成。');
      log('转文字完成，文本长度 ' + app.transcriptText.length + ' 字符。', 'success');
    } catch (error) {
      clearInterval(app.transcribeTimer);
      app.transcribeTimer = null;
      setButton('transcribe-btn', true);
      setProgress('text', 100, '转文字失败', error.message);
      setProgress('overall', 100, '失败', error.message);
      log('转文字失败：' + error.message, 'error');
      alert('转文字失败：' + error.message + '。可以缩短捕获时长、切换 Tiny 模型，或换一个允许跨域的媒体直链。');
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

  function wire() {
    $('inspect-btn')?.addEventListener('click', () => inspect(false));
    $('auto-btn')?.addEventListener('click', () => inspect(true));
    $('capture-start-btn')?.addEventListener('click', () => startCapture());
    $('capture-tab-btn')?.addEventListener('click', () => startTabCapture());
    $('capture-stop-btn')?.addEventListener('click', () => stopCapture());
    $('transcribe-btn')?.addEventListener('click', () => transcribe());
    $('download-audio-btn')?.addEventListener('click', () => downloadAudio());
    $('download-txt-btn')?.addEventListener('click', () => downloadTxt());
    $('download-srt-btn')?.addEventListener('click', () => downloadSrt());
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
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
