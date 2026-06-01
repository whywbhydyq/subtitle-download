(function (window) {
  'use strict';

  function assertUrl(value) {
    try { return new URL(value, window.location.href).href; }
    catch (error) { throw new Error('M3U8链接格式无效'); }
  }

  function resolveUrl(uri, baseUrl) {
    return new URL(uri, baseUrl).href;
  }

  function parseAttributes(raw) {
    var attrs = {};
    String(raw || '').replace(/([A-Z0-9-]+)=(("[^"]+")|[^,]*)/gi, function (_, key, value) {
      attrs[key.toUpperCase()] = String(value || '').replace(/^"|"$/g, '');
      return '';
    });
    return attrs;
  }

  function ensurePlaylist(text) {
    if (!/^#EXTM3U/m.test(text || '')) throw new Error('目标内容不是有效的M3U8播放列表');
  }

  async function fetchText(url) {
    var response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取播放列表：HTTP ' + response.status);
    return await response.text();
  }

  async function fetchBinary(url) {
    var response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取视频分片：HTTP ' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  function pickVariant(variants, quality) {
    if (!variants.length) return null;
    var sorted = variants.slice().sort(function (a, b) { return a.bandwidth - b.bandwidth; });
    if (quality === 'low') return sorted[0];
    if (quality === 'high') return sorted[sorted.length - 1];
    return sorted[Math.floor((sorted.length - 1) / 2)] || sorted[0];
  }

  async function resolveMediaPlaylist(sourceUrl, quality) {
    var initialUrl = assertUrl(sourceUrl);
    var text = await fetchText(initialUrl);
    ensurePlaylist(text);

    if (!/#EXT-X-STREAM-INF/i.test(text)) {
      return { url: initialUrl, text: text, variant: null };
    }

    var lines = text.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    var variants = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) {
        var attrs = parseAttributes(lines[i].split(':').slice(1).join(':'));
        var j = i + 1;
        while (j < lines.length && lines[j].charAt(0) === '#') j++;
        if (lines[j]) {
          variants.push({
            url: resolveUrl(lines[j], initialUrl),
            bandwidth: parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
            resolution: attrs.RESOLUTION || ''
          });
        }
      }
    }

    var selected = pickVariant(variants, quality || 'medium');
    if (!selected) throw new Error('未找到可转换的视频清晰度');
    var mediaText = await fetchText(selected.url);
    ensurePlaylist(mediaText);
    return { url: selected.url, text: mediaText, variant: selected };
  }

  function parseMediaPlaylist(text, playlistUrl) {
    if (/#EXT-X-KEY:(?!.*METHOD=NONE)/i.test(text)) {
      throw new Error('此M3U8包含加密分片，浏览器端无法在本站解密转换');
    }
    if (/#EXT-X-BYTERANGE/i.test(text)) {
      throw new Error('此M3U8使用字节范围分片，当前浏览器端转换器暂不支持');
    }

    var lines = text.split(/\r?\n/).map(function (line) { return line.trim(); });
    var map = null;
    var segments = [];

    lines.forEach(function (line) {
      if (!line) return;
      if (line.indexOf('#EXT-X-MAP') === 0) {
        var attrs = parseAttributes(line.split(':').slice(1).join(':'));
        if (attrs.URI) map = resolveUrl(attrs.URI, playlistUrl);
        return;
      }
      if (line.charAt(0) !== '#') segments.push(resolveUrl(line, playlistUrl));
    });

    if (!segments.length) throw new Error('未找到可下载的视频分片');
    var fragmentedMp4 = Boolean(map) || segments.some(function (url) { return /\.(m4s|mp4|cmf[av])($|[?#])/i.test(url); });
    return { map: map, segments: segments, fragmentedMp4: fragmentedMp4 };
  }

  function transmuxTsSegment(bytes, state) {
    return new Promise(function (resolve, reject) {
      if (!window.muxjs || !window.muxjs.mp4 || !window.muxjs.mp4.Transmuxer) {
        reject(new Error('MP4转换库加载失败，请刷新页面后重试'));
        return;
      }

      var transmuxer = new window.muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
      var output = [];
      transmuxer.on('data', function (segment) {
        if (!state.hasInitSegment && segment.initSegment) {
          output.push(segment.initSegment);
          state.hasInitSegment = true;
        }
        if (segment.data) output.push(segment.data);
      });
      transmuxer.on('done', function () { resolve(output); });
      try {
        transmuxer.push(bytes);
        transmuxer.flush();
      } catch (error) {
        reject(error);
      }
    });
  }

  function safeFileName(name) {
    var base = String(name || '').trim() || ('m3u8-video-' + Date.now() + '.mp4');
    base = base.replace(/[\\/:*?"<>|]+/g, '-');
    if (!/\.mp4$/i.test(base)) base += '.mp4';
    return base;
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function convert(sourceUrl, options) {
    options = options || {};
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    onProgress(2, '正在读取M3U8清单...');

    var media = await resolveMediaPlaylist(sourceUrl, options.quality || 'medium');
    var parsed = parseMediaPlaylist(media.text, media.url);
    var total = parsed.segments.length;
    var parts = [];

    if (parsed.fragmentedMp4) {
      if (parsed.map) {
        onProgress(8, '正在读取MP4初始化分片...');
        parts.push(await fetchBinary(parsed.map));
      }
      for (var i = 0; i < parsed.segments.length; i++) {
        var fmp4Bytes = await fetchBinary(parsed.segments[i]);
        parts.push(fmp4Bytes);
        onProgress(10 + Math.round(((i + 1) / total) * 86), '正在合并MP4分片 ' + (i + 1) + '/' + total);
      }
    } else {
      var state = { hasInitSegment: false };
      for (var j = 0; j < parsed.segments.length; j++) {
        var tsBytes = await fetchBinary(parsed.segments[j]);
        var mp4Parts = await transmuxTsSegment(tsBytes, state);
        parts = parts.concat(mp4Parts);
        onProgress(10 + Math.round(((j + 1) / total) * 86), '正在转封装TS分片 ' + (j + 1) + '/' + total);
      }
    }

    var blob = new Blob(parts, { type: 'video/mp4' });
    if (!blob.size) throw new Error('转换结果为空，请检查源链接是否可访问');
    onProgress(100, 'MP4转换完成');
    return {
      blob: blob,
      filename: safeFileName(options.filename),
      segments: total,
      mediaUrl: media.url,
      variant: media.variant,
      mode: parsed.fragmentedMp4 ? 'fmp4-merge' : 'ts-transmux'
    };
  }

  window.M3U8Mp4Converter = {
    convert: convert,
    downloadBlob: downloadBlob,
    safeFileName: safeFileName
  };
})(window);
