#!/usr/bin/env node
/**
 * 关系诊断书 · 服务器（零依赖）
 * ------------------------------------------------------------
 * 1. 把当前文件夹的网页跑起来
 * 2. /api/chat 代理你的 AI，Key 只放在服务器上
 * 3. 授权码：签名码，一码 N 次，服务器重启也不丢
 *
 * 启动：node server.js
 *
 * 环境变量（或 .env）：
 *   DEEPSEEK_API_KEY   你的 key
 *   AI_BASE_URL        接口地址，默认 https://api.deepseek.com/chat/completions
 *   AI_MODEL           模型名，默认 deepseek-chat
 *   ADMIN_TOKEN        后台密码，也是授权码的签名密钥
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const LIC = require('./license.js');

const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USE_FILE = path.join(DATA_DIR, 'codes.json');

/* ---------- 读 .env ---------- */
function loadEnv(){
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  });
}
loadEnv();

const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.deepseek.com/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';
const AI_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

/* ---------- 用量存储：文件优先，不可写就用内存 ---------- */
const memoryUsage = new Map();
let fileOk = true;

/* 登记表：code -> {q:总次数, u:已用, t:生成时间} */
function loadStore(){
  if (!fileOk) return memoryUsage;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USE_FILE)) fs.writeFileSync(USE_FILE, '{}', 'utf8');
    const obj = JSON.parse(fs.readFileSync(USE_FILE, 'utf8'));
    Object.keys(obj).forEach(k => memoryUsage.set(k, obj[k]));
  } catch (e){ fileOk = false; }
  return memoryUsage;
}
function saveStore(){
  if (!fileOk) return;
  try {
    const obj = {};
    memoryUsage.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(USE_FILE, JSON.stringify(obj), 'utf8');
  } catch (e){ fileOk = false; }
}
function registerCode(code, quota){
  const m = loadStore();
  m.set(code, { q: quota, u: 0, t: Date.now() });
  saveStore();
}
function usageOf(code){
  const m = loadStore();
  const r = m.get(code);
  return r ? r.u : 0;
}
function recordUse(code, quota){
  const m = loadStore();
  const r = m.get(code) || { q: quota, u: 0, t: Date.now() };
  r.u = (r.u || 0) + 1;
  m.set(code, r);
  saveStore();
}
function loadUsage(){
  if (!fileOk) return memoryUsage;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USE_FILE)) fs.writeFileSync(USE_FILE, '{}', 'utf8');
    const obj = JSON.parse(fs.readFileSync(USE_FILE, 'utf8'));
    Object.keys(obj).forEach(k => memoryUsage.set(k, obj[k]));
  } catch (e){ fileOk = false; }
  return memoryUsage;
}
function saveUsage(){
  if (!fileOk) return;
  try {
    const obj = {};
    memoryUsage.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(USE_FILE, JSON.stringify(obj), 'utf8');
  } catch (e){ fileOk = false; }
}
function usedOf(code){
  return usageOf(code);
}
function addUse(code, quota){
  recordUse(code, quota || 1);
}

/* ---------- 工具 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};
function json(res, status, obj){
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-License, X-Device');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

/* ---------- 服务器 ---------- */
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  cors(res);
  if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }

  if (u.pathname === '/api/health'){
    json(res, 200, { ok: true, model: AI_MODEL, key: !!AI_KEY, admin: !!ADMIN_TOKEN });
    return;
  }

  /* 查码 */
  if (u.pathname === '/api/license/check'){
    const code = String(u.query.code || '').trim().toUpperCase();
    if (!code) return json(res, 200, { ok: false, reason: '请输入激活码' });
    const r = LIC.checkCode(code);
    if (!r.ok) return json(res, 200, { ok: false, reason: r.reason });
    const used = usedOf(code);
    if (used >= r.quota) return json(res, 200, { ok: false, reason: '这个码的次数已经用完了' });
    return json(res, 200, { ok: true, quota: r.quota, used, remaining: r.quota - used });
  }

  /* 生成码 */
  if (u.pathname === '/api/admin/gen'){
    if (!ADMIN_TOKEN) return json(res, 403, { error: '服务器没设置 ADMIN_TOKEN' });
    if (u.query.token !== ADMIN_TOKEN) return json(res, 403, { error: '密码不对' });
    const n = Math.min(200, Math.max(1, parseInt(u.query.n || '1', 10)));
    const quota = Math.max(1, parseInt(u.query.quota || '1', 10));
    const codes = [];
    for (let i = 0; i < n; i++){
      const code = LIC.makeCode(quota);
      codes.push(code);
      registerCode(code, quota);
    }
    if (u.query.fmt === 'text'){
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(codes.join('\n'));
      return;
    }
    return json(res, 200, { ok: true, codes, count: codes.length, quota });
  }

  /* 后台页面 */
  if (u.pathname === '/admin'){
    if (!ADMIN_TOKEN) return json(res, 403, { error: '服务器没设置 ADMIN_TOKEN' });
    if (u.query.token !== ADMIN_TOKEN) return json(res, 403, { error: '密码不对' });

    const store = loadStore();
    const rows = [];
    store.forEach((v, k) => rows.push({ code: k, q: v.q, u: v.u, t: v.t }));
    rows.sort((a, b) => (b.t || 0) - (a.t || 0));

    const total = rows.length;
    const usedUp = rows.filter(r => (r.u || 0) >= (r.q || 1)).length;
    const remain = total - usedUp;

    const trs = rows.slice(0, 300).map(r => {
      const left = (r.q || 1) - (r.u || 0);
      const state = left <= 0 ? '<span class="bad">已用完</span>' : '<span class="ok">可用</span>';
      const when = r.t ? new Date(r.t).toLocaleString('zh-CN', { hour12: false }) : '-';
      return '<tr><td class="mono">' + r.code + '</td><td>' + r.q + ' 次</td><td>' + (r.u || 0) + '</td><td>' + Math.max(0, left) + '</td><td>' + state + '</td><td class="dim">' + when + '</td></tr>';
    }).join('');

    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>激活码管理</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei";background:#FBF6F1;color:#3A2E2A;padding:24px 16px;max-width:860px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:26px 0 10px;padding-top:16px;border-top:1px solid #EADCD1;color:#7A6155}
.sub{color:#9A857A;font-size:13px;margin-bottom:18px;line-height:1.8}
.cards{display:flex;gap:10px;margin:16px 0 6px}
.card{flex:1;background:#fff;border-radius:14px;padding:14px 12px;text-align:center;border:1px solid #EFE1D6}
.card b{display:block;font-size:24px;color:#8C5A52;font-family:Georgia,serif}
.card span{font-size:12px;color:#A8918A}
form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:14px}
input{padding:9px 11px;border:1px solid #E6D8CD;border-radius:10px;font-size:15px;background:#fff}
input[type=number]{width:74px}
button{padding:10px 18px;border:0;border-radius:11px;background:#B76E74;color:#fff;font-size:14px;cursor:pointer}
a.btn{display:inline-block;padding:10px 16px;border-radius:11px;background:#fff;border:1px solid #E6D8CD;color:#8C5A52;text-decoration:none;font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;font-size:13px;border:1px solid #EFE1D6}
th,td{padding:10px 6px;text-align:left;border-bottom:1px solid #F3E9E1;white-space:nowrap}
th{background:#FCF6F1;font-weight:600;color:#7A6155;font-size:12px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;font-size:12.5px}
.dim{color:#AE9C93;font-size:11.5px}
.ok{color:#3F7D5A;background:#EAF4EE;padding:3px 9px;border-radius:99px;font-size:11.5px;white-space:nowrap;display:inline-block}
.bad{color:#A65B52;background:#FBEDEA;padding:3px 9px;border-radius:99px;font-size:11.5px;white-space:nowrap;display:inline-block}
.tip{color:#A8918A;font-size:12px;line-height:1.9;margin-top:16px}
.warn{background:#FFF6E9;border:1px solid #F0DDBE;color:#8A6A3A;font-size:12px;line-height:1.8;padding:10px 12px;border-radius:10px;margin-top:14px}
</style>
<h1>激活码管理</h1>
<div class="sub">这里的数字是实时的：客户用完一个码，刷新页面就能看到。</div>

<div class="cards">
  <div class="card"><b>${total}</b><span>已生成</span></div>
  <div class="card"><b>${remain}</b><span>还没用完</span></div>
  <div class="card"><b>${usedUp}</b><span>已用完</span></div>
</div>

<form action="/api/admin/gen" method="GET">
  <input type="hidden" name="token" value="${ADMIN_TOKEN}">
  生成 <input type="number" name="n" value="10" min="1" max="200"> 个，
  每个可用 <input type="number" name="quota" value="1" min="1" max="255"> 次
  <button type="submit">生成</button>
</form>

<div style="margin:12px 0 4px;display:flex;gap:10px;flex-wrap:wrap">
  <a class="btn" href="/admin?token=${ADMIN_TOKEN}">刷新表格</a>
  <a class="btn" href="/admin/csv?token=${ADMIN_TOKEN}">导出 CSV（Excel 能打开）</a>
</div>

<h2>全部激活码</h2>
<table>
<tr><th>激活码</th><th>总次数</th><th>已用</th><th>剩余</th><th>状态</th><th>生成时间</th></tr>
${trs || '<tr><td colspan="6" class="dim" style="padding:20px">还没有生成过。上面填数字点"生成"。</td></tr>'}
</table>

<h2>查一查某个码</h2>
<form action="/api/license/check" method="GET">
  <input type="text" name="code" placeholder="XXXXX-XXXXX" style="width:180px;text-transform:uppercase">
  <button type="submit">查询</button>
</form>

<div class="warn">⚠️ 免费版服务器重启后，这张表可能被清空（码本身依然有效，客户照样能用），所以重要记录请点上面「导出 CSV」存一份。</div>
<div class="tip">这个页面别发给客户。</div>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (u.pathname === '/admin/csv'){
    if (u.query.token !== ADMIN_TOKEN) return json(res, 403, { error: '密码不对' });
    const store = loadStore();
    const lines = ['激活码,总次数,已用,剩余,状态,生成时间'];
    store.forEach((v, k) => {
      const left = (v.q || 1) - (v.u || 0);
      const when = v.t ? new Date(v.t).toLocaleString('zh-CN', { hour12: false }) : '';
      lines.push([k, v.q, v.u || 0, Math.max(0, left), left <= 0 ? '已用完' : '可用', when].join(','));
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="codes.csv"'
    });
    res.end('\ufeff' + lines.join('\r\n'));
    return;
  }

  /* AI 代理 */
  if (u.pathname === '/api/chat' && req.method === 'POST'){
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch (e){ return json(res, 400, { error: 'bad json' }); }

      if (!AI_KEY) return json(res, 401, { error: '服务器没有配置 API Key：请在 .env 里写 DEEPSEEK_API_KEY=sk-...' });

      const needLicense = !!ADMIN_TOKEN;
      const code = String(req.headers['x-license'] || '').trim().toUpperCase();
      let licQuota = 1;

      if (needLicense){
        if (!code) return json(res, 402, { error: '需要激活码', code: 'NO_LICENSE' });
        const r = LIC.checkCode(code);
        if (!r.ok) return json(res, 402, { error: r.reason, code: 'BAD_LICENSE' });
        licQuota = r.quota;
        if (usedOf(code) >= r.quota) return json(res, 402, { error: '这个码的次数已经用完了', code: 'QUOTA' });
      }

      const out = {
        model: payload.model || AI_MODEL,
        messages: payload.messages || [],
        temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.85,
        stream: payload.stream !== false,
        max_tokens: payload.max_tokens || 8000
      };

      const target = new URL(AI_BASE_URL);
      const data = JSON.stringify(out);
      const opts = {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + AI_KEY,
          'Content-Length': Buffer.byteLength(data),
          'Accept': out.stream ? 'text/event-stream' : 'application/json'
        }
      };

      if (needLicense) addUse(code, licQuota);

      const upstream = https.request(opts, up => {
        res.writeHead(up.statusCode, {
          'Content-Type': up.headers['content-type'] || (out.stream ? 'text/event-stream' : 'application/json'),
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        up.pipe(res);
      });
      upstream.on('error', err => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'upstream error: ' + err.message }));
      });
      upstream.write(data);
      upstream.end();
    });
    return;
  }

  /* 静态文件 */
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/关系诊断书.html';
  const filePath = path.join(__dirname, p);
  if (!filePath.startsWith(__dirname)){ res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE'){
    console.log('');
    console.log('  已经在运行了。打开：http://localhost:' + PORT);
    console.log('');
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log('');
  console.log('  关系诊断书 · 服务已启动');
  console.log('  ─────────────────────────');
  console.log('  网址：http://localhost:' + PORT);
  console.log('  后台：http://localhost:' + PORT + '/admin?token=' + (ADMIN_TOKEN || '（未设置）'));
  console.log('  模型：' + AI_MODEL + (AI_KEY ? '（Key 已配置）' : '（Key 未配置）'));
  console.log('  授权：' + (ADMIN_TOKEN ? '已开启' : '未开启'));
  console.log('');
});
