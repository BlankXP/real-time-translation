/* 设置校验 / 密钥分层 / 接口地址 —— 纯逻辑回归 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadShared } = require('./helpers');

loadShared('shared/langs.js');
loadShared('shared/defaults.js');

const D = globalThis.LF_DEFAULTS;
const clone = (v) => JSON.parse(JSON.stringify(v));

test('默认设置零修正', () => {
  const r = LF_VALIDATE_SETTINGS(clone(D));
  assert.deepStrictEqual(r.fixes, []);
  assert.strictEqual(r.settings.advanced.maxCache, 800);
});

test('maxCache 脏值被夹到安全区间（曾导致 SW 死循环）', () => {
  const cases = [
    [-1, 50],
    [0, 50],
    ['999999', 5000],
    [null, 800]
  ];
  for (const [input, expect] of cases) {
    const r = LF_VALIDATE_SETTINGS({ advanced: { maxCache: input } });
    assert.strictEqual(r.settings.advanced.maxCache, expect, 'input=' + JSON.stringify(input));
    assert.ok(r.fixes.length > 0, '应记录修正项：' + JSON.stringify(input));
  }
});

test('其余数值越界被夹住', () => {
  const s = LF_VALIDATE_SETTINGS({
    advanced: { maxUnits: -5, concurrency: 999, minTextLength: 0 },
    voice: { playbackDelayMs: 999999, videoDelayTrimMs: -99999 },
    style: { fontSize: 1000 }
  }).settings;
  assert.strictEqual(s.advanced.maxUnits, 50);
  assert.strictEqual(s.advanced.concurrency, 8);
  assert.strictEqual(s.advanced.minTextLength, 1);
  assert.strictEqual(s.voice.playbackDelayMs, 30000);
  assert.strictEqual(s.voice.videoDelayTrimMs, -3000);
  assert.strictEqual(s.style.fontSize, 200);
});

test('providers 清洗：类型白名单 / id 去重 / plan 归一', () => {
  const s = LF_VALIDATE_SETTINGS({
    providers: [
      { id: 'a', type: 'openai', name: 'A', baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
      { id: 'a', type: 'deepl', name: 'dup', apiKey: 'k2', plan: 'weird' },
      { id: 'b', type: 'not-an-engine', name: 'bad' },
      null,
      'string'
    ],
    activeProviderId: 'nope'
  }).settings;
  assert.strictEqual(s.providers.length, 2);
  assert.notStrictEqual(s.providers[1].id, 'a');
  assert.strictEqual(s.providers[1].plan, 'free');
  assert.ok(s.providers.some((p) => p.id === s.activeProviderId));
});

test('providers 全空时恢复默认引擎列表', () => {
  const s = LF_VALIDATE_SETTINGS({ providers: [] }).settings;
  assert.strictEqual(s.providers.length, D.providers.length);
});

test('枚举 / 数组 / 站点规则被规范化', () => {
  const s = LF_VALIDATE_SETTINGS({
    displayMode: 'weird',
    targetLang: 'klingon',
    sourceLang: 123,
    quickLangs: ['auto', 'en', 'en', 42, 'ja'],
    customLangs: [{ code: 'km', name: '高棉语' }, { code: 'BAD CODE!' }],
    blacklist: ['a.com', '', 7],
    siteRules: { 'ok.com': { auto: 1 }, 'bad.com': 'nope' }
  }).settings;
  assert.strictEqual(s.displayMode, 'bilingual');
  assert.strictEqual(s.targetLang, 'zh-CN');
  assert.strictEqual(s.sourceLang, 'auto');
  assert.deepStrictEqual(s.quickLangs, ['en', 'ja']);
  assert.deepStrictEqual(s.customLangs.map((l) => l.code), ['km']);
  assert.deepStrictEqual(s.blacklist, ['a.com']);
  assert.deepStrictEqual(Object.keys(s.siteRules), ['ok.com']);
});

test('旧版 voice 结构仍能迁移', () => {
  const v = LF_VALIDATE_SETTINGS({
    voice: { protocol: 'openai', baseUrl: 'http://localhost:9000/v1', model: 'whisper-1', apiKey: 'k' }
  }).settings.voice;
  assert.strictEqual(v.engine, 'openai');
  assert.strictEqual(v.openai.baseUrl, 'http://localhost:9000/v1');
  assert.strictEqual(v.protocol, undefined);
});

test('密钥拆分：公开设置里不留 apiKey', () => {
  const full = {
    providers: [
      { id: 'a', type: 'openai', name: 'A', apiKey: 'sk-aaa' },
      { id: 'b', type: 'bing-free', name: 'B' }
    ],
    voice: { engine: 'bailian', bailian: { apiKey: 'bk' }, openai: { apiKey: 'ok' } }
  };
  const sp = LF_SPLIT_SECRETS(full);
  assert.ok(!JSON.stringify(sp.pub).includes('apiKey'));
  assert.strictEqual(sp.hadKeys, true);
  assert.strictEqual(sp.secrets.providers.a, 'sk-aaa');
  assert.strictEqual(sp.secrets.voice.bailian, 'bk');
  assert.strictEqual(sp.secrets.voice.openai, 'ok');
  assert.strictEqual(full.providers[0].apiKey, 'sk-aaa', '不应修改入参');
});

test('密钥回填与合并', () => {
  const pub = { providers: [{ id: 'a', type: 'openai' }], voice: { bailian: {}, openai: {} } };
  const back = LF_APPLY_SECRETS(pub, { providers: { a: 'k' }, voice: { bailian: 'bk' } });
  assert.strictEqual(back.providers[0].apiKey, 'k');
  assert.strictEqual(back.voice.bailian.apiKey, 'bk');

  const merged = LF_MERGE_SECRETS({ providers: { a: 'old', x: 'keep' } }, { providers: { a: 'new' } });
  assert.strictEqual(merged.providers.a, 'new');
  assert.strictEqual(merged.providers.x, 'keep');
  assert.strictEqual(LF_MERGE_SECRETS({ providers: { a: 'v' } }, { providers: { a: '' } }).providers.a, 'v');
});

test('接口地址：远程必须 https，本机可 http', () => {
  assert.strictEqual(LF_VALIDATE_ENDPOINT('https://api.deepseek.com/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://localhost:11434/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://127.0.0.1:9000/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://192.168.1.9:8080/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://api.example.com/v1').ok, false);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('api.example.com/v1').ok, false);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('ftp://x.com/v1').ok, false);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('https://a.com/v1/').url, 'https://a.com/v1');
});

test('接口地址：只有真正的内网 IP 才放行 http（域名伪装必须拒绝）', () => {
  // 形如 10.xxx / 192.168.xxx / 172.16.xxx 的域名不是内网地址
  ['http://10.attacker.example/v1',
    'http://192.168.attacker.example/v1',
    'http://172.16.evil.com/v1',
    'http://127.0.0.1.evil.com/v1'
  ].forEach((u) => assert.strictEqual(LF_VALIDATE_ENDPOINT(u).ok, false, '应拒绝：' + u));

  // 真内网 / 回环 / 链路本地放行
  ['http://10.0.0.5:11434/v1',
    'http://10.255.255.254/v1',
    'http://172.16.3.9/v1',
    'http://172.31.255.1/v1',
    'http://192.168.0.2/v1',
    'http://169.254.1.1/v1'
  ].forEach((u) => assert.strictEqual(LF_VALIDATE_ENDPOINT(u).ok, true, '应放行：' + u));

  // 落在私有段之外（含越界的 172.32 / 192.169 / 超范围八位组）
  ['http://172.32.0.1/v1',
    'http://172.15.0.1/v1',
    'http://192.169.1.1/v1',
    'http://11.0.0.1/v1',
    'http://256.1.1.1/v1',
    'http://8.8.8.8/v1'
  ].forEach((u) => assert.strictEqual(LF_VALIDATE_ENDPOINT(u).ok, false, '应拒绝：' + u));
});

test('接口地址：IPv6 回环与 ULA 放行，公网地址拒绝', () => {
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://[::1]:8080/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://[fd00::1]:8080/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://[fe80::1]:8080/v1').ok, true);
  assert.strictEqual(LF_VALIDATE_ENDPOINT('http://[2001:db8::1]/v1').ok, false);
});

/* ---------- 导出 / 导入：默认剥离密钥后仍可完整还原 ---------- */

/** 模拟一份"用户自己的完整设置"（含引擎与语音密钥） */
function fullSettingsWithKeys() {
  const s = clone(D);
  s.providers = [
    { id: 'p1', type: 'openai', name: 'AI 模型', enabled: true, baseUrl: 'https://api.x/v1', model: 'm', apiKey: 'sk-SECRET-1', temperature: 0.1, promptTemplate: '' },
    { id: 'p2', type: 'deepl', name: 'DeepL', enabled: true, apiKey: 'deepl-SECRET-2', plan: 'free' }
  ];
  s.activeProviderId = 'p1';
  s.voice = LF_MIGRATE_VOICE({
    engine: 'bailian',
    bailian: { model: 'fun-asr-flash-2026-06-15', apiKey: 'sk-VOICE-KEY' },
    openai: { baseUrl: '', model: '', apiKey: '' }
  });
  return s;
}

test('默认导出：文件里不含任何密钥（引擎与语音都要剥离）', () => {
  const full = fullSettingsWithKeys();
  const pub = LF_SPLIT_SECRETS(full).pub;
  const text = JSON.stringify(pub);

  assert.ok(!text.includes('sk-SECRET-1'));
  assert.ok(!text.includes('deepl-SECRET-2'));
  assert.ok(!text.includes('sk-VOICE-KEY'));
  assert.strictEqual(pub.providers[0].apiKey, undefined);
  assert.strictEqual(pub.voice.bailian.apiKey, undefined);
  // 非密钥字段必须原样保留，否则"分享预设"就没意义了
  assert.strictEqual(pub.providers[0].baseUrl, 'https://api.x/v1');
  assert.strictEqual(pub.providers[1].plan, 'free');
  assert.strictEqual(pub.voice.bailian.model, 'fun-asr-flash-2026-06-15');
});

test('无密钥文件导入：本机已有密钥被保留（不会被一次导入清空）', () => {
  const pub = LF_SPLIT_SECRETS(fullSettingsWithKeys()).pub;
  // 导入端顺序：先校验收敛，再按需把本机密钥合并回来
  const checked = LF_VALIDATE_SETTINGS(clone(pub));
  const local = { providers: { p1: 'sk-SECRET-1', p2: 'deepl-SECRET-2' }, voice: { bailian: 'sk-VOICE-KEY', openai: '' } };
  const merged = LF_APPLY_SECRETS(checked.settings, local);

  assert.strictEqual(merged.providers[0].apiKey, 'sk-SECRET-1');
  assert.strictEqual(merged.providers[1].apiKey, 'deepl-SECRET-2');
  assert.strictEqual(merged.voice.bailian.apiKey, 'sk-VOICE-KEY');
});

test('含密钥的旧文件导入：以文件为准（不依赖本机残留）', () => {
  const full = fullSettingsWithKeys();
  const checked = LF_VALIDATE_SETTINGS(clone(full));
  assert.strictEqual(checked.settings.providers[0].apiKey, 'sk-SECRET-1', '文件里的密钥要跟着走');
  assert.strictEqual(checked.settings.voice.bailian.apiKey, 'sk-VOICE-KEY');
});

test('无密钥文件导入到全新配置：不会凭空生出密钥', () => {
  const pub = LF_SPLIT_SECRETS(fullSettingsWithKeys()).pub;
  const checked = LF_VALIDATE_SETTINGS(clone(pub));
  const merged = LF_APPLY_SECRETS(checked.settings, { providers: {}, voice: {} });
  // 空缺可能表现为 undefined 或被迁移函数归一成 ''，都算"没有密钥"
  assert.ok(!merged.providers[0].apiKey, '引擎不应有密钥');
  assert.ok(!merged.voice.bailian.apiKey, '语音引擎不应有密钥');
});
