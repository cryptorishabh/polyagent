import { createServer, type Server } from 'node:http';
import type { Snapshot } from './snapshot.ts';

const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Read-only local dashboard. Binds to 127.0.0.1 only and rejects other Host headers
 * (blocks DNS-rebinding), so nothing is reachable from the network.
 */
export function startWeb(get: (runId?: string) => Snapshot, port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (!ALLOWED_HOSTS.test(req.headers.host ?? '')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (u.pathname === '/api/snapshot') {
      try {
        const body = JSON.stringify(get(u.searchParams.get('run') ?? undefined));
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(body);
      } catch (e) {
        res.writeHead(500, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }
    if (u.pathname === '/') {
      res
        .writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" })
        .end(PAGE);
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const a = server.address();
      const p = typeof a === 'object' && a ? a.port : port;
      resolve({ server, url: `http://127.0.0.1:${p}/` });
    });
  });
}

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>polyagent dashboard</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--mut:#6b6b66;--line:#e6e5e0;--ok:#2f8a4a;--run:#2563c9;--warn:#b7791f;--bad:#c53b3b;--lead:#8a4fc9;--track:#ecebe6}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecebe6;--mut:#9a9a93;--line:#2e2e2b;--ok:#5cc27a;--run:#6aa1ff;--warn:#e0a640;--bad:#ef6b6b;--lead:#b98cff;--track:#2a2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 40px}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:16px}
h1{font-size:18px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:24px 0 8px;font-weight:600}
.sub{color:var(--mut)}select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.kpi span{color:var(--mut);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.prov{display:grid;grid-template-columns:80px 1fr 56px;gap:4px 12px;align-items:center;padding:12px 14px;border-top:1px solid var(--line)}
.prov:first-child{border-top:0}.prov .meta{grid-column:2/4;color:var(--mut);font-size:12px}
.track{height:10px;background:var(--track);border-radius:5px;overflow:hidden}.fill{height:100%;border-radius:5px}
.pct{text-align:right;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 12px;border-top:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mut);font-weight:600;border-top:0}td.n{font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.s-running{color:var(--run);background:color-mix(in srgb,var(--run) 14%,transparent)}
.s-passed,.s-merged{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}
.s-failed,.s-blocked{color:var(--bad);background:color-mix(in srgb,var(--bad) 14%,transparent)}
.s-stopped,.s-unverified{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.s-lead{color:var(--lead);background:color-mix(in srgb,var(--lead) 14%,transparent)}.s-pending{color:var(--mut);background:var(--track)}
.small{font-size:12px;color:var(--mut)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.banner{margin-top:12px;padding:10px 14px;border-radius:8px;background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.wrap{overflow-x:auto}
@media (max-width:640px){.hide-sm{display:none}.prov{grid-template-columns:64px 1fr 44px}}
</style></head><body><main>
<header><div><h1>polyagent</h1><div class="sub" id="runline">loading…</div></div>
<label class="sub">run <select id="run"></select></label></header>
<div id="banner"></div>
<div class="kpis" id="kpis"></div>
<h2>Tools · budget used this window</h2><div class="card" id="provs"></div>
<h2>Tasks</h2><div class="card wrap"><table><thead><tr><th>Status</th><th>Task</th><th>Tier</th><th>Tool · model</th><th class="hide-sm">Where</th><th>Time</th><th>Tokens</th><th class="hide-sm">Try</th></tr></thead><tbody id="tasks"></tbody></table></div>
<p class="small" id="foot"></p>
</main><script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tok=n=>n>=1e6?(n/1e6).toFixed(n>=1e7?0:1)+'M':n>=1e3?(n/1e3).toFixed(n>=1e4?0:1)+'k':String(n);
const dur=ms=>{const s=Math.max(0,Math.round(ms/1e3));if(s<60)return s+'s';const m=Math.floor(s/60);return m<60?m+'m '+String(s%60).padStart(2,'0')+'s':Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m'};
const ORDER=['running','pending','lead','failed','blocked','stopped','unverified','passed','merged'];
let chosen=new URLSearchParams(location.search).get('run')||'';
$('run').onchange=e=>{chosen=e.target.value;history.replaceState(null,'',chosen?'?run='+encodeURIComponent(chosen):'/');load()};
function color(f){return f>=.85?'var(--bad)':f>=.6?'var(--warn)':'var(--ok)'}
function stateLabel(p){return p.state==='busy'?'<span class="dot" style="background:var(--run)"></span>working ('+p.running+')':p.state==='cooling'?'<span class="dot" style="background:var(--warn)"></span>cooling down '+esc(p.note||''):p.state==='disabled'?'<span class="dot" style="background:var(--bad)"></span>disabled: '+esc(p.note||''):p.state==='off'?'off':'<span class="dot" style="background:var(--mut)"></span>idle'}
function render(s){
  const sel=$('run');const cur=s.run?s.run.id:'';
  if(sel.options.length!==s.runs.length){sel.innerHTML=s.runs.map(r=>'<option value="'+esc(r)+'">'+esc(r)+'</option>').join('')}
  sel.value=cur;
  if(!s.run){$('runline').textContent='No runs yet. Start one with: polyagent run <tasks.json>';$('kpis').innerHTML='';$('provs').innerHTML='';$('tasks').innerHTML='';return}
  const live=!s.run.finishedAt;
  $('runline').innerHTML=esc(s.run.id)+' · '+(live?'<b style="color:var(--run)">running</b>':s.run.stopped?'<b style="color:var(--warn)">stopped</b>':'finished')+' · '+dur(s.run.elapsedMs);
  $('banner').innerHTML=s.run.stopped?'<div class="banner">'+esc(s.run.stopped)+' — continue later with <span class="mono">polyagent resume '+esc(s.run.id)+'</span></div>':'';
  const c=s.counts,done=(c.passed||0)+(c.merged||0);
  $('kpis').innerHTML=[[c.running||0,'running'],[done+' / '+s.tasks.length,'passed'],[(c.failed||0)+(c.blocked||0),'failed or blocked'],[tok(s.totals.runTokens),'tokens this run'+(s.totals.estimated?' (some estimated)':'')]].map(k=>'<div class="kpi"><b>'+esc(k[0])+'</b><span>'+esc(k[1])+'</span></div>').join('');
  $('provs').innerHTML=s.providers.map(p=>'<div class="prov"><b>'+esc(p.id)+'</b><div class="track" role="progressbar" aria-valuenow="'+Math.round(p.used*100)+'" aria-valuemin="0" aria-valuemax="100" aria-label="'+esc(p.id)+' budget used"><div class="fill" style="width:'+(p.used*100).toFixed(1)+'%;background:'+color(p.used)+'"></div></div><div class="pct">'+Math.round(p.used*100)+'%</div><div class="meta">'+stateLabel(p)+' · '+p.windowTasks+(p.maxTasks?'/'+p.maxTasks:'')+' tasks in '+p.windowHours+'h window · '+tok(p.runTokens)+' tokens this run ('+p.runTasks+' attempts)</div></div>').join('');
  const rows=[...s.tasks].sort((a,b)=>ORDER.indexOf(a.status)-ORDER.indexOf(b.status));
  $('tasks').innerHTML=rows.map(t=>{const tool=t.provider?esc(t.provider)+' · <span class="mono">'+esc(t.model||'default')+(t.effort?'/'+esc(t.effort):'')+'</span>':t.status==='lead'?'Claude (lead)':'—';
    return '<tr title="'+esc(t.summary||'')+'"><td><span class="pill s-'+esc(t.status)+'">'+esc(t.status)+'</span></td><td><b>'+esc(t.id)+'</b>'+(t.summary?'<div class="small">'+esc(t.summary.slice(0,140))+'</div>':'')+'</td><td>'+esc(t.tier)+'</td><td>'+tool+'</td><td class="hide-sm mono">'+esc(t.where||'—')+'</td><td class="n">'+(t.elapsedMs?dur(t.elapsedMs):'—')+'</td><td class="n">'+(t.tokens?tok(t.tokens):'—')+'</td><td class="n hide-sm">'+(t.attempt||'—')+'</td></tr>'}).join('');
  $('foot').textContent='updated '+new Date(s.at).toLocaleTimeString()+' · all-time tokens '+tok(s.totals.allTimeTokens)+' · refreshes every 2s · read-only, local only';
}
async function load(){try{const r=await fetch('/api/snapshot'+(chosen?'?run='+encodeURIComponent(chosen):''));render(await r.json())}catch(e){$('runline').textContent='dashboard server not reachable (is polyagent dashboard --web still running?)'}}
load();setInterval(load,2000);
</script></body></html>`;
