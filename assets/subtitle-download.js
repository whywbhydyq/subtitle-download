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
    lastCaptureError: '',
    awaitingTabCaptureConsent: false,
    awaitingTabCaptureYoutubeId: '',
    captionAbortController: null
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
    box.innerHTML = '<div class="line">[等待] 粘贴链接后点击“获取简体中文文本”。</div>';
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
    setProgress('asr', 0, '转文字', 'YouTube 默认只直取字幕，不播放视频；没有字幕时会等待你再次确认是否播放并捕获音频。');
  }

  function resetOutputs() {
    if (app.captionAbortController) {
      try { app.captionAbortController.abort(); } catch (_) {}
      app.captionAbortController = null;
    }
    app.asrRunId += 1;
    app.resetSerial += 1;
    app.oneClickState = 'idle';
    app.captionFastPathUsed = false;
    app.firstSegmentLanguageDecisionDone = false;
    app.lastCaptionTracks = [];
    app.lastCaptureError = '';
    app.awaitingTabCaptureConsent = false;
    app.awaitingTabCaptureYoutubeId = '';
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
    log('已取消独立播放页：所有操作都在当前页面完成。', 'warn');
  }

  async function probeHttp(input, kind) {
    if (kind === 'youtube') return { ok: true, state: 'ok', message: 'YouTube 默认只走字幕接口，不加载播放器、不播放视频。' };
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

  const TRAD_TO_SIMP = Object.freeze({'臺':'台','台':'台','灣':'湾','萬':'万','與':'与','專':'专','業':'业','叢':'丛','東':'东','絲':'丝','丟':'丢','兩':'两','嚴':'严','喪':'丧','個':'个','臨':'临','為':'为','麗':'丽','舉':'举','麼':'么','義':'义','烏':'乌','樂':'乐','喬':'乔','習':'习','鄉':'乡','書':'书','買':'买','亂':'乱','爭':'争','於':'于','虧':'亏','雲':'云','亞':'亚','產':'产','畝':'亩','親':'亲','褻':'亵','嚲':'亸','億':'亿','僅':'仅','從':'从','侖':'仑','倉':'仓','儀':'仪','們':'们','價':'价','眾':'众','優':'优','夥':'伙','會':'会','傘':'伞','偉':'伟','傳':'传','傷':'伤','倀':'伥','倫':'伦','偽':'伪','體':'体','餘':'余','傭':'佣','債':'债','傾':'倾','僂':'偻','僅':'仅','僉':'佥','僑':'侨','僕':'仆','僥':'侥','僱':'雇','儈':'侩','儉':'俭','儂':'侬','億':'亿','儐':'傧','儔':'俦','儕':'侪','儘':'尽','償':'偿','優':'优','儲':'储','儷':'俪','儺':'傩','兒':'儿','兌':'兑','兗':'兖','黨':'党','蘭':'兰','關':'关','興':'兴','養':'养','獸':'兽','內':'内','岡':'冈','冊':'册','寫':'写','軍':'军','農':'农','馮':'冯','沖':'冲','決':'决','況':'况','凍':'冻','淨':'净','淒':'凄','準':'准','涼':'凉','減':'减','湊':'凑','凜':'凛','幾':'几','鳳':'凤','憑':'凭','凱':'凯','擊':'击','鑿':'凿','芻':'刍','劃':'划','別':'别','剄':'刭','則':'则','剋':'克','剎':'刹','剗':'刬','剛':'刚','剝':'剥','劑':'剂','剮':'剐','劍':'剑','劉':'刘','劊':'刽','劌':'刿','劇':'剧','劏':'㓥','勁':'劲','動':'动','務':'务','勛':'勋','勝':'胜','勞':'劳','勢':'势','勩':'勚','勱':'劢','勵':'励','勸':'劝','勻':'匀','匭':'匦','匯':'汇','匱':'匮','區':'区','協':'协','卻':'却','厙':'厍','厭':'厌','厲':'厉','厴':'厣','參':'参','雙':'双','發':'发','變':'变','敘':'叙','疊':'叠','葉':'叶','號':'号','嘆':'叹','嚇':'吓','呂':'吕','嗎':'吗','噸':'吨','聽':'听','啟':'启','吳':'吴','吶':'呐','嘸':'呒','囈':'呓','嘔':'呕','嚦':'呖','唄':'呗','員':'员','嗆':'呛','嗚':'呜','詠':'咏','嚨':'咙','嚀':'咛','嚐':'尝','啞':'哑','啟':'启','問':'问','啓':'启','嗶':'哔','嘩':'哗','喚':'唤','喪':'丧','喬':'乔','單':'单','喲':'哟','嗇':'啬','嗊':'唝','嗎':'吗','嗚':'呜','嗩':'唢','嗶':'哔','嘆':'叹','嘍':'喽','嘔':'呕','嘖':'啧','嘗':'尝','嘜':'唛','嘩':'哗','嘮':'唠','嘯':'啸','嘰':'叽','嘵':'哓','嘸':'呒','噁':'恶','噓':'嘘','噚':'寻','噝':'咝','噠':'哒','噥':'哝','噦':'哕','噯':'嗳','噲':'哙','噴':'喷','噸':'吨','噹':'当','嚀':'咛','嚇':'吓','嚌':'哜','嚕':'噜','嚙':'啮','嚥':'咽','嚦':'呖','嚨':'咙','嚮':'向','嚲':'亸','嚳':'喾','嚴':'严','囀':'啭','囁':'嗫','囂':'嚣','囅':'冁','囈':'呓','囉':'啰','囌':'苏','圇':'囵','國':'国','圍':'围','園':'园','圓':'圆','圖':'图','團':'团','埡':'垭','執':'执','堅':'坚','堊':'垩','堖':'垴','堝':'埚','堯':'尧','報':'报','場':'场','塊':'块','塋':'茔','塏':'垲','塒':'埘','塗':'涂','塚':'冢','塢':'坞','塤':'埙','塵':'尘','塹':'堑','墊':'垫','墜':'坠','墮':'堕','墳':'坟','墻':'墙','墾':'垦','壇':'坛','壓':'压','壘':'垒','壙':'圹','壚':'垆','壞':'坏','壟':'垄','壠':'垅','壢':'坜','壩':'坝','壯':'壮','壺':'壶','壼':'壸','壽':'寿','夠':'够','夢':'梦','夾':'夹','奐':'奂','奧':'奥','奩':'奁','奪':'夺','奮':'奋','奼':'姹','妝':'妆','姍':'姗','姦':'奸','娛':'娱','婁':'娄','婦':'妇','婭':'娅','媧':'娲','媯':'妫','媼':'媪','媽':'妈','嫗':'妪','嫵':'妩','嫻':'娴','嬀':'妫','嬈':'娆','嬋':'婵','嬌':'娇','嬙':'嫱','嬡':'嫒','嬤':'嬷','嬪':'嫔','嬰':'婴','嬸':'婶','孌':'娈','孫':'孙','學':'学','孿':'孪','宮':'宫','寢':'寝','實':'实','寧':'宁','審':'审','寫':'写','寬':'宽','寵':'宠','寶':'宝','將':'将','專':'专','尋':'寻','對':'对','導':'导','尷':'尴','屆':'届','屍':'尸','屓':'屃','屜':'屉','屢':'屡','層':'层','屨':'屦','屬':'属','岡':'冈','峽':'峡','崍':'崃','崑':'昆','崗':'岗','崠':'岽','崢':'峥','崬':'岽','嵐':'岚','嶁':'嵝','嶄':'崭','嶇':'岖','嶔':'嵚','嶗':'崂','嶠':'峤','嶢':'峣','嶧':'峄','嶮':'崄','嶴':'岙','嶸':'嵘','嶺':'岭','嶼':'屿','巋':'岿','巒':'峦','巔':'巅','巰':'巯','帥':'帅','師':'师','帳':'帐','帶':'带','幀':'帧','幃':'帏','幗':'帼','幘':'帻','幟':'帜','幣':'币','幫':'帮','幬':'帱','幹':'干','幾':'几','庫':'库','廁':'厕','廂':'厢','廄':'厩','廈':'厦','廚':'厨','廟':'庙','廠':'厂','廡':'庑','廢':'废','廣':'广','廩':'廪','廬':'庐','廳':'厅','弒':'弑','張':'张','強':'强','彆':'别','彈':'弹','彌':'弥','彎':'弯','彙':'汇','彞':'彝','彥':'彦','後':'后','徑':'径','從':'从','徠':'徕','復':'复','徵':'征','徹':'彻','恆':'恒','恥':'耻','悅':'悦','悞':'悮','悵':'怅','悶':'闷','惡':'恶','惱':'恼','惲':'恽','惻':'恻','愛':'爱','愜':'惬','愨':'悫','愴':'怆','愷':'恺','愾':'忾','慄':'栗','態':'态','慍':'愠','慘':'惨','慚':'惭','慟':'恸','慣':'惯','慤':'悫','慪':'怄','慫':'怂','慮':'虑','慳':'悭','慶':'庆','憂':'忧','憊':'惫','憐':'怜','憑':'凭','憒':'愦','憚':'惮','憤':'愤','憫':'悯','憮':'怃','憲':'宪','憶':'忆','懇':'恳','應':'应','懌':'怿','懍':'懔','懞':'蒙','懟':'怼','懣':'懑','懨':'恹','懲':'惩','懶':'懒','懷':'怀','懸':'悬','懺':'忏','懼':'惧','懾':'慑','戀':'恋','戇':'戆','戔':'戋','戩':'戬','戰':'战','戱':'戏','戲':'戏','戶':'户','拋':'抛','挾':'挟','捨':'舍','捫':'扪','掃':'扫','掄':'抡','掗':'挜','掙':'挣','掛':'挂','採':'采','揀':'拣','揚':'扬','換':'换','揮':'挥','損':'损','搖':'摇','搗':'捣','搶':'抢','摑':'掴','摜':'掼','摟':'搂','摯':'挚','摳':'抠','摶':'抟','摺':'折','摻':'掺','撈':'捞','撏':'挦','撐':'撑','撓':'挠','撟':'挢','撣':'掸','撥':'拨','撫':'抚','撲':'扑','撳':'揿','撻':'挞','撾':'挝','撿':'捡','擁':'拥','擄':'掳','擇':'择','擊':'击','擋':'挡','擓':'㧟','擔':'担','據':'据','擠':'挤','擬':'拟','擯':'摈','擰':'拧','擱':'搁','擲':'掷','擴':'扩','擷':'撷','擺':'摆','擻':'擞','擼':'撸','擾':'扰','攄':'摅','攆':'撵','攏':'拢','攔':'拦','攖':'撄','攙':'搀','攛':'撺','攜':'携','攝':'摄','攢':'攒','攣':'挛','攤':'摊','攪':'搅','攬':'揽','敗':'败','敘':'叙','數':'数','斂':'敛','斃':'毙','斕':'斓','鬥':'斗','斬':'斩','斷':'断','於':'于','時':'时','晉':'晋','晝':'昼','暈':'晕','暉':'晖','暘':'旸','暢':'畅','暫':'暂','曄':'晔','曆':'历','曇':'昙','曉':'晓','曏':'向','曖':'暧','曠':'旷','曨':'昽','曬':'晒','書':'书','會':'会','朧':'胧','術':'术','機':'机','殺':'杀','雜':'杂','權':'权','條':'条','來':'来','楊':'杨','極':'极','構':'构','標':'标','樞':'枢','樣':'样','樹':'树','橋':'桥','機':'机','橫':'横','檔':'档','檢':'检','櫃':'柜','櫻':'樱','欄':'栏','權':'权','歡':'欢','欽':'钦','歐':'欧','歸':'归','歲':'岁','歷':'历','殘':'残','殼':'壳','毀':'毁','毆':'殴','氈':'毡','氣':'气','漢':'汉','湯':'汤','溝':'沟','滅':'灭','滯':'滞','滲':'渗','滾':'滚','滿':'满','漁':'渔','漚':'沤','漢':'汉','漣':'涟','漫':'漫','漬':'渍','漲':'涨','漸':'渐','潁':'颍','潑':'泼','潔':'洁','潛':'潜','潤':'润','潯':'浔','潰':'溃','潷':'滗','潿':'涠','澀':'涩','澆':'浇','澇':'涝','澗':'涧','澠':'渑','澤':'泽','澦':'滪','澩':'泶','澮':'浍','澱':'淀','濁':'浊','濃':'浓','濕':'湿','濘':'泞','濟':'济','濤':'涛','濫':'滥','濰':'潍','濱':'滨','濺':'溅','濼':'泺','濾':'滤','瀅':'滢','瀆':'渎','瀉':'泻','瀋':'沈','瀏':'浏','瀕':'濒','瀘':'泸','瀝':'沥','瀟':'潇','瀠':'潆','瀦':'潴','瀧':'泷','瀨':'濑','瀰':'弥','瀲':'潋','瀾':'澜','灃':'沣','灄':'滠','灑':'洒','灕':'漓','灘':'滩','灝':'灏','灣':'湾','灤':'滦','災':'灾','為':'为','烏':'乌','無':'无','煉':'炼','煒':'炜','煙':'烟','煢':'茕','煥':'焕','煩':'烦','煬':'炀','熅':'煴','熒':'荧','熗':'炝','熱':'热','熲':'颎','熾':'炽','燁':'烨','燈':'灯','燉':'炖','燒':'烧','燙':'烫','燜':'焖','營':'营','燦':'灿','燭':'烛','燴':'烩','燶':'㶶','燼':'烬','燾':'焘','爍':'烁','爐':'炉','爛':'烂','爭':'争','爲':'为','爺':'爷','牆':'墙','牘':'牍','牽':'牵','犧':'牺','狀':'状','狹':'狭','狽':'狈','猙':'狰','猶':'犹','猻':'狲','獁':'犸','獄':'狱','獅':'狮','獎':'奖','獨':'独','獪':'狯','獫':'猃','獮':'狝','獰':'狞','獲':'获','獵':'猎','獸':'兽','獺':'獭','獻':'献','獼':'猕','玀':'猡','現':'现','琺':'珐','琿':'珲','瑋':'玮','瑣':'琐','瑤':'瑶','瑩':'莹','瑪':'玛','瑲':'玱','璉':'琏','璣':'玑','璦':'瑷','璫':'珰','環':'环','璽':'玺','瓊':'琼','瓏':'珑','瓔':'璎','甌':'瓯','產':'产','畢':'毕','畫':'画','異':'异','當':'当','疇':'畴','疊':'叠','痙':'痉','痠':'酸','痾':'疴','瘂':'痖','瘋':'疯','瘍':'疡','瘓':'痪','瘞':'瘗','瘡':'疮','瘧':'疟','瘮':'瘆','瘺':'瘘','瘻':'瘘','療':'疗','癆':'痨','癇':'痫','癉':'瘅','癒':'愈','癘':'疠','癟':'瘪','癡':'痴','癢':'痒','癤':'疖','癥':'症','癧':'疬','癩':'癞','癬':'癣','癭':'瘿','癮':'瘾','癰':'痈','癱':'瘫','癲':'癫','發':'发','皚':'皑','皰':'疱','皸':'皲','皺':'皱','盃':'杯','盜':'盗','盞':'盏','盡':'尽','監':'监','盤':'盘','盧':'卢','眥':'眦','眾':'众','睏':'困','睜':'睁','睞':'睐','瞘':'眍','瞜':'䁖','瞞':'瞒','瞭':'了','瞶':'瞆','瞼':'睑','矇':'蒙','矚':'瞩','矯':'矫','硃':'朱','硤':'硖','硨':'砗','硯':'砚','碩':'硕','碭':'砀','碸':'砜','確':'确','碼':'码','磚':'砖','磣':'碜','磧':'碛','磯':'矶','磽':'硗','礎':'础','礙':'碍','礦':'矿','礪':'砺','礫':'砾','礬':'矾','禍':'祸','禎':'祯','禕':'祎','禡':'祃','禦':'御','禪':'禅','禮':'礼','禰':'祢','禱':'祷','禿':'秃','稈':'秆','稅':'税','稜':'棱','稟':'禀','種':'种','稱':'称','穀':'谷','穌':'稣','積':'积','穎':'颖','穠':'秾','穡':'穑','穢':'秽','穩':'稳','窩':'窝','窪':'洼','窮':'穷','窯':'窑','窵':'窎','窶':'窭','竄':'窜','竅':'窍','竇':'窦','竈':'灶','竊':'窃','競':'竞','筆':'笔','筍':'笋','筧':'笕','箇':'个','箋':'笺','箏':'筝','節':'节','範':'范','築':'筑','篋':'箧','篔':'筼','篤':'笃','篩':'筛','篳':'筚','簀':'箦','簍':'篓','簞':'箪','簡':'简','簣':'篑','簫':'箫','簷':'檐','簽':'签','簾':'帘','籃':'篮','籌':'筹','籐':'藤','籙':'箓','籟':'籁','籠':'笼','籤':'签','籩':'笾','籪':'簖','籬':'篱','籮':'箩','籲':'吁','粵':'粤','糝':'糁','糞':'粪','糧':'粮','糰':'团','糴':'籴','糶':'粜','糾':'纠','紀':'纪','紂':'纣','約':'约','紅':'红','紆':'纡','紇':'纥','紈':'纨','紉':'纫','紋':'纹','納':'纳','紐':'纽','紓':'纾','純':'纯','紕':'纰','紗':'纱','紙':'纸','級':'级','紛':'纷','紜':'纭','紝':'纴','紡':'纺','紬':'䌷','細':'细','紱':'绂','紲':'绁','紳':'绅','紵':'纻','紹':'绍','紺':'绀','紼':'绋','紿':'绐','絀':'绌','終':'终','組':'组','絆':'绊','絎':'绗','結':'结','絕':'绝','絛':'绦','絝':'绔','絞':'绞','絡':'络','絢':'绚','給':'给','絨':'绒','絰':'绖','統':'统','絲':'丝','絳':'绛','絹':'绢','綁':'绑','綃':'绡','綆':'绠','綈':'绨','綉':'绣','綌':'绤','綏':'绥','經':'经','綜':'综','綞':'缍','綠':'绿','綢':'绸','綣':'绻','綫':'线','綬':'绶','維':'维','綰':'绾','綱':'纲','網':'网','綴':'缀','綵':'彩','綸':'纶','綹':'绺','綺':'绮','綻':'绽','綽':'绰','綾':'绫','綿':'绵','緄':'绲','緇':'缁','緊':'紧','緋':'绯','緒':'绪','緗':'缃','緘':'缄','緙':'缂','線':'线','緝':'缉','緞':'缎','締':'缔','緡':'缗','緣':'缘','緦':'缌','編':'编','緩':'缓','緬':'缅','緯':'纬','緱':'缑','緲':'缈','練':'练','緶':'缏','緹':'缇','緻':'致','縈':'萦','縉':'缙','縊':'缢','縋':'缒','縐':'绉','縑':'缣','縛':'缚','縝':'缜','縞':'缟','縟':'缛','縣':'县','縧':'绦','縫':'缝','縭':'缡','縮':'缩','縱':'纵','縲':'缧','縳':'䌸','縵':'缦','縶':'絷','縷':'缕','縹':'缥','總':'总','績':'绩','繃':'绷','繅':'缫','繆':'缪','繒':'缯','織':'织','繕':'缮','繚':'缭','繞':'绕','繡':'绣','繢':'缋','繩':'绳','繪':'绘','繫':'系','繭':'茧','繮':'缰','繯':'缳','繰':'缲','繳':'缴','繹':'绎','繼':'继','繽':'缤','繾':'缱','纈':'缬','纊':'纩','續':'续','纍':'累','纏':'缠','纓':'缨','纔':'才','纖':'纤','纘':'缵','纜':'缆','缽':'钵','罈':'坛','罌':'罂','罰':'罚','罵':'骂','罷':'罢','羅':'罗','羆':'罴','羈':'羁','羋':'芈','羥':'羟','義':'义','習':'习','翹':'翘','耬':'耧','聖':'圣','聞':'闻','聯':'联','聰':'聪','聲':'声','聳':'耸','聵':'聩','聶':'聂','職':'职','聹':'聍','聽':'听','聾':'聋','肅':'肃','脅':'胁','脈':'脉','脛':'胫','脫':'脱','脹':'胀','腎':'肾','腖':'胨','腡':'脶','腦':'脑','腫':'肿','腳':'脚','腸':'肠','膃':'腽','膚':'肤','膠':'胶','膩':'腻','膽':'胆','膾':'脍','膿':'脓','臉':'脸','臍':'脐','臏':'膑','臘':'腊','臚':'胪','臟':'脏','臠':'脔','臢':'臜','臥':'卧','臨':'临','臺':'台','與':'与','興':'兴','舉':'举','艙':'舱','艤':'舣','艦':'舰','艫':'舻','艱':'艰','艷':'艳','藝':'艺','節':'节','芻':'刍','莊':'庄','莖':'茎','莢':'荚','莧':'苋','華':'华','萇':'苌','萊':'莱','萬':'万','萵':'莴','葉':'叶','葒':'荭','著':'着','葤':'荮','葦':'苇','葷':'荤','蒍':'为','蒔':'莳','蒞':'莅','蒼':'苍','蓀':'荪','蓋':'盖','蓮':'莲','蓯':'苁','蓴':'莼','蓽':'荜','蔔':'卜','蔞':'蒌','蔣':'蒋','蔥':'葱','蔦':'茑','蔭':'荫','蕁':'荨','蕆':'蒇','蕎':'荞','蕒':'荬','蕓':'芸','蕕':'莸','蕘':'荛','蕢':'蒉','蕩':'荡','蕪':'芜','蕭':'萧','蕷':'蓣','薈':'荟','薊':'蓟','薌':'芗','薔':'蔷','薘':'荙','薟':'莶','薦':'荐','薩':'萨','薴':'苧','薺':'荠','藍':'蓝','藎':'荩','藝':'艺','藥':'药','藪':'薮','藶':'苈','藹':'蔼','藺':'蔺','蘄':'蕲','蘆':'芦','蘇':'苏','蘊':'蕴','蘋':'苹','蘚':'藓','蘞':'蔹','蘢':'茏','蘭':'兰','蘺':'蓠','蘿':'萝','處':'处','虛':'虚','虜':'虏','號':'号','虧':'亏','蟲':'虫','蛺':'蛱','蛻':'蜕','蜆':'蚬','蝕':'蚀','蝟':'猬','蝦':'虾','蝸':'蜗','螄':'蛳','螞':'蚂','螢':'萤','螻':'蝼','螿':'螀','蟄':'蛰','蟈':'蝈','蟎':'螨','蟣':'虮','蟬':'蝉','蟯':'蛲','蟲':'虫','蟶':'蛏','蟻':'蚁','蠅':'蝇','蠆':'虿','蠍':'蝎','蠐':'蛴','蠑':'蝾','蠟':'蜡','蠣':'蛎','蠱':'蛊','蠶':'蚕','蠻':'蛮','衆':'众','衊':'蔑','術':'术','衕':'同','衚':'胡','衛':'卫','衝':'冲','衡':'衡','袞':'衮','裊':'袅','裏':'里','補':'补','裝':'装','製':'制','複':'复','褌':'裈','褘':'袆','褲':'裤','褳':'裢','褸':'褛','褻':'亵','襆':'幞','襇':'裥','襖':'袄','襝':'裣','襠':'裆','襤':'褴','襪':'袜','襬':'摆','襯':'衬','襲':'袭','見':'见','覎':'觃','規':'规','覓':'觅','視':'视','覘':'觇','覡':'觋','覥':'觍','覦':'觎','親':'亲','覬':'觊','覯':'觏','覲':'觐','覷':'觑','覺':'觉','覽':'览','覿':'觌','觀':'观','觴':'觞','觸':'触','訁':'讠','訂':'订','訃':'讣','計':'计','訊':'讯','訌':'讧','討':'讨','訐':'讦','訒':'讱','訓':'训','訕':'讪','訖':'讫','託':'托','記':'记','訛':'讹','訝':'讶','訟':'讼','訢':'䜣','訣':'诀','訥':'讷','訪':'访','設':'设','許':'许','訴':'诉','訶':'诃','診':'诊','註':'注','証':'证','詁':'诂','詆':'诋','詎':'讵','詐':'诈','詒':'诒','詔':'诏','評':'评','詖':'诐','詗':'诇','詘':'诎','詛':'诅','詞':'词','詠':'咏','詡':'诩','詢':'询','詣':'诣','試':'试','詩':'诗','詫':'诧','詬':'诟','詭':'诡','詮':'诠','詰':'诘','話':'话','該':'该','詳':'详','詵':'诜','詼':'诙','詿':'诖','誄':'诔','誅':'诛','誆':'诓','誇':'夸','誌':'志','認':'认','誑':'诳','誒':'诶','誕':'诞','誘':'诱','誚':'诮','語':'语','誠':'诚','誡':'诫','誣':'诬','誤':'误','誥':'诰','誦':'诵','誨':'诲','說':'说','誰':'谁','課':'课','誶':'谇','誹':'诽','誼':'谊','誾':'訚','調':'调','諂':'谄','諄':'谆','談':'谈','諉':'诿','請':'请','諍':'诤','諏':'诹','諑':'诼','諒':'谅','論':'论','諗':'谂','諛':'谀','諜':'谍','諞':'谝','諢':'诨','諤':'谔','諦':'谛','諧':'谐','諫':'谏','諭':'谕','諮':'谘','諱':'讳','諳':'谙','諶':'谌','諷':'讽','諸':'诸','諺':'谚','諼':'谖','諾':'诺','謀':'谋','謁':'谒','謂':'谓','謄':'誊','謅':'诌','謊':'谎','謎':'谜','謐':'谧','謔':'谑','謖':'谡','謗':'谤','謙':'谦','講':'讲','謝':'谢','謠':'谣','謡':'谣','謨':'谟','謫':'谪','謬':'谬','謳':'讴','謹':'谨','謾':'谩','譁':'哗','證':'证','譎':'谲','譏':'讥','譖':'谮','識':'识','譙':'谯','譚':'谭','譜':'谱','譞':'谞','譟':'噪','警':'警','譫':'谵','譯':'译','議':'议','譴':'谴','護':'护','譸':'诪','譽':'誉','讀':'读','變':'变','讎':'雠','讒':'谗','讓':'让','讕':'谰','讖':'谶','讚':'赞','讜':'谠','豈':'岂','豎':'竖','豐':'丰','豬':'猪','貓':'猫','貝':'贝','貞':'贞','負':'负','財':'财','貢':'贡','貧':'贫','貨':'货','販':'贩','貪':'贪','貫':'贯','責':'责','貯':'贮','貰':'贳','貲':'赀','貳':'贰','貴':'贵','貶':'贬','買':'买','貸':'贷','貺':'贶','費':'费','貼':'贴','貽':'贻','貿':'贸','賀':'贺','賁':'贲','賂':'赂','賃':'赁','賄':'贿','資':'资','賈':'贾','賊':'贼','賑':'赈','賒':'赊','賓':'宾','賕':'赇','賙':'赒','賚':'赉','賜':'赐','賞':'赏','賠':'赔','賡':'赓','賢':'贤','賣':'卖','賤':'贱','賦':'赋','質':'质','賫':'赍','賬':'账','賭':'赌','賴':'赖','賺':'赚','賻':'赙','購':'购','賽':'赛','贄':'贽','贅':'赘','贇':'赟','贈':'赠','贊':'赞','贋':'赝','贍':'赡','贏':'赢','贐':'赆','贓':'赃','贔':'赑','贖':'赎','贗':'赝','贛':'赣','趕':'赶','趙':'赵','趨':'趋','趲':'趱','跡':'迹','踐':'践','踴':'踊','蹌':'跄','蹕':'跸','蹣':'蹒','蹤':'踪','蹺':'跷','躂':'跶','躉':'趸','躊':'踌','躋':'跻','躍':'跃','躑':'踯','躒':'跞','躓':'踬','躕':'蹰','躚':'跹','躡':'蹑','躥':'蹿','躦':'躜','躪':'躏','軀':'躯','車':'车','軋':'轧','軌':'轨','軍':'军','軒':'轩','軔':'轫','軛':'轭','軟':'软','軤':'轷','軫':'轸','軲':'轱','軸':'轴','軹':'轵','軺':'轺','軻':'轲','軼':'轶','軾':'轼','較':'较','輅':'辂','輇':'辁','輈':'辀','載':'载','輊':'轾','輒':'辄','輔':'辅','輕':'轻','輛':'辆','輜':'辎','輝':'辉','輞':'辋','輟':'辍','輥':'辊','輦':'辇','輩':'辈','輪':'轮','輯':'辑','輸':'输','輻':'辐','輾':'辗','轀':'辒','轂':'毂','轄':'辖','轅':'辕','轆':'辘','轉':'转','轍':'辙','轎':'轿','轔':'辚','轟':'轰','轡':'辔','轢':'轹','轤':'轳','辦':'办','辭':'辞','辮':'辫','辯':'辩','農':'农','迴':'回','逕':'迳','這':'这','連':'连','週':'周','進':'进','遊':'游','運':'运','過':'过','達':'达','違':'违','遙':'遥','遜':'逊','遞':'递','遠':'远','適':'适','遲':'迟','遷':'迁','選':'选','遺':'遗','遼':'辽','邁':'迈','還':'还','邇':'迩','邊':'边','邏':'逻','鄧':'邓','鄭':'郑','鄰':'邻','鄲':'郸','鄴':'邺','鄶':'郐','鄺':'邝','酈':'郦','醜':'丑','醫':'医','醬':'酱','醱':'酦','釀':'酿','釁':'衅','釃':'酾','釅':'酽','釋':'释','釐':'厘','針':'针','釘':'钉','釣':'钓','鈔':'钞','鈕':'钮','鈣':'钙','鈴':'铃','鈷':'钴','鈺':'钰','鈾':'铀','鉀':'钾','鉅':'钜','鉉':'铉','鉋':'铇','鉑':'铂','鉗':'钳','鉚':'铆','鉛':'铅','鉞':'钺','鉤':'钩','鉦':'钲','鉬':'钼','鉭':'钽','鉸':'铰','鉺':'铒','鉻':'铬','鉿':'铪','銀':'银','銃':'铳','銅':'铜','銍':'铚','銑':'铣','銓':'铨','銖':'铢','銘':'铭','銚':'铫','銜':'衔','銠':'铑','銣':'铷','銥':'铱','銦':'铟','銨':'铵','銩':'铥','銪':'铕','銫':'铯','銬':'铐','銱':'铞','銳':'锐','銷':'销','銹':'锈','銻':'锑','銼':'锉','鋁':'铝','鋃':'锒','鋅':'锌','鋇':'钡','鋌':'铤','鋏':'铗','鋒':'锋','鋙':'铻','鋝':'锊','鋟':'锓','鋤':'锄','鋦':'锔','鋨':'锇','鋪':'铺','鋭':'锐','鋯':'锆','鋰':'锂','鋱':'铽','鋶':'锍','鋸':'锯','鋼':'钢','錄':'录','錆':'锖','錇':'锫','錈':'锩','錏':'铔','錐':'锥','錒':'锕','錕':'锟','錘':'锤','錙':'锱','錚':'铮','錛':'锛','錟':'锬','錠':'锭','錡':'锜','錢':'钱','錦':'锦','錨':'锚','錫':'锡','錮':'锢','錯':'错','錳':'锰','錶':'表','錸':'铼','鍀':'锝','鍁':'锨','鍆':'钔','鍇':'锴','鍈':'锳','鍋':'锅','鍍':'镀','鍔':'锷','鍘':'铡','鍛':'锻','鍤':'锸','鍥':'锲','鍩':'锘','鍬':'锹','鍰':'锾','鍵':'键','鍶':'锶','鍺':'锗','鍼':'针','鎂':'镁','鎄':'锿','鎇':'镅','鎊':'镑','鎔':'镕','鎖':'锁','鎘':'镉','鎚':'锤','鎛':'镈','鎝':'𨱏','鎡':'镃','鎢':'钨','鎦':'镏','鎧':'铠','鎩':'铩','鎪':'锼','鎬':'镐','鎰':'镒','鎳':'镍','鎵':'镓','鎶':'锘','鎸':'镌','鎿':'镎','鏃':'镞','鏈':'链','鏑':'镝','鏜':'镗','鏞':'镛','鏟':'铲','鏡':'镜','鏢':'镖','鏤':'镂','鏨':'錾','鏰':'镚','鏵':'铧','鏷':'镤','鏹':'镪','鏺':'䥽','鏽':'锈','鐃':'铙','鐋':'铴','鐐':'镣','鐒':'铹','鐓':'镦','鐔':'镡','鐘':'钟','鐙':'镫','鐝':'镢','鐠':'镨','鐦':'锎','鐧':'锏','鐨':'镄','鐫':'镌','鐮':'镰','鐲':'镯','鐳':'镭','鐵':'铁','鐶':'镮','鐸':'铎','鐺':'铛','鐿':'镱','鑄':'铸','鑊':'镬','鑌':'镔','鑒':'鉴','鑔':'镲','鑕':'锧','鑞':'镴','鑠':'铄','鑣':'镳','鑥':'镥','鑭':'镧','鑰':'钥','鑲':'镶','鑷':'镊','鑹':'镩','鑼':'锣','鑽':'钻','鑾':'銮','鑿':'凿','長':'长','門':'门','閂':'闩','閃':'闪','閆':'闫','閉':'闭','開':'开','閌':'闶','閎':'闳','閏':'闰','閑':'闲','間':'间','閔':'闵','閘':'闸','閡':'阂','閣':'阁','閤':'合','閥':'阀','閨':'闺','閩':'闽','閫':'阃','閬':'阆','閭':'闾','閱':'阅','閶':'阊','閹':'阉','閻':'阎','閼':'阏','閽':'阍','閾':'阈','閿':'阌','闃':'阒','闆':'板','闈':'闱','闊':'阔','闋':'阕','闌':'阑','闍':'阇','闐':'阗','闓':'闿','闔':'阖','闕':'阙','闖':'闯','關':'关','闞':'阚','闠':'阓','闡':'阐','闢':'辟','闤':'阛','闥':'闼','阪':'阪','陘':'陉','陝':'陕','陣':'阵','陰':'阴','陳':'陈','陸':'陆','陽':'阳','隉':'陧','隊':'队','階':'阶','隕':'陨','際':'际','隨':'随','險':'险','隱':'隐','隴':'陇','隸':'隶','隻':'只','雋':'隽','雖':'虽','雙':'双','雛':'雏','雜':'杂','雞':'鸡','離':'离','難':'难','雲':'云','電':'电','霧':'雾','霽':'霁','靂':'雳','靄':'霭','靈':'灵','靚':'靓','靜':'静','靦':'腼','鞏':'巩','韁':'缰','韃':'鞑','韆':'千','韉':'鞯','韋':'韦','韌':'韧','韓':'韩','韙':'韪','韜':'韬','韞':'韫','韻':'韵','頁':'页','頂':'顶','頃':'顷','項':'项','順':'顺','須':'须','頊':'顼','頌':'颂','頎':'颀','頏':'颃','預':'预','頑':'顽','頒':'颁','頓':'顿','頗':'颇','領':'领','頜':'颌','頡':'颉','頤':'颐','頦':'颏','頭':'头','頰':'颊','頲':'颋','頷':'颔','頸':'颈','頹':'颓','頻':'频','顆':'颗','題':'题','額':'额','顎':'颚','顏':'颜','顒':'颙','顓':'颛','願':'愿','顙':'颡','顛':'颠','類':'类','顢':'颟','顥':'颢','顧':'顾','顫':'颤','顬':'颥','顯':'显','顰':'颦','顱':'颅','顳':'颞','顴':'颧','風':'风','颭':'飐','颮':'飑','颯':'飒','颱':'台','颳':'刮','颶':'飓','颸':'飔','颺':'飏','颻':'飖','飀':'飗','飄':'飘','飆':'飙','飛':'飞','飢':'饥','飩':'饨','飪':'饪','飫':'饫','飭':'饬','飯':'饭','飲':'饮','飴':'饴','飼':'饲','飽':'饱','飾':'饰','餃':'饺','餄':'饸','餅':'饼','餉':'饷','養':'养','餌':'饵','餎':'饹','餏':'饻','餑':'饽','餒':'馁','餓':'饿','餘':'余','餛':'馄','餜':'馃','餞':'饯','餡':'馅','館':'馆','餱':'糇','餳':'饧','餵':'喂','餶':'馉','餷':'馇','餺':'馎','餼':'饩','餾':'馏','餿':'馊','饃':'馍','饅':'馒','饈':'馐','饉':'馑','饊':'馓','饋':'馈','饌':'馔','饑':'饥','饒':'饶','饗':'飨','饜':'餍','饞':'馋','饢':'馕','馬':'马','馭':'驭','馮':'冯','馱':'驮','馳':'驰','馴':'驯','駁':'驳','駐':'驻','駑':'驽','駒':'驹','駔':'驵','駕':'驾','駘':'骀','駙':'驸','駛':'驶','駝':'驼','駟':'驷','駡':'骂','駢':'骈','駭':'骇','駰':'骃','駱':'骆','駿':'骏','騁':'骋','騂':'骍','騅':'骓','騎':'骑','騏':'骐','騖':'骛','騙':'骗','騫':'骞','騭':'骘','騮':'骝','騰':'腾','騶':'驺','騷':'骚','騸':'骟','騾':'骡','驀':'蓦','驁':'骜','驂':'骖','驃':'骠','驅':'驱','驊':'骅','驌':'骕','驍':'骁','驏':'骣','驕':'骄','驗':'验','驚':'惊','驛':'驿','驟':'骤','驢':'驴','驤':'骧','驥':'骥','驦':'骦','驪':'骊','骯':'肮','髏':'髅','髒':'脏','體':'体','髕':'髌','鬆':'松','鬍':'胡','鬚':'须','鬢':'鬓','鬥':'斗','鬧':'闹','鬩':'阋','鬱':'郁','魎':'魉','魘':'魇','魚':'鱼','魯':'鲁','魴':'鲂','鮁':'鲅','鮃':'鲆','鮎':'鲇','鮐':'鲐','鮑':'鲍','鮒':'鲋','鮓':'鲊','鮚':'鲒','鮜':'鲘','鮞':'鲕','鮟':'𩽾','鮠':'𬶏','鮢':'鲝','鮣':'䲟','鮤':'䲠','鮦':'鲖','鮪':'鲔','鮫':'鲛','鮭':'鲑','鮮':'鲜','鮳':'鲓','鮶':'鲪','鮺':'鲝','鯀':'鲧','鯁':'鲠','鯇':'鲩','鯉':'鲤','鯊':'鲨','鯒':'鲬','鯔':'鲻','鯕':'鲯','鯖':'鲭','鯗':'鲞','鯛':'鲷','鯝':'鲴','鯡':'鲱','鯢':'鲵','鯤':'鲲','鯧':'鲳','鯨':'鲸','鯪':'鲮','鯫':'鲰','鯰':'鲶','鯴':'鲺','鯷':'鳀','鯽':'鲫','鯿':'鳊','鰁':'鳈','鰂':'鲗','鰃':'鳂','鰈':'鲽','鰉':'鳇','鰍':'鳅','鰏':'鲾','鰐':'鳄','鰒':'鳆','鰓':'鳃','鰜':'鳒','鰟':'鳑','鰠':'鳋','鰣':'鲥','鰥':'鳏','鰨':'鳎','鰩':'鳐','鰭':'鳍','鰱':'鲢','鰲':'鳌','鰳':'鳓','鰵':'鳘','鰷':'鲦','鰹':'鲣','鰻':'鳗','鰼':'鳛','鰾':'鳔','鱂':'鳉','鱅':'鳙','鱈':'鳕','鱉':'鳖','鱒':'鳟','鱔':'鳝','鱖':'鳜','鱗':'鳞','鱘':'鲟','鱝':'鲼','鱟':'鲎','鱠':'脍','鱣':'鳣','鱧':'鳢','鱨':'鲿','鱭':'鲚','鱯':'鳠','鱷':'鳄','鱸':'鲈','鱺':'鲡','鳥':'鸟','鳧':'凫','鳩':'鸠','鳳':'凤','鳴':'鸣','鳶':'鸢','鴆':'鸩','鴇':'鸨','鴉':'鸦','鴒':'鸰','鴕':'鸵','鴛':'鸳','鴝':'鸲','鴟':'鸱','鴣':'鸪','鴦':'鸯','鴨':'鸭','鴯':'鸸','鴰':'鸹','鴻':'鸿','鴿':'鸽','鵂':'鸺','鵃':'鸼','鵐':'鹀','鵓':'鹁','鵜':'鹈','鵝':'鹅','鵠':'鹄','鵡':'鹉','鵪':'鹌','鵬':'鹏','鵮':'鹐','鵯':'鹎','鵲':'鹊','鶇':'鸫','鶉':'鹑','鶊':'鹒','鶓':'鹋','鶖':'鹙','鶘':'鹕','鶚':'鹗','鶡':'鹖','鶥':'鹛','鶩':'鹜','鶯':'莺','鶴':'鹤','鶹':'鹠','鶺':'鹡','鶻':'鹘','鶼':'鹣','鶿':'鹚','鷂':'鹞','鷄':'鸡','鷈':'䴘','鷓':'鹧','鷗':'鸥','鷙':'鸷','鷚':'鹨','鷥':'鸶','鷦':'鹪','鷯':'鹩','鷲':'鹫','鷸':'鹬','鷹':'鹰','鷺':'鹭','鸇':'鹯','鸌':'鹱','鸏':'鹲','鸕':'鸬','鸚':'鹦','鸛':'鹳','鹵':'卤','鹹':'咸','鹺':'鹾','鹼':'碱','鹽':'盐','麗':'丽','麥':'麦','麩':'麸','麯':'曲','麼':'么','黃':'黄','黌':'黉','點':'点','黨':'党','黲':'黪','黴':'霉','黶':'黡','黷':'黩','黽':'黾','黿':'鼋','鼉':'鼍','鼴':'鼹','齊':'齐','齋':'斋','齒':'齿','齙':'龅','齜':'龇','齟':'龃','齡':'龄','齦':'龈','齪':'龊','齬':'龉','齲':'龋','齶':'腭','齷':'龌','龍':'龙','龐':'庞','龔':'龚','龕':'龛'});

  const TRAD_PHRASES = [
    ['雷蒙平台', '雷蒙平台'],
    ['阿杰斯', '阿杰斯'],
    ['這裡', '这里'],
    ['裡面', '里面'],
    ['什麼', '什么'],
    ['視頻', '视频'],
    ['實際', '实际'],
    ['針對', '针对'],
    ['問題', '问题'],
    ['解答', '解答'],
    ['還是', '还是'],
    ['我們', '我们'],
    ['來看', '来看'],
    ['收藏', '收藏'],
    ['成功之後', '成功之后'],
    ['轉文字', '转文字'],
    ['音頻', '音频']
  ];

  function toSimplifiedChinese(text) {
    let value = String(text || '');
    if (!value) return '';
    for (const [from, to] of TRAD_PHRASES) value = value.split(from).join(to);
    value = Array.from(value).map((ch) => TRAD_TO_SIMP[ch] || ch).join('');
    value = value.replace(/臺/g, '台').replace(/裏/g, '里');
    return value;
  }

  function inspectYouTubeWithoutPlayback(input, youtubeId) {
    stopNativeMedia();
    stopYouTubePlayer();
    app.currentKind = 'youtube';
    app.currentUrl = input;
    app.youtubeId = youtubeId;
    app.youtubeTitle = '';
    app.languageHint = 'zh';
    setStatus('check-connect', '字幕接口检测中', 'pending');
    setStatus('check-control', '未加载播放器', 'pending');
    setStatus('check-play', '未播放', 'ok');
    setStatus('check-capture', '优先直取字幕', 'pending');
    setProgress('overall', 12, 'YouTube 字幕检测', '只检查字幕接口；不加载播放器、不播放视频。');
    log('YouTube 视频 ID：' + youtubeId + '。默认只直取字幕，不加载 iframe，不播放视频。');
    return true;
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
    return 'subtitle-download:caption:v4:zh-Hans:' + [videoId, track.lang || '', track.name || '', track.kind || ''].join(':');
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
      if (!value.trim() || value.length > 900000) return;
      localStorage.setItem(captionCacheKey(videoId, track), JSON.stringify({ t: Date.now(), text: value }));
    } catch (_) {}
  }

  function uniqueList(values) {
    const seen = new Set();
    return values.filter((value) => {
      const key = String(value || '').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
    const controller = new AbortController();
    const outerSignal = options.signal;
    const onAbort = () => {
      try { controller.abort(outerSignal.reason); } catch (_) { controller.abort(); }
    };
    if (outerSignal) {
      if (outerSignal.aborted) throw new DOMException('请求已取消。', 'AbortError');
      outerSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      try { controller.abort(new Error('timeout')); } catch (_) { controller.abort(); }
    }, timeoutMs);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    }
  }

  function dedupeCaptionTracks(tracks) {
    const seen = new Set();
    return tracks.filter((track) => {
      const key = [track.lang, track.name, track.kind].join('\u0001');
      if (!track.lang || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function tryYouTubeCaptions(youtubeId) {
    const runId = app.asrRunId;
    const controller = new AbortController();
    app.captionAbortController = controller;
    const preferred = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', 'en'];
    setProgress('asr', 4, 'YouTube 字幕并行直取', '正在并行检查 YouTube 字幕/自动字幕轨。');
    log('优先并行直取 YouTube 字幕；成功时无需录音、无需本地 ASR，速度最快。');
    try {
      const tracks = await fetchYouTubeCaptionTracks(youtubeId, controller.signal);
      if (runId !== app.asrRunId || controller.signal.aborted) throw new Error('任务已取消。');
      app.lastCaptionTracks = tracks;
      if (!tracks.length) throw new Error('没有返回可读字幕轨。');
      const rankedTracks = rankCaptionTracks(tracks, preferred);
      if (!rankedTracks.length) throw new Error('没有匹配的中英文字幕轨。');

      let selected = null;
      let text = '';
      for (const track of rankedTracks.slice(0, 6)) {
        text = readCaptionCache(youtubeId, track);
        if (text && text.trim()) {
          selected = track;
          log('命中本地字幕缓存：' + track.display + ' / ' + track.lang + '，直接复用。', 'success');
          break;
        }
      }
      if (!text) {
        setProgress('asr', 18, 'YouTube 字幕并行直取', '正在并行下载最优字幕轨并转为简体中文。');
        const result = await fetchFirstCaptionText(youtubeId, rankedTracks.slice(0, 4), controller.signal);
        selected = result.track;
        text = result.text;
        writeCaptionCache(youtubeId, selected, text);
      }
      if (runId !== app.asrRunId || controller.signal.aborted) throw new Error('任务已取消。');
      if (!text || text.trim().length < 2) throw new Error('字幕轨为空。');
      app.captionFastPathUsed = true;
      app.transcriptText = cleanTranscriptText(text);
      const output = $('transcript-output');
      if (output) output.value = app.transcriptText;
      setButton('download-txt-btn', true);
      setStatus('check-capture', '已直取字幕，无需捕获音频', 'ok');
      setProgress('audio', 100, '未播放视频', '已直接读取 YouTube 字幕并转为简体中文，不需要播放视频或捕获音频。');
      setProgress('asr', 100, '字幕已完成', '已输出纯文本：' + app.transcriptText.length + ' 字符。');
      setProgress('overall', 100, '完成', 'YouTube 字幕并行直取完成：没有播放视频。');
      log('YouTube 字幕直取完成：' + (selected ? (selected.display + ' / ' + selected.lang + '，') : '') + app.transcriptText.length + ' 字符。', 'success');
      updateOneClickButton();
      return true;
    } catch (error) {
      if (runId !== app.asrRunId || controller.signal.aborted) return false;
      log('YouTube 字幕直取不可用：' + error.message + '。将改用当前标签页音频捕获。', 'warn');
      setProgress('asr', 0, '等待音频捕获', '没有可直取字幕，下一步需要授权捕获当前标签页音频。');
      return false;
    } finally {
      if (app.captionAbortController === controller) app.captionAbortController = null;
    }
  }

  async function fetchYouTubeCaptionTracks(youtubeId, signal) {
    const endpoints = [
      'https://video.google.com/timedtext',
      'https://www.youtube.com/api/timedtext'
    ];
    const hls = uniqueList(['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', navigator.language || 'zh-CN', 'en']);
    const tasks = [];
    const errors = [];
    for (const endpoint of endpoints) {
      for (const hl of hls) {
        const url = new URL(endpoint);
        url.searchParams.set('type', 'list');
        url.searchParams.set('v', youtubeId);
        url.searchParams.set('hl', hl);
        tasks.push(fetchWithTimeout(url.toString(), { mode: 'cors', cache: 'no-store', signal }, 5500)
          .then(async (response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const xmlText = await response.text();
            const tracks = parseCaptionTrackList(xmlText);
            if (!tracks.length) throw new Error('空字幕轨列表');
            return tracks;
          })
          .catch((error) => {
            errors.push(hl + ': ' + error.message);
            return [];
          }));
      }
    }
    const settled = await Promise.all(tasks);
    const merged = dedupeCaptionTracks(settled.flat());
    if (merged.length) {
      log('并行字幕轨检测完成：发现 ' + merged.length + ' 条字幕轨。', 'success');
      return merged;
    }
    if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
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
    return dedupeCaptionTracks(tracks);
  }

  function captionTrackScore(track, preferredLangs) {
    const lang = String(track.lang || '').toLowerCase();
    let score = 0;
    preferredLangs.forEach((preferred, index) => {
      const p = preferred.toLowerCase();
      if (lang === p) score = Math.max(score, 100 - index * 8);
      else if (lang.startsWith(p + '-') || lang.startsWith(p)) score = Math.max(score, 84 - index * 8);
    });
    if (/^zh-hans|^zh-cn|^zh($|-)/i.test(track.lang || '')) score += 20;
    if (/^zh-hant|^zh-tw|^zh-hk/i.test(track.lang || '')) score += 12;
    if (/^en($|-)/i.test(track.lang || '')) score += 4;
    if (track.kind !== 'asr') score += 6;
    return score;
  }

  function rankCaptionTracks(tracks, preferredLangs) {
    return dedupeCaptionTracks(tracks.slice())
      .map((track) => Object.assign({}, track, { score: captionTrackScore(track, preferredLangs) }))
      .sort((a, b) => b.score - a.score);
  }

  function chooseCaptionTrack(tracks, preferredLangs) {
    return rankCaptionTracks(tracks, preferredLangs)[0] || null;
  }

  function captionCandidateUrls(videoId, track) {
    const endpoints = ['https://video.google.com/timedtext', 'https://www.youtube.com/api/timedtext'];
    const formats = ['json3', 'vtt', ''];
    const urls = [];
    for (const endpoint of endpoints) {
      for (const fmt of formats) {
        const url = new URL(endpoint);
        url.searchParams.set('v', videoId);
        url.searchParams.set('lang', track.lang);
        if (track.name) url.searchParams.set('name', track.name);
        if (track.kind) url.searchParams.set('kind', track.kind);
        if (fmt) url.searchParams.set('fmt', fmt);
        if (!/^zh-(hans|cn)$/i.test(track.lang || '')) url.searchParams.set('tlang', 'zh-Hans');
        urls.push({ url: url.toString(), fmt, track });
      }
    }
    return urls;
  }

  async function fetchCaptionCandidate(candidate, signal) {
    const response = await fetchWithTimeout(candidate.url, { mode: 'cors', cache: 'no-store', signal }, 9000);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (candidate.fmt === 'json3') {
      const json = await response.json();
      return parseJson3Captions(json);
    }
    const raw = await response.text();
    return candidate.fmt === 'vtt' ? parseVttCaptions(raw) : parseXmlCaptions(raw);
  }

  function firstNonEmptyCaption(candidates, signal) {
    return new Promise((resolve, reject) => {
      if (!candidates.length) {
        reject(new Error('没有字幕下载候选。'));
        return;
      }
      let done = false;
      let pending = candidates.length;
      const errors = [];
      const localController = new AbortController();
      const onAbort = () => {
        if (!done) {
          done = true;
          try { localController.abort(); } catch (_) {}
          reject(new Error('字幕下载已取消。'));
        }
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      for (const candidate of candidates) {
        fetchCaptionCandidate(candidate, signal || localController.signal)
          .then((text) => {
            if (done) return;
            const cleaned = cleanTranscriptText(text);
            if (cleaned.trim()) {
              done = true;
              if (signal) signal.removeEventListener('abort', onAbort);
              try { localController.abort(); } catch (_) {}
              resolve({ track: candidate.track, text: cleaned });
            } else {
              errors.push('空字幕');
            }
          })
          .catch((error) => {
            if (!done) errors.push(error.message);
          })
          .finally(() => {
            pending -= 1;
            if (!done && pending === 0) {
              done = true;
              if (signal) signal.removeEventListener('abort', onAbort);
              reject(new Error(errors.slice(0, 3).join('；') || '字幕下载失败。'));
            }
          });
      }
    });
  }

  async function fetchFirstCaptionText(videoId, tracks, signal) {
    const candidates = tracks.flatMap((track) => captionCandidateUrls(videoId, track));
    log('并行下载字幕候选：' + tracks.length + ' 条轨道，' + candidates.length + ' 个请求。');
    return await firstNonEmptyCaption(candidates, signal);
  }

  async function fetchCaptionText(videoId, track) {
    const result = await fetchFirstCaptionText(videoId, [track], app.captionAbortController ? app.captionAbortController.signal : undefined);
    return result.text;
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
    const lines = toSimplifiedChinese(text)
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
    return toSimplifiedChinese(deduped.join('\n')).trim();
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
      throw new Error('浏览器阻止媒体播放：' + error.message + '。请确认链接可访问，或降低浏览器自动播放限制。');
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
    const options = { task: 'transcribe', return_timestamps: false, condition_on_previous_text: false };
    options.language = 'chinese';
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
    return toSimplifiedChinese(String(text || '')
      .replace(/\s+([,.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim());
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
    const pipe = await ensureTranscriber(runId, 'zh');
    const text = await runAsrOnBlob(pipe, segment.blob, transcribeOptions('zh'));
    if (!app.firstSegmentLanguageDecisionDone) {
      app.firstSegmentLanguageDecisionDone = true;
      app.languageHint = 'zh';
      if (looksEnglish(text) && !looksChinese(text)) {
        log('首段仍以英文字符为主：当前视频可能不是中文，或音频质量/倍速影响了中文识别。结果仍会统一转为简体中文显示。', 'warn');
      } else if (looksChinese(text)) {
        log('首段检测到中文：后续分段继续强制中文原文识别并转简体。', 'success');
      }
    }
    return toSimplifiedChinese(text);
  }

  function renderTranscript() {
    const parts = Array.from(app.transcriptBySegment.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => String(entry[1] || '').trim())
      .filter(Boolean);
    app.transcriptText = toSimplifiedChinese(parts.join('\n'));
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
      inspectYouTubeWithoutPlayback(input, info.youtubeId);
      return info;
    }
    await inspectNative(input, info.kind);
    return info;
  }

  async function runOneClick() {
    if (app.awaitingTabCaptureConsent && app.currentKind === 'youtube' && app.awaitingTabCaptureYoutubeId) {
      try {
        updateOneClickButton('running');
        log('用户确认进入音频捕获模式：即将加载当前页面内的 YouTube 播放器，并请求标签页音频授权。', 'warn');
        await inspectYouTube(app.currentUrl, app.awaitingTabCaptureYoutubeId);
        setStatus('check-capture', '等待标签页音频授权', 'warn');
        await startTabCapture();
      } catch (error) {
        stopDisplayCaptureTracks();
        stopCaptureStreamTracks();
        pauseSourcePlayback();
        app.captureActive = false;
        app.captureStopping = false;
        setProgress('overall', 100, '失败', error.message);
        log('捕获模式失败：' + error.message, 'error');
        alert(error.message);
      } finally {
        app.awaitingTabCaptureConsent = false;
        app.awaitingTabCaptureYoutubeId = '';
        updateOneClickButton();
      }
      return;
    }
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
        app.awaitingTabCaptureConsent = true;
        app.awaitingTabCaptureYoutubeId = info.youtubeId;
        setStatus('check-capture', '未捕获：等待确认', 'warn');
        setStatus('check-play', '未播放', 'ok');
        setProgress('audio', 0, '未播放视频', '未找到可直取字幕。为了节省流量，subtitle-download 不会自动播放；再次点击主按钮才会加载播放器并请求标签页音频授权。');
        setProgress('overall', 100, '等待用户确认', '没有可直取字幕；不会自动播放视频。');
        log('未找到可直取字幕：已停止在零播放模式。再次点击主按钮才会进入播放/捕获模式。', 'warn');
        updateOneClickButton();
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
    if (app.awaitingTabCaptureConsent) {
      btn.textContent = '无字幕，确认播放并捕获音频';
      btn.className = 'btn btn-dark';
      return;
    }
    if (forcedState === 'running') {
      btn.textContent = '正在获取简体中文文本';
      btn.className = 'btn btn-primary';
      return;
    }
    if (app.segmentProcessing || app.segmentQueue.length) {
      btn.textContent = '正在转文字，点击可重新开始';
      btn.className = 'btn btn-primary';
      return;
    }
    if (app.transcriptText) {
      btn.textContent = '重新获取简体中文文本';
      btn.className = 'btn btn-green';
      return;
    }
    btn.textContent = '获取简体中文文本';
    btn.className = 'btn btn-green';
  }

  function wire() {
    $('one-click-btn')?.addEventListener('click', () => runOneClick());
    $('download-audio-btn')?.addEventListener('click', () => downloadAudio());
    $('download-txt-btn')?.addEventListener('click', () => downloadTxt());
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
    log('YouTube 默认只直取字幕，不加载播放器、不播放视频；结果统一显示简体中文。');
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
