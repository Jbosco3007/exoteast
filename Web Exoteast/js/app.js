/* ==================== STORAGE LAYER ====================
   Uses window.storage when available (e.g. running inside a Claude.ai
   artifact). When running as a standalone website — opened directly or
   hosted on your own server — window.storage doesn't exist, so this
   automatically falls back to the browser's localStorage instead.
   The rest of the app never needs to know which one is active. */
const localStorageShim = {
  async get(key){
    const raw = localStorage.getItem('exoteast:'+key);
    return raw === null ? null : { key, value: raw };
  },
  async set(key, value){
    localStorage.setItem('exoteast:'+key, value);
    return { key, value };
  },
  async delete(key){
    localStorage.removeItem('exoteast:'+key);
    return { key, deleted: true };
  },
  async list(prefix){
    const keys = [];
    for(let i=0; i<localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith('exoteast:')){
        const bare = k.slice('exoteast:'.length);
        if(!prefix || bare.startsWith(prefix)) keys.push(bare);
      }
    }
    return { keys };
  }
};
const storageBackend = (typeof window.storage !== 'undefined' && window.storage) ? window.storage : localStorageShim;

async function storageGet(key){
  try{
    const r = await storageBackend.get(key);
    return r ? JSON.parse(r.value) : null;
  }catch(e){ return null; }
}
async function storageSet(key, value){
  try{
    const r = await storageBackend.set(key, JSON.stringify(value));
    if(!r) throw new Error('empty result');
    return true;
  }catch(e){ showToast('Gagal menyimpan data. Coba lagi.', true); return false; }
}

/* ==================== AUTH / SESSION ====================
   Login accounts (username/password/role) are stored in the same
   business-data storage so Admin can manage them from any device.
   The *current* logged-in session lives in the browser's sessionStorage
   only — it clears when the tab closes, and never syncs as "business
   data". Two roles exist:
     - admin : full access, can create/edit/delete everything
     - owner : read-only access to Dashboard + Laporan (owner/investor) */
const SESSION_KEY = 'exoteast_session_v1';
function getSession(){
  try{ return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }catch(e){ return null; }
}
function setSession(sess){ sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess)); }
function clearSession(){ sessionStorage.removeItem(SESSION_KEY); }
function isAdmin(){ const s = getSession(); return !!s && s.role==='admin'; }
function currentUserLabel(){ const s = getSession(); return s ? s.name : ''; }

async function loadUsers(){
  let users = await storageGet('users');
  if(!users || users.length===0){
    users = [
      { id: uid(), username:'admin', password:'admin123', role:'admin', name:'Admin' },
      { id: uid(), username:'viewer', password:'owner123', role:'viewer', name:'Viewer' }
    ];
    await storageSet('users', users);
  }
  return users;
}
async function saveUsers(users){ await storageSet('users', users); }

const ADMIN_ONLY_TABS = ['pemasukan','pengeluaran','inventori','karyawan','varian','akun'];

/* ==================== STATE ==================== */
const state = {
  tab: 'dashboard',
  meta: { businessName: 'Exoteast' },
  variants: [],     // [{name, priceNormal, priceNight}]
  inventory: [],
  employees: [],    // [{id, name, role:'driver'|'dapur', salaryType, rate}]
  users: [],
  monthCache: {},
  loaded: false
};
let pemasukanFilter = 'all'; // all | reguler | nightmarket
let pemasukanEmpFilter = 'all'; // all | employeeId
let dailyChartInstance = null;
let monthlyChartInstance = null;

function pad(n){ return n.toString().padStart(2,'0'); }
function todayISO(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function monthOf(dateStr){ return dateStr.slice(0,7); }
const BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const BULAN_SHORT = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
const HARI = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
function formatMonthLabel(m){ const [y,mo]=m.split('-'); return `${BULAN[parseInt(mo,10)-1]} ${y}`; }
function formatMonthLabelShort(m){ const [y,mo]=m.split('-'); return `${BULAN_SHORT[parseInt(mo,10)-1]} '${y.slice(2)}`; }
function formatDateLabel(d){ const [y,mo,da]=d.split('-'); return `${da} ${BULAN[parseInt(mo,10)-1]} ${y}`; }
function formatUSD(n){ n = Number(n)||0; return '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function escapeHTML(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeFileName(s){ return String(s||'Exoteast').trim().replace(/[^a-z0-9]+/gi,'-'); }
function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : 'id-'+Date.now()+'-'+Math.random().toString(16).slice(2)); }
function isDriver(emp){ return (emp.role || 'driver') === 'driver'; }

let toastTimer;
function showToast(msg, isErr){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove('show'), 2400);
}

/* ---- month data: { entries:[{id,date,location,employee,income,cups:{variantName:qty},note}],
                       expenses:[{id,date,category,item,qty,unitPrice,amount,note}],
                       salaryDays:{empId:number} } ---- */
function monthKey(m){ return `month:${m}`; }
async function loadMonth(m){
  if(state.monthCache[m]) return state.monthCache[m];
  const data = await storageGet(monthKey(m));
  const shaped = data || { entries:[], expenses:[], salaryDays:{} };
  if(!shaped.entries) shaped.entries = [];
  if(!shaped.expenses) shaped.expenses = [];
  if(!shaped.salaryDays) shaped.salaryDays = {};
  state.monthCache[m] = shaped;
  return shaped;
}
async function persistMonth(m){ await storageSet(monthKey(m), state.monthCache[m]); }

async function loadAll(){
  const [meta, variants, inventory, employees] = await Promise.all([
    storageGet('meta'), storageGet('variants'), storageGet('inventory'), storageGet('employees')
  ]);
  state.meta = meta || { businessName: 'Exoteast' };
  state.variants = variants || [];
  state.inventory = inventory || [];
  state.employees = employees || [];
  state.loaded = true;
}
async function saveMeta(){ await storageSet('meta', state.meta); }
async function saveVariants(){ await storageSet('variants', state.variants); }
async function saveInventory(){ await storageSet('inventory', state.inventory); }
async function saveEmployees(){ await storageSet('employees', state.employees); }

/* ==================== CALC HELPERS ==================== */
function cupsTotal(entry){
  if(!entry || !entry.cups) return 0;
  return Object.values(entry.cups).reduce((a,b)=> a + (Number(b)||0), 0);
}
function entriesForDate(monthData, date){
  return (monthData.entries||[]).filter(e=> e.date===date);
}
function groupEntriesByDate(monthData){
  const map = {};
  (monthData.entries||[]).forEach(e=>{
    if(!map[e.date]) map[e.date] = {income:0, cups:0, hasReg:false, hasNight:false};
    map[e.date].income += Number(e.income)||0;
    map[e.date].cups += cupsTotal(e);
    if(e.location==='nightmarket') map[e.date].hasNight = true; else map[e.date].hasReg = true;
  });
  return map;
}
function monthIncomeTotal(monthData){
  return (monthData.entries||[]).reduce((a,e)=> a + (Number(e.income)||0), 0);
}
function incomeByLocation(monthData){
  const res = {reguler:0, nightmarket:0};
  (monthData.entries||[]).forEach(e=>{ res[e.location] = (res[e.location]||0) + (Number(e.income)||0); });
  return res;
}
function monthExpenseTotal(monthData){
  return (monthData.expenses||[]).reduce((a,e)=> a + (Number(e.amount)||0), 0);
}
function employeeMonthlyPay(emp, monthData){
  if(emp.salaryType === 'bulanan') return Number(emp.rate)||0;
  const days = Number((monthData.salaryDays||{})[emp.id]) || 0;
  return (Number(emp.rate)||0) * days;
}
function monthSalaryTotal(monthData){
  return state.employees.reduce((a,e)=> a + employeeMonthlyPay(e, monthData), 0);
}
function variantTotalsForMonth(monthData){
  const totals = {};
  state.variants.forEach(v=> totals[v.name]=0);
  (monthData.entries||[]).forEach(e=>{
    Object.entries(e.cups||{}).forEach(([name,q])=>{ totals[name] = (totals[name]||0) + (Number(q)||0); });
  });
  return totals;
}
function variantRevenueForMonth(monthData){
  const rev = {};
  state.variants.forEach(v=> rev[v.name]=0);
  (monthData.entries||[]).forEach(e=>{
    const priceField = e.location==='nightmarket' ? 'priceNight' : 'priceNormal';
    Object.entries(e.cups||{}).forEach(([name,q])=>{
      const v = state.variants.find(x=> x.name===name);
      const price = v ? (Number(v[priceField])||0) : 0;
      rev[name] = (rev[name]||0) + price*(Number(q)||0);
    });
  });
  return rev;
}
function priceFor(variant, location){
  return location==='nightmarket' ? (Number(variant.priceNight)||0) : (Number(variant.priceNormal)||0);
}
/* Only Reguler entries with an assigned driver count toward the leaderboard.
   Night Market sales are intentionally excluded from per-driver attribution,
   and kitchen staff never appear here since they can't be assigned a sale. */
function employeeSalesForMonth(monthData){
  const map = {};
  state.employees.forEach(emp=> map[emp.id] = {income:0, cups:0, count:0});
  (monthData.entries||[]).forEach(e=>{
    if(e.location==='reguler' && e.employee){
      if(!map[e.employee]) map[e.employee] = {income:0, cups:0, count:0};
      map[e.employee].income += Number(e.income)||0;
      map[e.employee].cups += cupsTotal(e);
      map[e.employee].count += 1;
    }
  });
  return map;
}
function rankedEmployeeSales(monthData){
  const map = employeeSalesForMonth(monthData);
  return state.employees
    .filter(isDriver)
    .map(emp=> ({ emp, ...map[emp.id] }))
    .sort((a,b)=> b.income - a.income);
}

/* ==================== DASHBOARD CHART DATA ==================== */
function daysInMonth(m){ const [y,mo]=m.split('-').map(Number); return new Date(y, mo, 0).getDate(); }
function dailySeriesForMonth(monthData, m){
  const days = daysInMonth(m);
  const income = new Array(days).fill(0);
  const expense = new Array(days).fill(0);
  (monthData.entries||[]).forEach(e=>{ const d=Number(e.date.slice(8,10)); if(d>=1 && d<=days) income[d-1]+=Number(e.income)||0; });
  (monthData.expenses||[]).forEach(e=>{ const d=Number(e.date.slice(8,10)); if(d>=1 && d<=days) expense[d-1]+=Number(e.amount)||0; });
  return { labels: Array.from({length:days},(_,i)=> String(i+1)), income, expense };
}
function lastNMonths(n, endMonth){
  const [y,mo] = endMonth.split('-').map(Number);
  const arr=[];
  for(let i=n-1;i>=0;i--){
    let mm = mo - i, yy = y;
    while(mm<=0){ mm+=12; yy-=1; }
    arr.push(`${yy}-${pad(mm)}`);
  }
  return arr;
}
async function monthlySeries(n, endMonth){
  const months = lastNMonths(n, endMonth);
  const income=[], expense=[];
  for(const mm of months){
    const md = await loadMonth(mm);
    income.push(monthIncomeTotal(md));
    expense.push(monthExpenseTotal(md));
  }
  return { labels: months.map(formatMonthLabelShort), income, expense };
}

/* ==================== NAV / RENDER ==================== */
const NAV_ITEMS = [
  {id:'dashboard',   label:'Dashboard',          ic:'🏠', roles:['admin','viewer']},
  {id:'pemasukan',   label:'Pemasukan Harian',   ic:'📅', roles:['admin']},
  {id:'pengeluaran', label:'Pengeluaran',        ic:'💸', roles:['admin']},
  {id:'inventori',   label:'Inventori',          ic:'📦', roles:['admin']},
  {id:'karyawan',    label:'Karyawan',           ic:'👥', roles:['admin']},
  {id:'varian',      label:'Varian Minuman',     ic:'🥤', roles:['admin']},
  {id:'laporan',     label:'Laporan',            ic:'🧾', roles:['admin','viewer']},
  {id:'akun',        label:'Kelola Akun',        ic:'🔐', roles:['admin']}
];

function renderSidebar(){
  const sess = getSession();
  if(!sess) return;
  const items = NAV_ITEMS.filter(i=> i.roles.includes(sess.role));
  const navList = document.getElementById('navList');
  navList.innerHTML = items.map(i=> `<button class="nav-btn ${state.tab===i.id?'active':''}" data-action="set-tab" data-id="${i.id}"><span class="ic">${i.ic}</span>${i.label}</button>`).join('');

  const initial = (sess.name||'?').trim().charAt(0).toUpperCase() || '?';
  document.getElementById('sidebarFoot').innerHTML = `
    <div class="user-chip">
      <div class="avatar">${initial}</div>
      <div class="info">
        <div class="uname">${escapeHTML(sess.name)}</div>
        <div class="urole">${sess.role==='admin' ? '🔐 Admin — dapat mengedit' : '👁️ Viewer — lihat saja'}</div>
      </div>
    </div>
    <button class="logout-btn" id="logoutBtn">↩️ Keluar</button>
    <div style="font-size:11px; opacity:.45; padding:8px 4px 0; line-height:1.5;">Data tersimpan otomatis di perangkat ini.</div>
  `;
  document.getElementById('logoutBtn').addEventListener('click', ()=>{
    clearSession();
    showLogin();
  });

  document.getElementById('topbarUser').innerHTML = sess.role==='admin'
    ? `<span class="badge badge-reg">🔐 Admin</span> ${escapeHTML(sess.name)}`
    : `<span class="badge" style="background:var(--yellow); color:var(--ink);">👁️ Lihat Saja</span> ${escapeHTML(sess.name)}`;

  const bizInput = document.getElementById('bizNameInput');
  bizInput.readOnly = sess.role !== 'admin';
  bizInput.title = sess.role !== 'admin' ? 'Hanya Admin yang dapat mengubah nama bisnis' : '';
}

function setTab(tab){
  const sess = getSession();
  if(sess && sess.role!=='admin' && ADMIN_ONLY_TABS.includes(tab)) tab = 'dashboard';
  state.tab = tab;
  pemasukanFilter = 'all';
  renderSidebar();
  renderMain();
}
function loadingHTML(){ return `<div class="empty"><span class="ic">⏳</span>Memuat data...</div>`; }

function viewOnlyBanner(){
  return `<div class="viewonly-banner"><span>👁️</span> Anda masuk sebagai Viewer — halaman ini hanya untuk dilihat, tidak dapat mengedit data.</div>`;
}

async function renderMain(){
  const main = document.getElementById('main');
  main.innerHTML = loadingHTML();
  try{
    if(state.tab==='dashboard') await renderDashboard(main);
    else if(state.tab==='pemasukan') await renderPemasukan(main);
    else if(state.tab==='pengeluaran') await renderPengeluaran(main);
    else if(state.tab==='inventori') await renderInventori(main);
    else if(state.tab==='karyawan') await renderKaryawan(main);
    else if(state.tab==='varian') await renderVarian(main);
    else if(state.tab==='laporan') await renderLaporan(main);
    else if(state.tab==='akun') await renderAkun(main);
  }catch(e){
    console.error(e);
    main.innerHTML = `<div class="empty"><span class="ic">⚠️</span>Terjadi kesalahan saat memuat halaman ini.</div>`;
  }
}

/* ==================== DASHBOARD ==================== */
async function renderDashboard(main){
  const today = todayISO();
  const m = monthOf(today);
  const monthData = await loadMonth(m);
  const todayEntries = entriesForDate(monthData, today);
  const todayIncome = todayEntries.reduce((a,e)=> a + (Number(e.income)||0), 0);
  const todayCups = todayEntries.reduce((a,e)=> a + cupsTotal(e), 0);
  const todayHasNight = todayEntries.some(e=> e.location==='nightmarket');
  const incomeMonth = monthIncomeTotal(monthData);
  const expenseMonth = monthExpenseTotal(monthData);
  const salaryMonth = monthSalaryTotal(monthData);
  const laba = incomeMonth - expenseMonth - salaryMonth;
  const lowStock = state.inventory.filter(i => Number(i.stock) <= Number(i.minStock));

  const grouped = groupEntriesByDate(monthData);
  const recentDays = Object.entries(grouped).sort((a,b)=> b[0].localeCompare(a[0])).slice(0,7);
  const variantTotals = variantTotalsForMonth(monthData);
  const maxVariant = Math.max(1, ...Object.values(variantTotals));

  const leaderboard = rankedEmployeeSales(monthData).filter(r=> r.count>0);
  const medals = ['🥇','🥈','🥉'];
  const sess = getSession();

  main.innerHTML = `
    ${sess && sess.role!=='admin' ? viewOnlyBanner() : ''}
    <div class="hero">
      <img src="image/ext.png" alt="ext ${escapeHTML(state.meta.businessName)}">
      <div class="hero-content">
      <h2>${escapeHTML(state.meta.businessName)}</h2>
        <div class="eyebrow">Fresh Drinks, Anytime, Anywhere</div>
        <p>${escapeHTML(HARI[new Date().getDay()])}, ${formatDateLabel(today)} — ringkasan bisnis hari ini.</p>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card" style="border-left-color:var(--green)">
        <div class="stat-label">Pemasukan Hari Ini</div>
        <div class="stat-value">${formatUSD(todayIncome)}</div>
        <div class="stat-sub">${todayCups} cup · ${todayEntries.length} transaksi${todayHasNight? ' · 🌙 Night Market/Event':''}</div>
      </div>
      <div class="stat-card" style="border-left-color:var(--primary)">
        <div class="stat-label">Pemasukan Bulan Ini</div>
        <div class="stat-value">${formatUSD(incomeMonth)}</div>
        <div class="stat-sub">${formatMonthLabel(m)}</div>
      </div>
      <div class="stat-card" style="border-left-color:var(--red)">
        <div class="stat-label">Pengeluaran + Gaji Bulan Ini</div>
        <div class="stat-value">${formatUSD(expenseMonth + salaryMonth)}</div>
        <div class="stat-sub">Bahan, operasional &amp; gaji</div>
      </div>
      <div class="stat-card" style="border-left-color:${laba>=0?'var(--green)':'var(--red)'}">
        <div class="stat-label">Laba Bulan Ini</div>
        <div class="stat-value" style="color:${laba>=0?'var(--green)':'var(--red)'}">${formatUSD(laba)}</div>
        <div class="stat-sub">${laba>=0?'Untung':'Rugi'} sejauh ini</div>
      </div>
    </div>


    <div class="divider"></div>

    <div class="row" style="align-items:flex-start;">
      <div class="card" style="flex:1.3; min-width:300px;">
        <h3 style="margin:0 0 12px; font-size:16px;">📆 7 Hari Terakhir</h3>
        ${recentDays.length===0 ? `<div class="empty"><span class="ic">📝</span>Belum ada catatan pemasukan bulan ini.${sess && sess.role==='admin' ? '<br><button class="btn btn-primary" data-action="set-tab" data-id="pemasukan">Catat Pemasukan</button>':''}</div>` : `
        <div class="table-wrap"><table>
          <tr><th>Tanggal</th><th class="num">Cup</th><th class="num">Pemasukan</th></tr>
          ${recentDays.map(([d,g])=> `<tr><td>${formatDateLabel(d)} ${g.hasNight? '<span class="badge badge-night" style="margin-left:4px;">🌙</span>':''}</td><td class="num mono">${g.cups}</td><td class="num mono">${formatUSD(g.income)}</td></tr>`).join('')}
        </table></div>`}
      </div>

      <div class="card" style="flex:1; min-width:260px;">
        <h3 style="margin:0 0 12px; font-size:16px;">🥤 Varian Terlaris (Bulan Ini)</h3>
        ${state.variants.length===0 ? `<div class="empty"><span class="ic">🥤</span>Belum ada varian minuman.</div>` :
        state.variants.map(v=>{
          const val = variantTotals[v.name]||0;
          const pct = Math.round((val/maxVariant)*100);
          return `<div class="bar-row"><div class="bar-label" title="${escapeHTML(v.name)}">${escapeHTML(v.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="bar-val">${val}</div></div>`;
        }).join('')}
      </div>
    </div>

    <div class="divider"></div>

    <div class="card" style="margin-bottom:22px;">
      <div class="row-between" style="margin-bottom:8px;">
        <h3 style="margin:0; font-size:16px;">🏆 Peringkat Driver Bulan Ini</h3>
        <span class="badge badge-outline">Data pemasukan penjualan reguler saja</span>
      </div>
      ${leaderboard.length===0 ? `<div class="empty"><span class="ic">🏆</span>Belum ada penjualan reguler yang tercatat atas nama driver bulan ini.</div>` :
      leaderboard.map((r,idx)=> `
        <div class="lb-row">
          <div class="lb-rank">${medals[idx] || (idx+1)}</div>
          <div style="flex:1; min-width:0;">
            <div class="lb-name">${escapeHTML(r.emp.name)}</div>
            <div class="lb-sub">${r.cups} cup · ${r.count} transaksi</div>
          </div>
          <div class="lb-val">${formatUSD(r.income)}</div>
        </div>`).join('')}
    </div>

    <div class="card" style="border-color:${lowStock.length? 'var(--red)':'var(--ink)'};">
      <div class="row-between" style="margin-bottom:${lowStock.length?'12px':'0'};">
        <h3 style="margin:0; font-size:16px;">📦 Status Stok</h3>
        ${lowStock.length ? `<span class="badge badge-red">${lowStock.length} bahan menipis</span>` : `<span class="badge badge-green">Stok aman</span>`}
      </div>
      ${lowStock.length ? `<div class="table-wrap"><table>
        <tr><th>Bahan</th><th class="num">Stok</th><th class="num">Minimum</th></tr>
        ${lowStock.map(i=> `<tr class="low-stock"><td>${escapeHTML(i.name)}</td><td class="num mono">${i.stock} ${escapeHTML(i.unit||'')}</td><td class="num mono">${i.minStock} ${escapeHTML(i.unit||'')}</td></tr>`).join('')}
      </table></div>` : ''}
    </div>
  `;

  // Charts (Chart.js) — daily current-month + last-6-months trend
  const daily = dailySeriesForMonth(monthData, m);
  const monthly = await monthlySeries(6, m);

  if(typeof Chart !== 'undefined'){
    if(dailyChartInstance){ dailyChartInstance.destroy(); dailyChartInstance = null; }
    if(monthlyChartInstance){ monthlyChartInstance.destroy(); monthlyChartInstance = null; }

    const dailyCtx = document.getElementById('dailyChart');
    if(dailyCtx){
      dailyChartInstance = new Chart(dailyCtx.getContext('2d'), {
        type:'line',
        data:{ labels: daily.labels, datasets:[
          { label:'Pemasukan', data: daily.income, borderColor:'#2F9E6E', backgroundColor:'rgba(47,158,110,0.14)', tension:.3, fill:true, pointRadius:2 },
          { label:'Pengeluaran', data: daily.expense, borderColor:'#D64545', backgroundColor:'rgba(214,69,69,0.10)', tension:.3, fill:true, pointRadius:2 }
        ]},
        options:{ responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, font:{ family:'Plus Jakarta Sans', size:11 } } } },
          scales:{
            x:{ title:{ display:true, text:'Tanggal', font:{ size:10 } }, grid:{ display:false } },
            y:{ beginAtZero:true, ticks:{ callback:v=> '$'+v, font:{ size:10 } } }
          }
        }
      });
    }

    const monthlyCtx = document.getElementById('monthlyChart');
    if(monthlyCtx){
      monthlyChartInstance = new Chart(monthlyCtx.getContext('2d'), {
        type:'bar',
        data:{ labels: monthly.labels, datasets:[
          { label:'Pemasukan', data: monthly.income, backgroundColor:'#CF5A2B', borderRadius:5 },
          { label:'Pengeluaran', data: monthly.expense, backgroundColor:'#D64545', borderRadius:5 }
        ]},
        options:{ responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, font:{ family:'Plus Jakarta Sans', size:11 } } } },
          scales:{
            x:{ grid:{ display:false } },
            y:{ beginAtZero:true, ticks:{ callback:v=> '$'+v, font:{ size:10 } } }
          }
        }
      });
    }
  }
}

/* ==================== PEMASUKAN HARIAN ==================== */
async function renderPemasukan(main, presetDate, editId){
  const date = presetDate || todayISO();
  const m = monthOf(date);
  const monthData = await loadMonth(m);
  const editEntry = editId ? (monthData.entries||[]).find(e=> e.id===editId) : null;
  const location = editEntry ? editEntry.location : 'reguler';
  const drivers = state.employees.filter(isDriver);

  const cupFields = state.variants.length===0 ? `<p class="hint">Tambah varian minuman dulu di menu "Varian Minuman" (lengkap dengan harga) agar bisa mencatat cup terjual per varian.</p>` :
    `<div class="form-grid">
      ${state.variants.map(v=> `
        <div class="field">
          <label>${escapeHTML(v.name)}</label>
          <input type="number" min="0" step="1" data-variant="${escapeHTML(v.name)}" data-price-reg="${v.priceNormal||0}" data-price-night="${v.priceNight||0}" class="cup-input" value="${editEntry && editEntry.cups && editEntry.cups[v.name] ? editEntry.cups[v.name] : ''}" placeholder="0">
          <div class="hint price-hint">${formatUSD(priceFor(v, location))}/cup</div>
        </div>`).join('')}
    </div>`;

  function employeeNameById(id){ const emp = state.employees.find(x=> x.id===id); return emp ? emp.name : null; }

  let entries = (monthData.entries||[]).slice().sort((a,b)=> b.date.localeCompare(a.date));
  if(pemasukanFilter!=='all') entries = entries.filter(e=> e.location===pemasukanFilter);
  if(pemasukanEmpFilter!=='all') entries = entries.filter(e=> e.employee===pemasukanEmpFilter);

  main.innerHTML = `
    <h2 class="section-title">Pemasukan Harian</h2>
    <p class="section-sub">Catat pemasukan dan cup terjual. Pilih lokasi Reguler atau Night Market/ — harga per cup otomatis menyesuaikan.</p>

    <div class="card" style="margin-bottom:22px;">
      <form id="incomeForm">
        <div class="form-grid">
          <div class="field">
            <label>Tanggal</label>
            <input type="date" id="incomeDate" value="${date}" max="${todayISO()}" required>
          </div>
        </div>

        <label>Lokasi Jualan</label>
        <div class="seg-control" id="locSeg">
          <label class="seg-opt ${location==='reguler'?'active':''}" data-loc="reguler">
            <input type="radio" name="location" value="reguler" ${location==='reguler'?'checked':''}> 🚚 Reguler
          </label>
          <label class="seg-opt night ${location==='nightmarket'?'active':''}" data-loc="nightmarket">
            <input type="radio" name="location" value="nightmarket" ${location==='nightmarket'?'checked':''}> 🌙 Night Market/Event
          </label>
        </div>

        <div class="field" id="employeeField" style="margin-top:12px; ${location==='nightmarket'?'display:none;':''}">
          <label>Nama Staff (Driver) *</label>
          <select id="incomeEmployee" ${location==='reguler' ? 'required' : ''}>
            <option value="">— Pilih driver —</option>
            ${drivers.map(emp=> `<option value="${emp.id}" ${editEntry && editEntry.employee===emp.id ? 'selected':''}>${escapeHTML(emp.name)}</option>`).join('')}
          </select>
          ${drivers.length===0 ? `<div class="hint">Belum ada driver. Tambah karyawan bertipe "Driver" dulu di menu "Karyawan".</div>` : `<div class="hint">Wajib dipilih untuk Reguler (dipakai untuk target &amp; peringkat driver). Night Market tidak dihitung ke target driver.</div>`}
        </div>

        <label style="margin-top:12px;">Cup Terjual per Varian</label>
        ${cupFields}

        <div class="field" style="margin-top:6px;">
          <label>Total Pemasukan</label>
          <div class="input-money"><input type="number" min="0" step="0.01" id="incomeAmount" value="${editEntry ? editEntry.income : ''}" placeholder="0.00" required></div>
          <div class="hint">Dihitung otomatis dari cup × harga sesuai lokasi. Bisa diedit manual jika perlu (cth. diskon).</div>
        </div>
        <div class="field">
          <label>Catatan (opsional)</label>
          <input type="text" id="incomeNote" value="${escapeHTML(editEntry ? (editEntry.note||'') : '')}" placeholder="cth. hujan, lokasi baru, event tertentu">
        </div>
        <div class="row" style="gap:10px;">
          <button class="btn btn-primary" type="submit">${editEntry? '💾 Simpan Perubahan' : '➕ Tambah Transaksi'}</button>
          ${editEntry ? `<button type="button" class="btn btn-ghost" id="cancelEditBtn">Batal Edit</button>` : ''}
        </div>
      </form>
    </div>

    <div class="row-between">
      <h3 style="font-size:16px; margin:0;">Riwayat — ${formatMonthLabel(m)}</h3>
    </div>
    <div class="filter-pills">
      <button class="filter-pill ${pemasukanFilter==='all'?'active':''}" data-filter="all">Semua</button>
      <button class="filter-pill ${pemasukanFilter==='reguler'?'active':''}" data-filter="reguler">🚚 Reguler</button>
      <button class="filter-pill ${pemasukanFilter==='nightmarket'?'active':''}" data-filter="nightmarket">🌙 Night Market</button>
      <select id="empFilterSelect" style="max-width:190px; padding:6px 12px; font-size:12.5px; border-radius:999px; border:1.5px solid var(--ink-faint);">
        <option value="all">🚚 Semua Driver</option>
        ${drivers.map(emp=> `<option value="${emp.id}" ${pemasukanEmpFilter===emp.id?'selected':''}>${escapeHTML(emp.name)}</option>`).join('')}
      </select>
    </div>

    ${entries.length===0 ? `<div class="empty"><span class="ic">📝</span>Belum ada transaksi untuk filter ini.</div>` : `
    <div class="table-wrap"><table>
      <tr><th>Tanggal</th><th>Lokasi</th><th>Driver</th><th class="num">Cup</th><th class="num">Pemasukan</th><th>Catatan</th><th></th></tr>
      ${entries.map(e=> {
        const empName = e.location==='reguler' ? employeeNameById(e.employee) : null;
        return `
        <tr>
          <td>${formatDateLabel(e.date)}</td>
          <td>${e.location==='nightmarket' ? '<span class="badge badge-night">🌙 Night Market</span>' : '<span class="badge badge-reg">🚚 Reguler</span>'}</td>
          <td>${empName ? escapeHTML(empName) : '<span class="hint">—</span>'}</td>
          <td class="num mono">${cupsTotal(e)}</td>
          <td class="num mono">${formatUSD(e.income||0)}</td>
          <td>${escapeHTML(e.note||'')}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-sm btn-icon" data-action="edit-entry" data-id="${e.id}" data-date="${e.date}" title="Edit">✏️</button>
            <button class="btn btn-sm btn-icon btn-danger" data-action="delete-entry" data-id="${e.id}" data-date="${e.date}" title="Hapus">🗑️</button>
          </td>
        </tr>`;}).join('')}
    </table></div>`}
  `;

  // location toggle visuals + recalc
  function updatePriceHints(){
    const loc = document.querySelector('input[name="location"]:checked').value;
    document.querySelectorAll('.seg-opt').forEach(l=> l.classList.toggle('active', l.dataset.loc===loc));
    document.getElementById('employeeField').style.display = loc==='nightmarket' ? 'none' : 'block';
    document.getElementById('incomeEmployee').required = loc==='reguler';
    document.querySelectorAll('.cup-input').forEach(inp=>{
      const price = Number(loc==='nightmarket' ? inp.dataset.priceNight : inp.dataset.priceReg) || 0;
      const hint = inp.parentElement.querySelector('.price-hint');
      if(hint) hint.textContent = formatUSD(price) + '/cup';
    });
  }
  function recalcIncome(){
    const loc = document.querySelector('input[name="location"]:checked').value;
    let sum = 0;
    document.querySelectorAll('.cup-input').forEach(inp=>{
      const qty = Number(inp.value)||0;
      const price = Number(loc==='nightmarket' ? inp.dataset.priceNight : inp.dataset.priceReg) || 0;
      sum += qty*price;
    });
    document.getElementById('incomeAmount').value = sum.toFixed(2);
  }

  document.querySelectorAll('input[name="location"]').forEach(r=>{
    r.addEventListener('change', ()=>{ updatePriceHints(); recalcIncome(); });
  });
  document.querySelectorAll('.cup-input').forEach(inp=>{
    inp.addEventListener('input', recalcIncome);
  });

  document.getElementById('incomeDate').addEventListener('change', (e)=>{
    renderPemasukan(document.getElementById('main'), e.target.value, null);
  });

  const cancelBtn = document.getElementById('cancelEditBtn');
  if(cancelBtn) cancelBtn.addEventListener('click', ()=> renderPemasukan(document.getElementById('main'), date, null));

  document.querySelectorAll('.filter-pill').forEach(p=>{
    p.addEventListener('click', ()=>{
      pemasukanFilter = p.dataset.filter;
      renderPemasukan(document.getElementById('main'), date, null);
    });
  });
  document.getElementById('empFilterSelect').addEventListener('change', (e)=>{
    pemasukanEmpFilter = e.target.value;
    renderPemasukan(document.getElementById('main'), date, null);
  });

  document.getElementById('incomeForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
    const d = document.getElementById('incomeDate').value;
    if(!d){ showToast('Pilih tanggal terlebih dahulu', true); return; }
    const loc = document.querySelector('input[name="location"]:checked').value;
    const empVal = document.getElementById('incomeEmployee').value;
    if(loc==='reguler' && !empVal){ showToast('Pilih nama staff (driver) untuk Reguler', true); return; }
    const mm = monthOf(d);
    const md = await loadMonth(mm);
    const cups = {};
    document.querySelectorAll('.cup-input').forEach(inp=>{
      const v = inp.dataset.variant;
      const val = Number(inp.value)||0;
      if(val>0) cups[v]=val;
    });
    const payload = {
      date: d,
      location: loc,
      employee: loc==='reguler' ? empVal : null,
      income: Number(document.getElementById('incomeAmount').value)||0,
      cups,
      note: document.getElementById('incomeNote').value.trim()
    };
    if(editEntry){
      const idx = md.entries.findIndex(x=> x.id===editEntry.id);
      if(idx>-1) md.entries[idx] = {...editEntry, ...payload};
    } else {
      md.entries.push({ id: uid(), ...payload });
    }
    await persistMonth(mm);
    showToast(editEntry ? 'Transaksi diperbarui' : 'Transaksi ditambahkan');
    renderPemasukan(document.getElementById('main'), d, null);
  });
}

/* ==================== PENGELUARAN ==================== */
async function renderPengeluaran(main, presetMonth){
  const m = presetMonth || monthOf(todayISO());
  const monthData = await loadMonth(m);
  const expenses = (monthData.expenses||[]).slice().sort((a,b)=> b.date.localeCompare(a.date));
  const total = monthExpenseTotal(monthData);

  main.innerHTML = `
    <h2 class="section-title">Pengeluaran</h2>
    <p class="section-sub">Catat pembelian bahan &amp; biaya operasional. Masukkan nama barang, jumlah, dan harga satuan — totalnya dihitung otomatis.</p>

    <div class="row-between" style="margin-bottom:16px;">
      <div class="field" style="max-width:220px; margin:0;">
        <label>Pilih Bulan</label>
        <input type="month" id="expMonth" value="${m}">
      </div>
      <div class="stat-card" style="border-left-color:var(--red); min-width:200px;">
        <div class="stat-label">Total Pengeluaran</div>
        <div class="stat-value">${formatUSD(total)}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:22px;">
      <form id="expenseForm">
        <div class="form-grid">
          <div class="field">
            <label>Tanggal</label>
            <input type="date" id="expDate" value="${todayISO()}" required>
          </div>
          <div class="field">
            <label>Kategori</label>
            <select id="expCategory">
              <option value="Bahan Baku">Bahan Baku</option>
              <option value="Operasional">Operasional</option>
              <option value="Lainnya">Lainnya</option>
            </select>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Nama Barang</label>
            <input type="text" id="expItem" placeholder="cth. Gula Aren" required>
          </div>
          <div class="field">
            <label>Jumlah</label>
            <input type="number" min="0.01" step="0.01" id="expQty" value="1" required>
          </div>
          <div class="field">
            <label>Harga Satuan</label>
            <div class="input-money"><input type="number" min="0" step="0.01" id="expUnitPrice" placeholder="0.00" required></div>
          </div>
          <div class="field">
            <label>Total (otomatis)</label>
            <div class="total-display" id="expTotalDisplay">$0.00</div>
          </div>
        </div>
        <div class="field">
          <label>Catatan (opsional)</label>
          <input type="text" id="expNote" placeholder="cth. beli di Pasar Baru">
        </div>
        <button class="btn btn-primary" type="submit">➕ Tambah Pengeluaran</button>
      </form>
    </div>

    ${expenses.length===0 ? `<div class="empty"><span class="ic">💸</span>Belum ada pengeluaran di bulan ini.</div>` : `
    <div class="table-wrap"><table>
      <tr><th>Tanggal</th><th>Kategori</th><th>Nama Barang</th><th class="num">Jumlah</th><th class="num">Harga Satuan</th><th class="num">Total</th><th>Catatan</th><th></th></tr>
      ${expenses.map(e=> `
        <tr>
          <td>${formatDateLabel(e.date)}</td>
          <td><span class="badge badge-outline">${escapeHTML(e.category)}</span></td>
          <td>${escapeHTML(e.item || e.desc || '')}</td>
          <td class="num mono">${e.qty!=null ? e.qty : '—'}</td>
          <td class="num mono">${e.unitPrice!=null ? formatUSD(e.unitPrice) : '—'}</td>
          <td class="num mono">${formatUSD(e.amount)}</td>
          <td>${escapeHTML(e.note || e.desc || '')}</td>
          <td><button class="btn btn-sm btn-icon btn-danger" data-action="delete-expense" data-id="${e.id}" data-month="${m}" title="Hapus">🗑️</button></td>
        </tr>`).join('')}
    </table></div>`}
  `;

  document.getElementById('expMonth').addEventListener('change', (e)=>{
    if(e.target.value) renderPengeluaran(document.getElementById('main'), e.target.value);
  });

  function recalcExpenseTotal(){
    const qty = Number(document.getElementById('expQty').value)||0;
    const price = Number(document.getElementById('expUnitPrice').value)||0;
    document.getElementById('expTotalDisplay').textContent = formatUSD(qty*price);
  }
  document.getElementById('expQty').addEventListener('input', recalcExpenseTotal);
  document.getElementById('expUnitPrice').addEventListener('input', recalcExpenseTotal);

  document.getElementById('expenseForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
    const date = document.getElementById('expDate').value;
    if(!date){ showToast('Pilih tanggal terlebih dahulu', true); return; }
    const mm = monthOf(date);
    const md = await loadMonth(mm);
    const qty = Number(document.getElementById('expQty').value)||0;
    const unitPrice = Number(document.getElementById('expUnitPrice').value)||0;
    md.expenses.push({
      id: uid(),
      date,
      category: document.getElementById('expCategory').value,
      item: document.getElementById('expItem').value.trim(),
      qty,
      unitPrice,
      amount: qty*unitPrice,
      note: document.getElementById('expNote').value.trim()
    });
    await persistMonth(mm);
    showToast('Pengeluaran ditambahkan');
    renderPengeluaran(document.getElementById('main'), mm);
  });
}

/* ==================== INVENTORI ==================== */
async function renderInventori(main){
  const items = state.inventory.slice().sort((a,b)=> a.name.localeCompare(b.name));
  main.innerHTML = `
    <h2 class="section-title">Inventori</h2>
    <p class="section-sub">Pantau stok bahan baku agar tidak kehabisan saat jualan.</p>

    <div class="card" style="margin-bottom:22px;">
      <form id="invForm">
        <div class="form-grid">
          <div class="field">
            <label>Nama Bahan</label>
            <input type="text" id="invName" placeholder="cth. Gula Aren" required>
          </div>
          <div class="field">
            <label>Stok Awal</label>
            <input type="number" min="0" step="0.1" id="invStock" placeholder="0" required>
          </div>
          <div class="field">
            <label>Satuan</label>
            <input type="text" id="invUnit" placeholder="kg / liter / pcs / box" required>
          </div>
          <div class="field">
            <label>Stok Minimum</label>
            <input type="number" min="0" step="0.1" id="invMin" placeholder="0" required>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">➕ Tambah Bahan</button>
      </form>
    </div>

    ${items.length===0 ? `<div class="empty"><span class="ic">📦</span>Belum ada bahan yang dicatat.</div>` : `
    <div class="table-wrap"><table>
      <tr><th>Bahan</th><th class="num">Stok</th><th class="num">Minimum</th><th>Status</th><th></th></tr>
      ${items.map(i=>{
        const low = Number(i.stock) <= Number(i.minStock);
        return `<tr class="${low?'low-stock':''}">
          <td>${escapeHTML(i.name)}</td>
          <td class="num mono">${i.stock} ${escapeHTML(i.unit)}</td>
          <td class="num mono">${i.minStock} ${escapeHTML(i.unit)}</td>
          <td>${low ? '<span class="badge badge-red">Menipis</span>' : '<span class="badge badge-green">Aman</span>'}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-sm btn-icon" data-action="adjust-stock" data-id="${i.id}" data-delta="-1" title="Kurangi">−</button>
            <button class="btn btn-sm btn-icon" data-action="adjust-stock" data-id="${i.id}" data-delta="1" title="Tambah">+</button>
            <button class="btn btn-sm btn-icon btn-danger" data-action="delete-inventory" data-id="${i.id}" title="Hapus">🗑️</button>
          </td>
        </tr>`;
      }).join('')}
    </table></div>`}
  `;

  document.getElementById('invForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
    state.inventory.push({
      id: uid(),
      name: document.getElementById('invName').value.trim(),
      stock: Number(document.getElementById('invStock').value)||0,
      unit: document.getElementById('invUnit').value.trim(),
      minStock: Number(document.getElementById('invMin').value)||0
    });
    await saveInventory();
    showToast('Bahan ditambahkan');
    renderInventori(document.getElementById('main'));
  });
}

/* ==================== KARYAWAN ==================== */
async function renderKaryawan(main, presetMonth){
  const m = presetMonth || monthOf(todayISO());
  const monthData = await loadMonth(m);
  const employees = state.employees.slice().sort((a,b)=> a.name.localeCompare(b.name));
  const totalGaji = monthSalaryTotal(monthData);

  main.innerHTML = `
    <h2 class="section-title">Karyawan &amp; Gaji</h2>
    <p class="section-sub">Kelola daftar karyawan (driver &amp; staff dapur) dan hitung total gaji bulanan. Hanya Driver yang punya target harian &amp; muncul di form Pemasukan Harian.</p>

    <div class="card" style="margin-bottom:22px;">
      <form id="empForm">
        <div class="form-grid">
          <div class="field">
            <label>Nama Karyawan</label>
            <input type="text" id="empName" placeholder="cth. Budi" required>
          </div>
          <div class="field">
            <label>Jenis Staff</label>
            <select id="empRole">
              <option value="driver">🚚 Driver (target harian)</option>
              <option value="dapur">🍳 Staff Dapur (tanpa target harian)</option>
            </select>
          </div>
          <div class="field">
            <label>Tipe Gaji</label>
            <select id="empType">
              <option value="bulanan">Bulanan (tetap)</option>
              <option value="harian">Harian (per hari kerja)</option>
            </select>
          </div>
          <div class="field">
            <label>Rate</label>
            <div class="input-money"><input type="number" min="0" step="0.5" id="empRate" placeholder="0.00" required></div>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">➕ Tambah Karyawan</button>
      </form>
    </div>

    <div class="row-between" style="margin-bottom:12px;">
      <div class="field" style="max-width:220px; margin:0;">
        <label>Bulan Gaji</label>
        <input type="month" id="empMonth" value="${m}">
      </div>
      <div class="stat-card" style="border-left-color:var(--primary); min-width:200px;">
        <div class="stat-label">Total Gaji Bulan Ini</div>
        <div class="stat-value">${formatUSD(totalGaji)}</div>
      </div>
    </div>

    ${employees.length===0 ? `<div class="empty"><span class="ic">👥</span>Belum ada karyawan.</div>` : (()=>{
      const sales = employeeSalesForMonth(monthData);
      const topId = Object.entries(sales).sort((a,b)=> b[1].income - a[1].income).filter(([,v])=> v.income>0)[0]?.[0];
      return `
    <div class="table-wrap"><table>
      <tr><th>Nama</th><th>Jenis</th><th>Tipe Gaji</th><th class="num">Rate</th><th class="num">Hari Kerja</th><th class="num">Gaji Bulan Ini</th><th class="num">Penjualan Reguler</th><th></th></tr>
      ${employees.map(emp=>{
        const isHarian = emp.salaryType==='harian';
        const driver = isDriver(emp);
        const days = (monthData.salaryDays||{})[emp.id] || 0;
        const pay = employeeMonthlyPay(emp, monthData);
        const sold = (sales[emp.id]||{income:0,cups:0}).income;
        const cupsSold = (sales[emp.id]||{cups:0}).cups;
        return `<tr>
          <td>${escapeHTML(emp.name)} ${driver && emp.id===topId ? '<span class="badge badge-yellow">🏆 Top Sales</span>' : ''}</td>
          <td>${driver ? '<span class="badge badge-reg">🚚 Driver</span>' : '<span class="badge" style="background:var(--night); color:#fff;">🍳 Dapur</span>'}</td>
          <td><span class="badge badge-outline">${isHarian?'Harian':'Bulanan'}</span></td>
          <td class="num mono">${formatUSD(emp.rate)}${isHarian?'/hari':'/bln'}</td>
          <td class="num">${isHarian ? `<input type="number" min="0" step="1" value="${days}" class="salary-days-input" data-id="${emp.id}" style="width:70px; padding:6px 8px; text-align:right;">` : '—'}</td>
          <td class="num mono">${formatUSD(pay)}</td>
          <td class="num mono">${driver ? formatUSD(sold) + `<div class="hint" style="margin-top:2px;">${cupsSold} cup</div>` : '<span class="hint">— tanpa target —</span>'}</td>
          <td><button class="btn btn-sm btn-icon btn-danger" data-action="delete-employee" data-id="${emp.id}" title="Hapus">🗑️</button></td>
        </tr>`;
      }).join('')}
    </table></div>`;
    })()}
  `;

  document.getElementById('empMonth').addEventListener('change', (e)=>{
    if(e.target.value) renderKaryawan(document.getElementById('main'), e.target.value);
  });

  document.querySelectorAll('.salary-days-input').forEach(inp=>{
    inp.addEventListener('change', async ()=>{
      if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
      const md = await loadMonth(m);
      md.salaryDays[inp.dataset.id] = Number(inp.value)||0;
      await persistMonth(m);
      showToast('Hari kerja tersimpan');
      renderKaryawan(document.getElementById('main'), m);
    });
  });

  document.getElementById('empForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
    state.employees.push({
      id: uid(),
      name: document.getElementById('empName').value.trim(),
      role: document.getElementById('empRole').value,
      salaryType: document.getElementById('empType').value,
      rate: Number(document.getElementById('empRate').value)||0
    });
    await saveEmployees();
    showToast('Karyawan ditambahkan');
    renderKaryawan(document.getElementById('main'), m);
  });
}

/* ==================== VARIAN MINUMAN ==================== */
async function renderVarian(main){
  main.innerHTML = `
    <h2 class="section-title">Varian Minuman</h2>
    <p class="section-sub">Atur harga Reguler dan harga Night Market/Event tiap varian. Harga ini dipakai untuk menghitung otomatis total pemasukan saat mencatat penjualan.</p>

    

    <div class="card" style="margin-bottom:22px; max-width:560px;">
      <form id="varForm">
        <div class="form-grid">
          <div class="field">
            <label>Nama Varian</label>
            <input type="text" id="varName" placeholder="cth. Thai Tea" required>
          </div>
          <div class="field">
            <label>Harga Reguler</label>
            <div class="input-money"><input type="number" min="0" step="0.01" id="varPriceReg" placeholder="1.50" required></div>
          </div>
          <div class="field">
            <label>Night Market/Event</label>
            <div class="input-money"><input type="number" min="0" step="0.01" id="varPriceNight" placeholder="2.00" required></div>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">➕ Tambah Varian</button>
      </form>
    </div>

    ${state.variants.length===0 ? `<div class="empty"><span class="ic">🥤</span>Belum ada varian minuman.</div>` : `
    <div class="table-wrap" style="max-width:560px;"><table>
      <tr><th>Varian</th><th class="num">🚚 Harga Reguler</th><th class="num">🌙 Harga Night Market/Event</th><th></th></tr>
      ${state.variants.map(v=> `
        <tr>
          <td>${escapeHTML(v.name)}</td>
          <td class="num"><div class="input-money sm"><input type="number" min="0" step="0.01" class="price-edit" data-name="${escapeHTML(v.name)}" data-field="priceNormal" value="${v.priceNormal}" style="text-align:right;"></div></td>
          <td class="num"><div class="input-money sm"><input type="number" min="0" step="0.01" class="price-edit" data-name="${escapeHTML(v.name)}" data-field="priceNight" value="${v.priceNight}" style="text-align:right;"></div></td>
          <td><button class="btn btn-sm btn-icon btn-danger" data-action="delete-variant" data-id="${escapeHTML(v.name)}" title="Hapus">🗑️</button></td>
        </tr>`).join('')}
    </table></div>`}
  `;

  document.querySelectorAll('.price-edit').forEach(inp=>{
    inp.addEventListener('change', async ()=>{
      if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
      const v = state.variants.find(x=> x.name===inp.dataset.name);
      if(v){
        v[inp.dataset.field] = Number(inp.value)||0;
        await saveVariants();
        showToast('Harga diperbarui');
      }
    });
  });

  document.getElementById('varForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
    const name = document.getElementById('varName').value.trim();
    if(!name) return;
    if(state.variants.some(v=> v.name===name)){ showToast('Varian sudah ada', true); return; }
    state.variants.push({
      name,
      priceNormal: Number(document.getElementById('varPriceReg').value)||0,
      priceNight: Number(document.getElementById('varPriceNight').value)||0
    });
    await saveVariants();
    showToast('Varian ditambahkan');
    renderVarian(document.getElementById('main'));
  });
}

/* ==================== LAPORAN ==================== */
async function renderLaporan(main, presetMonth){
  const m = presetMonth || monthOf(todayISO());
  const monthData = await loadMonth(m);
  const sess = getSession();

  const income = monthIncomeTotal(monthData);
  const byLoc = incomeByLocation(monthData);
  const expenses = (monthData.expenses||[]).slice().sort((a,b)=> a.date.localeCompare(b.date));
  const byCategory = {};
  expenses.forEach(e=>{ byCategory[e.category] = (byCategory[e.category]||0) + Number(e.amount); });
  const expenseTotal = monthExpenseTotal(monthData);
  const variantTotals = variantTotalsForMonth(monthData);
  const variantRevenue = variantRevenueForMonth(monthData);
  const cupsGrand = Object.values(variantTotals).reduce((a,b)=>a+b,0);
  const employees = state.employees;
  const salaryTotal = monthSalaryTotal(monthData);
  const laba = income - expenseTotal - salaryTotal;
  const daysRecorded = new Set((monthData.entries||[]).map(e=> e.date)).size;
  const txCount = (monthData.entries||[]).length;
  const rankedDrivers = rankedEmployeeSales(monthData);
  const pemasukanRows = (monthData.entries||[]).slice().sort((a,b)=> a.date.localeCompare(b.date));

  function empName(id){ const e = state.employees.find(x=> x.id===id); return e ? e.name : '—'; }

  main.innerHTML = `
    ${sess && sess.role!=='admin' ? viewOnlyBanner() : ''}
    <h2 class="section-title">Laporan Bulanan</h2>
    <p class="section-sub">Pilih bulan untuk melihat ringkasan, detail pemasukan &amp; pengeluaran, peringkat driver, dan data master — lalu cetak atau unduh sebagai Excel.</p>

    <div class="row-between no-print" style="margin-bottom:20px;">
      <div class="field" style="max-width:220px; margin:0;">
        <label>Pilih Bulan</label>
        <input type="month" id="reportMonth" value="${m}">
      </div>
      <div class="row" style="gap:10px;">
        <button class="btn" id="exportExcelBtn">⬇️ Export Excel</button>
        <button class="btn btn-primary" id="printBtn">🖨️ Cetak Ringkasan</button>
      </div>
    </div>

    ${txCount===0 && expenses.length===0 ? `<div class="empty no-print"><span class="ic">🧾</span>Belum ada data untuk bulan ini.</div>` : ''}

    <div class="receipt" style="margin-bottom:30px;">
      <div class="receipt-zig"></div>
      <div class="receipt-header">
        <img src="image/logo.png" alt="${escapeHTML(state.meta.businessName)}" style="width:150px; height:auto; margin:0 auto 4px;">
        <div class="sub">Ringkasan · ${formatMonthLabel(m)}</div>
      </div>
      <hr>
      <div class="receipt-section-title">Pemasukan</div>
      <div class="receipt-row"><span class="l">Total pemasukan (${daysRecorded} hari, ${txCount} transaksi)</span><span class="mono">${formatUSD(income)}</span></div>
      <div class="receipt-row"><span class="l">🚚 Reguler</span><span class="mono">${formatUSD(byLoc.reguler||0)}</span></div>
      <div class="receipt-row"><span class="l">🌙 Night Market/Event</span><span class="mono">${formatUSD(byLoc.nightmarket||0)}</span></div>
      <div class="receipt-row"><span class="l">Total cup terjual</span><span class="mono">${cupsGrand}</span></div>
      <hr>
      <div class="receipt-section-title">Pengeluaran</div>
      ${Object.keys(byCategory).length===0 ? `<div class="receipt-row"><span class="l">— tidak ada pengeluaran —</span></div>` :
        Object.entries(byCategory).map(([cat,amt])=> `<div class="receipt-row"><span class="l">${escapeHTML(cat)}</span><span class="mono">${formatUSD(amt)}</span></div>`).join('')}
      <div class="receipt-row" style="font-weight:700; margin-top:2px;"><span>Total Pengeluaran</span><span class="mono">${formatUSD(expenseTotal)}</span></div>
      <hr>
      <div class="receipt-section-title">Gaji Karyawan</div>
      <div class="receipt-row" style="font-weight:700;"><span>Total Gaji</span><span class="mono">${formatUSD(salaryTotal)}</span></div>
      <hr>
      <div class="receipt-row receipt-total ${laba>=0?'profit':'loss'}"><span>${laba>=0?'LABA BERSIH':'RUGI BERSIH'}</span><span class="mono">${formatUSD(Math.abs(laba))}</span></div>
      <div class="receipt-zig bottom"></div>
      <div class="receipt-foot">Dicetak ${formatDateLabel(todayISO())} · Terima kasih! 🧋</div>
    </div>

    <div class="report-section no-print">
      <h3>📋 Detail Pemasukan — ${formatMonthLabel(m)}</h3>
      ${pemasukanRows.length===0 ? `<div class="empty"><span class="ic">📝</span>Tidak ada transaksi pemasukan.</div>` : `
      <div class="table-wrap"><table>
        <tr><th>Tanggal</th><th>Lokasi</th><th>Driver</th><th class="num">Cup</th><th class="num">Pemasukan</th><th>Catatan</th></tr>
        ${pemasukanRows.map(e=> `<tr>
          <td>${formatDateLabel(e.date)}</td>
          <td>${e.location==='nightmarket' ? '<span class="badge badge-night">🌙 Night Market/Event</span>' : '<span class="badge badge-reg">🚚 Reguler</span>'}</td>
          <td>${e.employee ? escapeHTML(empName(e.employee)) : '<span class="hint">—</span>'}</td>
          <td class="num mono">${cupsTotal(e)}</td>
          <td class="num mono">${formatUSD(e.income||0)}</td>
          <td>${escapeHTML(e.note||'')}</td>
        </tr>`).join('')}
      </table></div>`}
    </div>

    <div class="report-section no-print">
      <h3>💸 Detail Pengeluaran — ${formatMonthLabel(m)}</h3>
      ${expenses.length===0 ? `<div class="empty"><span class="ic">💸</span>Tidak ada pengeluaran.</div>` : `
      <div class="table-wrap"><table>
        <tr><th>Tanggal</th><th>Kategori</th><th>Nama Barang</th><th class="num">Jumlah</th><th class="num">Harga Satuan</th><th class="num">Total</th><th>Catatan</th></tr>
        ${expenses.map(e=> `<tr>
          <td>${formatDateLabel(e.date)}</td>
          <td><span class="badge badge-outline">${escapeHTML(e.category)}</span></td>
          <td>${escapeHTML(e.item || e.desc || '')}</td>
          <td class="num mono">${e.qty!=null ? e.qty : '—'}</td>
          <td class="num mono">${e.unitPrice!=null ? formatUSD(e.unitPrice) : '—'}</td>
          <td class="num mono">${formatUSD(e.amount)}</td>
          <td>${escapeHTML(e.note || e.desc || '')}</td>
        </tr>`).join('')}
      </table></div>`}
    </div>

    <div class="report-section no-print">
      <h3>🏆 Peringkat Driver (Reguler) — ${formatMonthLabel(m)}</h3>
      ${rankedDrivers.filter(r=>r.count>0).length===0 ? `<div class="empty"><span class="ic">🏆</span>Belum ada penjualan reguler beratribusi ke driver.</div>` : `
      <div class="table-wrap"><table>
        <tr><th>Peringkat</th><th>Nama Driver</th><th class="num">Cup</th><th class="num">Transaksi</th><th class="num">Pemasukan</th></tr>
        ${rankedDrivers.filter(r=>r.count>0).map((r,idx)=> `<tr>
          <td>${idx+1}</td><td>${escapeHTML(r.emp.name)}</td><td class="num mono">${r.cups}</td><td class="num mono">${r.count}</td><td class="num mono">${formatUSD(r.income)}</td>
        </tr>`).join('')}
      </table></div>`}
    </div>

    <div class="report-section no-print">
      <h3>🗂️ Data Master</h3>
      <div class="row" style="align-items:flex-start;">
        <div style="flex:1; min-width:260px;">
          <div class="hint" style="margin-bottom:6px; font-weight:700; text-transform:uppercase; font-size:11px;">Varian Minuman</div>
          <div class="table-wrap"><table>
            <tr><th>Varian</th><th class="num">Reguler</th><th class="num">Night Market/Event</th></tr>
            ${state.variants.map(v=> `<tr><td>${escapeHTML(v.name)}</td><td class="num mono">${formatUSD(v.priceNormal)}</td><td class="num mono">${formatUSD(v.priceNight)}</td></tr>`).join('') || '<tr><td colspan="3" class="hint">— belum ada —</td></tr>'}
          </table></div>
        </div>
        <div style="flex:1; min-width:260px;">
          <div class="hint" style="margin-bottom:6px; font-weight:700; text-transform:uppercase; font-size:11px;">Karyawan</div>
          <div class="table-wrap"><table>
            <tr><th>Nama</th><th>Jenis</th><th class="num">Gaji Bulan Ini</th></tr>
            ${employees.map(emp=> `<tr><td>${escapeHTML(emp.name)}</td><td>${isDriver(emp)?'🚚 Driver':'🍳 Dapur'}</td><td class="num mono">${formatUSD(employeeMonthlyPay(emp, monthData))}</td></tr>`).join('') || '<tr><td colspan="3" class="hint">— belum ada —</td></tr>'}
          </table></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('reportMonth').addEventListener('change', (e)=>{
    if(e.target.value) renderLaporan(document.getElementById('main'), e.target.value);
  });
  document.getElementById('printBtn').addEventListener('click', ()=> window.print());
  document.getElementById('exportExcelBtn').addEventListener('click', ()=> exportExcelReport(m, monthData));
}

function exportExcelReport(m, monthData){
  if(typeof XLSX === 'undefined'){ showToast('Fitur Excel belum siap, coba lagi.', true); return; }
  const income = monthIncomeTotal(monthData);
  const byLoc = incomeByLocation(monthData);
  const expenseTotal = monthExpenseTotal(monthData);
  const salaryTotal = monthSalaryTotal(monthData);
  const laba = income - expenseTotal - salaryTotal;

  const wb = XLSX.utils.book_new();

  const ringkasan = [
    ['Laporan Bulanan', formatMonthLabel(m)],
    [],
    ['Total Pemasukan', income],
    ['  - Reguler', byLoc.reguler||0],
    ['  - Night Market', byLoc.nightmarket||0],
    ['Total Pengeluaran', expenseTotal],
    ['Total Gaji Karyawan', salaryTotal],
    [laba>=0 ? 'Laba Bersih' : 'Rugi Bersih', Math.abs(laba)]
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ringkasan), 'Ringkasan');

  const pemasukanRows = [['Tanggal','Lokasi','Driver','Total Cup','Pemasukan','Catatan']];
  (monthData.entries||[]).slice().sort((a,b)=> a.date.localeCompare(b.date)).forEach(e=>{
    const emp = state.employees.find(x=> x.id===e.employee);
    pemasukanRows.push([e.date, e.location==='nightmarket'?'Night Market':'Reguler', emp?emp.name:'', cupsTotal(e), Number(e.income)||0, e.note||'']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pemasukanRows), 'Detail Pemasukan');

  const pengeluaranRows = [['Tanggal','Kategori','Nama Barang','Jumlah','Harga Satuan','Total','Catatan']];
  (monthData.expenses||[]).slice().sort((a,b)=> a.date.localeCompare(b.date)).forEach(e=>{
    pengeluaranRows.push([e.date, e.category, e.item||e.desc||'', e.qty!=null?e.qty:'', e.unitPrice!=null?e.unitPrice:'', Number(e.amount)||0, e.note||e.desc||'']);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pengeluaranRows), 'Detail Pengeluaran');

  const ranked = rankedEmployeeSales(monthData).filter(r=> r.count>0);
  const driverRows = [['Peringkat','Nama Driver','Cup Terjual','Jumlah Transaksi','Total Pemasukan']];
  ranked.forEach((r,idx)=> driverRows.push([idx+1, r.emp.name, r.cups, r.count, r.income]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(driverRows), 'Peringkat Driver');

  const varianRows = [['Nama Varian','Harga Reguler','Harga Night Market']];
  state.variants.forEach(v=> varianRows.push([v.name, v.priceNormal, v.priceNight]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(varianRows), 'Master Varian');

  const empRows = [['Nama','Jenis Staff','Tipe Gaji','Rate','Gaji Bulan Ini']];
  state.employees.forEach(e=> empRows.push([e.name, isDriver(e)?'Driver':'Staff Dapur', e.salaryType==='bulanan'?'Bulanan':'Harian', e.rate, employeeMonthlyPay(e, monthData)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(empRows), 'Master Karyawan');

  XLSX.writeFile(wb, `Laporan-${safeFileName(state.meta.businessName)}-${m}.xlsx`);
  showToast('Laporan Excel diunduh');
}

/* ==================== KELOLA AKUN (admin only) ==================== */
async function renderAkun(main){
  const users = state.users.slice().sort((a,b)=> a.username.localeCompare(b.username));
  const sess = getSession();

  main.innerHTML = `
    <h2 class="section-title">Kelola Akun</h2>
    <p class="section-sub">Buat akun login untuk Admin (dapat mengedit) atau Viewer (hanya melihat Dashboard &amp; Laporan).</p>

    <div class="card" style="margin-bottom:22px; max-width:640px;">
      <form id="userForm">
        <div class="form-grid">
          <div class="field">
            <label>Nama Tampilan</label>
            <input type="text" id="uName" placeholder="cth. Pak Rudi" required>
          </div>
          <div class="field">
            <label>Peran</label>
            <select id="uRole">
              <option value="viewer">👁️ Viewer (lihat saja)</option>
              <option value="admin">🔐 Admin (dapat mengedit)</option>
            </select>
          </div>
        </div>
        <div class="form-grid">
          <div class="field">
            <label>Username</label>
            <input type="text" id="uUsername" placeholder="username" required>
          </div>
          <div class="field">
            <label>Password</label>
            <input type="text" id="uPassword" placeholder="password" required>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">➕ Tambah Akun</button>
      </form>
    </div>

    <div class="table-wrap" style="max-width:640px;"><table>
      <tr><th>Nama</th><th>Username</th><th>Peran</th><th></th></tr>
      ${users.map(u=> `<tr>
        <td>${escapeHTML(u.name)}</td>
        <td class="mono">${escapeHTML(u.username)}</td>
        <td><span class="acc-role-pill ${u.role==='admin'?'acc-role-admin':'acc-role-viewer'}">${u.role==='admin'?'Admin':'Viewer'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm btn-icon" data-action="reset-password" data-id="${u.id}" title="Ganti Password">🔑</button>
          ${sess.username!==u.username ? `<button class="btn btn-sm btn-icon btn-danger" data-action="delete-user" data-id="${u.id}" title="Hapus">🗑️</button>` : `<span class="hint" style="padding:0 4px;">(akun Anda)</span>`}
        </td>
      </tr>`).join('')}
    </table></div>
  `;

  document.getElementById('userForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }
    const username = document.getElementById('uUsername').value.trim().toLowerCase();
    if(!username){ return; }
    if(state.users.some(u=> u.username.toLowerCase()===username)){ showToast('Username sudah dipakai', true); return; }
    state.users.push({
      id: uid(),
      username,
      password: document.getElementById('uPassword').value,
      role: document.getElementById('uRole').value,
      name: document.getElementById('uName').value.trim() || username
    });
    await saveUsers(state.users);
    showToast('Akun ditambahkan');
    renderAkun(document.getElementById('main'));
  });
}

/* ==================== EVENT DELEGATION ==================== */
document.getElementById('app').addEventListener('click', async (e)=>{
  const btn = e.target.closest('[data-action]');
  if(!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if(action==='set-tab'){ setTab(id); return; }

  const editActions = ['edit-entry','delete-entry','delete-expense','delete-inventory','adjust-stock','delete-employee','delete-variant','reset-password','delete-user'];
  if(editActions.includes(action) && !isAdmin()){ showToast('Hanya Admin yang dapat mengedit data', true); return; }

  if(action==='edit-entry'){
    renderPemasukan(document.getElementById('main'), btn.dataset.date, id);
    return;
  }
  if(action==='delete-entry'){
    if(!confirm('Hapus transaksi ini?')) return;
    const mm = monthOf(btn.dataset.date);
    const md = await loadMonth(mm);
    md.entries = md.entries.filter(x=> x.id!==id);
    await persistMonth(mm);
    showToast('Transaksi dihapus');
    renderPemasukan(document.getElementById('main'), btn.dataset.date, null);
    return;
  }
  if(action==='delete-expense'){
    if(!confirm('Hapus pengeluaran ini?')) return;
    const mm = btn.dataset.month;
    const md = await loadMonth(mm);
    md.expenses = md.expenses.filter(x=> x.id!==id);
    await persistMonth(mm);
    showToast('Pengeluaran dihapus');
    renderPengeluaran(document.getElementById('main'), mm);
    return;
  }
  if(action==='delete-inventory'){
    if(!confirm('Hapus bahan ini dari inventori?')) return;
    state.inventory = state.inventory.filter(x=> x.id!==id);
    await saveInventory();
    showToast('Bahan dihapus');
    renderInventori(document.getElementById('main'));
    return;
  }
  if(action==='adjust-stock'){
    const delta = Number(btn.dataset.delta);
    const item = state.inventory.find(x=> x.id===id);
    if(item){
      item.stock = Math.max(0, Number(item.stock) + delta);
      await saveInventory();
      renderInventori(document.getElementById('main'));
    }
    return;
  }
  if(action==='delete-employee'){
    if(!confirm('Hapus karyawan ini?')) return;
    state.employees = state.employees.filter(x=> x.id!==id);
    await saveEmployees();
    showToast('Karyawan dihapus');
    renderKaryawan(document.getElementById('main'));
    return;
  }
  if(action==='delete-variant'){
    if(!confirm('Hapus varian ini? Transaksi lama tidak akan hilang tapi varian tidak akan tampil lagi di form baru.')) return;
    state.variants = state.variants.filter(v=> v.name!==id);
    await saveVariants();
    showToast('Varian dihapus');
    renderVarian(document.getElementById('main'));
    return;
  }
  if(action==='reset-password'){
    const u = state.users.find(x=> x.id===id);
    if(!u) return;
    const np = prompt(`Password baru untuk ${u.name} (${u.username}):`);
    if(!np) return;
    u.password = np;
    await saveUsers(state.users);
    showToast('Password diperbarui');
    renderAkun(document.getElementById('main'));
    return;
  }
  if(action==='delete-user'){
    const target = state.users.find(x=> x.id===id);
    if(!target) return;
    const adminCount = state.users.filter(u=> u.role==='admin').length;
    if(target.role==='admin' && adminCount<=1){ showToast('Tidak bisa menghapus satu-satunya akun Admin', true); return; }
    if(!confirm(`Hapus akun ${target.name}?`)) return;
    state.users = state.users.filter(x=> x.id!==id);
    await saveUsers(state.users);
    showToast('Akun dihapus');
    renderAkun(document.getElementById('main'));
    return;
  }
});

/* ==================== LOGIN / LOGOUT FLOW ==================== */
function showLogin(){
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  const errEl = document.getElementById('loginError');
  if(errEl) errEl.textContent = '';
  const form = document.getElementById('loginForm');
  if(form) form.reset();
}

async function showApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if(!state.loaded) await loadAll();
  document.getElementById('bizNameInput').value = state.meta.businessName;
  renderSidebar();
  setTab('dashboard');
}

function attachLoginHandler(){
  document.getElementById('loginForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;
    const users = await loadUsers();
    state.users = users;
    const match = users.find(u=> u.username.toLowerCase()===username && u.password===password);
    const errEl = document.getElementById('loginError');
    if(!match){
      errEl.textContent = 'Username atau password salah.';
      return;
    }
    errEl.textContent = '';
    setSession({ username: match.username, role: match.role, name: match.name });
    await showApp();
  });
}

/* ==================== INIT ==================== */
async function init(){
  document.getElementById('topbarDate').textContent = `${HARI[new Date().getDay()]}, ${formatDateLabel(todayISO())}`;
  state.users = await loadUsers();
  attachLoginHandler();

  document.getElementById('bizNameInput').addEventListener('change', async (e)=>{
    if(!isAdmin()){ e.target.value = state.meta.businessName; return; }
    state.meta.businessName = e.target.value.trim() || 'Exoteast';
    await saveMeta();
    showToast('Nama bisnis tersimpan');
  });

  const sess = getSession();
  if(sess){
    await showApp();
  } else {
    showLogin();
  }
}
init();
