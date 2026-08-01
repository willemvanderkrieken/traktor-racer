// Tiny zero-dependency server for Traktor Racer.
// - serves the game (traktor-racer.html) at /
// - POST /api/result  {distance, convoy}  -> aggregates 4 global stats in memory
// - GET  /stats?key=…  -> private stats page (only the owner, via secret key)
// - GET  /api/stats?key=…  -> same stats as JSON
// Stats are kept in memory (safe under concurrency: Node is single-threaded, so each
// request's read-modify-write runs without interleaving) and persisted atomically.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 3000;
const KEY       = process.env.STATS_KEY || 'GCMumtU50oNOrqTpLig2';   // override via env in production
const ADMIN_USER= process.env.ADMIN_USER || 'boekel';                 // admin login for deleting scores
const ADMIN_PASS= process.env.ADMIN_PASS || 'trekker-'+ (process.env.STATS_KEY || 'GCMumtU50oNOrqTpLig2');  // override via env!
const DATA_DIR  = process.env.DATA_DIR || '/data';
const STATS_FILE= path.join(DATA_DIR, 'stats.json');
const SCORES_FILE= path.join(DATA_DIR, 'scores.json');
const GAME_FILE = path.join(__dirname, 'traktor-racer.html');

const MAX_SCORES = 500;  // how many we keep on disk (so a player's rank + neighbours stay meaningful)

let stats = { plays:0, bestDistance:0, longestConvoy:0, totalTractors:0, updated:null };
let scores = [];         // [{name, distance, trekkers, ts}]  sorted high->low by distance
try { fs.mkdirSync(DATA_DIR, { recursive:true }); } catch(e){}
try { Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE,'utf8'))); } catch(e){}
try { const s = JSON.parse(fs.readFileSync(SCORES_FILE,'utf8')); if(Array.isArray(s)) scores = s; } catch(e){}

function cleanName(v){
  return String(v==null?'':v).replace(/[\x00-\x1f\x7f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,24) || 'Anoniem';
}
// a score is only shown on the leaderboard if it has a real name (anonymous ones are hidden)
function isNamed(s){ const n=((s&&s.name)||'').trim().toLowerCase(); return !!n && n!=='anoniem'; }

let game = '<h1>Game bestand ontbreekt</h1>';
try { game = fs.readFileSync(GAME_FILE,'utf8'); } catch(e){}

// buffered + atomic persistence (tmp file then rename) so nothing corrupts under load
let dirty = false, scoresDirty = false;
// one-time data fix: give the record-holder a proper name (idempotent — only matches while still 'Anoniem')
{ const rec = scores.find(s=> s.ts===1785566034117); if(rec && rec.name==='Anoniem'){ rec.name='Sanne van den Elzen'; scoresDirty=true; } }
// one-time cleanup: remove the fake #1 record (ZZ-TEST-CLAUDE, 999999 m) — idempotent
{ const i = scores.findIndex(s=> s.ts===1785580257558); if(i>=0){ scores.splice(i,1); scoresDirty=true; } }
function persist(){
  if(dirty){ dirty = false;
    try { const tmp = STATS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(stats)); fs.renameSync(tmp, STATS_FILE); }
    catch(e){ dirty = true; }
  }
  if(scoresDirty){ scoresDirty = false;
    try { const tmp = SCORES_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(scores)); fs.renameSync(tmp, SCORES_FILE); }
    catch(e){ scoresDirty = true; }
  }
}
setInterval(persist, 2000);
process.on('SIGTERM', ()=>{ persist(); process.exit(0); });
process.on('SIGINT',  ()=>{ persist(); process.exit(0); });

function send(res, code, type, body){
  res.writeHead(code, { 'Content-Type':type, 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' });
  res.end(body);
}

const server = http.createServer((req,res)=>{
  let u; try { u = new URL(req.url, 'http://x'); } catch(e){ return send(res,400,'text/plain','bad'); }

  // record a finished run
  if(req.method==='POST' && u.pathname==='/api/result'){
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
        stats.updated = new Date().toISOString();
        dirty = true;
      } catch(e){}
      send(res,204,'text/plain','');
    });
    return;
  }

  // submit a highscore (name only) — returns the top list + the player's rank
  if(req.method==='POST' && u.pathname==='/api/score'){
    let b=''; let abort=false;
    req.on('data', c=>{ b+=c; if(b.length>3000){ abort=true; req.destroy(); } });
    req.on('end', ()=>{
      if(abort) return;
      try{
        const d = JSON.parse(b || '{}');
        const name = cleanName(d.name);
        const dist = Math.max(0, Math.min(1e7, Math.floor(Number(d.distance)||0)));
        const trek = Math.max(0, Math.min(1e6, Math.floor(Number(d.trekkers)||0)));
        const entry = { name, distance:dist, trekkers:trek, ts:Date.now() };
        scores.push(entry);
        scores.sort((a,b)=> b.distance-a.distance || a.ts-b.ts);
        if(scores.length > MAX_SCORES) scores.length = MAX_SCORES;
        scoresDirty = true;
        const named = scores.filter(isNamed);     // anonymous scores are never shown
        const top = named.slice(0, 10);           // top 10 of the named leaderboard
        let rank = 0, around = [], aroundFrom = 0; // a window of 10 above + you + 10 below
        if(isNamed(entry)){
          rank = named.indexOf(entry) + 1;
          const from = Math.max(0, rank-11), to = Math.min(named.length, rank+10);
          around = named.slice(from, to); aroundFrom = from + 1;
        }
        return send(res,200,'application/json', JSON.stringify({ rank, total: named.length, top, around, aroundFrom }));
      } catch(e){ return send(res,400,'application/json', JSON.stringify({error:'bad'})); }
    });
    return;
  }

  // admin: delete a score, by leaderboard rank (delete-score=1) or by exact id (delete-ts=...).
  // requires user + password. Example: /admin/delete?delete-score=1&user=boekel&password=...
  if(u.pathname==='/admin/delete' || u.searchParams.has('delete-score') || u.searchParams.has('delete-ts')){
    const user = u.searchParams.get('user') || '';
    const pass = u.searchParams.get('password') || '';
    if(user !== ADMIN_USER || pass !== ADMIN_PASS){
      return send(res,403,'application/json', JSON.stringify({error:'forbidden'}));
    }
    // work on the sorted, named leaderboard (same view the public sees)
    const named = scores.filter(isNamed).slice().sort((a,b)=> b.distance-a.distance || a.ts-b.ts);
    let removed = null;
    const tsParam = u.searchParams.get('delete-ts');
    if(tsParam){
      const ts = Number(tsParam);
      const i = scores.findIndex(s=> s.ts===ts);
      if(i>=0){ removed = scores.splice(i,1)[0]; scoresDirty = true; }
    } else {
      const rank = Math.floor(Number(u.searchParams.get('delete-score')) || 0);
      const target = named[rank-1];
      if(target){ const i = scores.findIndex(s=> s.ts===target.ts); if(i>=0){ removed = scores.splice(i,1)[0]; scoresDirty = true; } }
    }
    const top = scores.filter(isNamed).slice().sort((a,b)=> b.distance-a.distance || a.ts-b.ts).slice(0,20);
    return send(res,200,'application/json', JSON.stringify({ ok: !!removed, removed, top }));
  }

  // public leaderboard (top 20)
  if(u.pathname==='/api/scores'){
    return send(res,200,'application/json', JSON.stringify({ top: scores.filter(isNamed).slice(0,20) }));
  }

  // private stats (owner only)
  if(u.pathname==='/api/stats' || u.pathname==='/stats'){
    if((u.searchParams.get('key')||'') !== KEY) return send(res,403,'text/plain','Forbidden');
    if(u.pathname==='/api/stats') return send(res,200,'application/json', JSON.stringify(stats));
    const html = `<!doctype html><html lang=nl><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>T.O.T.-rit Boekel — statistieken</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef3e6;color:#2b3a2f;margin:0;padding:26px}
.c{max-width:440px;margin:auto;background:#fff;border-radius:18px;padding:22px 24px;box-shadow:0 10px 34px rgba(0,0,0,.12);border:3px solid #ffcf33}
h1{color:#2e7d32;font-size:22px;margin:0 0 14px}
.s{display:flex;justify-content:space-between;align-items:baseline;padding:12px 2px;border-bottom:2px solid #eef3e6}
.s:last-of-type{border-bottom:none}.s .l{color:#6b7d6e;font-weight:800;font-size:14px}
.s .n{color:#e65100;font-weight:900;font-size:26px;font-variant-numeric:tabular-nums}
small{color:#8a9a8c}</style>
<div class=c><h1>🚜 T.O.T.-rit Boekel — statistieken</h1>
<div class=s><span class=l>Keren gespeeld</span><span class=n>${stats.plays}</span></div>
<div class=s><span class=l>Verste afstand</span><span class=n>${stats.bestDistance} m</span></div>
<div class=s><span class=l>Langste stoet</span><span class=n>${stats.longestConvoy} 🚜</span></div>
<div class=s><span class=l>Tractoren totaal</span><span class=n>${stats.totalTractors}</span></div>
<p><small>Laatst bijgewerkt: ${stats.updated || '—'}</small></p></div></html>`;
    return send(res,200,'text/html; charset=utf-8', html);
  }

  if(u.pathname==='/healthz') return send(res,200,'text/plain','ok');
  // serve the game for the homepage and for clean challenge links like /u/Naam/1240
  if(req.method==='GET') return send(res,200,'text/html; charset=utf-8', game);
  return send(res,404,'text/plain','Not found');
});

server.listen(PORT, ()=> console.log('Traktor Racer server on :'+PORT));
