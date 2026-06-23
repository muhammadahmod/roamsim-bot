// RoamSIM analytics dashboard (served at /dashboard?key=YOUR_ADMIN_KEY)
export function dashboardHtml() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>RoamSIM — Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--ink:#e2e8f0;--mut:#94a3b8}
  *{box-sizing:border-box;font-family:system-ui,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:var(--bg);color:var(--ink);padding:24px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);font-size:13px;margin-bottom:20px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
  .card{background:var(--card);border-radius:14px;padding:18px}
  .kpi .v{font-size:26px;font-weight:700} .kpi .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  @media(max-width:760px){.grid{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{text-align:left;padding:8px;border-bottom:1px solid #334155}
  th{color:var(--mut);font-weight:600} .err{color:#f87171}
</style></head><body>
<h1>RoamSIM Dashboard</h1>
<div class="sub" id="meta">Loading…</div>
<div class="kpis" id="kpis"></div>
<div class="grid">
  <div class="card"><canvas id="destChart" height="200"></canvas></div>
  <div class="card"><canvas id="statusChart" height="200"></canvas></div>
</div>
<div class="card"><h3 style="margin:0 0 10px">Recent orders</h3><div id="recent">…</div></div>
<script>
const key = new URLSearchParams(location.search).get('key') || '';
const ZAR = n => 'R' + (n||0).toLocaleString('en-ZA');
let c1, c2;
async function load(){
  try{
    const r = await fetch('/api/admin/stats?key=' + encodeURIComponent(key));
    if(!r.ok){ document.getElementById('meta').innerHTML = '<span class="err">Access denied — append ?key=YOUR_ADMIN_KEY to the URL.</span>'; return; }
    const s = await r.json();
    document.getElementById('meta').textContent =
      (s.persistent ? 'Durable storage ✓' : '⚠ In-memory (set DATABASE_URL to retain data)') +
      ' · updated ' + new Date(s.generatedAt).toLocaleString();
    document.getElementById('kpis').innerHTML = [
      ['Revenue (confirmed)', ZAR(s.revenueZar)],
      ['Confirmed orders', s.confirmed],
      ['Fulfilled', s.fulfilled],
      ['Awaiting payment', s.awaitingPayment],
      ['Conversion', s.conversionRate + '%'],
      ['Total leads', s.total],
    ].map(([l,v])=>'<div class="card kpi"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>').join('');
    const dest = s.topDestinations.slice(0,8);
    c1 && c1.destroy();
    c1 = new Chart(document.getElementById('destChart'), {type:'bar',
      data:{labels:dest.map(d=>d.name),datasets:[{label:'Revenue (R)',data:dest.map(d=>d.revenue),backgroundColor:'#0ea5e9'}]},
      options:{plugins:{title:{display:true,text:'Revenue by destination',color:'#e2e8f0'},legend:{display:false}},scales:{x:{ticks:{color:'#94a3b8'}},y:{ticks:{color:'#94a3b8'}}}}});
    const st = Object.entries(s.byStatus);
    c2 && c2.destroy();
    c2 = new Chart(document.getElementById('statusChart'), {type:'doughnut',
      data:{labels:st.map(x=>x[0]),datasets:[{data:st.map(x=>x[1]),backgroundColor:['#f59e0b','#22c55e','#0ea5e9','#a855f7','#ef4444']}]},
      options:{plugins:{title:{display:true,text:'Orders by status',color:'#e2e8f0'},legend:{labels:{color:'#94a3b8'}}}}});
    const rows = (s.recent||[]).map(o=>'<tr><td>'+o.reference+'</td><td>'+(o.customerName||'')+'</td><td>'+(o.destinationName||'')+'</td><td>'+ZAR(o.priceZar)+'</td><td>'+o.status+'</td></tr>').join('');
    document.getElementById('recent').innerHTML = '<table><thead><tr><th>Ref</th><th>Customer</th><th>Destination</th><th>Price</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }catch(e){ document.getElementById('meta').innerHTML='<span class="err">'+e.message+'</span>'; }
}
load(); setInterval(load, 30000);
</script></body></html>`;
}
