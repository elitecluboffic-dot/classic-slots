// ============================================================
//  CLASSIC SLOTS — Cloudflare Worker
//  KV Namespace: SLOTS_KV  (bind in wrangler.toml)
//  Env vars:
//    ADMIN_PASSWORD  — password untuk login admin
//    SESSION_SECRET  — string acak untuk sign cookie (min 32 char)
// ============================================================

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}
function html(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...extra } });
}
function redirect(loc, extra = {}) {
  return new Response(null, { status: 302, headers: { Location: loc, ...extra } });
}

async function sign(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return value + '.' + btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function verify(signed, secret) {
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const expected = await sign(value, secret);
  return expected === signed ? value : null;
}
function parseCookies(req) {
  const raw = req.headers.get('Cookie') || '';
  return Object.fromEntries(raw.split(';').map(s => s.trim().split('=').map(decodeURIComponent)));
}
function makeCookie(name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.maxAge) c += `; Max-Age=${opts.maxAge}`;
  if (opts.expires) c += `; Expires=${opts.expires}`;
  return c;
}
async function getSession(req, env) {
  const cookies = parseCookies(req);
  const raw = cookies['sess'];
  if (!raw) return null;
  const payload = await verify(raw, env.SESSION_SECRET || 'dev-secret-change-me');
  if (!payload) return null;
  try { return JSON.parse(payload); } catch { return null; }
}
async function makeSession(data, env) {
  const payload = JSON.stringify(data);
  const signed = await sign(payload, env.SESSION_SECRET || 'dev-secret-change-me');
  return makeCookie('sess', signed, { maxAge: 86400 * 7 });
}
function clearSession() {
  return makeCookie('sess', '', { expires: 'Thu, 01 Jan 1970 00:00:00 GMT' });
}

async function getUser(env, username) {
  const raw = await env.SLOTS_KV.get('user:' + username.toLowerCase());
  return raw ? JSON.parse(raw) : null;
}
async function putUser(env, username, data) {
  await env.SLOTS_KV.put('user:' + username.toLowerCase(), JSON.stringify(data));
}
async function listUsers(env) {
  const list = await env.SLOTS_KV.list({ prefix: 'user:' });
  const users = [];
  for (const key of list.keys) {
    const raw = await env.SLOTS_KV.get(key.name);
    if (raw) users.push(JSON.parse(raw));
  }
  return users;
}
async function getSettings(env) {
  const raw = await env.SLOTS_KV.get('settings');
  if (raw) return JSON.parse(raw);
  // UPDATED: semua nilai dalam satuan perak. 5000 = 5K, 100000 = 100K, dst.
  return { minBet: 5000, maxBet: 500000, rtp: 85, winBoost: 0, loseForce: 0, startBalance: 100000, jackpotMult: 50, scatterMult: 3 };
}
async function putSettings(env, s) {
  await env.SLOTS_KV.put('settings', JSON.stringify(s));
}
async function hashPwd(pwd) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd + 'slots_salt_v1'));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const SYMS = ['🍒','🍓','🍇','🍌','🍑','7️⃣','💎','🔔','⭐'];
const BASE_WEIGHTS = [18, 15, 14, 12, 10, 6, 3, 8, 5];
const WILD = '🔔';
const SCATTER = '⭐';
const PAY_TABLE = { '🍒':5,'🍓':8,'🍇':10,'🍌':12,'🍑':15,'7️⃣':25,'💎':50 };

function pickSym(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SYMS.length; i++) { r -= weights[i]; if (r <= 0) return SYMS[i]; }
  return SYMS[0];
}

function spinGrid(settings) {
  // FORCE LOSE: generate grid yang dijamin tidak ada kombinasi menang sama sekali
  if (settings.loseForce) {
    const noWinSyms = ['🍒','🍓','🍇','🍌','🍑'];
    const grid = [];
    for (let c = 0; c < 5; c++) {
      const col = [];
      for (let r = 0; r < 3; r++) {
        col.push(noWinSyms[(c + r * 2) % noWinSyms.length]);
      }
      grid.push(col);
    }
    // Verifikasi & fix kalau ada row yang kebetulan sama
    for (let r = 0; r < 3; r++) {
      const freq = {};
      for (let c = 0; c < 5; c++) freq[grid[c][r]] = (freq[grid[c][r]] || 0) + 1;
      for (const [s, cnt] of Object.entries(freq)) {
        if (cnt >= 3) {
          let replaced = 0;
          for (let c = 0; c < 5 && replaced < cnt - 2; c++) {
            if (grid[c][r] === s) {
              const alt = noWinSyms.filter(x => x !== s);
              grid[c][r] = alt[(c + r + 1) % alt.length];
              replaced++;
            }
          }
        }
      }
    }
    return grid;
  }

  let w = [...BASE_WEIGHTS];
  const factor = (settings.rtp || 85) / 85;
  w[5] = Math.max(1, Math.round(w[5] * factor));
  w[6] = Math.max(1, Math.round(w[6] * factor));
  w[7] = Math.max(1, Math.round(w[7] * factor));

  if (settings.winBoost) { w[6] = 15; w[5] = 15; w[7] = 18; }

  const grid = [];
  for (let c = 0; c < 5; c++) {
    const col = [];
    for (let r = 0; r < 3; r++) col.push(pickSym(w));
    grid.push(col);
  }
  if (settings.winBoost && Math.random() < 0.6) {
    const sym = SYMS[Math.floor(Math.random() * 7)];
    const row = Math.floor(Math.random() * 3);
    for (let c = 0; c < 5; c++) grid[c][row] = sym;
  }
  return grid;
}

function calcWin(grid, bet, settings) {
  // FORCE LOSE: langsung return 0, tidak perlu hitung apapun
  if (settings.loseForce) return { win: 0, winRows: [], scatCount: 0 };

  const winRows = [];
  let win = 0;
  let scatCount = 0;
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) if (grid[c][r] === SCATTER) scatCount++;
  for (let r = 0; r < 3; r++) {
    const row = grid.map(col => col[r]);
    const nonWild = row.filter(s => s !== WILD && s !== SCATTER);
    const wilds = row.filter(s => s === WILD).length;
    const freq = {};
    for (const s of nonWild) freq[s] = (freq[s] || 0) + 1;
    let bestSym = null, bestCount = 0;
    for (const [s, c] of Object.entries(freq)) {
      if (c + wilds >= 3 && (bestSym === null || PAY_TABLE[s] > PAY_TABLE[bestSym])) { bestSym = s; bestCount = c + wilds; }
    }
    if (!bestSym && wilds >= 3) { bestSym = '7️⃣'; bestCount = wilds; }
    if (bestSym && bestCount >= 3) {
      const mult = PAY_TABLE[bestSym] || 0;
      win += bet * mult * (bestCount === 5 ? 2 : bestCount === 4 ? 1.5 : 1);
      winRows.push(r);
    }
  }
  if (scatCount >= 3) win += bet * (settings.scatterMult || 3) * scatCount;
  return { win: parseFloat(win.toFixed(2)), winRows, scatCount };
}

function pageLogin(error = '') {
  return `<!DOCTYPE html><html lang="id"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Login — Classic Slots</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&family=Nunito:wght@400;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:linear-gradient(135deg,#1a0328 0%,#2d0845 50%,#1a0328 100%);font-family:'Nunito',sans-serif;display:flex;align-items:center;justify-content:center}
.card{background:linear-gradient(145deg,rgba(60,15,90,.9),rgba(30,5,50,.95));border:1px solid rgba(255,215,0,.25);border-radius:20px;padding:40px 36px;width:min(380px,92vw);box-shadow:0 0 60px rgba(255,215,0,.1),0 20px 60px rgba(0,0,0,.5)}
.logo{text-align:center;margin-bottom:28px}
.logo-classic{font-family:'Cinzel Decorative',cursive;font-size:13px;color:#8B4513;-webkit-text-stroke:.5px #FFD700;display:block}
.logo-slots{font-family:'Cinzel Decorative',cursive;font-size:32px;font-weight:900;color:#FFD700;letter-spacing:4px;display:block;text-shadow:0 0 20px rgba(255,215,0,.5)}
.tabs{display:flex;gap:0;background:rgba(0,0,0,.3);border-radius:10px;padding:3px;margin-bottom:24px}
.tab{flex:1;text-align:center;padding:8px;border-radius:8px;font-size:13px;font-weight:800;color:rgba(255,255,255,.4);cursor:pointer;transition:.2s;border:none;background:none;font-family:'Nunito',sans-serif}
.tab.active{background:rgba(255,215,0,.2);color:#FFD700;border:1px solid rgba(255,215,0,.3)}
label{display:block;font-size:11px;font-weight:800;letter-spacing:1.5px;color:#c8a0d8;text-transform:uppercase;margin-bottom:5px}
input{width:100%;background:rgba(0,0,0,.35);border:1px solid rgba(255,215,0,.2);border-radius:10px;padding:11px 14px;color:#fff;font-size:14px;font-family:'Nunito',sans-serif;outline:none;transition:.2s;margin-bottom:16px}
input:focus{border-color:rgba(255,215,0,.6);box-shadow:0 0 0 3px rgba(255,215,0,.08)}
.btn{width:100%;background:linear-gradient(135deg,#FFD700,#FFA500);border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:900;color:#3a1a00;cursor:pointer;font-family:'Nunito',sans-serif;transition:.15s}
.btn:hover{filter:brightness(1.1)}
.err{background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.3);border-radius:8px;padding:10px 14px;font-size:13px;color:#ff9090;margin-bottom:16px;text-align:center}
</style></head><body>
<div class="card">
  <div class="logo">
    <span class="logo-classic">Classic</span>
    <span class="logo-slots">SLOTS</span>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="showTab('login')">🔑 Login</button>
    <button class="tab" onclick="showTab('register')">📝 Register</button>
  </div>
  ${error ? `<div class="err">⚠ ${error}</div>` : ''}
  <form id="loginForm" method="POST" action="/login">
    <label>Username</label>
    <input name="username" type="text" placeholder="masukkan username" autocomplete="username" required/>
    <label>Password</label>
    <input name="password" type="password" placeholder="••••••••" autocomplete="current-password" required/>
    <button class="btn" type="submit">Masuk 🎰</button>
  </form>
  <form id="registerForm" method="POST" action="/register" style="display:none">
    <label>Username</label>
    <input name="username" type="text" placeholder="pilih username unik" autocomplete="off" required/>
    <label>Password</label>
    <input name="password" type="password" placeholder="min 6 karakter" autocomplete="new-password" required/>
    <label>Konfirmasi Password</label>
    <input name="confirm" type="password" placeholder="ulangi password" required/>
    <button class="btn" type="submit">Daftar Sekarang ✨</button>
  </form>
</div>
<script>
function showTab(t){
  document.getElementById('loginForm').style.display=t==='login'?'':'none';
  document.getElementById('registerForm').style.display=t==='register'?'':'none';
  document.querySelectorAll('.tab').forEach((el,i)=>el.classList.toggle('active',(i===0&&t==='login')||(i===1&&t==='register')));
}
const url=new URL(location.href);
if(url.searchParams.get('tab')==='register')showTab('register');
</script>
</body></html>`;
}

function pageAdminLogin(error = '') {
  return `<!DOCTYPE html><html lang="id"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Login — Classic Slots</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&family=Nunito:wght@400;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:linear-gradient(135deg,#0a0a1a 0%,#1a1a2d 100%);font-family:'Nunito',sans-serif;display:flex;align-items:center;justify-content:center}
.card{background:rgba(15,15,30,.95);border:1px solid rgba(100,180,255,.2);border-radius:20px;padding:40px 36px;width:min(360px,92vw);box-shadow:0 0 60px rgba(50,100,255,.1)}
.logo{text-align:center;margin-bottom:28px}
.logo-txt{font-family:'Cinzel Decorative',cursive;font-size:22px;font-weight:900;color:#64b4ff;display:block;letter-spacing:3px}
.logo-sub{font-size:12px;color:#4a6a8a;letter-spacing:2px;margin-top:4px}
label{display:block;font-size:11px;font-weight:800;letter-spacing:1.5px;color:#4a6a8a;text-transform:uppercase;margin-bottom:5px}
input{width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(100,180,255,.15);border-radius:10px;padding:11px 14px;color:#fff;font-size:14px;font-family:'Nunito',sans-serif;outline:none;transition:.2s;margin-bottom:16px}
input:focus{border-color:rgba(100,180,255,.5)}
.btn{width:100%;background:linear-gradient(135deg,#1a4aff,#0a2aaa);border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:900;color:#fff;cursor:pointer;font-family:'Nunito',sans-serif}
.btn:hover{filter:brightness(1.2)}
.err{background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.2);border-radius:8px;padding:10px 14px;font-size:13px;color:#ff9090;margin-bottom:16px;text-align:center}
.back{display:block;text-align:center;margin-top:14px;font-size:12px;color:#4a6a8a;text-decoration:none}
.back:hover{color:#64b4ff}
</style></head><body>
<div class="card">
  <div class="logo">
    <span class="logo-txt">⚙ ADMIN PANEL</span>
    <span class="logo-sub">Classic Slots Management</span>
  </div>
  ${error ? `<div class="err">⚠ ${error}</div>` : ''}
  <form method="POST" action="/admin/login">
    <label>Username Admin</label>
    <input name="username" type="text" value="admin" readonly/>
    <label>Password Admin</label>
    <input name="password" type="password" placeholder="••••••••" autocomplete="current-password" required/>
    <button class="btn" type="submit">🔐 Masuk Admin</button>
  </form>
  <a class="back" href="/">← Kembali ke Game</a>
</div>
</body></html>`;
}

function pageAdmin(users, settings) {
  // UPDATED: format K untuk tampilan saldo di tabel
  const fmtK = v => (parseFloat(v || 0) / 1000).toFixed(2) + 'K';
  const rows = users.map(u => `
    <tr>
      <td>${u.username}</td>
      <td class="num">${fmtK(u.balance)}</td>
      <td class="num">${fmtK(u.totalBet)}</td>
      <td class="num">${fmtK(u.totalWin)}</td>
      <td class="num">${u.spins || 0}</td>
      <td><span class="badge ${u.banned ? 'bad' : 'good'}">${u.banned ? 'Banned' : 'Aktif'}</span></td>
      <td>
        <button class="act-btn" onclick="setBalance('${u.username}')">💰 Saldo</button>
        <button class="act-btn red" onclick="toggleBan('${u.username}','${u.banned ? '0' : '1'}')">${u.banned ? '✅ Unban' : '🚫 Ban'}</button>
        <button class="act-btn red" onclick="deleteUser('${u.username}')">🗑 Hapus</button>
      </td>
    </tr>`).join('');

  // UPDATED: statistik global dalam K
  const totalBal = (users.reduce((a,u)=>a+(u.balance||0),0)/1000).toFixed(2);
  const totalBet = (users.reduce((a,u)=>a+(u.totalBet||0),0)/1000).toFixed(2);
  const totalWin = (users.reduce((a,u)=>a+(u.totalWin||0),0)/1000).toFixed(2);

  return `<!DOCTYPE html><html lang="id"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Panel — Classic Slots</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700&family=Nunito:wght@400;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:#080814;color:#ccd;font-family:'Nunito',sans-serif;padding:0}
.header{background:linear-gradient(90deg,#0a1530,#0a0a20);border-bottom:1px solid rgba(100,180,255,.15);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.header-title{font-family:'Cinzel Decorative',cursive;font-size:18px;color:#64b4ff;letter-spacing:2px}
.header-sub{font-size:11px;color:#4a6a8a;margin-top:2px}
.header-right{display:flex;gap:8px;align-items:center}
.hbtn{background:rgba(100,180,255,.1);border:1px solid rgba(100,180,255,.2);border-radius:8px;color:#64b4ff;font-size:12px;font-family:'Nunito',sans-serif;padding:6px 14px;cursor:pointer;text-decoration:none;display:inline-block}
.hbtn.red{background:rgba(255,80,80,.1);border-color:rgba(255,80,80,.2);color:#ff8080}
.content{max-width:1200px;margin:0 auto;padding:24px 16px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
@media(max-width:700px){.grid-2{grid-template-columns:1fr}}
.card{background:rgba(255,255,255,.03);border:1px solid rgba(100,180,255,.1);border-radius:14px;padding:20px}
.card h3{font-size:13px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#4a6a8a;margin-bottom:16px}
.stat-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.stat-row:last-child{border:none}
.stat-label{font-size:13px;color:#889}
.stat-val{font-size:16px;font-weight:800;color:#fff}
.stat-val.gold{color:#FFD700}
.stat-val.green{color:#4dff9a}
.stat-val.red{color:#ff7070}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:500px){.form-row{grid-template-columns:1fr}}
.form-group{display:flex;flex-direction:column;gap:4px}
label{font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#4a6a8a}
input[type=number],input[type=text],select{background:rgba(0,0,0,.4);border:1px solid rgba(100,180,255,.15);border-radius:8px;padding:9px 12px;color:#fff;font-size:13px;font-family:'Nunito',sans-serif;outline:none;width:100%;transition:.2s}
input:focus,select:focus{border-color:rgba(100,180,255,.4)}
select option{background:#080814}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.toggle-row:last-child{border:none}
.toggle-label{font-size:13px;color:#ccd}
.toggle-sub{font-size:11px;color:#4a6a8a;margin-top:2px}
.switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:rgba(255,255,255,.1);border-radius:24px;cursor:pointer;transition:.2s}
.slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s}
input:checked+.slider{background:linear-gradient(135deg,#1a4aff,#0a2aaa)}
input:checked+.slider:before{transform:translateX(20px)}
.save-btn{width:100%;background:linear-gradient(135deg,#1a4aff,#0a2aaa);border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:900;color:#fff;cursor:pointer;font-family:'Nunito',sans-serif;margin-top:12px}
.save-btn:hover{filter:brightness(1.2)}
.section-title{font-size:15px;font-weight:800;color:#fff;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid rgba(100,180,255,.1)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead tr{background:rgba(100,180,255,.06)}
th{padding:10px 14px;text-align:left;font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#4a6a8a;border-bottom:1px solid rgba(100,180,255,.1)}
td{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
td.num{font-family:'Nunito',sans-serif;font-weight:700;color:#FFD700}
tr:last-child td{border:none}
tr:hover td{background:rgba(255,255,255,.02)}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:800}
.badge.good{background:rgba(70,255,130,.12);color:#4dff9a;border:1px solid rgba(70,255,130,.2)}
.badge.bad{background:rgba(255,80,80,.12);color:#ff7070;border:1px solid rgba(255,80,80,.2)}
.act-btn{background:rgba(100,180,255,.1);border:1px solid rgba(100,180,255,.2);border-radius:6px;color:#64b4ff;font-size:11px;font-family:'Nunito',sans-serif;padding:4px 8px;cursor:pointer;margin-right:4px;transition:.15s}
.act-btn:hover{background:rgba(100,180,255,.2)}
.act-btn.red{background:rgba(255,80,80,.08);border-color:rgba(255,80,80,.2);color:#ff8080}
.act-btn.red:hover{background:rgba(255,80,80,.18)}
.toast{position:fixed;bottom:24px;right:24px;background:#1a4aff;border-radius:10px;padding:12px 20px;color:#fff;font-weight:700;font-size:13px;z-index:9999;opacity:0;transform:translateY(10px);transition:.3s;pointer-events:none}
.toast.show{opacity:1;transform:translateY(0)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9000;display:none;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#0a0a1a;border:1px solid rgba(100,180,255,.2);border-radius:16px;padding:28px;width:min(340px,90vw)}
.modal h4{font-size:15px;font-weight:800;color:#fff;margin-bottom:16px}
.modal input{width:100%;background:rgba(0,0,0,.4);border:1px solid rgba(100,180,255,.2);border-radius:8px;padding:10px 12px;color:#fff;font-size:14px;font-family:'Nunito',sans-serif;outline:none;margin-bottom:14px}
.modal-btns{display:flex;gap:8px}
.modal-btns button{flex:1;padding:10px;border-radius:8px;font-weight:800;font-family:'Nunito',sans-serif;cursor:pointer;border:none;font-size:13px}
.modal-ok{background:#1a4aff;color:#fff}
.modal-cancel{background:rgba(255,255,255,.08);color:#889}
</style></head><body>
<div class="header">
  <div>
    <div class="header-title">⚙ Admin Panel</div>
    <div class="header-sub">Classic Slots Management</div>
  </div>
  <div class="header-right">
    <a href="/" class="hbtn">🎰 Lihat Game</a>
    <a href="/admin/logout" class="hbtn red">🚪 Logout</a>
  </div>
</div>
<div class="content">
  <div class="grid-2">
    <div class="card">
      <h3>📊 Statistik Global</h3>
      <div class="stat-row"><span class="stat-label">Total User</span><span class="stat-val">${users.length}</span></div>
      <div class="stat-row"><span class="stat-label">Total Saldo Semua User</span><span class="stat-val gold">${totalBal}K ★</span></div>
      <div class="stat-row"><span class="stat-label">Total Bet Semua User</span><span class="stat-val">${totalBet}K ★</span></div>
      <div class="stat-row"><span class="stat-label">Total Win Semua User</span><span class="stat-val green">${totalWin}K ★</span></div>
      <div class="stat-row"><span class="stat-label">Total Spin</span><span class="stat-val">${users.reduce((a,u)=>a+(u.spins||0),0)}</span></div>
      <div class="stat-row"><span class="stat-label">User Banned</span><span class="stat-val red">${users.filter(u=>u.banned).length}</span></div>
    </div>
    <div class="card">
      <h3>🎮 Override Permainan</h3>
      <form id="overrideForm">
        <div class="toggle-row">
          <div><div class="toggle-label">🍀 Win Boost</div><div class="toggle-sub">Perbesar peluang menang semua user</div></div>
          <label class="switch"><input type="checkbox" id="winBoost" ${settings.winBoost ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">💸 Force Lose</div><div class="toggle-sub">Paksa kalah 100% semua user</div></div>
          <label class="switch"><input type="checkbox" id="loseForce" ${settings.loseForce ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div style="margin-top:14px">
          <label>RTP (Return to Player) — ${settings.rtp}%</label>
          <input type="number" id="rtp" value="${settings.rtp}" min="50" max="99" style="margin-top:6px"/>
          <div style="font-size:11px;color:#4a6a8a;margin-top:4px">50% = peluang kecil, 99% = hampir selalu menang</div>
        </div>
        <button type="button" class="save-btn" onclick="saveOverride()">💾 Simpan Override</button>
      </form>
    </div>
  </div>
  <div class="card" style="margin-bottom:28px">
    <h3>⚙ Pengaturan Permainan</h3>
    <form id="settingsForm">
      <div class="form-row">
        <div class="form-group"><label>Min Bet (perak)</label><input type="number" id="minBet" value="${settings.minBet}" min="1"/></div>
        <div class="form-group"><label>Max Bet (perak)</label><input type="number" id="maxBet" value="${settings.maxBet}" min="1"/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Saldo Awal User Baru (perak)</label><input type="number" id="startBalance" value="${settings.startBalance}" min="0"/></div>
        <div class="form-group"><label>Scatter Multiplier (×Bet)</label><input type="number" id="scatterMult" value="${settings.scatterMult}" min="1"/></div>
      </div>
      <button type="button" class="save-btn" onclick="saveSettings()">💾 Simpan Pengaturan</button>
    </form>
  </div>
  <div class="section-title">👥 Daftar User</div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Username</th><th>Saldo (K★)</th><th>Total Bet (K)</th><th>Total Win (K)</th><th>Spin</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:#4a6a8a;padding:24px">Belum ada user</td></tr>'}</tbody>
    </table>
  </div>
</div>
<div class="modal-overlay" id="balModal">
  <div class="modal">
    <h4>💰 Atur Saldo User (perak)</h4>
    <input type="number" id="newBalance" placeholder="mis. 100000 = 100K" min="0"/>
    <div class="modal-btns">
      <button class="modal-cancel" onclick="closeModal()">Batal</button>
      <button class="modal-ok" onclick="confirmBalance()">Simpan</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let targetUser='';
function toast(msg,ok=true){const t=document.getElementById('toast');t.textContent=msg;t.style.background=ok?'#1a4aff':'#cc2222';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2800)}
async function saveSettings(){const s={minBet:+document.getElementById('minBet').value,maxBet:+document.getElementById('maxBet').value,startBalance:+document.getElementById('startBalance').value,scatterMult:+document.getElementById('scatterMult').value,rtp:+document.getElementById('rtp').value,winBoost:document.getElementById('winBoost').checked?1:0,loseForce:document.getElementById('loseForce').checked?1:0};const r=await fetch('/admin/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});const d=await r.json();toast(d.ok?'✅ Pengaturan disimpan!':'❌ Gagal: '+d.error,d.ok)}
async function saveOverride(){const s={winBoost:document.getElementById('winBoost').checked?1:0,loseForce:document.getElementById('loseForce').checked?1:0,rtp:+document.getElementById('rtp').value};const r=await fetch('/admin/api/override',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});const d=await r.json();toast(d.ok?'✅ Override disimpan!':'❌ Gagal',d.ok)}
function setBalance(u){targetUser=u;document.getElementById('balModal').classList.add('show')}
function closeModal(){document.getElementById('balModal').classList.remove('show');targetUser=''}
async function confirmBalance(){const bal=+document.getElementById('newBalance').value;const r=await fetch('/admin/api/set-balance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:targetUser,balance:bal})});const d=await r.json();toast(d.ok?'✅ Saldo diperbarui!':'❌ Gagal',d.ok);if(d.ok)setTimeout(()=>location.reload(),800);closeModal()}
async function toggleBan(u,banned){if(!confirm((banned==='1'?'Ban':'Unban')+' user '+u+'?'))return;const r=await fetch('/admin/api/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,banned:+banned})});const d=await r.json();toast(d.ok?'✅ Status diperbarui!':'❌ Gagal',d.ok);if(d.ok)setTimeout(()=>location.reload(),800)}
async function deleteUser(u){if(!confirm('Hapus permanen user '+u+'?'))return;const r=await fetch('/admin/api/delete-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})});const d=await r.json();toast(d.ok?'✅ User dihapus!':'❌ Gagal',d.ok);if(d.ok)setTimeout(()=>location.reload(),800)}
</script>
</body></html>`;
}

function HTML_GAME(session, settings) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Classic Slots</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@700;900&family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
:root{--gold:#FFD700;--gold2:#FFA500;--gold-dark:#B8860B;--purple-deep:#1a0328;--reel-bg:#2d0845;--win-cyan:#00eeff;--win-yellow:#ffe000;--text-muted:#c8a0d8}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:var(--purple-deep);font-family:'Nunito',sans-serif;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
.sky{position:fixed;inset:0;z-index:0;background:linear-gradient(170deg,#87ceeb 0%,#b0d8f0 20%,#d4a0c0 55%,#c87a5a 80%,#a0503a 100%);animation:skyShift 12s ease-in-out infinite alternate}
@keyframes skyShift{0%{filter:hue-rotate(0deg) brightness(1)}50%{filter:hue-rotate(15deg) brightness(1.05)}100%{filter:hue-rotate(-10deg) brightness(.95)}}
.clouds{position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden}
.cloud{position:absolute;border-radius:50%;background:rgba(255,255,255,.55);filter:blur(18px);animation:driftCloud linear infinite}
.cloud:nth-child(1){width:320px;height:110px;top:8%;animation-duration:28s;animation-delay:0s;opacity:.7}
.cloud:nth-child(2){width:200px;height:80px;top:18%;animation-duration:22s;animation-delay:-8s;opacity:.5}
.cloud:nth-child(3){width:260px;height:90px;top:5%;animation-duration:35s;animation-delay:-14s;opacity:.6}
.cloud:nth-child(4){width:180px;height:70px;top:30%;animation-duration:25s;animation-delay:-4s;opacity:.4}
.cloud:nth-child(5){width:300px;height:100px;top:60%;animation-duration:30s;animation-delay:-18s;opacity:.45}
.cloud:nth-child(6){width:220px;height:85px;top:75%;animation-duration:20s;animation-delay:-10s;opacity:.5}
@keyframes driftCloud{from{left:-25%}to{left:115%}}
.sparkle-layer{position:fixed;inset:0;z-index:100;pointer-events:none;overflow:hidden;display:none}
.sparkle-layer.active{display:block}
.spark{position:absolute;width:6px;height:6px;border-radius:50%;animation:sparkFly 1s ease-out forwards}
@keyframes sparkFly{0%{transform:scale(1);opacity:1}100%{transform:var(--tx);opacity:0}}
.game-root{position:relative;z-index:10;display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;animation:fadeIn .6s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.top-bar{width:100%;display:flex;justify-content:flex-end;gap:8px;max-width:520px}
.tb-btn{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.15);border-radius:20px;color:rgba(255,255,255,.7);font-size:12px;font-family:'Nunito',sans-serif;padding:5px 14px;cursor:pointer;transition:background .15s;text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.tb-btn:hover{background:rgba(255,255,255,.1)}
.tb-user{background:rgba(255,215,0,.12);border-color:rgba(255,215,0,.3);color:var(--gold)}
.title-wrap{text-align:center;line-height:1;filter:drop-shadow(0 2px 8px rgba(0,0,0,.5))}
.title-classic{font-family:'Cinzel Decorative',cursive;font-size:clamp(18px,4vw,30px);font-weight:700;color:#8B4513;-webkit-text-stroke:1px var(--gold);text-shadow:1px 1px 0 var(--gold),2px 2px 4px rgba(0,0,0,.4);font-style:italic;display:block}
.title-slots{font-family:'Cinzel Decorative',cursive;font-size:clamp(30px,7vw,52px);font-weight:900;color:var(--gold);-webkit-text-stroke:2px var(--gold-dark);text-shadow:2px 2px 0 var(--gold-dark),0 0 20px rgba(255,215,0,.6);letter-spacing:6px;display:block}
.machine-outer{background:linear-gradient(145deg,#ffe066,var(--gold),#e6a800,var(--gold),#ffe066);border-radius:20px;padding:5px;box-shadow:0 0 40px rgba(255,215,0,.35),0 8px 32px rgba(0,0,0,.6)}
.machine-inner{background:linear-gradient(180deg,#3d0f5c 0%,var(--reel-bg) 40%,#1a0328 100%);border-radius:16px;padding:14px;width:clamp(320px,85vw,500px)}
.gem{position:absolute;width:18px;height:18px;border-radius:50%}
.gem-tl{top:8px;left:8px;background:radial-gradient(circle at 35% 35%,#ff6be8,#a020f0);box-shadow:0 0 6px #ff6be8}
.gem-tr{top:8px;right:8px;background:radial-gradient(circle at 35% 35%,#6be8ff,#207af0);box-shadow:0 0 6px #6be8ff}
.gem-bl{bottom:8px;left:8px;background:radial-gradient(circle at 35% 35%,#ffe06b,#f0a020);box-shadow:0 0 6px #ffe06b}
.gem-br{bottom:8px;right:8px;background:radial-gradient(circle at 35% 35%,#6bffb0,#20c060);box-shadow:0 0 6px #6bffb0}
.reels-wrap{background:var(--reel-bg);border-radius:10px;padding:10px;border:2px solid rgba(255,215,0,.3);position:relative;overflow:hidden}
.row-lines{position:absolute;inset:10px;pointer-events:none;z-index:1}
.row-line{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(0,238,255,0),transparent);transition:background .3s}
.row-line.active{background:linear-gradient(90deg,transparent 2%,rgba(0,238,255,.7) 20%,rgba(0,238,255,.9) 50%,rgba(0,238,255,.7) 80%,transparent 98%);box-shadow:0 0 8px var(--win-cyan),0 0 16px rgba(0,238,255,.4)}
.reels-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;position:relative;z-index:2}
.cell{aspect-ratio:1;background:rgba(255,255,255,.06);border-radius:8px;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:clamp(20px,5vw,34px);transition:background .15s,border-color .15s;position:relative;overflow:hidden;user-select:none}
.cell::after{content:'';position:absolute;top:0;left:0;right:0;height:40%;background:linear-gradient(rgba(255,255,255,.07),transparent);pointer-events:none;border-radius:8px 8px 0 0}
.cell.spinning-cell{animation:cellBlur .12s ease-in-out infinite alternate}
@keyframes cellBlur{from{transform:scaleY(.96);filter:blur(1.5px)}to{transform:scaleY(1.02);filter:blur(2.5px)}}
.cell.winner{background:rgba(255,220,0,.22);border-color:var(--gold);box-shadow:0 0 12px rgba(255,215,0,.6),inset 0 0 8px rgba(255,215,0,.15);animation:cellPop .4s ease}
@keyframes cellPop{0%{transform:scale(1)}40%{transform:scale(1.12)}70%{transform:scale(.96)}100%{transform:scale(1)}}
.cell.scatter-hit{background:rgba(255,80,200,.22);border-color:#ff60f0;box-shadow:0 0 14px rgba(255,80,240,.7)}
.win-badge{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(0);background:linear-gradient(135deg,var(--gold),#ffb300);border-radius:16px;padding:8px 24px;font-size:clamp(16px,4vw,26px);font-weight:900;color:#3a1a00;border:2px solid #fff;z-index:20;white-space:nowrap;pointer-events:none;transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .25s;box-shadow:0 4px 20px rgba(255,150,0,.5)}
.win-badge.show{transform:translate(-50%,-50%) scale(1)}
.win-badge.hide{transform:translate(-50%,-50%) scale(0);opacity:0}
.coin{position:absolute;font-size:18px;pointer-events:none;z-index:30;animation:coinFly 1.2s ease-out forwards}
@keyframes coinFly{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:var(--tx) scale(.3);opacity:0}}
.bottom-bar{display:flex;align-items:center;justify-content:space-between;margin-top:12px;gap:8px}
.stat-block{text-align:center;min-width:85px}
.stat-label{font-size:10px;color:var(--text-muted);font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
.stat-value{font-size:clamp(13px,3vw,19px);font-weight:800;color:#fff;white-space:nowrap}
.stat-star{color:var(--gold);font-size:.75em}
.bet-group{display:flex;align-items:center;gap:6px;background:rgba(0,0,0,.3);border-radius:30px;padding:4px 10px;border:1px solid rgba(255,215,0,.2)}
.btn-round{width:30px;height:30px;border-radius:50%;background:rgba(120,120,130,.5);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,transform .1s;line-height:1}
.btn-round:hover:not(:disabled){background:rgba(180,180,190,.5)}
.btn-round:active:not(:disabled){transform:scale(.9)}
.btn-round:disabled{opacity:.3;cursor:not-allowed}
.bet-center{text-align:center;min-width:65px}
.spin-btn{width:clamp(52px,10vw,66px);height:clamp(52px,10vw,66px);border-radius:50%;background:radial-gradient(circle at 38% 38%,#5599ff,#1144cc);border:3px solid #88bbff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s,opacity .2s,box-shadow .2s;box-shadow:0 4px 16px rgba(30,80,220,.55),inset 0 1px 0 rgba(255,255,255,.25);flex-shrink:0}
.spin-btn:hover:not(:disabled){transform:scale(1.08)}
.spin-btn:active:not(:disabled){transform:scale(.93)}
.spin-btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.spin-icon{font-size:26px;color:#fff;display:block;transition:transform .4s}
.spin-btn.spinning-anim .spin-icon{animation:rotateSpin .5s linear infinite}
@keyframes rotateSpin{to{transform:rotate(360deg)}}
.controls-row{display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:6px}
.auto-group{display:flex;align-items:center;gap:6px}
.auto-select{background:rgba(0,0,0,.4);border:1px solid rgba(255,215,0,.25);border-radius:20px;color:var(--text-muted);font-size:12px;font-family:'Nunito',sans-serif;padding:4px 10px;cursor:pointer;outline:none;appearance:none;-webkit-appearance:none}
.auto-select option{background:#2d0845}
.auto-btn{background:linear-gradient(135deg,rgba(255,215,0,.15),rgba(255,150,0,.1));border:1px solid rgba(255,215,0,.3);border-radius:20px;color:var(--gold);font-size:12px;font-weight:700;font-family:'Nunito',sans-serif;padding:4px 14px;cursor:pointer;transition:background .15s}
.auto-btn:hover{background:rgba(255,215,0,.2)}
.auto-btn.active{background:rgba(255,80,80,.2);border-color:rgba(255,80,80,.4);color:#ff8080}
.auto-counter{font-size:11px;color:var(--text-muted);min-width:55px}
.sound-btn{background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.15);border-radius:50%;width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--text-muted);transition:background .15s}
.sound-btn:hover{background:rgba(255,255,255,.1)}
.sound-btn.on{color:var(--gold)}
.msg-bar{margin-top:8px;height:22px;text-align:center;font-size:13px;font-weight:800;letter-spacing:1px;color:var(--gold);text-shadow:0 0 8px rgba(255,215,0,.5);transition:opacity .3s}
.msg-bar.big-win{font-size:15px;color:#fff;text-shadow:0 0 12px var(--gold),0 0 24px var(--gold);animation:msgPulse .4s ease infinite alternate}
@keyframes msgPulse{from{opacity:.7}to{opacity:1}}
.paytable{display:flex;flex-wrap:wrap;gap:5px;justify-content:center;margin-top:8px}
.pay-item{background:rgba(0,0,0,.28);border:1px solid rgba(255,215,0,.12);border-radius:8px;padding:3px 7px;font-size:11px;color:#ccc;display:flex;align-items:center;gap:3px;white-space:nowrap}
.pay-item .sym{font-size:14px}
.pay-item .pay{color:var(--gold);font-weight:700}
@media(max-width:400px){.paytable{display:none}}
</style>
</head>
<body>
<div class="sky"></div>
<div class="clouds">
  <div class="cloud"></div><div class="cloud"></div><div class="cloud"></div>
  <div class="cloud"></div><div class="cloud"></div><div class="cloud"></div>
</div>
<div class="sparkle-layer" id="sparkleLayer"></div>
<div class="game-root">
  <div class="top-bar">
    <span class="tb-btn tb-user">👤 ${session.username}</span>
    <a href="/logout" class="tb-btn">🚪 Logout</a>
  </div>
  <div class="title-wrap">
    <span class="title-classic">Classic</span>
    <span class="title-slots">SLOTS</span>
  </div>
  <div class="machine-outer">
    <div class="machine-inner" style="position:relative">
      <div class="gem gem-tl"></div><div class="gem gem-tr"></div>
      <div class="gem gem-bl"></div><div class="gem gem-br"></div>
      <div class="reels-wrap" id="reelsWrap">
        <div class="row-lines" id="rowLines">
          <div class="row-line" id="rl0" style="top:16.5%"></div>
          <div class="row-line" id="rl1" style="top:49.5%"></div>
          <div class="row-line" id="rl2" style="top:82.5%"></div>
        </div>
        <div class="reels-grid" id="reelsGrid"></div>
        <div class="win-badge" id="winBadge"></div>
      </div>
      <div class="bottom-bar">
        <div class="stat-block">
          <div class="stat-label">Balance</div>
          <div class="stat-value" id="balDisplay">…<span class="stat-star">★</span></div>
        </div>
        <div class="bet-group">
          <button class="btn-round" id="betMinus">−</button>
          <div class="bet-center">
            <div class="stat-label">Bet</div>
            <div class="stat-value" id="betDisplay">5.00K<span class="stat-star">★</span></div>
          </div>
          <button class="btn-round" id="betPlus">+</button>
        </div>
        <button class="spin-btn" id="spinBtn"><span class="spin-icon">↻</span></button>
      </div>
      <div class="controls-row">
        <div class="auto-group">
          <select class="auto-select" id="autoSelect">
            <option value="0">Auto</option>
            <option value="5">5×</option>
            <option value="10">10×</option>
            <option value="25">25×</option>
            <option value="50">50×</option>
            <option value="100">100×</option>
          </select>
          <button class="auto-btn" id="autoBtn">▶ Start</button>
          <span class="auto-counter" id="autoCounter"></span>
        </div>
        <button class="sound-btn on" id="soundBtn">🔊</button>
      </div>
      <div class="msg-bar" id="msgBar">Welcome, ${session.username}! 🎰</div>
      <div class="paytable">
        <div class="pay-item"><span class="sym">🍒</span>×3 <span class="pay">5×</span></div>
        <div class="pay-item"><span class="sym">🍓</span>×3 <span class="pay">8×</span></div>
        <div class="pay-item"><span class="sym">🍇</span>×3 <span class="pay">10×</span></div>
        <div class="pay-item"><span class="sym">🍌</span>×3 <span class="pay">12×</span></div>
        <div class="pay-item"><span class="sym">🍑</span>×3 <span class="pay">15×</span></div>
        <div class="pay-item"><span class="sym">7️⃣</span>×3 <span class="pay">25×</span></div>
        <div class="pay-item"><span class="sym">💎</span>×3 <span class="pay">50×</span></div>
        <div class="pay-item"><span class="sym">🔔</span><span class="pay">WILD</span></div>
        <div class="pay-item"><span class="sym">⭐</span>×3 <span class="pay">SCATTER</span></div>
      </div>
    </div>
  </div>
</div>
<script>
// UPDATED: bet levels fixed dalam perak, filter sesuai minBet/maxBet dari settings
const CFG={
  minBet:${settings.minBet},
  maxBet:${settings.maxBet},
  betLevels:[5000,10000,25000,50000,125000,150000,500000].filter(v=>v>=${settings.minBet}&&v<=${settings.maxBet})
};
if(CFG.betLevels.length===0)CFG.betLevels=[CFG.minBet];

let audioCtx=null,soundOn=true;
function getCtx(){if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();return audioCtx}
function playTone(freq,type,dur,gain=.3,start=0){if(!soundOn)return;try{const c=getCtx(),t=c.currentTime+start,o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);o.type=type;o.frequency.setValueAtTime(freq,t);g.gain.setValueAtTime(gain,t);g.gain.exponentialRampToValueAtTime(.0001,t+dur);o.start(t);o.stop(t+dur)}catch(e){}}
function playClick(){playTone(800,'square',.05,.15)}
function playSpinTick(){playTone(200+Math.random()*80,'sawtooth',.07,.07)}
function playReelStop(i){const f=[300,340,380,420,460];playTone(f[i],'triangle',.15,.25)}
// UPDATED: threshold 200K (dalam perak)
function playWinSound(amt){if(!soundOn)return;const notes=amt>200000?[523,659,784,1047,1319]:[523,659,784,880];notes.forEach((f,i)=>playTone(f,'sine',.25,.3,i*.1))}
function playNoWin(){playTone(200,'sawtooth',.18,.15);setTimeout(()=>playTone(160,'sawtooth',.18,.15),100)}
function playBtn(){playTone(600,'sine',.08,.18)}
const SYMS=['🍒','🍓','🍇','🍌','🍑','7️⃣','💎','🔔','⭐'];
const ROWS=3,COLS=5;
// UPDATED: mulai dari betIdx=0 (5K)
let balance=0,betIdx=0,bet=CFG.betLevels[0],spinning=false,autoLeft=0,autoTimer=null;
let grid=Array.from({length:COLS},()=>Array(ROWS).fill('🍒'));
const rg=document.getElementById('reelsGrid');
function buildGrid(){rg.innerHTML='';for(let c=0;c<COLS;c++){const col=document.createElement('div');col.style.cssText='display:flex;flex-direction:column;gap:5px';for(let r=0;r<ROWS;r++){const cell=document.createElement('div');cell.className='cell';cell.id='c_'+c+'_'+r;cell.textContent=grid[c][r];col.appendChild(cell)}rg.appendChild(col)}}
buildGrid();
function cel(c,r){return document.getElementById('c_'+c+'_'+r)}
// UPDATED: tampilkan dalam K
function fmtK(v){return (v/1000).toFixed(2)+'K<span class="stat-star">★</span>'}
function updBal(){document.getElementById('balDisplay').innerHTML=fmtK(balance)}
function updBet(){
  document.getElementById('betDisplay').innerHTML=fmtK(bet);
  // UPDATED: disable − di level terkecil, disable + kalau level berikutnya > saldo
  document.getElementById('betMinus').disabled=(betIdx<=0);
  const nextBet=CFG.betLevels[betIdx+1];
  document.getElementById('betPlus').disabled=(betIdx>=CFG.betLevels.length-1)||(nextBet!==undefined&&nextBet>balance);
}
fetch('/api/me').then(r=>r.json()).then(d=>{
  balance=d.balance||0;
  // UPDATED: turunkan bet ke level yang mampu setelah dapat saldo
  while(betIdx>0&&bet>balance){betIdx--;bet=CFG.betLevels[betIdx];}
  updBal();updBet();
});
function setMsg(t,big=false){const e=document.getElementById('msgBar');e.textContent=t;e.classList.toggle('big-win',big)}
function clearWins(){for(let c=0;c<COLS;c++)for(let r=0;r<ROWS;r++){const e=cel(c,r);if(e)e.classList.remove('winner','scatter-hit')}[0,1,2].forEach(i=>{const e=document.getElementById('rl'+i);if(e)e.classList.remove('active')});const b=document.getElementById('winBadge');b.classList.remove('show');setTimeout(()=>b.classList.remove('hide'),300)}
function spawnCoins(n=8){const w=document.getElementById('reelsWrap');const cx=w.clientWidth/2,cy=w.clientHeight/2;for(let i=0;i<n;i++){const c=document.createElement('div');c.className='coin';c.textContent=['🪙','💰','💵'][Math.floor(Math.random()*3)];const a=(Math.PI*2/n)*i+Math.random()*.5,d=60+Math.random()*80;const tx=Math.cos(a)*d,ty=-(Math.abs(Math.sin(a))*d+40);c.style.cssText='left:'+cx+'px;top:'+cy+'px;--tx:translate('+tx+'px,'+ty+'px);animation-delay:'+Math.random()*.2+'s';w.appendChild(c);setTimeout(()=>c.remove(),1400)}}
function showSparkles(){const l=document.getElementById('sparkleLayer');l.classList.add('active');l.innerHTML='';const cols=['#FFD700','#FF69B4','#00FFFF','#FF4500','#7FFF00'];for(let i=0;i<60;i++){const s=document.createElement('div');s.className='spark';const x=Math.random()*100,y=Math.random()*100,tx=(Math.random()-.5)*300,ty=(Math.random()-1.2)*400;s.style.cssText='left:'+x+'%;top:'+y+'%;background:'+cols[i%5]+';--tx:translate('+tx+'px,'+ty+'px);animation-delay:'+Math.random()*.4+'s;animation-duration:'+(0.8+Math.random()*.8)+'s';l.appendChild(s)}setTimeout(()=>{l.classList.remove('active');l.innerHTML=''},2200)}
async function animateReels(serverGrid){const DURS=[350,450,550,650,750],TICK=60;const promises=[];for(let c=0;c<COLS;c++){promises.push(new Promise(res=>{let elapsed=0,tick=0;const iv=setInterval(()=>{for(let r=0;r<ROWS;r++){const e=cel(c,r);if(e){e.classList.add('spinning-cell');e.textContent=SYMS[Math.floor(Math.random()*SYMS.length)]}}tick++;if(tick%2===0)playSpinTick();elapsed+=TICK;if(elapsed>=DURS[c]){clearInterval(iv);for(let r=0;r<ROWS;r++){grid[c][r]=serverGrid[c][r];const e=cel(c,r);if(e){e.classList.remove('spinning-cell');e.textContent=serverGrid[c][r]}}playReelStop(c);res()}},TICK)}))}await Promise.all(promises)}
async function doSpin(){
  if(spinning)return;
  // UPDATED: auto-turunkan bet ke level yang mampu sebelum spin
  while(betIdx>0&&bet>balance){betIdx--;bet=CFG.betLevels[betIdx];}
  if(balance<bet){setMsg('💸 Saldo tidak cukup!');stopAuto();return}
  spinning=true;
  document.getElementById('spinBtn').disabled=true;
  document.getElementById('spinBtn').classList.add('spinning-anim');
  clearWins();setMsg('Spinning…');
  let result;
  try{
    const res=await fetch('/api/spin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bet})});
    result=await res.json();
    if(result.error){setMsg('⚠ '+result.error);spinning=false;document.getElementById('spinBtn').disabled=false;document.getElementById('spinBtn').classList.remove('spinning-anim');stopAuto();return}
  }catch(e){setMsg('⚠ Network error');spinning=false;document.getElementById('spinBtn').disabled=false;document.getElementById('spinBtn').classList.remove('spinning-anim');stopAuto();return}
  balance=result.balance;
  await animateReels(result.grid);
  updBal();
  // UPDATED: sinkronkan bet setelah saldo berubah
  while(betIdx>0&&bet>balance){betIdx--;bet=CFG.betLevels[betIdx];}
  updBet();
  if(result.win>0){
    result.winRows.forEach(r=>{document.getElementById('rl'+r)?.classList.add('active');for(let c=0;c<COLS;c++)cel(c,r)?.classList.add('winner')});
    if(result.scatCount>=3)for(let c=0;c<COLS;c++)for(let r=0;r<ROWS;r++){if(grid[c][r]==='⭐')cel(c,r)?.classList.add('scatter-hit')}
    const badge=document.getElementById('winBadge');
    // UPDATED: tampilkan win dalam K
    badge.textContent='+'+(result.win/1000).toFixed(2)+'K';
    requestAnimationFrame(()=>badge.classList.add('show'));
    // UPDATED: threshold coin banyak di 100K
    spawnCoins(result.win>100000?14:8);
    playWinSound(result.win);
    if(result.win>=bet*10){showSparkles();setMsg('🎉 BIG WIN! +'+(result.win/1000).toFixed(2)+'K★',true)}
    else setMsg('✨ WIN! +'+(result.win/1000).toFixed(2)+'K★');
    setTimeout(()=>{badge.classList.add('hide');badge.classList.remove('show')},2500)
  }else{playNoWin();setMsg('No win — try again!')}
  spinning=false;
  document.getElementById('spinBtn').disabled=false;
  document.getElementById('spinBtn').classList.remove('spinning-anim');
  if(autoLeft>0){
    autoLeft--;updAutoCounter();
    // UPDATED: stop auto kalau saldo sudah tidak cukup
    if(autoLeft===0||balance<bet)stopAuto();
    else autoTimer=setTimeout(doSpin,900)
  }
}
function updAutoCounter(){const e=document.getElementById('autoCounter');e.textContent=autoLeft>0?autoLeft+' left':''}
function startAuto(){const v=parseInt(document.getElementById('autoSelect').value);if(v===0)return;autoLeft=v;updAutoCounter();const b=document.getElementById('autoBtn');b.textContent='■ Stop';b.classList.add('active');document.getElementById('betMinus').disabled=true;document.getElementById('betPlus').disabled=true;doSpin()}
function stopAuto(){autoLeft=0;clearTimeout(autoTimer);updAutoCounter();const b=document.getElementById('autoBtn');b.textContent='▶ Start';b.classList.remove('active');updBet();}
document.getElementById('spinBtn').addEventListener('click',()=>{playBtn();if(!autoLeft)doSpin()});
document.getElementById('betMinus').addEventListener('click',()=>{
  if(betIdx<=0)return;
  playClick();betIdx--;bet=CFG.betLevels[betIdx];updBet();
});
document.getElementById('betPlus').addEventListener('click',()=>{
  const next=betIdx+1;
  // UPDATED: tidak boleh naik kalau level berikutnya melebihi saldo
  if(next>=CFG.betLevels.length||CFG.betLevels[next]>balance)return;
  playClick();betIdx=next;bet=CFG.betLevels[betIdx];updBet();
});
document.getElementById('autoBtn').addEventListener('click',()=>{playBtn();autoLeft>0?stopAuto():startAuto()});
document.getElementById('soundBtn').addEventListener('click',()=>{soundOn=!soundOn;const b=document.getElementById('soundBtn');b.textContent=soundOn?'🔊':'🔇';b.classList.toggle('on',soundOn);playClick()});
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!spinning&&!autoLeft){e.preventDefault();playBtn();doSpin()}});
updBet();
</script>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/' && method === 'GET') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'user') return redirect('/login');
      const settings = await getSettings(env);
      return html(HTML_GAME(sess, settings));
    }
    if (path === '/login' && method === 'GET') {
      const sess = await getSession(request, env);
      if (sess?.role === 'user') return redirect('/');
      return html(pageLogin());
    }
    if (path === '/login' && method === 'POST') {
      const form = await request.formData();
      const username = (form.get('username') || '').trim().toLowerCase();
      const password = form.get('password') || '';
      if (!username || !password) return html(pageLogin('Username dan password wajib diisi'));
      const user = await getUser(env, username);
      if (!user) return html(pageLogin('Username tidak ditemukan'));
      if (user.banned) return html(pageLogin('Akun kamu telah dibanned'));
      const hash = await hashPwd(password);
      if (user.passwordHash !== hash) return html(pageLogin('Password salah'));
      const cookie = await makeSession({ username: user.username, role: 'user' }, env);
      return redirect('/', { 'Set-Cookie': cookie });
    }
    if (path === '/register' && method === 'GET') return redirect('/login?tab=register');
    if (path === '/register' && method === 'POST') {
      const form = await request.formData();
      const username = (form.get('username') || '').trim().toLowerCase();
      const password = form.get('password') || '';
      const confirm = form.get('confirm') || '';
      if (!username || username.length < 3) return html(pageLogin('Username min 3 karakter'));
      if (!/^[a-z0-9_]+$/.test(username)) return html(pageLogin('Username hanya boleh huruf, angka, underscore'));
      if (password.length < 6) return html(pageLogin('Password min 6 karakter'));
      if (password !== confirm) return html(pageLogin('Password tidak sama'));
      const existing = await getUser(env, username);
      if (existing) return html(pageLogin('Username sudah dipakai'));
      const settings = await getSettings(env);
      // UPDATED: fallback saldo awal 100K
      const user = { username, passwordHash: await hashPwd(password), balance: settings.startBalance || 100000, totalBet: 0, totalWin: 0, spins: 0, banned: false, createdAt: Date.now() };
      await putUser(env, username, user);
      const cookie = await makeSession({ username, role: 'user' }, env);
      return redirect('/', { 'Set-Cookie': cookie });
    }
    if (path === '/logout') return redirect('/login', { 'Set-Cookie': clearSession() });
    if (path === '/api/me' && method === 'GET') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'user') return json({ error: 'Unauthorized' }, 401);
      const user = await getUser(env, sess.username);
      return json({ balance: user?.balance || 0, username: sess.username });
    }
    if (path === '/api/spin' && method === 'POST') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'user') return json({ error: 'Unauthorized' }, 401);
      const user = await getUser(env, sess.username);
      if (!user) return json({ error: 'User tidak ditemukan' }, 404);
      if (user.banned) return json({ error: 'Akun kamu dibanned' }, 403);
      const body = await request.json();
      const bet = parseFloat(body.bet);
      const settings = await getSettings(env);
      if (isNaN(bet) || bet < settings.minBet || bet > settings.maxBet) return json({ error: `Bet harus antara ${settings.minBet} - ${settings.maxBet}` });
      if (user.balance < bet) return json({ error: 'Saldo tidak cukup' });
      user.balance -= bet;
      const grid = spinGrid(settings);
      const { win, winRows, scatCount } = calcWin(grid, bet, settings);
      user.balance = parseFloat((user.balance + win).toFixed(2));
      user.totalBet = parseFloat(((user.totalBet || 0) + bet).toFixed(2));
      user.totalWin = parseFloat(((user.totalWin || 0) + win).toFixed(2));
      user.spins = (user.spins || 0) + 1;
      await putUser(env, sess.username, user);
      return json({ grid, win, winRows, scatCount, balance: user.balance });
    }
    if (path === '/admin/login' && method === 'GET') {
      const sess = await getSession(request, env);
      if (sess?.role === 'admin') return redirect('/admin');
      return html(pageAdminLogin());
    }
    if (path === '/admin/login' && method === 'POST') {
      const form = await request.formData();
      const password = form.get('password') || '';
      const adminPassword = env.ADMIN_PASSWORD || 'admin123';
      if (password !== adminPassword) return html(pageAdminLogin('Password admin salah'));
      const cookie = await makeSession({ username: 'admin', role: 'admin' }, env);
      return redirect('/admin', { 'Set-Cookie': cookie });
    }
    if (path === '/admin' && method === 'GET') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'admin') return redirect('/admin/login');
      const [users, settings] = await Promise.all([listUsers(env), getSettings(env)]);
      return html(pageAdmin(users, settings));
    }
    if (path === '/admin/logout') return redirect('/admin/login', { 'Set-Cookie': clearSession() });
    if (path === '/admin/api/settings' && method === 'POST') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
      const body = await request.json();
      const current = await getSettings(env);
      const updated = { ...current, minBet: +body.minBet || current.minBet, maxBet: +body.maxBet || current.maxBet, startBalance: +body.startBalance ?? current.startBalance, scatterMult: +body.scatterMult || current.scatterMult, rtp: Math.min(99, Math.max(50, +body.rtp || current.rtp)), winBoost: +body.winBoost, loseForce: +body.loseForce };
      await putSettings(env, updated);
      return json({ ok: true });
    }
    if (path === '/admin/api/override' && method === 'POST') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
      const body = await request.json();
      const current = await getSettings(env);
      await putSettings(env, { ...current, winBoost: +body.winBoost, loseForce: +body.loseForce, rtp: Math.min(99, Math.max(50, +body.rtp || current.rtp)) });
      return json({ ok: true });
    }
    if (path === '/admin/api/set-balance' && method === 'POST') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
      const { username, balance } = await request.json();
      const user = await getUser(env, username);
      if (!user) return json({ error: 'User tidak ditemukan' });
      user.balance = parseFloat(parseFloat(balance).toFixed(2));
      await putUser(env, username, user);
      return json({ ok: true });
    }
    if (path === '/admin/api/ban' && method === 'POST') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
      const { username, banned } = await request.json();
      const user = await getUser(env, username);
      if (!user) return json({ error: 'User tidak ditemukan' });
      user.banned = !!banned;
      await putUser(env, username, user);
      return json({ ok: true });
    }
    if (path === '/admin/api/delete-user' && method === 'POST') {
      const sess = await getSession(request, env);
      if (!sess || sess.role !== 'admin') return json({ error: 'Unauthorized' }, 401);
      const { username } = await request.json();
      await env.SLOTS_KV.delete('user:' + username.toLowerCase());
      return json({ ok: true });
    }
    return new Response('Not Found', { status: 404 });
  }
};
