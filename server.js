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
const USE_FILE = path.join(DATA_DIR, 'usage.json');

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
  const m = loadUsage();
  return m.get(code) || 0;
}
function addUse(code){
  const m = loadUsage();
  m.set(code, (m.get(code) || 0) + 1);
  saveUsage();
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
  if (u.pathname === '/api/admin/gen' && req.method === 'POST'){
    if (!ADMIN_TOKEN) return json(res, 403, { error: '服务器没设置 ADMIN_TOKEN' });
    if (u.query.token !== ADMIN_TOKEN) return json(res, 403, { error: '密码不对' });
    const n = Math.min(200, Math.max(1, parseInt(u.query.n || '1', 10)));
    const quota = Math.max(1, parseInt(u.query.quota || '1', 10));
    const codes = [];
    for (let i = 0; i < n; i++) codes.push(LIC.makeCode(quota));
    return json(res, 200, { ok: true, codes, count: codes.length, quota });
  }

  /* 后台页面 */
  if (u.pathname === '/admin'){
    if (!ADMIN_TOKEN) return json(res, 403, { error: '服务器没设置 ADMIN_TOKEN' });
    if (u.query.token !== ADMIN_TOKEN) return json(res, 403, { error: '密码不对' });
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>生成激活码</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei";background:#FBF6F1;color:#3A2E2A;padding:26px 18px;max-width:620px;margin:0 auto}
h1{font-size:20px;margin:0 0 6px}
.sub{color:#9A857A;font-size:13px;margin-bottom:22px}
.row{display:flex;gap:12px;align-items:center;margin-bottom:14px;font-size:14px;flex-wrap:wrap}
input{padding:10px 12px;border:1px solid #E6D8CD;border-radius:10px;width:90px;font-size:15px}
button{padding:12px 20px;border:0;border-radius:12px;background:#B76E74;color:#fff;font-size:15px;cursor:pointer}
button:active{transform:translateY(1px)}
pre{background:#fff;padding:16px;border-radius:12px;font-size:15px;line-height:2;white-space:pre-wrap;letter-spacing:.06em;
border:1px dashed #E6D8CD;min-height:60px}
.tip{color:#A8918A;font-size:12px;line-height:1.9;margin-top:14px}
</style>
<h1>生成激活码</h1>
<div class="sub">生成后复制发给客户。一个码只能用你设定的次数。</div>
<div class="row">生成数量 <input id="n" value="10"> 个，每个可用 <input id="q" value="1"> 次</div>
<div class="row"><button onclick="gen()">生成</button></div>
<pre id="out">点“生成”</pre>
<div class="tip">客户打开网站 → 输入码 → 答题 → 生成。用完次数就作废。<br>这个页面别发给客户。</div>
<script>
async function gen(){
  const n=document.getElementById('n').value, q=document.getElementById('q').value;
  document.getElementById('out').textContent='生成中…';
  const r=await fetch('/api/admin/gen?n='+n+'&quota='+q+'&token='+encodeURIComponent('${ADMIN_TOKEN}'),{method:'POST'});
  const j=await r.json();
  document.getElementById('out').textContent = j.codes ? j.codes.join('\\n') : (j.error||'失败');
}
</script>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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

      if (needLicense){
        if (!code) return json(res, 402, { error: '需要激活码', code: 'NO_LICENSE' });
        const r = LIC.checkCode(code);
        if (!r.ok) return json(res, 402, { error: r.reason, code: 'BAD_LICENSE' });
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

      if (needLicense) addUse(code);

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
