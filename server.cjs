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
const DATA_DIR  = process.env.DATA_DIR || '/data';
const STATS_FILE= path.join(DATA_DIR, 'stats.json');
const GAME_FILE = path.join(__dirname, 'traktor-racer.html');

let stats = { plays:0, bestDistance:0, longestConvoy:0, totalTractors:0, updated:null };
try { fs.mkdirSync(DATA_DIR, { recursive:true }); } catch(e){}
try { Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE,'utf8'))); } catch(e){}

let game = '<h1>Game bestand ontbreekt</h1>';
try { game = fs.readFileSync(GAME_FILE,'utf8'); } catch(e){}

// buffered + atomic persistence (tmp file then rename) so nothing corrupts under load
let dirty = false;
function persist(){
  if(!dirty) return; dirty = false;
  try { const tmp = STATS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(stats)); fs.renameSync(tmp, STATS_FILE); }
  catch(e){ dirty = true; }
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
  if(u.pathname==='/' || u.pathname==='/index.html') return send(res,200,'text/html; charset=utf-8', game);
  return send(res,404,'text/plain','Not found');
});

server.listen(PORT, ()=> console.log('Traktor Racer server on :'+PORT));
