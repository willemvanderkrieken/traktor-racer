// Tiny zero-dependency server for Traktor Racer.
// - serves the game (traktor-racer.html) at /
// - POST /api/result   {distance, convoy}      -> aggregates 4 global stats
// - POST /api/progress {n, distance}           -> per-run telemetry (furthest reached), used to validate a score
// - GET  /api/score-token                      -> a fresh HMAC-signed {t, n, sig} for a run
// - POST /api/score     {name,distance,trekkers,t,n,sig} -> validated highscore submission
// - GET  /api/scores                           -> public top-20 leaderboard
// - GET  /stats?key=… / /api/stats?key=…       -> private owner stats
//
// Deleting scores is NOT a web endpoint (see admin-scores.cjs, run in the container).
// Secrets have NO in-code defaults: the server refuses to start without strong env vars.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT       = process.env.PORT || 3000;
const DATA_DIR   = process.env.DATA_DIR || '/data';
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const SCORES_FILE= path.join(DATA_DIR, 'scores.json');
const GAME_FILE  = path.join(__dirname, 'traktor-racer.html');

// --- secrets: NEVER a public/repo default. Use a strong env var if given; otherwise generate a
// strong random secret once and persist it in the /data volume (not in the repo). Fail-safe: the
// server always starts, but it can never fall back to a value that is knowable from the source code. ---
try { fs.mkdirSync(DATA_DIR, { recursive:true }); } catch(e){}
function validEnv(name){
  const v = process.env[name];
  const placeholder = /^(changeme|change-me|change_me|placeholder|secret|password|example|test|GCMumtU50oNOrqTpLig2)$/i;
  return (v && v.length >= 16 && !placeholder.test(v)) ? v : null;
}
function persistentSecret(fileName){
  const p = path.join(DATA_DIR, fileName);
  try { const v = String(fs.readFileSync(p,'utf8')).trim(); if(v && v.length >= 16) return v; } catch(e){}
  const v = crypto.randomBytes(24).toString('base64url');
  try { fs.writeFileSync(p, v, { mode:0o600 }); } catch(e){}
  return v;
}
// signs the run start-tokens; nobody needs to know it -> env if set, else auto-generated + persisted
const SIGN_SECRET = validEnv('SIGN_SECRET') || persistentSecret('.sign_secret');
// protects the private /stats page; the owner needs to know it -> env if set, else a persisted random key
const STATS_KEY   = validEnv('STATS_KEY')   || persistentSecret('.stats_key');
if(!validEnv('SIGN_SECRET')) console.warn('note: SIGN_SECRET not set via env; using the persisted key in ' + DATA_DIR + '/.sign_secret');
if(!validEnv('STATS_KEY'))   console.warn('note: STATS_KEY not set via env; /stats uses a persisted random key until you set STATS_KEY.');
const ALLOW_ORIGIN= process.env.ALLOW_ORIGIN || 'https://totrit.inboekel.nl';

const TOKEN_TTL_MS = 60*60*1000;   // a start-token is valid for 60 minutes
const MAX_MPS      = 150;          // plausibility: max metres/second -> minimum plausible run time
const MAX_DISTANCE = 2000000;      // absolute sanity cap (m)
const DIST_MARGIN  = 120;          // telemetry tolerance (m)
const MAX_SCORES   = 500;

const usedNonces  = new Map();     // nonce -> time used (replay guard, leaderboard)
const runCounted  = new Map();     // nonce -> time counted into the validated stats (each run counts once)
const runProgress = new Map();     // nonce -> { dist, ts } furthest distance the run actually reported
function hmac(secret, msg){ return crypto.createHmac('sha256', secret).update(msg).digest('hex'); }
function eqHex(a, b){ a=String(a||''); b=String(b||''); if(a.length!==b.length || !a) return false; try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch(e){ return false; } }

// --- simple in-memory per-IP rate limiting ---
const rl = new Map();   // ip -> { count, start }
function rateLimited(ip, limit, windowMs){
  const now = Date.now(); let e = rl.get(ip);
  if(!e || now - e.start > windowMs){ e = { count:0, start:now }; rl.set(ip, e); }
  e.count++; return e.count > limit;
}
function clientIp(req){
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

let stats = { plays:0, bestDistance:0, longestConvoy:0, totalTractors:0, updated:null };
let scores = [];         // [{name, distance, trekkers, ts}]  sorted high->low by distance
try { fs.mkdirSync(DATA_DIR, { recursive:true }); } catch(e){}
try { Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE,'utf8'))); } catch(e){}
try { const s = JSON.parse(fs.readFileSync(SCORES_FILE,'utf8')); if(Array.isArray(s)) scores = s; } catch(e){}
// buffered + atomic persistence flags (declared before the seed below uses `dirty`)
let dirty = false, scoresDirty = false, lastSelfWrite = 0;
// validated stats: forward-looking trust counters (grow from the moment the anti-cheat went live).
// the record baseline (best/longest) is seeded from the existing leaderboard so the fraud-check is meaningful.
if(!stats.valid){
  const named = scores.filter(isNamed);
  stats.valid = {
    since: Date.now(),
    plays: 0, totalDistance: 0, totalTractors: 0,
    bestDistance:  named.reduce((m,s)=>Math.max(m, s.distance), 0),
    longestConvoy: named.reduce((m,s)=>Math.max(m, s.trekkers), 0)
  };
  dirty = true;
} else if(stats.valid.since === undefined){
  // migrate an earlier over-seeded version: keep the record baseline, reset the forward counters to 0
  const named = scores.filter(isNamed);
  stats.valid.since = Date.now();
  stats.valid.plays = 0; stats.valid.totalDistance = 0; stats.valid.totalTractors = 0;
  stats.valid.bestDistance  = Math.max(stats.valid.bestDistance||0,  named.reduce((m,s)=>Math.max(m,s.distance),0));
  stats.valid.longestConvoy = Math.max(stats.valid.longestConvoy||0, named.reduce((m,s)=>Math.max(m,s.trekkers),0));
  dirty = true;
}
function countValidatedRun(n, dist, trek){       // count a validated run once into the clean stats
  if(!n || runCounted.has(n)) return;
  runCounted.set(n, Date.now());
  const v = stats.valid;
  v.plays++; v.totalDistance += dist; v.totalTractors += trek;
  if(dist > v.bestDistance)  v.bestDistance  = dist;
  if(trek > v.longestConvoy) v.longestConvoy = trek;
  dirty = true;
}

function cleanName(v){
  return String(v==null?'':v).replace(/[\x00-\x1f\x7f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,24) || 'Anoniem';
}
function isNamed(s){ const n=((s&&s.name)||'').trim().toLowerCase(); return !!n && n!=='anoniem'; }

let game = '<h1>Game bestand ontbreekt</h1>';
try { game = fs.readFileSync(GAME_FILE,'utf8'); } catch(e){}

// buffered + atomic persistence (tmp file then rename) so nothing corrupts under load
function persist(){
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for(const [n,ts] of usedNonces){ if(ts < cutoff) usedNonces.delete(n); }
  for(const [n,ts] of runCounted){ if(ts < cutoff) runCounted.delete(n); }
  for(const [n,o] of runProgress){ if(o.ts < cutoff) runProgress.delete(n); }
  if(dirty){ dirty = false;
    try { const tmp = STATS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(stats)); fs.renameSync(tmp, STATS_FILE); }
    catch(e){ dirty = true; }
  }
  if(scoresDirty){ scoresDirty = false;
    try { const tmp = SCORES_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(scores)); fs.renameSync(tmp, SCORES_FILE); lastSelfWrite = Date.now(); }
    catch(e){ scoresDirty = true; }
  }
}
setInterval(persist, 2000);
process.on('SIGTERM', ()=>{ persist(); process.exit(0); });
process.on('SIGINT',  ()=>{ persist(); process.exit(0); });

// pick up external edits (the admin-scores.cjs maintenance script) without a restart
try {
  fs.watch(DATA_DIR, { persistent:false }, (ev, fname)=>{
    if(fname !== 'scores.json') return;
    if(Date.now() - lastSelfWrite < 1500) return;       // ignore our own atomic writes
    try { const s = JSON.parse(fs.readFileSync(SCORES_FILE,'utf8')); if(Array.isArray(s)) scores = s; } catch(e){}
  });
} catch(e){}

function send(res, code, type, body, origin){
  const h = { 'Content-Type':type, 'Cache-Control':'no-store' };
  if(origin && origin === ALLOW_ORIGIN) h['Access-Control-Allow-Origin'] = origin;   // same-origin only, not *
  res.writeHead(code, h); res.end(body);
}

const server = http.createServer((req,res)=>{
  let u; try { u = new URL(req.url, 'http://x'); } catch(e){ return send(res,400,'text/plain','bad'); }
  const origin = req.headers.origin || '';
  const ip = clientIp(req);

  // record a finished run (global stats)
  if(req.method==='POST' && u.pathname==='/api/result'){
    if(rateLimited(ip, 40, 60000)) return send(res,429,'text/plain','slow down', origin);
    let b=''; let abort=false;
    req.on('data', c=>{ b+=c; if(b.length>2000){ abort=true; req.destroy(); } });
    req.on('end', ()=>{
      if(abort) return;
      try{
        const d = JSON.parse(b || '{}');
        const dist = Math.max(0, Math.min(1e7, Math.floor(Number(d.distance)||0)));
        const conv = Math.max(0, Math.min(1e6, Math.floor(Number(d.convoy)||0)));
        stats.plays++;
        if(dist > stats.bestDistance)  stats.bestDistance  = dist;
        if(conv > stats.longestConvoy) stats.longestConvoy = conv;
        stats.totalTractors += conv;
        stats.totalDistance = (stats.totalDistance||0) + dist;
        stats.updated = new Date().toISOString();
        dirty = true;
      } catch(e){}
      send(res,204,'text/plain','', origin);
    });
    return;
  }

  // per-run telemetry: the game reports how far it has actually gotten (keyed by the run's nonce)
  if(req.method==='POST' && u.pathname==='/api/progress'){
    if(rateLimited(ip, 150, 60000)) return send(res,429,'text/plain','slow down', origin);
    let b=''; let abort=false;
    req.on('data', c=>{ b+=c; if(b.length>500){ abort=true; req.destroy(); } });
    req.on('end', ()=>{
      if(abort) return;
      try{
        const d = JSON.parse(b || '{}');
        const n = String(d.n||''), t = Math.floor(Number(d.t)||0);
        const dist = Math.max(0, Math.min(1e7, Math.floor(Number(d.distance)||0)));
        if(n && t){                       // reported distance can never grow faster than MAX_MPS in real time
          const now = Date.now(), prev = runProgress.get(n);
          if(!prev){
            const cap = MAX_MPS * Math.max(0, now - t)/1000 + DIST_MARGIN;         // bounded by the token's age
            runProgress.set(n, { dist: Math.min(dist, cap), ts: now });
          } else {
            const maxGain = MAX_MPS * (now - prev.ts)/1000 + DIST_MARGIN;
            runProgress.set(n, { dist: Math.max(prev.dist, Math.min(dist, prev.dist + maxGain)), ts: now });
          }
        }
      } catch(e){}
      send(res,204,'text/plain','', origin);
    });
    return;
  }

  // record a validated finished run into the clean stats (no name, not on the board).
  // fired for EVERY completed run so the clean stats also capture runs that were never submitted as a highscore.
  if(req.method==='POST' && u.pathname==='/api/run'){
    if(rateLimited(ip, 30, 60000)) return send(res,429,'text/plain','slow down', origin);
    let b=''; let abort=false;
    req.on('data', c=>{ b+=c; if(b.length>1000){ abort=true; req.destroy(); } });
    req.on('end', ()=>{
      if(abort) return;
      try{
        const d = JSON.parse(b || '{}');
        const dist = Math.max(0, Math.min(1e7, Math.floor(Number(d.distance)||0)));
        const trek = Math.max(0, Math.min(1e6, Math.floor(Number(d.trekkers)||0)));
        const t = Math.floor(Number(d.t)||0), n = String(d.n||''), sig = String(d.sig||'');
        const now = Date.now();
        const rep = runProgress.get(n);
        const ok = eqHex(sig, hmac(SIGN_SECRET, t+'.'+n)) && (now - t <= TOKEN_TTL_MS) && (t - now <= 60000)
                   && dist <= MAX_DISTANCE && (now - t) >= (dist / MAX_MPS) * 1000
                   && rep && dist <= rep.dist + DIST_MARGIN;
        if(ok) countValidatedRun(n, dist, trek);   // counts once per nonce; does NOT consume the leaderboard nonce
      } catch(e){}
      send(res,204,'text/plain','', origin);
    });
    return;
  }

  // hand out a fresh, signed start-token when a run begins
  if(u.pathname==='/api/score-token'){
    if(rateLimited(ip, 40, 60000)) return send(res,429,'application/json', JSON.stringify({error:'rate'}), origin);
    const t = Date.now(), n = crypto.randomBytes(9).toString('hex');
    return send(res,200,'application/json', JSON.stringify({ t, n, sig: hmac(SIGN_SECRET, t+'.'+n) }), origin);
  }

  // submit a highscore — validated against the run's own token + telemetry + plausible time
  if(req.method==='POST' && u.pathname==='/api/score'){
    if(rateLimited(ip, 20, 60000)) return send(res,429,'application/json', JSON.stringify({error:'rate'}), origin);
    let b=''; let abort=false;
    req.on('data', c=>{ b+=c; if(b.length>3000){ abort=true; req.destroy(); } });
    req.on('end', ()=>{
      if(abort) return;
      try{
        const d = JSON.parse(b || '{}');
        const name = cleanName(d.name);
        const dist = Math.max(0, Math.min(1e7, Math.floor(Number(d.distance)||0)));
        const trek = Math.max(0, Math.min(1e6, Math.floor(Number(d.trekkers)||0)));
        const t = Math.floor(Number(d.t)||0), n = String(d.n||''), sig = String(d.sig||'');
        const now = Date.now();
        if(!eqHex(sig, hmac(SIGN_SECRET, t+'.'+n)))    return send(res,403,'application/json', JSON.stringify({error:'bad-token'}), origin);
        if(now - t > TOKEN_TTL_MS || t - now > 60000)  return send(res,403,'application/json', JSON.stringify({error:'expired'}), origin);
        if(usedNonces.has(n))                          return send(res,403,'application/json', JSON.stringify({error:'replay'}), origin);
        if(dist > MAX_DISTANCE)                        return send(res,403,'application/json', JSON.stringify({error:'too-far'}), origin);
        if((now - t) < (dist / MAX_MPS) * 1000)        return send(res,403,'application/json', JSON.stringify({error:'too-fast'}), origin);
        const rep = runProgress.get(n);                // the run must actually have reported getting this far
        if(!rep || dist > rep.dist + DIST_MARGIN)      return send(res,403,'application/json', JSON.stringify({error:'telemetry-mismatch'}), origin);
        usedNonces.set(n, now);
        countValidatedRun(n, dist, trek);   // also count into the clean stats (once per nonce; /api/run may already have)
        const entry = { name, distance:dist, trekkers:trek, ts:Date.now() };
        scores.push(entry);
        scores.sort((a,b)=> b.distance-a.distance || a.ts-b.ts);
        if(scores.length > MAX_SCORES) scores.length = MAX_SCORES;
        scoresDirty = true;
        const named = scores.filter(isNamed);     // anonymous scores are never shown
        const top = named.slice(0, 10);
        let rank = 0, around = [], aroundFrom = 0;
        if(isNamed(entry)){
          rank = named.indexOf(entry) + 1;
          const from = Math.max(0, rank-11), to = Math.min(named.length, rank+10);
          around = named.slice(from, to); aroundFrom = from + 1;
        }
        return send(res,200,'application/json', JSON.stringify({ rank, total: named.length, top, around, aroundFrom }), origin);
      } catch(e){ return send(res,400,'application/json', JSON.stringify({error:'bad'}), origin); }
    });
    return;
  }

  // public leaderboard (top 20)
  if(u.pathname==='/api/scores'){
    return send(res,200,'application/json', JSON.stringify({ top: scores.filter(isNamed).slice(0,20) }), origin);
  }

  // private stats (owner only)
  if(u.pathname==='/api/stats' || u.pathname==='/stats'){
    if((u.searchParams.get('key')||'') !== STATS_KEY) return send(res,403,'text/plain','Forbidden', origin);
    if(u.pathname==='/api/stats') return send(res,200,'application/json', JSON.stringify(stats), origin);
    const v = stats.valid || {since:0,plays:0,totalDistance:0,totalTractors:0,bestDistance:0,longestConvoy:0};
    const named = scores.filter(isNamed);
    const lbBest  = named.reduce((m,s)=>Math.max(m, s.distance), 0);
    const lbTotal = named.reduce((a,s)=>a + s.distance, 0);
    const lbTrek  = named.reduce((a,s)=>a + s.trekkers, 0);
    const fmt = (x)=> Number(x||0).toLocaleString('nl-NL');
    const rawBest = stats.bestDistance || 0;
    const record  = Math.max(v.bestDistance||0, lbBest);      // hoogste dóór een run bevestigde afstand
    const sinceStr = v.since ? new Date(v.since).toLocaleDateString('nl-NL',{day:'numeric',month:'long',year:'numeric'}) : '—';
    const flag = rawBest > record
      ? `<div class=warn>⚠️ Ruw gemeld record: <b>${fmt(rawBest)} m</b>, maar het hoogste dóór een echte run bevestigde record is <b>${fmt(record)} m</b>. Dat verschil is door geen enkele gespeelde run onderbouwd — waarschijnlijk rechtstreeks naar de statistieken gestuurd.</div>`
      : '';
    const html = `<!doctype html><html lang=nl><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>T.O.T.-rit Boekel — statistieken</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef3e6;color:#2b3a2f;margin:0;padding:22px}
.c{max-width:460px;margin:0 auto 18px;background:#fff;border-radius:18px;padding:20px 22px;box-shadow:0 10px 34px rgba(0,0,0,.12);border:3px solid #ffcf33}
.c.rec{border-color:#9ccc9e}.c.val{border-color:#8fbfe0}
h1{color:#2e7d32;font-size:21px;margin:0 0 12px;text-align:center}h2{font-size:16px;margin:0 0 4px;color:#2e7d32}
.sub{color:#8a9a8c;font-size:12px;margin:0 0 10px}
.s{display:flex;justify-content:space-between;align-items:baseline;padding:11px 2px;border-bottom:2px solid #eef3e6}
.s:last-of-type{border-bottom:none}.s .l{color:#6b7d6e;font-weight:800;font-size:14px}
.s .n{color:#e65100;font-weight:900;font-size:24px;font-variant-numeric:tabular-nums}
.warn{max-width:460px;margin:0 auto 14px;background:#fff4f4;border:2px solid #e0a0a0;border-radius:12px;padding:12px 14px;color:#8a3b3b;font-size:13px;line-height:1.4}
small{color:#8a9a8c}</style>
<h1>🚜 T.O.T.-rit Boekel — statistieken</h1>
${flag}
<div class="c"><h2>🚜 Community — alle runs</h2><p class=sub>Alle gespeelde runs sinds de start (ongefilterd geteld).</p>
<div class=s><span class=l>Keren gespeeld</span><span class=n>${fmt(stats.plays)}</span></div>
<div class=s><span class=l>Langste stoet</span><span class=n>${fmt(stats.longestConvoy)} 🚜</span></div>
<div class=s><span class=l>Tractoren totaal</span><span class=n>${fmt(stats.totalTractors)}</span></div></div>
<div class="c rec"><h2>🏁 Highscore-records</h2><p class=sub>Uit het bord — bevestigde inzendingen.</p>
<div class=s><span class=l>Beste afstand</span><span class=n>${fmt(lbBest)} m</span></div>
<div class=s><span class=l>Afstand — alle records samen</span><span class=n>${fmt(lbTotal)} m</span></div>
<div class=s><span class=l>Trekkers — alle records samen</span><span class=n>${fmt(lbTrek)}</span></div>
<div class=s><span class=l>Aantal highscores</span><span class=n>${fmt(named.length)}</span></div></div>
<div class="c val"><h2>✅ Gevalideerd — sinds ${sinceStr}</h2><p class=sub>Runs die de anti-cheat doorstaan; groeit vanaf het inschakelen van de beveiliging.</p>
<div class=s><span class=l>Gevalideerde runs</span><span class=n>${fmt(v.plays)}</span></div>
<div class=s><span class=l>Afstand — iedereen samen</span><span class=n>${fmt(v.totalDistance)} m</span></div>
<div class=s><span class=l>Tractoren</span><span class=n>${fmt(v.totalTractors)}</span></div>
<div class=s><span class=l>Verste afstand (bevestigd)</span><span class=n>${fmt(record)} m</span></div></div>
<p style="text-align:center"><small>Laatst bijgewerkt: ${stats.updated || '—'}</small></p></html>`;
    return send(res,200,'text/html; charset=utf-8', html, origin);
  }

  if(u.pathname==='/healthz') return send(res,200,'text/plain','ok', origin);
  // serve the game for the homepage and for clean challenge links like /u/Naam/1240
  if(req.method==='GET') return send(res,200,'text/html; charset=utf-8', game, origin);
  return send(res,404,'text/plain','Not found', origin);
});

server.listen(PORT, ()=> console.log('Traktor Racer server on :'+PORT));
