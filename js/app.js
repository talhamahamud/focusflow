const CIRC = 2 * Math.PI * 108; // 678.58

let settings = { focus:25, short:5, long:15, interval:4, autoBreak:false, autoFocus:false };
let tasks    = [];
let sessions = [];
let stats    = { total:0, todayDate:'', todayCount:0, streak:0, lastDate:'', weekData:{} };
let activeTaskIdx = -1;
let currentMode   = 'focus';
let sessionCounter = 0;
let timeLeft = 0, totalTime = 0, running = false, timerInterval = null, expectedEndTime = 0;
let currentSound = null, audioCtx = null, volume = 0.5;
let currentAudio = null;
let settingsOpen = false;

/* ─ WebSocket sync to Electron floating widget ─ */
let _wsClient = null;
let _wsRetryTimer = null;
const WS_PORT = 49000;

function wsSync_connect() {
  // Only run in a real browser, not in Electron renderer itself
  if (navigator.userAgent.toLowerCase().includes('electron')) return;

  if (_wsClient && (_wsClient.readyState === WebSocket.OPEN || _wsClient.readyState === WebSocket.CONNECTING)) return;
  try {
    // 127.0.0.1 is used instead of localhost to bypass HTTPS mixed-content blocking
    // This allows your deployed web app to connect to the local widget seamlessly!
    _wsClient = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    _wsClient.onopen = () => {
      if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }
      // Immediately push current state so widget starts in sync
      wsSync_send();
    };
    _wsClient.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'toggle') toggleTimer();
        else if (msg.type === 'reset')  resetTimer();
      } catch(e) {}
    };
    _wsClient.onclose = () => {
      _wsClient = null;
      // Retry in 3 s (widget may not be running yet)
      _wsRetryTimer = setTimeout(wsSync_connect, 3000);
    };
    _wsClient.onerror = () => { _wsClient && _wsClient.close(); };
  } catch(e) {}
}

function wsSync_send() {
  if (!_wsClient || _wsClient.readyState !== WebSocket.OPEN) return;
  const m = Math.floor(timeLeft/60).toString().padStart(2,'0');
  const s = (timeLeft%60).toString().padStart(2,'0');
  try {
    _wsClient.send(JSON.stringify({ type:'sync', timeStr:`${m}:${s}`, mode:currentMode, running }));
  } catch(e) {}
}

// Start trying to connect after page load
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => setTimeout(wsSync_connect, 800));
}

// Supabase Configuration
// USER: Enter your Supabase credentials here to enable auth and database sync
const supabaseUrl = 'https://eolzzpkwpxfcgvvgnqhm.supabase.co'; 
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVvbHp6cGt3cHhmY2d2dmducWhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1Mzc5MzMsImV4cCI6MjA5NzExMzkzM30.-R5BgX20f1eVT_scpD7GY229mLX7P-1Y0ud8QNUAlgQ';
let supabaseClient = null;
let currentUser = null;
let authMode = 'login'; // 'login' or 'signup'

if (supabaseUrl && supabaseKey) {
  try {
    supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);
  } catch (e) {
    console.error("Failed to initialize Supabase client:", e);
  }
}

/* ─ Storage & Sync ─ */
let dbSyncTimeout = null;

async function save(){
  // Local fallback
  localStorage.setItem('ff_tasks',    JSON.stringify(tasks));
  localStorage.setItem('ff_sessions', JSON.stringify(sessions.slice(0,200)));
  localStorage.setItem('ff_stats',    JSON.stringify(stats));
  localStorage.setItem('ff_settings', JSON.stringify(settings));

  // Debounce database sync by 300ms to avoid multiple rapid writes
  if (supabaseClient && currentUser) {
    if (dbSyncTimeout) clearTimeout(dbSyncTimeout);
    dbSyncTimeout = setTimeout(syncToDatabase, 300);
  }
}

async function syncToDatabase() {
  if (!supabaseClient || !currentUser) return;
  try {
    const { error } = await supabaseClient
      .from('user_data')
      .upsert({
        user_id: currentUser.id,
        tasks: tasks,
        sessions: sessions.slice(0, 200),
        stats: stats,
        settings: settings,
        updated_at: new Date().toISOString()
      });
    if (error) {
      console.error("Supabase sync error on database sync:", error);
    }
  } catch (e) {
    console.error("Failed to sync to database:", e);
  }
}

function loadLocalData(){
  try { tasks    = JSON.parse(localStorage.getItem('ff_tasks')    || '[]'); } catch(e){}
  try { sessions = JSON.parse(localStorage.getItem('ff_sessions') || '[]'); } catch(e){}
  try { stats    = Object.assign({ total:0, todayDate:'', todayCount:0, streak:0, lastDate:'', weekData:{} }, JSON.parse(localStorage.getItem('ff_stats') || '{}')); } catch(e){}
  try { settings = Object.assign({ focus:25, short:5, long:15, interval:4, autoBreak:false, autoFocus:false }, JSON.parse(localStorage.getItem('ff_settings') || '{}')); } catch(e){}
  
  updateSettingsInputs();
}

function updateSettingsInputs() {
  document.getElementById('s-focus').value        = settings.focus;
  document.getElementById('s-short').value        = settings.short;
  document.getElementById('s-long').value         = settings.long;
  document.getElementById('s-interval').value     = settings.interval;
  document.getElementById('s-auto-break').checked = settings.autoBreak;
  document.getElementById('s-auto-focus').checked = settings.autoFocus;
  document.getElementById('s-floating').checked   = !!settings.floatingTimer;
}

async function syncDataFromDatabase() {
  if (!supabaseClient || !currentUser) return;
  
  try {
    const { data, error } = await supabaseClient
      .from('user_data')
      .select('tasks, sessions, stats, settings')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (error) {
      console.error("Error fetching user data from Supabase:", error);
      return;
    }

    if (data) {
      // Load cloud data
      tasks = data.tasks || [];
      sessions = data.sessions || [];
      stats = Object.assign({ total:0, todayDate:'', todayCount:0, streak:0, lastDate:'', weekData:{} }, data.stats || {});
      settings = Object.assign({ focus:25, short:5, long:15, interval:4, autoBreak:false, autoFocus:false }, data.settings || {});
      
      // Update cache
      localStorage.setItem('ff_tasks',    JSON.stringify(tasks));
      localStorage.setItem('ff_sessions', JSON.stringify(sessions));
      localStorage.setItem('ff_stats',    JSON.stringify(stats));
      localStorage.setItem('ff_settings', JSON.stringify(settings));
    } else {
      // First sign-in: upload local guest data to Supabase
      const { error: insertError } = await supabaseClient
        .from('user_data')
        .insert({
          user_id: currentUser.id,
          tasks: tasks,
          sessions: sessions.slice(0, 200),
          stats: stats,
          settings: settings,
          updated_at: new Date().toISOString()
        });
      if (insertError) {
        console.error("Error creating initial user data in Supabase:", insertError);
      }
    }

    // Refresh UI
    updateSettingsInputs();
    if (settings.timerState) {
      restoreTimerState();
    } else if (!running) {
      timeLeft = totalTime = getDuration(currentMode);
      updateDisplay();
      updateRing(1);
    }
    renderTasks();
    updateStreakDisplay();
    updateSessionLabel();
    if (document.getElementById('analytics-page').classList.contains('active')) {
      renderAnalytics();
    }
  } catch (e) {
    console.error("Database sync exception:", e);
  }
}

function saveTimerState() {
  const timerState = {
    timeLeft,
    totalTime,
    running,
    expectedEndTime,
    currentMode,
    updatedAt: Date.now()
  };
  settings.timerState = timerState;
  save();
}

function restoreTimerState() {
  const timerState = settings.timerState;
  if (!timerState) return;

  const now = Date.now();
  const targetMode = timerState.currentMode || 'focus';
  const targetRunning = !!timerState.running;
  const targetExpectedEndTime = timerState.expectedEndTime || 0;
  const targetTotalTime = timerState.totalTime || getDuration(targetMode);
  const targetTimeLeft = timerState.timeLeft !== undefined ? timerState.timeLeft : getDuration(targetMode);

  // If local timer is already in this exact state, do nothing to avoid stutters
  if (
    currentMode === targetMode &&
    running === targetRunning &&
    expectedEndTime === targetExpectedEndTime &&
    totalTime === targetTotalTime
  ) {
    return;
  }

  // Otherwise, apply the state change
  currentMode = targetMode;
  document.querySelectorAll('.mode-tab').forEach((t, i) =>
    t.classList.toggle('active', ['focus', 'short', 'long'][i] === currentMode));
  document.getElementById('timer-card').setAttribute('data-mode', currentMode);
  document.getElementById('timer-label').textContent =
    currentMode === 'focus' ? 'Focus Session' : currentMode === 'short' ? 'Short Break' : 'Long Break';

  totalTime = targetTotalTime;

  if (targetRunning && targetExpectedEndTime > now) {
    expectedEndTime = targetExpectedEndTime;
    timeLeft = Math.max(0, Math.round((expectedEndTime - now) / 1000));
    running = true;
    document.getElementById('play-btn').innerHTML = '&#9646;&#9646;';
    updateModeTabs();
    clearInterval(timerInterval);
    timerInterval = setInterval(tick, 1000);
  } else if (targetRunning && targetExpectedEndTime <= now) {
    timeLeft = 0;
    expectedEndTime = 0;
    running = false;
    document.getElementById('play-btn').innerHTML = '&#9654;';
    updateModeTabs();
    updateDisplay();
    updateRing(0);
    sessionEnd();
  } else {
    timeLeft = targetTimeLeft;
    expectedEndTime = 0;
    running = false;
    document.getElementById('play-btn').innerHTML = '&#9654;';
    updateModeTabs();
    updateDisplay();
    updateRing(totalTime > 0 ? timeLeft / totalTime : 1);
  }
  updateDisplay();
  updateSessionLabel();
}

/* ─ Pages ─ */
function showPage(p){
  document.getElementById('timer-page').classList.toggle('active', p==='timer');
  document.getElementById('analytics-page').classList.toggle('active', p==='analytics');
  document.getElementById('nav-timer').classList.toggle('active', p==='timer');
  document.getElementById('nav-analytics').classList.toggle('active', p==='analytics');
  if(p==='analytics') renderAnalytics();
}

/* ─ Timer ─ */
function getDuration(m){ return (m==='focus'?settings.focus:m==='short'?settings.short:settings.long)*60; }

function updateModeTabs(){
  const isLocked = running || (timeLeft > 0 && timeLeft < totalTime);
  document.querySelectorAll('.mode-tab').forEach(t => t.disabled = isLocked);
}

function setMode(mode, auto=false){
  // Always stop any running timer before switching modes
  clearInterval(timerInterval); running=false;
  document.getElementById('play-btn').innerHTML='&#9654;';
  currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach((t,i)=>
    t.classList.toggle('active',['focus','short','long'][i]===mode));
  document.getElementById('timer-card').setAttribute('data-mode', mode);
  document.getElementById('timer-label').textContent =
    mode==='focus'?'Focus Session':mode==='short'?'Short Break':'Long Break';
  // Reset the timer to the new mode's duration
  timeLeft=totalTime=getDuration(mode);
  updateDisplay(); updateRing(1);
  updateSessionLabel();
  updateModeTabs();
  if(auto) {
    toggleTimer();
  } else {
    saveTimerState();
  }
}

function toggleTimer(){ running?pause():start(); }
function start(){
  if(timeLeft<=0) resetTimer();
  running=true;
  expectedEndTime = Date.now() + timeLeft * 1000;
  document.getElementById('play-btn').innerHTML='&#9646;&#9646;';
  updateModeTabs();
  timerInterval=setInterval(tick,1000);
  saveTimerState();
}
function pause(){
  running=false;
  if (expectedEndTime > 0) {
    timeLeft = Math.max(0, Math.round((expectedEndTime - Date.now()) / 1000));
  }
  document.getElementById('play-btn').innerHTML='&#9654;';
  updateModeTabs();
  clearInterval(timerInterval);
  saveTimerState();
}
function resetTimer(){
  pause(); timeLeft=totalTime=getDuration(currentMode);
  expectedEndTime = 0;
  updateDisplay(); updateRing(1);
  updateModeTabs();
  saveTimerState();
}
function tick(){
  timeLeft = Math.max(0, Math.round((expectedEndTime - Date.now()) / 1000));
  updateDisplay(); updateRing(timeLeft/totalTime);
  if(timeLeft<=0) sessionEnd();
}
function nextSession(){
  pause();
  if(currentMode==='focus'){ sessionCounter++; showModal('focus', sessionCounter%settings.interval===0); }
  else showModal(currentMode, false);
}
function sessionEnd(){
  clearInterval(timerInterval); running=false;
  document.getElementById('play-btn').innerHTML='&#9654;';
  updateModeTabs();

  // Set the timerState to a completed state
  settings.timerState = {
    timeLeft: 0,
    totalTime,
    running: false,
    expectedEndTime: 0,
    currentMode,
    updatedAt: Date.now()
  };

  if(currentMode==='focus'){
    sessionCounter++;
    recordSession();
    showModal('focus', sessionCounter%settings.interval===0);
    notify('Focus session complete.', 'focus');
  } else {
    save();
    showModal(currentMode, false);
    notify('Break finished. Ready to focus.', 'break');
  }
}
function recordSession(){
  const today=new Date().getFullYear() + '-'
    + String(new Date().getMonth()+1).padStart(2,'0') + '-'
    + String(new Date().getDate()).padStart(2,'0');
  const ts=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const activeTask=activeTaskIdx>=0?tasks[activeTaskIdx]:null;
  const taskName=activeTask?activeTask.name:'Untitled';
  sessions.unshift({task:taskName, mode:currentMode, ts, duration:settings.focus, date:today});
  if(activeTask) activeTask.pomos=(activeTask.pomos||0)+1;
  stats.total++;
  stats.weekData=stats.weekData||{};
  stats.weekData[today]=(stats.weekData[today]||0)+1;
  if(stats.todayDate!==today){
    stats.streak=(stats.lastDate&&dayDiff(stats.lastDate,today)===1)?stats.streak+1:1;
    stats.lastDate=today; stats.todayDate=today; stats.todayCount=1;
  } else stats.todayCount++;
  updateStreakDisplay(); renderTasks(); save();
  if(document.getElementById('analytics-page').classList.contains('active')) renderHeatmap();
}
function dayDiff(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
function updateDisplay(){
  const m=Math.floor(timeLeft/60).toString().padStart(2,'0');
  const s=(timeLeft%60).toString().padStart(2,'0');
  document.getElementById('timer-display').textContent=`${m}:${s}`;
  document.title=`${m}:${s} \u2014 FocusFlow`;
  updateFloatingTimer(`${m}:${s}`);
}
function updateRing(f){ document.getElementById('ring').style.strokeDashoffset=CIRC*(1-f); }
function updateSessionLabel(){
  document.getElementById('session-count-label').textContent=
    currentMode==='focus'?`Session ${sessionCounter+1}`:'Rest period';
}
function updateStreakDisplay(){ document.getElementById('streak-num').textContent=stats.streak||0; }

/* ─ Settings ─ */
function toggleSettings(){
  settingsOpen=!settingsOpen;
  document.getElementById('settings-btn').classList.toggle('open',settingsOpen);
  document.getElementById('settings-drop').classList.toggle('open',settingsOpen);
}
document.addEventListener('click',e=>{
  if(settingsOpen&&!document.getElementById('settings-wrap').contains(e.target)){
    settingsOpen=false;
    document.getElementById('settings-btn').classList.remove('open');
    document.getElementById('settings-drop').classList.remove('open');
  }
});
function saveSettings(){
  settings.focus    =parseInt(document.getElementById('s-focus').value)||25;
  settings.short    =parseInt(document.getElementById('s-short').value)||5;
  settings.long     =parseInt(document.getElementById('s-long').value)||15;
  settings.interval =parseInt(document.getElementById('s-interval').value)||4;
  settings.autoBreak=document.getElementById('s-auto-break').checked;
  settings.autoFocus=document.getElementById('s-auto-focus').checked;
  save(); resetTimer(); toggleSettings(); showToast('Settings saved.');
}

/* ─ Tasks ─ */
function addTask(){
  const inp=document.getElementById('task-input');
  const name=inp.value.trim();
  if(!name) return;
  tasks.push({ name, done:false, pomos:0, id:Date.now() });
  inp.value='';
  renderTasks();
  save();
}

function toggleTask(id){
  const t=tasks.find(t=>t.id===id);
  if(t){ t.done=!t.done; renderTasks(); save(); }
}

function deleteTask(id){
  const idx=tasks.findIndex(t=>t.id===id);
  if(idx===-1) return;
  // If we're deleting the active task, deselect it
  if(activeTaskIdx===idx) activeTaskIdx=-1;
  // If the deleted task was before the active one, shift the index down
  else if(idx<activeTaskIdx) activeTaskIdx--;
  tasks.splice(idx,1);
  renderTasks();
  save();
}

function selectTask(id){
  const idx=tasks.findIndex(t=>t.id===id);
  if(idx===-1) return;
  activeTaskIdx = activeTaskIdx===idx ? -1 : idx;
  renderTasks();
}

function renderTasks(){
  const list=document.getElementById('task-list');
  document.getElementById('task-count').textContent=tasks.length;

  // Clear all children except the empty-state div
  Array.from(list.children).forEach(c=>{ if(!c.classList.contains('task-empty')) c.remove(); });
  const empty=document.getElementById('task-empty');

  if(!tasks.length){
    empty.style.display='block';
    return;
  }
  empty.style.display='none';

  tasks.forEach((t,i)=>{
    const el=document.createElement('div');
    el.className='task-item'+(t.done?' done':'')+(i===activeTaskIdx?' active-task':'');
    el.dataset.id=t.id;

    // Checkbox
    const chk=document.createElement('div');
    chk.className='tcheck';
    chk.textContent=t.done?'\u2713':'';
    chk.addEventListener('click',e=>{ e.stopPropagation(); toggleTask(t.id); });

    // Name
    const nm=document.createElement('span');
    nm.className='tname';
    nm.textContent=t.name;

    // Pomo count
    const pm=document.createElement('span');
    pm.className='tpomos';
    pm.textContent=(t.pomos||0)+'\u00d7';

    // Delete button
    const del=document.createElement('button');
    del.className='tdel';
    del.textContent='\u00d7';
    del.title='Remove task';
    del.addEventListener('click',e=>{ e.stopPropagation(); deleteTask(t.id); });

    el.appendChild(chk);
    el.appendChild(nm);
    el.appendChild(pm);
    el.appendChild(del);

    el.addEventListener('click',()=>selectTask(t.id));
    list.insertBefore(el, empty);
  });
}

function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ─ Ambient Sound Engine ─────────────────────────────────────────────────────
   Plays MP3 files from the "Sound Track" folder via HTML5 Audio.
   currentAudio holds the active HTMLAudioElement so it can be stopped cleanly.
────────────────────────────────────────────────────────────────────────────── */
const SOUND_FILES = {
  rain:   'Sound Track/dragon-studio-copyright-free-rain-sounds-331497.mp3',
  forest: 'Sound Track/whitenoisesleepers-rainy-day-in-town-with-birds-singing-194011.mp3',
  brown:  'Sound Track/cosmic-scapes-relaxing-smoothed-brown-noise-294838.mp3',
  thunder: 'Sound Track/universfield-relaxing-rain-387677.mp3',
};

function stopAll(){
  if(currentAudio){
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

/* ── Public API ─────────────────────────────────────────────────────────── */
function selectSound(type){
  if(currentSound === type){
    stopAll(); currentSound = null;
    document.querySelectorAll('.sound-btn').forEach(b=>b.classList.remove('active'));
    document.getElementById('ambient-status').textContent = 'off';
    return;
  }
  stopAll();
  currentSound = type;
  document.querySelectorAll('.sound-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('snd-'+type).classList.add('active');
  document.getElementById('ambient-status').textContent =
    {rain:'rain', forest:'forest', brown:'brown noise', thunder:'thunderstorm'}[type];

  const audio = new Audio(SOUND_FILES[type]);
  audio.loop = true;
  audio.volume = volume;
  audio.play().catch(()=>{}); // handle autoplay policy gracefully
  currentAudio = audio;
}

function setVolume(v){
  volume = parseFloat(v);
  if(currentAudio) currentAudio.volume = volume;
}
function stepVolume(delta){
  const slider = document.getElementById('vol-slider');
  volume = Math.min(1, Math.max(0, volume + delta));
  slider.value = volume;
  if(currentAudio) currentAudio.volume = volume;
}


/* ─ Modal ─ */
function showModal(done, nextLong){
  const title=document.getElementById('modal-title');
  const sub=document.getElementById('modal-sub');
  const btn=document.getElementById('modal-action');
  if(done==='focus'){
    title.textContent='Session Complete';
    sub.textContent=nextLong?'Excellent work. Take a long rest.':'Good work. Time for a short rest.';
    btn.textContent=nextLong?'Long Break':'Short Break';
    btn.onclick=()=>{dismissModal();setMode(nextLong?'long':'short',settings.autoBreak);};
  } else {
    title.textContent='Break Finished';
    sub.textContent='Ready to focus again?';
    btn.textContent='Start Focus';
    btn.onclick=()=>{dismissModal();setMode('focus',settings.autoFocus);};
  }
  document.getElementById('modal').classList.add('open');
}
function dismissModal(){ document.getElementById('modal').classList.remove('open'); }

/* ─ Analytics ─ */
function renderAnalytics(){
  const today=new Date().getFullYear() + '-'
    + String(new Date().getMonth()+1).padStart(2,'0') + '-'
    + String(new Date().getDate()).padStart(2,'0');
  const c=stats.todayDate===today?stats.todayCount:0;
  document.getElementById('a-today').textContent=c;
  document.getElementById('a-today-min').textContent=`${c*settings.focus} min focused`;
  document.getElementById('a-streak').textContent=stats.streak||0;
  document.getElementById('a-total').textContent=stats.total;
  document.getElementById('a-total-hrs').textContent=`${(stats.total*settings.focus/60).toFixed(1)} hrs focused`;
  renderChart(); renderHeatmap(); renderLog();
}
function renderChart(){
  const wrap=document.getElementById('chart-bars'); wrap.innerHTML='';
  const today=new Date(); const tStr=today.getFullYear() + '-'
    + String(today.getMonth()+1).padStart(2,'0') + '-'
    + String(today.getDate()).padStart(2,'0');
  const days=[]; for(let i=6;i>=0;i--){const d=new Date(today);d.setDate(today.getDate()-i);
    days.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'));}
  const dn=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const maxS=Math.max(1,...days.map(d=>stats.weekData?.[d]||0));
  days.forEach(ds=>{
    const count=stats.weekData?.[ds]||0;
    const hp=count>0?Math.max(6,(count/maxS)*100):0;
    const isToday=ds===tStr;
    const dow=new Date(ds+'T00:00:00').getDay();
    const label=dn[(dow+6)%7];
    const g=document.createElement('div'); g.className='bar-col';
    const barClass='bar-fill'+(isToday?' is-today':count>0?' has-data':' is-empty');
    g.innerHTML=`<span class="bar-count">${count>0?count:''}</span>
      <div class="${barClass}" style="height:${hp>0?hp:2}%">
        <span class="bar-label">${isToday?'today':label}</span>
      </div>`;
    wrap.appendChild(g);
  });
}

/* Tooltip positioning helper — keeps tooltip in viewport */
function positionTip(e, tip){
  const GAP   = 10;
  const tw    = tip.offsetWidth  || 120;
  const th    = tip.offsetHeight || 28;
  const vw    = window.innerWidth;
  let x = e.clientX - tw/2;
  let y = e.clientY - th - GAP;
  // clamp horizontally
  if(x < 8) x = 8;
  if(x + tw > vw - 8) x = vw - tw - 8;
  // if no room above, flip below
  if(y < 8){ y = e.clientY + GAP; }
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

/* ─ Heatmap ──────────────────────────────────────────────────────────────────
   Card matches other analytics cards at full width.
   Always renders prior months back to HISTORY_WEEKS; when columns exceed the
   visible track width, the leftmost weeks slide out of view.
   Cell = 11px, gap = 3px  →  one column = 14px.
────────────────────────────────────────────────────────────────────────────── */
function renderHeatmap(){
  const HISTORY_WEEKS = 45;         // months of history to keep in the strip
  const CELL = 11, GAP = 3;         // px
  const COL_W = CELL + GAP;         // 14px per column
  const DOW_W = 26;                 // 20px labels + 6px margin

  const wrap = document.getElementById('heatmap-grid');
  wrap.innerHTML = '';

  const today    = new Date();
  // Build todayStr from LOCAL date parts to avoid UTC offset shifting the date
  const todayStr = today.getFullYear() + '-'
    + String(today.getMonth()+1).padStart(2,'0') + '-'
    + String(today.getDate()).padStart(2,'0');
  today.setHours(0,0,0,0);
  const weekData = stats.weekData || {};

  // ── Metrics ──────────────────────────────────────────────────────────────
  const activeDates = Object.keys(weekData).filter(d=>(weekData[d]||0)>0).sort();
  let longest=0, run=0, prevD=null;
  for(const d of activeDates){
    if(!prevD){ run=1; }
    else { const diff=Math.round((new Date(d)-new Date(prevD))/86400000); run=diff===1?run+1:1; }
    if(run>longest) longest=run;
    prevD=d;
  }
  document.getElementById('hm-total').textContent       = stats.total||0;
  document.getElementById('hm-active-days').textContent = activeDates.length;
  document.getElementById('hm-longest').textContent     = longest;

  // ── Date range ───────────────────────────────────────────────────────────
  // End = Sunday of the current week (today stays in the rightmost column)
  const endDate = new Date(today);
  const todayDOW = today.getDay(); // 0=Sun
  endDate.setDate(today.getDate() + (6 - todayDOW));

  // Always include prior months: start at Monday HISTORY_WEEKS before end
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - HISTORY_WEEKS * 7 + 1);
  const sDOW = startDate.getDay();
  startDate.setDate(startDate.getDate() - ((sDOW + 6) % 7));

  const allDays = [];
  const cur = new Date(startDate);
  while(cur <= endDate){
    const ds = cur.getFullYear()+'-'+String(cur.getMonth()+1).padStart(2,'0')+'-'+String(cur.getDate()).padStart(2,'0');
    allDays.push(ds);
    cur.setDate(cur.getDate()+1);
  }

  // Group into weeks of 7
  const weeks = [];
  for(let i=0;i<allDays.length;i+=7) weeks.push(allDays.slice(i,i+7));

  const totalCols  = weeks.length;
  const trackWidth = totalCols * COL_W - GAP;

  // ── Level mapping ─────────────────────────────────────────────────────────
  function getLevel(n){
    if(!n) return 0;
    if(n<=1) return 1;
    if(n<=3) return 2;
    if(n<=6) return 3;
    return 4;
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── DOM structure ─────────────────────────────────────────────────────────
  const viewport = document.createElement('div');
  viewport.className = 'heatmap-viewport';

  const dowCol = document.createElement('div');
  dowCol.className = 'hm-dow-labels';
  ['','Mon','','Wed','','Fri',''].forEach(lbl => {
    const d = document.createElement('div');
    d.className = 'hm-dow';
    d.textContent = lbl;
    dowCol.appendChild(d);
  });

  const track = document.createElement('div');
  track.className = 'hm-track';

  const strip = document.createElement('div');
  strip.className = 'hm-strip';
  strip.style.width = trackWidth + 'px';

  const monthRow = document.createElement('div');
  monthRow.className = 'hm-month-labels';

  const weeksRow = document.createElement('div');
  weeksRow.className = 'hm-weeks';

  let lastMonth = -1;

  weeks.forEach((week) => {
    const firstDay   = new Date(week[0] + 'T00:00:00');
    const thisMonth  = firstDay.getMonth();
    const mlSpan     = document.createElement('span');
    mlSpan.className = 'hm-month-label';
    mlSpan.style.width    = COL_W + 'px';
    mlSpan.style.minWidth = COL_W + 'px';
    if(thisMonth !== lastMonth){
      mlSpan.textContent = MONTHS[thisMonth];
      lastMonth = thisMonth;
    }
    monthRow.appendChild(mlSpan);

    const weekCol = document.createElement('div');
    weekCol.className = 'hm-week';

    week.forEach(dayStr => {
      const count    = weekData[dayStr] || 0;
      const isFuture = dayStr > todayStr;
      const isToday  = dayStr === todayStr;
      const level    = isFuture ? 'future' : getLevel(count);

      const cell = document.createElement('div');
      cell.className = 'hm-cell'
        + (isFuture ? ' hm-future' : ` hm-${level}`)
        + (isToday  ? ' hm-today'  : '');

      const dObj = new Date(dayStr + 'T00:00:00');
      const dateLabel = dObj.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const tipText = isFuture
        ? dateLabel
        : count===0
          ? `No sessions — ${dateLabel}`
          : `${count} session${count>1?'s':''} — ${dateLabel}`;

      if(!isFuture){
        cell.addEventListener('mouseenter', e => {
          const tip = document.getElementById('hm-tooltip');
          tip.textContent = tipText;
          tip.classList.add('visible');
          positionTip(e, tip);
        });
        cell.addEventListener('mousemove',  e => positionTip(e, document.getElementById('hm-tooltip')));
        cell.addEventListener('mouseleave', ()  => document.getElementById('hm-tooltip').classList.remove('visible'));
      }

      weekCol.appendChild(cell);
    });

    weeksRow.appendChild(weekCol);
  });

  strip.appendChild(monthRow);
  strip.appendChild(weeksRow);
  track.appendChild(strip);
  viewport.appendChild(dowCol);
  viewport.appendChild(track);
  wrap.appendChild(viewport);

  // After layout, slide left so the rightmost columns fill the track width
  function applyHeatmapSlide(){
    const trackW = track.clientWidth;
    if(!trackW){ requestAnimationFrame(applyHeatmapSlide); return; }
    const visibleCols = Math.floor((trackW + GAP) / COL_W);
    if(totalCols > visibleCols){
      const overflow = (totalCols - visibleCols) * COL_W;
      strip.style.transform = `translateX(-${overflow}px)`;
    }
  }
  requestAnimationFrame(applyHeatmapSlide);
}

function renderLog(){
  const body=document.getElementById('log-body');
  const today=new Date().getFullYear() + '-'
    + String(new Date().getMonth()+1).padStart(2,'0') + '-'
    + String(new Date().getDate()).padStart(2,'0');
  const todaySessions=sessions.filter(s=>s.date===today);
  if(!todaySessions.length){
    body.innerHTML='<div class="log-empty">No sessions today yet. Complete a focus session to begin.</div>';
    return;
  }
  body.innerHTML='';
  todaySessions.slice(0,30).forEach(s=>{
    const el=document.createElement('div'); el.className='log-row';
    el.innerHTML=`<span class="log-task">${esc(s.task)}</span><span class="log-meta">${s.ts}&thinsp;&middot;&thinsp;${s.duration}&thinsp;min</span>`;
    body.appendChild(el);
  });
}

/* ─ Completion chimes ──────────────────────────────────────────────────────
   playFocusChime  — three ascending tones, warm and satisfying (session done)
   playBreakChime  — two soft descending tones (break over, back to work)
   Uses its own AudioContext so it works even when ambient sound is off.
────────────────────────────────────────────────────────────────────────── */
function getChimeCtx(){
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(ctx, dest, freq, startTime, duration, gainPeak, type='sine'){
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, startTime);
  env.gain.linearRampToValueAtTime(gainPeak, startTime + 0.04);
  env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(env); env.connect(dest);
  osc.start(startTime); osc.stop(startTime + duration + 0.05);
}

function playFocusChime(){
  // Three ascending bell tones — celebratory, gentle
  try {
    const ctx  = getChimeCtx();
    const dest = ctx.destination;
    const now  = ctx.currentTime;
    const g    = ctx.createGain(); g.gain.value = 0.55; g.connect(dest);
    // Add a touch of reverb via a short delay
    const del  = ctx.createDelay(0.4); del.delayTime.value=0.22;
    const delG = ctx.createGain(); delG.gain.value=0.18;
    g.connect(del); del.connect(delG); delG.connect(dest);
    playTone(ctx,g, 523.25, now+0.0,  1.4, 0.45); // C5
    playTone(ctx,g, 659.25, now+0.22, 1.4, 0.40); // E5
    playTone(ctx,g, 783.99, now+0.44, 1.8, 0.38); // G5
  } catch(e){}
}

function playBreakChime(){
  // Two soft descending tones — gentle nudge, not jarring
  try {
    const ctx  = getChimeCtx();
    const dest = ctx.destination;
    const now  = ctx.currentTime;
    const g    = ctx.createGain(); g.gain.value=0.42; g.connect(dest);
    playTone(ctx,g, 440.00, now+0.0,  1.2, 0.38); // A4
    playTone(ctx,g, 349.23, now+0.28, 1.5, 0.32); // F4
  } catch(e){}
}

/* ─ Toast & notify ─ */
let toastT;
function showToast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2600);
}
function notify(msg, chime){
  if('Notification' in window&&Notification.permission==='granted')
    new Notification('FocusFlow',{body:msg});
  if(chime==='focus') playFocusChime();
  else if(chime==='break') playBreakChime();
  showToast(msg);
}

/* ─ Keyboard ─ */
document.addEventListener('keydown',e=>{
  if(['INPUT','TEXTAREA'].includes(e.target.tagName))return;
  if(e.code==='Space'){e.preventDefault();toggleTimer();}
  else if(e.key==='r'||e.key==='R')resetTimer();
  else if(e.key==='n'||e.key==='N')nextSession();
  else if(e.key==='s'||e.key==='S')toggleSettings();
});

/* ─ Authentication Handlers ─ */
function openAuthModal() {
  if (!supabaseClient) {
    showToast("Supabase is not configured yet. Set credentials in app.js.");
    return;
  }
  document.getElementById('auth-error').style.display = 'none';
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
  setAuthTab('login');
  document.getElementById('auth-modal').classList.add('open');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.remove('open');
}

function setAuthTab(tab) {
  authMode = tab;
  const loginTab = document.getElementById('tab-login');
  const signupTab = document.getElementById('tab-signup');
  const submitBtn = document.getElementById('auth-submit-btn');
  
  if (tab === 'login') {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    submitBtn.textContent = 'Login';
  } else {
    loginTab.classList.remove('active');
    signupTab.classList.add('active');
    submitBtn.textContent = 'Sign Up';
  }
  document.getElementById('auth-error').style.display = 'none';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit-btn');

  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = authMode === 'login' ? 'Logging in...' : 'Signing up...';

  try {
    let result;
    if (authMode === 'login') {
      result = await supabaseClient.auth.signInWithPassword({ email, password });
    } else {
      result = await supabaseClient.auth.signUp({ email, password });
    }

    if (result.error) {
      errorEl.textContent = result.error.message;
      errorEl.style.display = 'block';
    } else {
      closeAuthModal();
      if (authMode === 'signup') {
        showToast("Registration successful! Check your email if verification is required.");
      }
    }
  } catch (err) {
    errorEl.textContent = "An unexpected error occurred.";
    errorEl.style.display = 'block';
    console.error("Auth error:", err);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = authMode === 'login' ? 'Login' : 'Sign Up';
  }
}

async function handleLogout() {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) {
      console.error("Error signing out:", error);
    } else {
      // Close settings menu
      settingsOpen = false;
      document.getElementById('settings-btn').classList.remove('open');
      document.getElementById('settings-drop').classList.remove('open');
      showToast("Logged out successfully.");
    }
  } catch (e) {
    console.error("Logout error:", e);
  }
}

/* ─ Init ─ */
(async function(){
  // Load local data as fallback
  loadLocalData();
  
  if (settings.timerState) {
    restoreTimerState();
  } else {
    timeLeft=totalTime=getDuration('focus');
    updateDisplay(); updateRing(1);
  }
  renderTasks(); updateStreakDisplay(); updateSessionLabel();
  
  const today=new Date().getFullYear() + '-'
    + String(new Date().getMonth()+1).padStart(2,'0') + '-'
    + String(new Date().getDate()).padStart(2,'0');
  if(stats.lastDate&&dayDiff(stats.lastDate,today)>1){stats.streak=0;save();}
  if('Notification' in window&&Notification.permission==='default')Notification.requestPermission();

  // Initialize Supabase Listeners
  if (supabaseClient) {
    // Check for existing session
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      currentUser = session.user;
      document.getElementById('login-btn').style.display = 'none';
      document.getElementById('logout-btn').style.display = 'block';
      await syncDataFromDatabase();
    } else {
      currentUser = null;
      document.getElementById('login-btn').style.display = 'block';
      document.getElementById('logout-btn').style.display = 'none';
    }

    // Set up auth state change observer
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        currentUser = session.user;
        document.getElementById('login-btn').style.display = 'none';
        document.getElementById('logout-btn').style.display = 'block';
        await syncDataFromDatabase();
      } else {
        currentUser = null;
        document.getElementById('login-btn').style.display = 'block';
        document.getElementById('logout-btn').style.display = 'none';
        loadLocalData();
      }
    });
  } else {
    // If credentials are empty, show Login button but trigger toast message
    document.getElementById('login-btn').style.display = 'block';
    document.getElementById('logout-btn').style.display = 'none';
  }

  // Sync from Supabase on tab visibility change
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncDataFromDatabase();
    }
  });
})();

/* ─ Floating Mini Timer ────────────────────────────────────────────────────
   Uses the Document Picture-in-Picture API (Chrome 116+) when available
   so the timer floats above ALL desktop apps.
   Falls back to a draggable in-browser overlay for other browsers.
─────────────────────────────────────────────────────────────────────────── */
let pipWindow = null;
let floatActive = false;

function modeLabel(m) {
  return m === 'focus' ? 'Focus' : m === 'short' ? 'Short Break' : 'Long Break';
}

async function toggleFloatingTimer(enable) {
  // Sync the settings checkbox
  const cb = document.getElementById('s-floating');
  if (cb) cb.checked = !!enable;
  settings.floatingTimer = !!enable;
  // Persist state (but don't trigger a heavy save on every tick)
  localStorage.setItem('ff_settings', JSON.stringify(settings));

  // If running in Electron, the window itself is the floating timer
  const isElectron = navigator.userAgent.toLowerCase().includes('electron');
  if (isElectron) {
    return;
  }

  if (enable) {
    floatActive = true;
    if ('documentPictureInPicture' in window) {
      await openPiP();
    } else {
      openFloatOverlay();
    }
  } else {
    floatActive = false;
    closePiP();
    closeFloatOverlay();
  }
}

/* ── Document PiP (stays on top of entire desktop) ─────────────────────── */
async function openPiP() {
  try {
    if (pipWindow) return; // already open
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 100,
      height: 36,
      disallowReturnToOpener: false,
    });

    // Build content inside PiP window — light theme, timer only
    const doc = pipWindow.document;
    doc.documentElement.style.cssText =
      'margin:0;padding:0;background:#FCFCFC;overflow:hidden;';
    doc.body.style.cssText =
      'margin:0;padding:0;width:100px;height:36px;display:flex;align-items:center;justify-content:center;background:#FCFCFC;';

    const timeEl = doc.createElement('div');
    timeEl.id = 'pip-time';
    timeEl.style.cssText = [
      'font-family:ui-monospace,monospace',
      'font-size:18px',
      'font-weight:500',
      'color:#1A120B',
      'letter-spacing:-0.3px',
      'line-height:1',
      'font-variant-numeric:tabular-nums',
      'white-space:nowrap',
      'user-select:none'
    ].join(';');
    timeEl.textContent = document.getElementById('timer-display').textContent;

    doc.body.appendChild(timeEl);

    // Set initial color
    updatePiPColors();

    // When user closes PiP window natively
    pipWindow.addEventListener('pagehide', () => {
      pipWindow = null;
      floatActive = false;
      const cb = document.getElementById('s-floating');
      if (cb) cb.checked = false;
      settings.floatingTimer = false;
      localStorage.setItem('ff_settings', JSON.stringify(settings));
    });

  } catch (e) {
    console.warn('PiP failed, falling back to overlay:', e);
    openFloatOverlay();
  }
}

function closePiP() {
  if (pipWindow) {
    try { pipWindow.close(); } catch(e){}
    pipWindow = null;
  }
}

function updatePiPColors() {
  if (!pipWindow) return;
  const timeEl = pipWindow.document.getElementById('pip-time');
  if (!timeEl) return;
  if (currentMode === 'focus') {
    timeEl.style.color = running ? '#1ba872' : '#1A120B';
  } else {
    timeEl.style.color = '#c97700';
  }
}

/* ── In-browser floating overlay (fallback) ─────────────────────────────── */
function openFloatOverlay() {
  const el = document.getElementById('float-timer');
  if (!el) return;
  el.style.display = 'flex';
  el.setAttribute('data-running', running ? 'true' : 'false');
  el.setAttribute('data-mode', currentMode);
  makeDraggable(el);
  // Sync initial text
  const t = document.getElementById('timer-display').textContent;
  const fTime = document.getElementById('float-time-display');
  if (fTime) fTime.textContent = t;
}

function closeFloatOverlay() {
  const el = document.getElementById('float-timer');
  if (el) el.style.display = 'none';
}

function updateFloatingTimer(timeStr) {
  // Update in-browser overlay
  const floatEl = document.getElementById('float-timer');
  if (floatEl && floatEl.style.display !== 'none') {
    const fTime = document.getElementById('float-time-display');
    if (fTime) fTime.textContent = timeStr;
    floatEl.setAttribute('data-running', running ? 'true' : 'false');
    floatEl.setAttribute('data-mode', currentMode);
  }

  // Update PiP window
  if (pipWindow) {
    const pipTime = pipWindow.document.getElementById('pip-time');
    if (pipTime) pipTime.textContent = timeStr;
    updatePiPColors();
  }

  // Push to Electron floating widget via WebSocket
  wsSync_send();
}

/* ── Draggable helper ───────────────────────────────────────────────────── */
function makeDraggable(el) {
  // Prevent double-binding
  if (el._dragBound) return;
  el._dragBound = true;

  let startX, startY, initLeft, initTop;

  el.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('float-close')) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    initLeft = rect.left;
    initTop  = rect.top;

    // Switch from bottom/right anchoring to top/left for free drag
    el.style.bottom = 'auto';
    el.style.right  = 'auto';
    el.style.left   = initLeft + 'px';
    el.style.top    = initTop  + 'px';

    function onMove(e) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Clamp to viewport
      const maxX = window.innerWidth  - el.offsetWidth;
      const maxY = window.innerHeight - el.offsetHeight;
      el.style.left = Math.min(maxX, Math.max(0, initLeft + dx)) + 'px';
      el.style.top  = Math.min(maxY, Math.max(0, initTop  + dy)) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

/* ── Restore floating timer on startup if enabled ───────────────────────── */
(function restoreFloat() {
  // Run after a small delay so DOM is ready
  setTimeout(() => {
    if (settings.floatingTimer) {
      const cb = document.getElementById('s-floating');
      if (cb) cb.checked = true;
      toggleFloatingTimer(true);
    }
  }, 600);
})();
