/*
 * BPFlow — Offscreen 文档逻辑
 * 链路：background(chrome.tabCapture.getMediaStreamId) → 本文档 getUserMedia(tab)
 *       → <audio> 回放（保住用户听感）
 * 转写协议（由 background 解析 voice 配置后传入，本文档不再关心引擎选择逻辑）：
 *   HTTP 分片（openai / dashscope）：MediaRecorder 5 秒分片 → WAV 16k → POST 转写
 */
'use strict';

/* tabId -> { stream, audioEl, controller, playCtx, gen, stopped, controllers } */
const sessions = new Map();
/** 正在 getUserMedia、尚未建立会话的标签页；此期间收到停止请求需要作废本次启动 */
const startingTabs = new Set();

/* ============================== 链路日志 ============================== */

/** 统一格式化日志数据：字符串直出，对象 JSON 化，超长截断 */
function fmtLog(v) {
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch (e) { s = String(v); } }
  return s.length > 300 ? s.slice(0, 300) + '…(共' + s.length + '字符)' : s;
}

/**
 * 直播链路日志：打到 offscreen 自身 console，
 * 并经 background 转发到直播页 console —— 用户在直播页 F12 即可看到全链路日志。
 */
function log(tabId, step, data) {
  const line = '[LF-OFF] ' + step + (data === undefined ? '' : ' ' + fmtLog(data));
  console.log(line);
  try {
    chrome.runtime.sendMessage({ type: 'lf:off:log', tabId, line }, () => { void chrome.runtime.lastError; });
  } catch (e) { /* noop */ }
}

chrome.runtime.onMessage.addListener((msg, sender, resp) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'lf:off:start') {
    startCapture(msg).then((r) => { try { resp(r); } catch (e) { /* noop */ } });
    return true; // 异步响应
  }
  if (msg.type === 'lf:off:stop') {
    stopCapture(msg.tabId);
    try { resp({ ok: true }); } catch (e) { /* noop */ }
    return false;
  }
  return false;
});

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of cands) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* noop */ }
  }
  return '';
}

async function startCapture(msg) {
  const { tabId, streamId, voice } = msg;
  stopCapture(tabId); // 幂等：重复启动安全（同时作废上一次未完成的启动）
  startingTabs.add(tabId);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
      },
      video: false
    });
    if (!startingTabs.delete(tabId)) {
      // 启动过程中（getUserMedia 等待期间）用户已点停止：直接释放，别留下幽灵会话
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
      log(tabId, '启动过程中收到停止请求，已取消本次捕获');
      return { ok: false, error: '启动已取消' };
    }

    // tab 捕获会接管页面声音，必须回放还给用户。
    // 「同步延迟」开启时（playbackDelayMs>0），回放经 Web Audio DelayNode 延迟：
    // 声音被延迟设定时长后到达用户耳朵；字幕按「语音发生时刻 + 延迟」定时上屏（speechAt 链路）。
    // syncVideo 开启时，内容脚本另有视频延迟覆盖层，三者整体对齐。
    // 注意：ASR 采集不受影响（另接原始流实时采样）。
    const delaySec = Math.max(0, Math.min(30, ((voice && voice.playbackDelayMs) || 0) / 1000));
    let audioEl = null;
    let playCtx = null;
    if (delaySec > 0) {
      try {
        playCtx = new AudioContext();
        playCtx.resume().catch(() => { /* noop */ });
        await new Promise((r) => setTimeout(r, 800)); // 稍等自动播放策略落定再检查状态
        if (playCtx.state === 'running') {
          const src = playCtx.createMediaStreamSource(stream);
          const delayNode = playCtx.createDelay(32); // 最大延迟 32s（滑杆上限 30s）
          delayNode.delayTime.value = delaySec;
          src.connect(delayNode);
          delayNode.connect(playCtx.destination);
          log(tabId, (voice && voice.syncVideo ? '画面+声音+字幕整体延迟 ' : '声音延迟播放 ') + delaySec
            + 's 已生效（识别仍实时采集' + (voice && voice.syncVideo ? '，视频经覆盖层延迟重放' : '，字幕将随延迟后的语音同时出现') + '）');
        } else {
          try { playCtx.close(); } catch (e) { /* noop */ }
          playCtx = null;
        }
      } catch (e) {
        log(tabId, '音频延迟初始化失败：' + ((e && e.message) || String(e)));
        try { if (playCtx) playCtx.close(); } catch (e2) { /* noop */ }
        playCtx = null;
      }
    }
    if (!playCtx) {
      // 无延迟（或延迟不可用）：原 <audio> 直通回放
      audioEl = document.createElement('audio');
      audioEl.srcObject = stream;
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      audioEl.play().catch(() => { /* noop */ });
      if (delaySec > 0) {
        notice(tabId, 'info', '当前环境不支持声音延迟（AudioContext 不可用），声音与字幕保持原有偏移');
      }
    }

    // 流意外结束（标签页跳转/关闭）时自动清理并通知
    stream.getAudioTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        stopCapture(tabId);
        try { chrome.runtime.sendMessage({ type: 'lf:off:stopped', tabId }); } catch (e) { /* noop */ }
      });
    });

    const tracks = stream.getAudioTracks();
    notice(tabId, 'info', '已捕获本页音频（' + tracks.length + ' 条音轨）');

    let controller;
    if (voice.protocol === 'paraformer-async') {
      // 防御：该协议只接受公网音频 URL，background 启动前已拦截；此处兜底避免误走分片链路
      throw new Error('模型 ' + voice.model + ' 为百炼录音文件转写（异步）接口，只接受公网可访问的音频 URL，'
        + '无法用于浏览器端实时转写，请在设置中改用 fun-asr-flash-2026-06-15');
    }
    // HTTP 分片协议：录音 + 转码为 WAV(16kHz 单声道)，再送转写
    log(tabId, '音频捕获成功（音轨 ' + tracks.length + ' 条），开始滚动录音');
    const session = {
      stream,
      audioEl,
      playCtx,
      controller: null,
      gen: msg.gen || '',
      stopped: false,
      controllers: new Set() // 在途转写请求的控制器：停止时统一 abort
    };
    controller = createWavRecorder(stream, tabId, voice, session);
    session.controller = controller;
    sessions.set(tabId, session);
    return { ok: true };
  } catch (e) {
    startingTabs.delete(tabId);
    log(tabId, '音频捕获失败：' + ((e && e.message) || String(e)));
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

/** 同时在处理的分片数上限（解码 + 转写；不设上限会让延迟与额度一起失控） */
const PIPE_MAX_INFLIGHT = 2;
/** 待处理队列上限（4 片 ≈ 20 秒）；超出丢弃最旧，避免字幕延迟无限累积 */
const PIPE_MAX_QUEUE = 4;

/**
 * 有序交付管道：分片可以乱序完成，但只能按 seq 顺序交付。
 * 空文本（静音/失败/被丢弃）也占位释放闸门，否则后面所有片会一直等。
 * @param {(text: string, at: number) => void} onDeliver
 */
function createOrderedPipe(onDeliver) {
  let deliverSeq = 1;          // 下一个可交付的序号
  const outbox = new Map();    // seq -> { text, at }

  function flush() {
    while (outbox.has(deliverSeq)) {
      const it = outbox.get(deliverSeq);
      outbox.delete(deliverSeq);
      deliverSeq++;
      if (it.text) {
        try { onDeliver(it.text, it.at); } catch (e) { /* noop */ }
      }
    }
  }

  return {
    settle(seq, text, at) {
      outbox.set(seq, { text: text || '', at: Number(at) || 0 });
      flush();
    },
    reset() { outbox.clear(); deliverSeq = 1; },
    /** 已就绪但还在等前面分片的条数（调试钩子） */
    waiting() { return outbox.size; }
  };
}

/**
 * 滚动录音 + 转码：MediaRecorder 每片约 5 秒录成 webm，再解码重采样为 WAV(16kHz 单声道)。
 *
 * 为什么不直接用 AudioContext 采 PCM：offscreen 文档没有用户激活，
 * AudioContext 会停在 suspended 状态，ScriptProcessor 回调永不触发（也就没机会 resume）
 * → 一个采样都拿不到。而 decodeAudioData / OfflineAudioContext 是纯计算 API，
 * 不受自动播放策略影响，稳定可用。
 *
 * 不用 recorder.start(timeslice)：timeslice 分片除首片外缺少容器头，无法独立解码；
 * 每片独立 stop 出来的 blob 才是完整可解码的 webm。
 */
function createWavRecorder(stream, tabId, voice, session) {
  const S = session || { stopped: false, controllers: new Set(), gen: '' };
  const mime = pickMime();
  let rec = null;
  let firstDone = false;

  /**
   * 有序流水线。
   * 背景：每片录完就去转写，网络快慢不同 → 后录的片可能先返回；直接按完成顺序上屏
   * 会让字幕乱序，慢服务下还会多片并发烧额度。这里做三件事：
   *   1) 并发上限 PIPE_MAX_INFLIGHT（背压）
   *   2) 队列积压超过 PIPE_MAX_QUEUE 时丢弃最旧（延迟优先于完整）
   *   3) 结果按 seq 顺序交付（createOrderedPipe）
   */
  const pipe = createOrderedPipe((text, at) => deliver(text, at));
  const inflight = { n: 0 };
  const queue = [];
  let enqueueSeq = 0; // 已入队的最大序号

  function deliver(text, at) {
    if (!text || S.stopped) return;
    log(tabId, '转写文本已发送给后台翻译');
    try {
      chrome.runtime.sendMessage({ type: 'lf:asrResult', tabId, text, speechAt: at, gen: S.gen || '' },
        () => { void chrome.runtime.lastError; });
    } catch (e) { /* noop */ }
  }

  /** 一片有了结论（无论有无文本）：登记结果并尝试按序交付 */
  function settle(seq, text, at) {
    if (S.stopped) return;
    pipe.settle(seq, text, at);
  }

  /** 处理一片：转码 → VAD → 转写，返回文本（空串表示无内容/失败，仍要占位保序） */
  async function processChunk(item) {
    const n = item.seq;
    if (S.stopped) return '';
    log(tabId, '片#' + n + ' 开始处理：webm ' + item.blob.size + 'B');
    const wav = await toWav16k(item.blob, tabId);
    if (S.stopped) {
      log(tabId, '片#' + n + ' 转码期间已停止，丢弃');
      return '';
    }
    if (!wav) {
      log(tabId, '片#' + n + ' 判定为静音或无语音，跳过转写');
      // 静音/无语音片：首片时提示一次，之后保持安静，避免刷屏
      if (!firstDone) {
        firstDone = true;
        notice(tabId, 'info', '已捕获音频流，但这段是静音或无语音（可能是音乐/音效，请确认页面正在说话）');
      }
      return '';
    }
    log(tabId, '片#' + n + ' 转码 WAV ' + wav.size + 'B（约' + Math.round((wav.size - 44) / 32000) + 's），送转写');
    if (!firstDone) {
      firstDone = true;
      notice(tabId, 'info', '音频就绪（' + Math.round(wav.size / 1024) + 'KB / 片），正在转写…');
    }
    const text = await transcribe(wav, tabId, voice, S);
    return text || '';
  }

  /** 取队列里的片去处理，直到并发打满 */
  function pump() {
    if (S.stopped) return;
    while (inflight.n < PIPE_MAX_INFLIGHT && queue.length) {
      const item = queue.shift();
      inflight.n++;
      processChunk(item)
        .then((text) => settle(item.seq, text, item.beganAt))
        .catch((e) => {
          log(tabId, '片#' + item.seq + ' 处理异常：' + ((e && e.message) || String(e)));
          settle(item.seq, '', item.beganAt);
        })
        .finally(() => { inflight.n--; pump(); });
    }
  }

  /** 入队（录制顺序即序号顺序） */
  function enqueue(blob, beganAt) {
    if (S.stopped) return;
    const item = { seq: ++enqueueSeq, blob, beganAt };
    queue.push(item);
    while (queue.length > PIPE_MAX_QUEUE) {
      const dropped = queue.shift();
      log(tabId, '处理排队积压，丢弃片#' + dropped.seq + '（避免字幕延迟持续增长）');
      settle(dropped.seq, '', dropped.beganAt); // 占位释放顺序闸门
    }
    pump();
  }

  function begin() {
    if (S.stopped) return;
    const beganAt = Date.now(); // 本片录音起点（字幕对齐用）
    try {
      rec = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 })
        : new MediaRecorder(stream);
    } catch (e) { return; }

    const parts = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      if (parts.length) enqueue(new Blob(parts, { type: mime || 'audio/webm' }), beganAt);
      if (!S.stopped) setTimeout(begin, 120); // 片间极小间隙
    };
    rec.start();
    setTimeout(() => {
      try { if (rec.state === 'recording') rec.stop(); } catch (e) { /* noop */ }
    }, 5000);
  }

  begin();

  return {
    stop() {
      S.stopped = true;
      queue.length = 0;
      pipe.reset();
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* noop */ }
    }
  };
}

/* ============================== 音频解码 / WAV 编码 ============================== */

/* ---------- 本地语音活动检测（VAD）参数 ---------- */
const VAD_FRAME_RMS_GATE = 0.01;  // 帧能量门限（RMS）：低于此值视为无声帧
const VAD_PEAK_GATE = 0.45;       // 自相关峰值门限：超过此值认为信号有周期性（浊音帧）
const VAD_MIN_ACTIVE = 6;         // 最少有声帧数（50ms/帧，6 帧≈0.3s）：低于视为无语音
const VAD_VOICED_RATIO = 0.12;    // 人声基频帧占有效帧比例下限：达到即判定含语音（保守，宁可放行）

/**
 * 本地语音活动检测（VAD）：判断 PCM 片段是否含人声。
 * 在送转写前过滤无语音片段（宽带噪声 / 音效 / 轰鸣等），省额度与延迟。
 *
 * 判定逻辑：50ms 分帧 → 帧能量筛出有声帧 → 对有声帧做归一化自相关，
 * 从小 lag 向大 lag 取第一个显著峰作为基频（周期），基频落在人声范围
 * （70~300Hz）的帧为浊音帧，占比 ≥ VAD_VOICED_RATIO 即含语音。
 *
 * 为什么取「第一个显著峰」而非只在人声范围搜峰/取全局最高峰：纯音在整数倍
 * 周期处相关值同样为 1——只在人声范围搜索会把 440Hz 音效读成 220Hz（倍周期
 * 伪基频）；取全局最高峰则会被次谐波峰欺骗（280Hz 在 7 倍周期 lag 处 r=1.0，
 * 频率误判为 1/7）。第一个显著峰即信号最小周期，是经典 pitch 检测的做法。
 *
 * 策略保守（宁可放行）：只有高置信「无人声特征」才判 false；
 * 旋律音乐等难判定内容仍上传，由服务端 ASR_RESPONSE_HAVE_NO_WORDS 兜底跳过——避免误杀正常说话。
 *
 * 能过滤的典型内容：白噪声/风声/电流声（无周期性）、枪声碰撞等高频音效（基频>300Hz）、
 * 鼓点爆炸等低频轰鸣（基频<70Hz）；静音已由整片 RMS 阈值先行过滤。
 *
 * @param {Float32Array} pcm 单声道 PCM
 * @param {number} sr 采样率
 * @returns {boolean} true=判定含语音（放行转写）
 */
function hasSpeech(pcm, sr) {
  const frameLen = Math.round(sr * 0.05); // 50ms/帧
  const lagLo = Math.round(sr / 1000);    // 搜索下界：1000Hz → 最小 lag
  const lagHi = Math.round(sr / 40);      // 搜索上界：40Hz → 最大 lag（覆盖轰鸣排除）
  const voiceLo = Math.round(sr / 300);   // 人声基频上限 300Hz 对应 lag
  const voiceHi = Math.round(sr / 70);    // 人声基频下限 70Hz 对应 lag
  const winLen = frameLen - lagHi;        // 自相关窗长（保证 n+lag 不越界，≥1.3 个人声基频周期）

  let active = 0;  // 有声帧计数
  let voiced = 0;  // 人声基频帧计数

  for (let i = 0; i + frameLen <= pcm.length; i += frameLen) {
    const frame = pcm.subarray(i, i + frameLen);

    // ---- 帧能量（RMS）：低于门限视为无声帧，跳过 ----
    let energy = 0;
    for (let n = 0; n < frameLen; n++) energy += frame[n] * frame[n];
    if (Math.sqrt(energy / frameLen) < VAD_FRAME_RMS_GATE) continue;
    active++;

    // ---- 归一化自相关找基频 ----
    // r(lag) = Σ x[n]·x[n+lag] / sqrt(Σx[n]² · Σx[n+lag]²)，值域 [-1,1]；
    // 周期信号在 lag=周期整数倍处接近 1，噪声各 lag 均接近 0。
    // 平方和用前缀和 O(1) 查询，避免每个 lag 重算（5 秒音频全帧约 15M 次乘加，<100ms）。
    const psq = new Float64Array(frameLen + 1); // psq[k] = Σ_{n<k} frame[n]²
    for (let n = 0; n < frameLen; n++) psq[n + 1] = psq[n] + frame[n] * frame[n];
    const e0 = psq[winLen]; // 相关窗 [0, winLen) 的能量

    // 先算整条 r(lag) 曲线（lag 数量 ≤ 400，开销可忽略）
    const r = new Float64Array(lagHi + 2);
    for (let lag = lagLo; lag <= lagHi; lag++) {
      let num = 0;
      for (let n = 0; n < winLen; n++) num += frame[n] * frame[n + lag];
      const eL = psq[winLen + lag] - psq[lag]; // 相关窗平移 lag 后的能量
      const denom = Math.sqrt(e0 * eL);
      r[lag] = denom > 0 ? num / denom : 0;
    }

    // ---- 峰判定：全局最高局部极大峰 + 谐波核查 ----
    // 收集超门限的局部极大峰（升序）。两类陷阱都需处理：
    //   a) 次谐波峰：纯音在整数倍周期处 r 同样≈1（如 280Hz 在 7 倍周期 lag 处
    //      r=1.0 反超基频峰）→ 若最高峰之前存在 ≥85% 峰值的强峰，说明最高峰是
    //      次谐波，取更小 lag 的强峰为基频；
    //   b) 低频尾巴：缓变信号在低 lag 处 r 接近 1（如 90Hz 在 lag=16 处 r≈0.998），
    //      但那是单调下降沿、非局部极大 → 只认「局部极大」峰即可排除。
    const peaks = []; // [{lag, r}] 升序
    for (let lag = lagLo + 1; lag < lagHi; lag++) {
      if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > VAD_PEAK_GATE) {
        peaks.push({ lag, r: r[lag] });
      }
    }
    if (peaks.length) {
      // 全局最高峰（严格大于遍历 → 并列时取最小 lag，即基频优先）
      let pG = peaks[0];
      for (const p of peaks) if (p.r > pG.r) pG = p;
      // 谐波核查：最高峰之前若存在足够强的峰 → 该峰才是基频（周期更短）
      let pH = null;
      for (const p of peaks) {
        if (p.lag < pG.lag && p.r > 0.85 * pG.r) { pH = p; break; }
      }
      const f0Lag = (pH || pG).lag;
      // 基频落在人声范围 → 浊音帧
      if (f0Lag >= voiceLo && f0Lag <= voiceHi) voiced++;
    }
  }

  // 有声帧太少（近静音）或人声基频帧占比过低 → 无语音
  return active >= VAD_MIN_ACTIVE && voiced / active >= VAD_VOICED_RATIO;
}

/**
 * webm/opus → WAV(16kHz 单声道)。
 * 整片接近静音或无人声特征时返回 null，调用方直接跳过，避免把无声片段送进 ASR 白烧额度。
 */
async function toWav16k(blob, tabId) {
  const decoded = await decodeAudio(blob);
  const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
  const oc = new OfflineAudioContext(1, frames, 16000); // 单声道 + 16k：下混与重采样一次完成
  const src = oc.createBufferSource();
  src.buffer = decoded;
  src.connect(oc.destination);
  src.start(0);
  const pcm = (await oc.startRendering()).getChannelData(0);

  const rms = rmsOf(pcm);
  if (rms < 0.005) {
    log(tabId, '  解码 OK：' + decoded.duration.toFixed(1) + 's，响度 RMS=' + rms.toFixed(4)
      + '（低于静音阈值 0.005），本地跳过');
    return null;
  }
  // 本地 VAD：有声但无人声特征（噪声/音效等）同样跳过，不发转写请求
  if (!hasSpeech(pcm, 16000)) {
    log(tabId, '  解码 OK：' + decoded.duration.toFixed(1) + 's，响度 RMS=' + rms.toFixed(4)
      + '，无人声特征（本地 VAD 判定），跳过');
    return null;
  }
  log(tabId, '  解码 OK：' + decoded.duration.toFixed(1) + 's，响度 RMS=' + rms.toFixed(4));
  return encodeWav(pcm, 16000);
}

async function decodeAudio(blob) {
  const arr = await blob.arrayBuffer();
  // 用 OfflineAudioContext 解码：只做计算不播放，不受自动播放策略限制
  const probe = new OfflineAudioContext(1, 1, 16000);
  try {
    return await probe.decodeAudioData(arr);
  } catch (e) {
    throw new Error('音频解码失败（' + ((e && e.message) || '不支持该编码') + '）');
  }
}

/** RMS 能量（抽样计算加速）：整片低于 0.005 视为静音，不送识别 */
function rmsOf(pcm) {
  if (!pcm.length) return 0;
  const step = Math.max(1, Math.floor(pcm.length / 4000)); // 抽样加速
  let sum = 0, n = 0;
  for (let i = 0; i < pcm.length; i += step) { sum += pcm[i] * pcm[i]; n++; }
  return Math.sqrt(sum / n);
}

/** Float32 PCM(-1~1) → 16bit 单声道 WAV Blob */
function encodeWav(samples, sampleRate) {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);      // fmt chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true);       // blockAlign
  view.setUint16(34, 16, true);      // bitsPerSample
  str(36, 'data');
  view.setUint32(40, bytes, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(new Error('音频 Base64 编码失败'));
    fr.readAsDataURL(blob);
  });
}

/** zh-CN -> zh，en-US -> en（各家 ASR 语言参数要 ISO-639-1 短码） */
function normalizeLang(lang) {
  return String(lang || '').split(/[-_]/)[0].toLowerCase();
}

/**
 * 单片转写：按协议分发
 *  - openai    : POST {base}/audio/transcriptions（multipart 上传音频文件）
 *  - dashscope : POST {base}/services/aigc/multimodal-generation/generation（JSON + Base64）
 */
/** 转写状态回传：让页面能把「为什么没字幕」显示出来，而不是静默失败 */
function notice(tabId, level, text) {
  try {
    chrome.runtime.sendMessage({ type: 'lf:off:notice', tabId, level, text },
      () => { void chrome.runtime.lastError; });
  } catch (e) { /* noop */ }
}

const failState = {}; // tabId -> { fails, lastAt }

function reportFailure(tabId, err) {
  const st = failState[tabId] || (failState[tabId] = { fails: 0, lastAt: 0 });
  st.fails++;
  const now = Date.now();
  // 第一次必报，之后 30 秒内最多报一次，避免刷屏
  if (st.fails === 1 || now - st.lastAt > 30000) {
    st.lastAt = now;
    notice(tabId, 'error', String(err && err.message ? err.message : err));
  }
}

/**
 * 单片转写：按协议分发
 *  - openai    : POST {base}/audio/transcriptions（multipart 上传音频文件）
 *  - dashscope : POST {base}/services/aigc/multimodal-generation/generation（JSON + Base64）
 * @param {number} speechAt 该片音频的起始墙钟时间（毫秒）——随消息传递，供字幕按「语音时刻+延迟」定时上屏
 */
/**
 * 单片转写：按协议分发
 *  - openai    : POST {base}/audio/transcriptions（multipart 上传音频文件）
 *  - dashscope : POST {base}/services/aigc/multimodal-generation/generation（JSON + Base64）
 * 只负责拿到文本并返回；何时上屏由调用方的有序流水线决定（见 createWavRecorder）。
 * @returns {Promise<string>} 转写文本，空串表示无内容/失败/已停止
 */
async function transcribe(blob, tabId, voice, session) {
  const v = voice || {};
  const base = String(v.baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  if (session && session.stopped) {
    log(tabId, '会话已停止，放弃本次转写');
    return '';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  // 控制器纳入会话集合：stopCapture 时统一 abort，避免停止后还有请求在跑
  if (session && session.controllers) session.controllers.add(ctrl);
  let text = '';
  const endpoint = (v.protocol === 'dashscope')
    ? base + '/services/aigc/multimodal-generation/generation'
    : base + '/audio/transcriptions';
  log(tabId, '转写请求 → ' + endpoint + '（model=' + (v.model || '(默认)')
    + '，音频 ' + blob.size + 'B，apiKey=' + (v.apiKey ? '***' + String(v.apiKey).slice(-4) : '无') + '）');
  try {
    text = (v.protocol === 'dashscope')
      ? await transcribeDashScope(blob, tabId, v, base, ctrl.signal)
      : await transcribeOpenAI(blob, v, base, ctrl.signal);
    if (failState[tabId]) failState[tabId].fails = 0; // 成功即清零
    log(tabId, '转写成功，返回：' + JSON.stringify(text));
  } catch (e) {
    // 可跳过的失败（无有效语音 / 网关空错误体拒发）：直接跳过，不算转写失败，不占用失败计数
    if (e && e.skip) {
      log(tabId, '转写跳过：' + ((e && e.message) || ''));
      return '';
    }
    if (e && (e.name === 'AbortError' || /aborted|abort/i.test(String(e.message || '')))) {
      // 只有「会话已停止」才静默；否则这里的 abort 只能来自 30 秒超时，
      // 必须上报，不然用户只看到字幕不再更新，完全不知道服务已经超时。
      if (session && session.stopped) {
        log(tabId, '转写已中止（直播已停止）');
        return '';
      }
      log(tabId, '转写超时（30 秒无响应），已中止本次请求');
      reportFailure(tabId, new Error('转写请求超时（30 秒无响应），请检查网络或转写服务状态'));
      return '';
    }
    log(tabId, '转写失败：' + ((e && e.message) || String(e)));
    reportFailure(tabId, e);
    return ''; // 单片失败不影响后续分片（但这一片仍要占位，保证后续片不被卡住）
  } finally {
    clearTimeout(timer);
    if (session && session.controllers) session.controllers.delete(ctrl);
  }

  // 停止后才返回的结果一律丢弃
  if (session && session.stopped) {
    log(tabId, '转写返回时会话已停止，丢弃结果');
    return '';
  }
  if (!text) log(tabId, '转写返回空文本（该片段可能无语音内容）');
  return text || '';
}

/** HTTP 非 2xx：把服务端返回的报错摘要带上，便于定位（模型名/字段/鉴权等） */
async function httpError(res) {
  let detail = '';
  try {
    const t = await res.text();
    detail = String(t || '').replace(/\s+/g, ' ').slice(0, 200);
  } catch (e) { /* noop */ }
  return new Error('HTTP ' + res.status + (detail ? ' · ' + detail : ''));
}

/** OpenAI 兼容：multipart/form-data */
async function transcribeOpenAI(blob, v, base, signal) {
  const fd = new FormData();
  fd.append('file', blob, 'chunk.wav');
  fd.append('model', v.model || 'whisper-1');
  fd.append('response_format', 'json');
  if (v.lang && v.lang !== 'auto') fd.append('language', normalizeLang(v.lang));

  const res = await fetch(base + '/audio/transcriptions', {
    method: 'POST',
    headers: v.apiKey ? { Authorization: 'Bearer ' + v.apiKey } : {},
    body: fd,
    signal
  });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  return String((data && data.text) || '').trim();
}

/**
 * 阿里云百炼 DashScope（multimodal-generation）：JSON + Base64。
 * 兼容两代模型（同一端点）：
 *   - 新一代（fun-asr-flash 系）：
 *       语言参数用 language_hints 数组；响应为 output.text / output.sentence.text
 *   - 旧（qwen3-asr 系）：语言参数用 asr_options.language；响应为 output.choices[0].message.content
 * Data URI 必须带 MIME 类型（data:audio/wav;base64,），缺失时服务端可能无法识别音频 → 返回空文本。
 * 错误分类（实测，两类均直接跳过、不上报错误）：
 *   - HTTP 400 + {"code":"CLIENT_ERROR","message":"ASR_RESPONSE_HAVE_NO_WORDS"}：
 *       该片段无有效语音（纯音乐/环境噪声等）；
 *   - HTTP 400 + 空错误体 {}：请求被网关直接拒绝（典型为「自定义接口地址」指向
 *     业务空间专属端点，仅服务空间内部署的模型，不支持 ASR）。
 */
async function transcribeDashScope(blob, tabId, v, base, signal) {
  // MIME 前缀按文档要求补全：data:audio/wav;base64,<data>
  const dataUrl = 'data:audio/wav;base64,' + (await blobToBase64(blob));
  const content = (v.audioField === 'input_audio')
    ? [{ type: 'input_audio', input_audio: { data: dataUrl } }]   // fun-asr / qwen3-asr 系
    : [{ audio: dataUrl }];                                        // Qwen-Audio 多模态原生风格（旧）

  // 按模型代次选择语言参数风格
  const lang = (v.lang && v.lang !== 'auto') ? normalizeLang(v.lang) : '';
  const isNewGen = /^fun-asr/i.test(v.model || '');
  const params = { format: 'wav', sample_rate: '16000' };
  if (isNewGen) {
    if (lang) params.language_hints = [lang]; // 新一代模型：language_hints 数组（fun-asr 仅取第一个）
  } else {
    params.asr_options = Object.assign({ enable_itn: false }, lang ? { language: lang } : {});
  }

  const body = {
    model: v.model || 'fun-asr-flash-2026-06-15',
    input: { messages: [{ role: 'user', content }] },
    parameters: params
  };

  const headers = { 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' };
  if (v.apiKey) headers.Authorization = 'Bearer ' + v.apiKey;

  const res = await fetch(base + '/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw await dashscopeError(res);
  const data = await res.json();
  const text = extractDashScopeText(data);
  if (!text) {
    // 空文本：输出原始响应片段，便于区分「确实静音」与「响应结构/格式问题」
    log(tabId, '转写返回空文本，原始响应：'
      + String(JSON.stringify(data)).replace(/\s+/g, ' ').slice(0, 300));
  }
  return text;
}

/**
 * DashScope 错误响应分类（替代通用 httpError）：
 * 两类已知形态打上 .skip 标记，由调用方直接跳过（不上报错误、不占用失败计数）：
 *   - 无有效语音（音乐/掌声/环境噪声片段）
 *   - HTTP 400 + 空错误体（网关直接拒绝，如业务空间专属端点未部署该转写模型）
 * @returns {Promise<Error>} 带 .skip 标记（跳过）或普通错误
 */
async function dashscopeError(res) {
  let raw = '';
  try { raw = await res.text(); } catch (e) { /* noop */ }
  let body = null;
  try { body = JSON.parse(raw); } catch (e) { /* 非 JSON 错误体 */ }
  const code = (body && body.code) || '';
  const message = (body && body.message) || '';

  // 无有效语音：与静音同等对待，直接跳过
  if (code === 'CLIENT_ERROR' && /ASR_RESPONSE_HAVE_NO_WORDS/i.test(message)) {
    const err = new Error('该片段无有效语音');
    err.skip = true;
    return err;
  }
  // 400 + 空错误体：网关直接拒绝（实测业务空间专属端点对未部署的转写模型返回 400 {}），直接跳过
  if (res.status === 400 && !code && !message) {
    const err = new Error('HTTP 400（服务端未返回错误详情）');
    err.skip = true;
    return err;
  }
  return new Error('HTTP ' + res.status + (raw ? ' · ' + raw.replace(/\s+/g, ' ').slice(0, 200) : ''));
}

/**
 * 解析百炼 ASR 响应文本，兼容两代格式：
 *   - 新一代：output.text / output.sentence.text（fun-asr-flash 系）
 *   - 旧：output.choices[0].message.content（qwen3-asr 系）
 */
function extractDashScopeText(data) {
  const out = data && data.output;
  if (!out) return '';
  // 新一代：文本在 output.text 或 output.sentence.text
  const t = (typeof out.text === 'string' && out.text.trim())
    || (out.sentence && typeof out.sentence.text === 'string' && out.sentence.text.trim());
  if (t) return t.trim();
  // 旧：文本在 output.choices[0].message.content
  const ch = out.choices && out.choices[0];
  if (!ch) return '';
  const msg = ch.message || {};
  const c0 = Array.isArray(msg.content) ? msg.content[0] : msg.content;
  if (!c0) return '';
  if (typeof c0 === 'string') return c0.trim();
  return String(c0.text || '').trim();
}

function stopCapture(tabId) {
  startingTabs.delete(tabId); // 作废「启动中」的捕获（getUserMedia 返回后自行释放）
  const s = sessions.get(tabId);
  if (!s) return;
  log(tabId, '停止音频捕获，清理会话（中止在途转写 ' + (s.controllers ? s.controllers.size : 0) + ' 个）');
  sessions.delete(tabId);
  s.stopped = true;
  // 先中止在途请求：否则停止后转写仍会返回，后台继续翻译并推字幕
  if (s.controllers) {
    s.controllers.forEach((c) => { try { c.abort(); } catch (e) { /* noop */ } });
    s.controllers.clear();
  }
  try { s.controller.stop(); } catch (e) { /* noop */ }
  try { if (s.playCtx) s.playCtx.close(); } catch (e) { /* noop */ } // 关闭延迟回放上下文
  try { s.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
  if (s.audioEl) {
    try { s.audioEl.pause(); s.audioEl.remove(); } catch (e) { /* noop */ }
  }
}
