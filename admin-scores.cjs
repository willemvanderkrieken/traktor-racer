#!/usr/bin/env node
// Maintenance CLI for the Traktor Racer leaderboard.
// Run it INSIDE the running container (Coolify -> the app -> Terminal). No web endpoint, no password:
// shell access to the container is already the authentication.
//
//   node admin-scores.cjs list
//   node admin-scores.cjs delete --ts 1785584153044
//   node admin-scores.cjs delete --rank 2
//
// Writes scores.json atomically. The running server watches the file and reloads within ~1s,
// so the change takes effect live (no restart needed).

const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'scores.json');

function load(){ try { const a = JSON.parse(fs.readFileSync(FILE,'utf8')); return Array.isArray(a) ? a : []; } catch(e){ return []; } }
function save(a){ const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(a)); fs.renameSync(tmp, FILE); }
function isNamed(s){ const n = ((s&&s.name)||'').trim().toLowerCase(); return !!n && n!=='anoniem'; }
function sorted(a){ return a.filter(isNamed).slice().sort((x,y)=> y.distance-x.distance || x.ts-y.ts); }

const [ ,, cmd, ...rest ] = process.argv;
const arg = (k)=>{ const i = rest.indexOf(k); return i>=0 ? rest[i+1] : undefined; };
let scores = load();

if(cmd === 'list'){
  const s = sorted(scores);
  s.forEach((r,i)=> console.log(
    String(i+1).padStart(3) + '.  ' + String(r.distance).padStart(7) + ' m   ' +
    String(r.trekkers).padStart(4) + ' trekkers   ts=' + r.ts + '   ' + r.name));
  console.log('\n' + s.length + ' named scores (' + scores.length + ' total incl. anonymous).');
} else if(cmd === 'delete'){
  const ts = arg('--ts'), rank = arg('--rank');
  let target = null;
  if(ts != null)        target = scores.find(x => String(x.ts) === String(ts));
  else if(rank != null) target = sorted(scores)[parseInt(rank,10) - 1];
  else { console.error('usage: node admin-scores.cjs delete --ts <id> | --rank <n>'); process.exit(1); }
  if(!target){ console.error('No matching score found.'); process.exit(1); }
  scores = scores.filter(x => x !== target);
  save(scores);
  console.log('Deleted: ' + target.name + '  ' + target.distance + ' m  ts=' + target.ts);
} else {
  console.log('usage:\n  node admin-scores.cjs list\n  node admin-scores.cjs delete --ts <id>\n  node admin-scores.cjs delete --rank <n>');
}
