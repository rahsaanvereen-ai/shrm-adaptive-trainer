(() => {
const $ = (id) => document.getElementById(id);
const views = ['homeView','setupView','quizView','reviewView','resultsView','missesView'];
const EXAM_TOTAL = 134;
const EXAM_SCORED = 110;
const FIELD_TEST = 24;
const SECTION_SIZE = 67;
const SECTION_SECONDS = 110 * 60;
const PER_Q_SEC = 220 * 60 / 134;
const STORAGE_KEY = 'shrm-adaptive-trainer-v1';
const MODES = [
{id:'quick10', name:'Quick 10', count:10, mode:'learn', desc:'Instant feedback after every answer.'},
{id:'practice20', name:'Practice 20', count:20, mode:'learn', desc:'Balanced learning session.'},
{id:'practice40', name:'Timed 40', count:40, mode:'mock', desc:'No feedback until submission.'},
{id:'half67', name:'Half Exam', count:67, mode:'mock', fixedSeconds:SECTION_SECONDS, desc:'67 questions · 110
minutes.'},
{id:'full134', name:'Full Simulation', count:134, mode:'full', fixedSeconds:220*60, desc:'2 sections · 67 questions
· 110 min each.'},
{id:'adaptive25', name:'Adaptive 25', count:25, mode:'learn', adaptive:true, desc:'Weights weak areas and missed
concepts.'}
];
let state = loadState();
let session = null;
let timerHandle = null;
let deferredInstallPrompt = null;
let supabaseClient = null;
let currentUser = null;
let cloudSaveTimer = null;
let cloudPullInProgress = false;
function defaultState(){
return {attempts:{}, domains:{}, history:[], reviewQueue:{}, totalCorrect:0, totalAnswered:0};
}
function loadState(){
try{
}catch{
return defaultState();
const raw = localStorage.getItem(STORAGE_KEY);
return raw ? {...defaultState(), ...JSON.parse(raw)} : defaultState();
}
}
function saveState(){
localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
scheduleCloudSave();
}
function cloudConfigured(){
const cfg = window.APP_CONFIG || {};
return !!(cfg.supabaseUrl && cfg.supabasePublishableKey && window.supabase?.createClient);
}
function scheduleCloudSave(){
if(!supabaseClient || !currentUser || cloudPullInProgress) return;
clearTimeout(cloudSaveTimer);
cloudSaveTimer = setTimeout(pushProgress, 500);
}
async function pushProgress(){
if(!supabaseClient || !currentUser) return;
const {error} = await supabaseClient.from('user_progress').upsert({
user_id: currentUser.id,
progress: {...state},
updated_at: new Date().toISOString()
}, {onConflict:'user_id'});
if(error){
console.warn('Cloud save failed', error);
updateSyncUI('error');
}else{
updateSyncUI('saved');
}
}
async function pullProgress(){
if(!supabaseClient || !currentUser) return;
cloudPullInProgress = true;
const {data,error} = await supabaseClient
.from('user_progress')
.select('progress')
.eq('user_id', currentUser.id)
.maybeSingle();
if(!error && data?.progress){
state = {...defaultState(), ...data.progress};
localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
renderDashboard();
}else if(!error && !data){
await pushProgress();
}
cloudPullInProgress = false;
updateSyncUI(error ? 'error' : 'saved');}
function updateSyncUI(status=''){
const banner = $('authBanner');
if(!banner) return;
banner.classList.remove('cloud-ok','cloud-warn');
if(currentUser){
$('syncTitle').textContent = 'Cloud sync active';
$('syncText').textContent = `Signed in as ${currentUser.email || 'your account'}${status==='saved' ? ' · Progress
saved' : ''}`;
$('syncBtn').textContent = 'Account';
banner.classList.add('cloud-ok');
}else if(cloudConfigured()){
$('syncTitle').textContent = 'Cloud sync ready';
$('syncText').textContent = 'Sign in once to save progress across devices.';
$('syncBtn').textContent = 'Sign in';
banner.classList.add('cloud-warn');
}else{
$('syncTitle').textContent = 'Local progress active';
$('syncText').textContent = 'Your progress is saved on this device.';
$('syncBtn').textContent = 'Setup info';
}
const signed = !!currentUser;
$('signInBtn')?.classList.toggle('hidden', signed);
$('signUpBtn')?.classList.toggle('hidden', signed);
$('signOutBtn')?.classList.toggle('hidden', !signed);
if($('authStatus')) $('authStatus').textContent = signed ? `Signed in as ${currentUser.email || 'account'}` : '';
}
async function initCloud(){
if(!cloudConfigured()){
updateSyncUI();
return;
}
const cfg = window.APP_CONFIG;
supabaseClient = window.supabase.createClient(
cfg.supabaseUrl,
cfg.supabasePublishableKey,
{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}
);
const {data:{session:authSession}} = await supabaseClient.auth.getSession();
currentUser = authSession?.user || null;
updateSyncUI();
if(currentUser) await pullProgress();
supabaseClient.auth.onAuthStateChange(async(_event,newSession)=>{
currentUser = newSession?.user || null;
updateSyncUI();
if(currentUser) await pullProgress();
});
}
function showView(id){
views.forEach(v => $(v)?.classList.toggle('active', v===id));
window.scrollTo({top:0,behavior:'smooth'});
}
function fmt(sec){
sec = Math.max(0, Math.floor(sec));
const h = Math.floor(sec/3600);
const m = Math.floor((sec%3600)/60);
const s = sec%60;
return h
? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
: `${m}:${String(s).padStart(2,'0')}`;
}
function modeSeconds(mode){
if(mode.id === 'full134') return SECTION_SECONDS;
return mode.fixedSeconds || Math.round(mode.count * PER_Q_SEC);
}
function renderModes(){
const grid = $('modeGrid');
if(!grid) return;
grid.innerHTML = '';
MODES.forEach(m=>{
const b = document.createElement('button');
b.className = 'mode-card';
b.type = 'button';
const total = m.id==='full134' ? '2 × 110 min' : fmt(modeSeconds(m));
b.innerHTML = `<strong>${m.name}</strong><span>${m.desc}</span><span class="mode-time">${m.count} questions · ${
total}</span>`;
b.addEventListener('click',()=>startSession(m));
grid.appendChild(b);
});
}
function shuffle(arr){
const a = [...arr];
for(let i=a.length-1;i>0;i--){
const j = Math.floor(Math.random()*(i+1));
[a[i],a[j]] = [a[j],a[i]];
}
return a;
}
function weightedQuestionPool(){
const bank = window.QUESTION_BANK || [];const weighted = [];
bank.forEach(q=>{
const d = state.domains[q.domain] || {c:0,t:0};
const acc = d.t ? d.c/d.t : .5;
const miss = state.reviewQueue[q.id] ? 2.5 : 0;
const copies = Math.max(1, Math.round((1 + (1-acc)*2 + miss)*2));
for(let i=0;i<copies;i++) weighted.push(q);
});
return weighted;
}
function chooseQuestions(count, adaptive=false){
const bank = window.QUESTION_BANK || [];
if(!bank.length) return [];
if(!adaptive){
const groups = {};
bank.forEach(q => (groups[q.domain] ||= []).push(q));
Object.keys(groups).forEach(k => groups[k] = shuffle(groups[k]));
const domains = Object.keys(groups);
const picked = [];
let idx = 0;
while(picked.length<count && picked.length<bank.length){
const d = domains[idx % domains.length];
const candidates = groups[d].filter(q => !picked.some(p => p.id===q.id));
if(candidates.length) picked.push(candidates[Math.floor(Math.random()*candidates.length)]);
idx++;
if(idx > bank.length*10) break;
}
if(picked.length<count){
shuffle(bank).forEach(q=>{
if(picked.length<count && !picked.some(p=>p.id===q.id)) picked.push(q);
});
}
return picked.slice(0,count);
}
const pool = weightedQuestionPool();
const picked = [];
let guard = 0;
while(picked.length<count && guard<5000 && pool.length){
const q = pool[Math.floor(Math.random()*pool.length)];
if(!picked.some(p=>p.id===q.id)) picked.push(q);
guard++;
}
if(picked.length<count){
shuffle(bank).forEach(q=>{
if(picked.length<count && !picked.some(p=>p.id===q.id)) picked.push(q);
});
}
return picked.slice(0,count);
}
function remapForSession(items){
let last = -1;
let streak = 0;
return items.map(original=>{
const q = JSON.parse(JSON.stringify(original));
let allowed = [0,1,2,3];
if(streak>=2) allowed = allowed.filter(x=>x!==last);
const target = allowed[Math.floor(Math.random()*allowed.length)];
const correctText = q.options[q.correct];
const wrong = q.options.filter((_,i)=>i!==q.correct);
for(let i=wrong.length-1;i>0;i--){
const j = Math.floor(Math.random()*(i+1));
[wrong[i],wrong[j]] = [wrong[j],wrong[i]];
}
const opts = [];
let wi = 0;
for(let p=0;p<4;p++) opts.push(p===target ? correctText : wrong[wi++]);
q.options = opts;
q.correct = target;
if(target===last) streak++;
else{
last = target;
streak = 1;
}
return q;
});
}
function assignFieldTestItems(questions){
questions.forEach(q=>q._fieldTest=false);
if(questions.length<EXAM_TOTAL) return;
shuffle(Array.from({length:EXAM_TOTAL},(_,i)=>i))
.slice(0,FIELD_TEST)
.forEach(i=>questions[i]._fieldTest=true);
}
function startSession(mode){const full = mode.id==='full134';
const count = full ? EXAM_TOTAL : mode.count;
const selected = chooseQuestions(count, mode.adaptive);
if(selected.length<count){
alert(`This mode needs ${count} unique questions, but the current bank only supplied ${selected.length}.`);
return;
}
const qs = remapForSession(selected);
if(full) assignFieldTestItems(qs);
session = {
mode,
questions:qs,
answers:{},
flagged:{},
index:0,
section:1,
sectionStart:0,
sectionEnd:full ? SECTION_SIZE : count,
sectionLocked:false,
remaining:modeSeconds(mode),
startedAt:Date.now(),
elapsed:0,
misses:[]
};
$('sectionLockNotice')?.classList.toggle('hidden',!full);
showView('quizView');
startTimer();
renderQuestion();
}
function startTimer(){
clearInterval(timerHandle);
if(!session) return;
$('timer').textContent = fmt(session.remaining);
timerHandle = setInterval(()=>{
session.remaining--;
$('timer').textContent = fmt(session.remaining);
updatePace();
if(session.remaining<=0){
clearInterval(timerHandle);
if(session.mode.id==='full134' && session.section===1) submitSection();
else finishSession();
}
},1000);
}
function updatePace(){
if(!session) return;
const sectionCount = session.sectionEnd-session.sectionStart;
const answeredInSection = Object.keys(session.answers).filter(k=>{
const i = Number(k);
return i>=session.sectionStart && i<session.sectionEnd;
}).length;
const targetSpent = (answeredInSection/sectionCount)*modeSeconds(session.mode);
const actualSpent = modeSeconds(session.mode)-session.remaining;
const delta = targetSpent-actualSpent;
const el = $('paceIndicator');
if(!el) return;
if(answeredInSection<2){
el.className='pace neutral';
el.textContent='On pace';
return;
}
if(delta>PER_Q_SEC*2){
el.className='pace good';
el.textContent='Ahead';
}else if(delta<-PER_Q_SEC*2){
el.className='pace bad';
el.textContent='Behind';
}else{
el.className='pace warn';
el.textContent='On pace';
}
}
function renderQuestion(){
if(!session) return;
const q = session.questions[session.index];
if(!q) return;
$('modeBadge').textContent = session.mode.name + (session.mode.id==='full134' ? ` · Section ${session.section}` :
'');
$('domainBadge').textContent = q.domain;
$('questionProgress').textContent = `Question ${session.index-session.sectionStart+1} of ${session.sectionEnd-
session.sectionStart}`;
$('questionType').textContent = `${q.type==='SJT' ? 'Situational Judgment' : 'Knowledge'} · ${q.topic}`;
$('questionText').textContent = q.question;
$('flagBtn').textContent = session.flagged[session.index] ? '★ Flagged' : '■ Flag';
$('flagBtn').classList.toggle('flagged',!!session.flagged[session.index]);
$('feedback').className='feedback hidden';
$('feedback').innerHTML='';
$('answersForm').innerHTML='';
q.options.forEach((opt,i)=>{const lab = document.createElement('label');
lab.className = 'answer-option' + (session.answers[session.index]===i ? ' selected' : '');
const checked = session.answers[session.index]===i ? 'checked' : '';
const disabled = (session.mode.mode==='learn' && session.answers[session.index]!==undefined) ? 'disabled' : '';
lab.innerHTML = `<input type="radio" name="answer" value="${i}" ${checked} ${disabled}><span class="answer-
letter">${String.fromCharCode(65+i)}.</span><span>${opt}</span>`;
$('answersForm').appendChild(lab);
});
const has = session.answers[session.index]!==undefined;
$('nextBtn').disabled = !has;
const last = session.index===session.sectionEnd-1;
$('nextBtn').textContent = last
? (session.mode.id==='full134' && session.section===1 ? 'Review Section 1' : 'Review & Submit')
: 'Next';
if(session.mode.mode==='learn' && has) showFeedback();
updatePace();
}
$('answersForm')?.addEventListener('change',e=>{
if(!e.target.matches('input[type=radio]')) return;
const pick = Number(e.target.value);
if(session.mode.mode==='learn' && session.answers[session.index]!==undefined) return;
session.answers[session.index]=pick;
[...document.querySelectorAll('.answer-option')].forEach((el,i)=>el.classList.toggle('selected',i===pick));
$('nextBtn').disabled=false;
if(session.mode.mode==='learn'){
[...$('answersForm').querySelectorAll('input')].forEach(x=>x.disabled=true);
showFeedback();
}
});
function showFeedback(){
const q = session.questions[session.index];
const pick = session.answers[session.index];
const ok = pick===q.correct;
const fb = $('feedback');
fb.className = 'feedback ' + (ok ? 'correct' : 'incorrect');
fb.innerHTML = `<strong>${ok ? '✓ Correct' : '✕ Incorrect'}</strong><div><b>Best answer: ${String.fromCharCode(65+q.
correct)}.</b> ${q.options[q.correct]}</div><div class="why">${q.explanation}</div>`;
}
$('flagBtn')?.addEventListener('click',()=>{
session.flagged[session.index] = !session.flagged[session.index];
renderQuestion();
});
$('nextBtn')?.addEventListener('click',()=>{
if(session.index===session.sectionEnd-1){
openReview();
return;
}
});
session.index++;
renderQuestion();
function openReview(){
clearInterval(timerHandle);
const flagged = Object.keys(session.flagged).filter(k=>{
const i=Number(k);
return session.flagged[k] && i>=session.sectionStart && i<session.sectionEnd;
});
$('flaggedCount').textContent = `${flagged.length} flagged`;
const list = $('reviewList');
list.innerHTML='';
for(let i=session.sectionStart;i<session.sectionEnd;i++){
const q=session.questions[i];
const ans=session.answers[i];
const item=document.createElement('div');
item.className='review-item';
item.innerHTML=`<button type="button"><strong>${i-session.sectionStart+1}. ${q.question}</strong><div
class="answer-state">${ans===undefined ? 'Unanswered' : `Selected ${String.fromCharCode(65+ans)}`} ${session.flagged[i]
? '· ★ Flagged' : ''}</div></button>`;
item.querySelector('button').addEventListener('click',()=>{
session.index=i;
showView('quizView');
startTimer();
renderQuestion();
});
list.appendChild(item);
}
$('submitSectionBtn').textContent = session.mode.id==='full134' && session.section===1 ? 'Submit Section 1' :
'Submit Test';
showView('reviewView');
}
$('reviewBackBtn')?.addEventListener('click',()=>{
showView('quizView');
startTimer();
renderQuestion();
});
$('submitSectionBtn')?.addEventListener('click',submitSection);function submitSection(){
clearInterval(timerHandle);
if(session.mode.id==='full134' && session.section===1){
session.sectionLocked=true;
session.section=2;
session.sectionStart=SECTION_SIZE;
session.sectionEnd=EXAM_TOTAL;
session.index=SECTION_SIZE;
session.remaining=SECTION_SECONDS;
showView('quizView');
startTimer();
renderQuestion();
return;
}
finishSession();
}
function estimateScaledScore(correct,total){
if(!total) return null;
const pct=correct/total;
let score;
if(pct<=0.70){
score=120+(pct/0.70)*80;
}else{
score=200+((pct-0.70)/0.30)*40;
}
return Math.round(Math.max(120,Math.min(240,score)));
}
function readinessFromResult({pct,scaledScore,modeId,scoredCount}){
const substantial = modeId==='full134' || scoredCount>=67;
if(!substantial){
if(pct>=80) return {label:'Strong practice session',detail:'Good performance. Confirm it on a longer timed exam.
'};
if(pct>=70) return {label:'Building toward readiness',detail:'You are near the trainer target. Keep strengthening
weak areas.'};
return {label:'Diagnostic range',detail:'Use the misses and domain breakdown to target your next session.'};
}
if(scaledScore>=210 && pct>=75){
return {label:'Exam-ready range',detail:'Strong timed performance. Keep confirming it across multiple simulations.
'};
}
if(scaledScore>=200){
cushion before exam day.'};
return {label:'Passing-range practice',detail:'This simulation reached the trainer passing benchmark. Build a
}
if(scaledScore>=190){
weaker domains.'};
return {label:'Close to passing range',detail:'You are within striking distance. Prioritize recurring misses and
}
return {label:'Needs more development',detail:'Use adaptive practice and focused review before relying on full
simulations.'};
}
function typeLabel(q){
return q.type==='SJT' ? 'SJT' : 'KBI';
}
function finishSession(){
clearInterval(timerHandle);
session.elapsed=Math.max(1,Math.round((Date.now()-session.startedAt)/1000));
const full=session.mode.id==='full134';
let scoredCorrect=0;
let scoredAnswered=0;
let scoredCount=0;
const domainNow={};
const typeNow={KBI:{c:0,t:0},SJT:{c:0,t:0}};
session.misses=[];
session.questions.forEach((q,i)=>{
const ans=session.answers[i];
const ok=ans===q.correct;
const scored=!(full && q._fieldTest);
if(!ok) session.misses.push({q,ans});
if(!scored) return;
scoredCount++;
if(ans!==undefined) scoredAnswered++;
if(ok) scoredCorrect++;
if(ans!==undefined){
state.totalAnswered++;
if(ok) state.totalCorrect++;
state.domains[q.domain] ||= {c:0,t:0};
state.domains[q.domain].t++;
if(ok) state.domains[q.domain].c++;
state.attempts[q.id] ||= {c:0,t:0,last:null};
state.attempts[q.id].t++;
if(ok) state.attempts[q.id].c++;state.attempts[q.id].last=Date.now();
if(ok){
delete state.reviewQueue[q.id];
}else{
state.reviewQueue[q.id]={
due:Date.now()+24*3600*1000,
misses:(state.reviewQueue[q.id]?.misses||0)+1
};
}
domainNow[q.domain] ||= {c:0,t:0};
domainNow[q.domain].t++;
if(ok) domainNow[q.domain].c++;
const bucket=typeNow[typeLabel(q)];
bucket.t++;
if(ok) bucket.c++;
}
});
const pct=scoredCount ? Math.round(scoredCorrect/scoredCount*100) : 0;
const scaledScore=estimateScaledScore(scoredCorrect,scoredCount);
const readiness=readinessFromResult({
pct,
scaledScore,
modeId:session.mode.id,
scoredCount
});
state.history.unshift({
date:Date.now(),
mode:session.mode.name,
count:session.questions.length,
scoredCount,
scoredCorrect,
scoredAnswered,
correct:scoredCorrect,
pct,
scaledScore,
readiness:readiness.label,
elapsed:session.elapsed
});
state.history=state.history.slice(0,12);
saveState();
$('resultHeadline').textContent=readiness.label;
$('resultScore').textContent=`${scoredCorrect}/${scoredCount}`;
$('resultPercent').textContent=`${pct}%`;
$('resultTime').textContent=full
? `Completed in ${fmt(session.elapsed)} · ${scoredAnswered}/${scoredCount} scored items answered · 24
experimental items excluded`
: `Completed in ${fmt(session.elapsed)} · ${scoredAnswered} answered`;
const breakdown=$('resultBreakdown');
breakdown.innerHTML='';
const scoreTitle=document.createElement('p');
scoreTitle.className='eyebrow';
scoreTitle.textContent='V2 SCORE SUMMARY';
breakdown.appendChild(scoreTitle);
const scoreGrid=document.createElement('div');
scoreGrid.className='breakdown-grid';
const scaledCard=document.createElement('div');
scaledCard.className='breakdown-card';
scaledCard.innerHTML=`<strong>${scaledScore ?? '—'}</strong><span>Practice scaled-score estimate</span>`;
scoreGrid.appendChild(scaledCard);
const readinessCard=document.createElement('div');
readinessCard.className='breakdown-card';
readinessCard.innerHTML=`<strong>${pct}%</strong><span>${readiness.label}</span>`;
scoreGrid.appendChild(readinessCard);
breakdown.appendChild(scoreGrid);
const readinessText=document.createElement('p');
readinessText.className='muted';
readinessText.textContent=readiness.detail;
breakdown.appendChild(readinessText);
const typeTitle=document.createElement('p');
typeTitle.className='eyebrow';
typeTitle.textContent='KNOWLEDGE VS SITUATIONAL JUDGMENT';
breakdown.appendChild(typeTitle);
const typeGrid=document.createElement('div');
typeGrid.className='breakdown-grid';
[
['Knowledge / KBI',typeNow.KBI],
['Situational Judgment / SJT',typeNow.SJT]
].forEach(([label,s])=>{
const div=document.createElement('div');
div.className='breakdown-card';
const p=s.t ? Math.round(s.c/s.t*100) : 0;
div.innerHTML=`<strong>${s.t ? `${p}%` : '—'}</strong><span>${label}${s.t ? ` · ${s.c}/${s.t}` : ''}</span>`;
typeGrid.appendChild(div);
});
breakdown.appendChild(typeGrid);
const domainTitle=document.createElement('p');
domainTitle.className='eyebrow';domainTitle.textContent='DOMAIN BREAKDOWN';
breakdown.appendChild(domainTitle);
const domainGrid=document.createElement('div');
domainGrid.className='breakdown-grid';
Object.entries(domainNow).forEach(([d,s])=>{
const div=document.createElement('div');
div.className='breakdown-card';
div.innerHTML=`<strong>${s.t ? Math.round(s.c/s.t*100) : 0}%</strong><span>${d} · ${s.c}/${s.t}</span>`;
domainGrid.appendChild(div);
});
breakdown.appendChild(domainGrid);
if(full){
const note=document.createElement('p');
note.className='muted';
note.textContent='Simulation scoring uses 110 scored questions from the 134 presented. The 24 experimental
questions were selected internally and were not identified during the exam. The scaled score shown here is a trainer
estimate, not an official SHRM score.';
breakdown.appendChild(note);
}
renderDashboard();
showView('resultsView');
}
$('quitBtn')?.addEventListener('click',()=>{
if(confirm('Exit this session? Current answers will not be added to your history.')){
clearInterval(timerHandle);
session=null;
showView('homeView');
}
});
$('homeBtn')?.addEventListener('click',()=>{
session=null;
showView('homeView');
});
$('reviewMissesBtn')?.addEventListener('click',()=>{
const list=$('missesList');
list.innerHTML='';
if(!session?.misses?.length){
list.innerHTML='<p class="muted">No misses in this session.</p>';
}else{
session.misses.forEach(({q,ans})=>{
const d=document.createElement('div');
d.className='miss-item';
d.innerHTML=`<div class="miss-top"><strong>${q.domain} · ${q.topic}</strong><small>${q.type==='SJT' ? 'SJT' :
'Knowledge'}</small></div><p>${q.question}</p><p><b>Your answer:</b> ${ans===undefined ? 'Unanswered' : q.options[
ans]}</p><p><b>Best answer:</b> ${q.options[q.correct]}</p><p class="why">${q.explanation}</p>`;
list.appendChild(d);
});
}
showView('missesView');
});
$('missesBackBtn')?.addEventListener('click',()=>showView('resultsView'));
function renderDashboard(){
$('overallAccuracy').textContent=state.totalAnswered
? `${Math.round(state.totalCorrect/state.totalAnswered*100)}%`
: '—';
const due=Object.values(state.reviewQueue).filter(x=>x.due<=Date.now()).length;
$('dueCount').textContent=`${due} due`;
const domains=['People','Organization','Workplace','Compliance'];
const box=$('domainStats');
box.innerHTML='';
domains.forEach(d=>{
const s=state.domains[d] || {c:0,t:0};
const pct=s.t ? Math.round(s.c/s.t*100) : 0;
const row=document.createElement('div');
row.className='stat-row';
row.innerHTML=`<span>${d}</span><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></
div></div><strong>${s.t ? `${pct}%` : '—'}</strong>`;
box.appendChild(row);
});
const hist=$('historyList');
hist.innerHTML='';
if(!state.history.length){
hist.innerHTML='<p class="muted">Your completed tests will appear here.</p>';
}else{
state.history.slice(0,5).forEach(h=>{
const div=document.createElement('div');
div.className='history-item';
const scoredTotal=h.scoredCount ?? h.count;
const scoredCorrect=h.scoredCorrect ?? h.correct;
const scaleText=Number.isFinite(h.scaledScore) ? ` · Est. ${h.scaledScore}` : '';
div.innerHTML=`<div class="history-top"><strong>${h.mode}</strong><strong>${h.pct}%</strong></div><small>${new
Date(h.date).toLocaleDateString()} · ${scoredCorrect}/${scoredTotal} · ${fmt(h.elapsed)}${scaleText}</small>`;
hist.appendChild(div);
});
}
}$('resetDataBtn')?.addEventListener('click',()=>{
if(confirm('Reset all local practice history and adaptive data?')){
state=defaultState();
saveState();
renderDashboard();
}
});
$('syncBtn')?.addEventListener('click',()=>showView('setupView'));
$('setupBackBtn')?.addEventListener('click',()=>showView('homeView'));
window.addEventListener('beforeinstallprompt',e=>{
e.preventDefault();
deferredInstallPrompt=e;
$('installBtn')?.classList.remove('hidden');
});
$('installBtn')?.addEventListener('click',async()=>{
if(!deferredInstallPrompt) return;
deferredInstallPrompt.prompt();
await deferredInstallPrompt.userChoice;
deferredInstallPrompt=null;
$('installBtn')?.classList.add('hidden');
});
if('serviceWorker' in navigator){
window.addEventListener('load',()=>{
navigator.serviceWorker.register('./sw.js').catch(()=>{});
});
}
$('signInBtn')?.addEventListener('click',async()=>{
if(!supabaseClient){
$('authStatus').textContent='Cloud sync is not configured yet.';
return;
}
const email=$('authEmail').value.trim();
const password=$('authPassword').value;
if(!email || !password){
$('authStatus').textContent='Enter your email and password.';
return;
}
$('authStatus').textContent='Signing in…';
const {error}=await supabaseClient.auth.signInWithPassword({email,password});
$('authStatus').textContent=error ? error.message : 'Signed in.';
});
$('signUpBtn')?.addEventListener('click',async()=>{
if(!supabaseClient){
$('authStatus').textContent='Cloud sync is not configured yet.';
return;
}
const email=$('authEmail').value.trim();
const password=$('authPassword').value;
if(!email || password.length<6){
$('authStatus').textContent='Use a valid email and a password of at least 6 characters.';
return;
}
$('authStatus').textContent='Creating account…';
const {data,error}=await supabaseClient.auth.signUp({email,password});
if(error) $('authStatus').textContent=error.message;
else if(data.session) $('authStatus').textContent='Account created and signed in.';
else $('authStatus').textContent='Account created. Check your email to confirm, then sign in.';
});
$('signOutBtn')?.addEventListener('click',async()=>{
if(supabaseClient) await supabaseClient.auth.signOut();
currentUser=null;
updateSyncUI();
});
renderModes();
renderDashboard();
showView('homeView');
initCloud();
})();




SHRM Adaptive Trainer V2 - app.js Replacement
Use this as a FULL replacement for the current app.js file.
What this version adds/fixes:
- fixes the broken JavaScript structure in the current app.js
- keeps Quick 10, Practice 20, Timed 40, Half Exam, Full Simulation, and Adaptive 25
- randomizes answer-letter positions each session
- keeps Supabase cloud sync
- adds a clearly labeled PRACTICE scaled-score estimate
- treats 24 of 134 full-simulation items as hidden experimental items
- adds readiness labels plus KBI/SJT and domain breakdowns
Copy ONLY the code beginning on the next page and replace the entire contents of app.js.
After GitHub saves/deploys, open the app and run a Quick 10 first, then a Half Exam test.
Important: the scaled score is an estimate for training. It is not SHRM's official scoring formula.(() => {
const $ = (id) => document.getElementById(id);
const views = ['homeView','setupView','quizView','reviewView','resultsView','missesView'];
const EXAM_TOTAL = 134;
const EXAM_SCORED = 110;
const FIELD_TEST = EXAM_TOTAL - EXAM_SCORED;
const SECTION_SIZE = 67;
const SECTION_SECONDS = 110 * 60;
const PER_Q_SEC = 220 * 60 / EXAM_TOTAL;
const STORAGE_KEY = 'shrm-adaptive-trainer-v1';
const MODES = [
{id:'quick10', name:'Quick 10', count:10, mode:'learn', desc:'Instant feedback after every answer.'},
{id:'practice20', name:'Practice 20', count:20, mode:'learn', desc:'Balanced learning session.'},
{id:'practice40', name:'Timed 40', count:40, mode:'mock', desc:'No feedback until submission.'},
{id:'half67', name:'Half Exam', count:67, mode:'mock', fixedSeconds:SECTION_SECONDS, desc:'67 questions - 110 minutes.'},
{id:'full134', name:'Full Simulation', count:EXAM_TOTAL, mode:'full', fixedSeconds:220*60, desc:'2 sections - 67 questions - 110 min each.'},
{id:'adaptive25', name:'Adaptive 25', count:25, mode:'learn', adaptive:true, desc:'Weights weak areas and missed concepts.'}
];
let state = loadState();
let session = null;
let timerHandle = null;
let deferredInstallPrompt = null;
let supabaseClient = null;
let currentUser = null;
let cloudSaveTimer = null;
let cloudPullInProgress = false;
function defaultState(){
return {attempts:{}, domains:{}, history:[], reviewQueue:{}, totalCorrect:0, totalAnswered:0};
}
function loadState(){
try{
}catch{
return defaultState();
const raw = localStorage.getItem(STORAGE_KEY);
return raw ? {...defaultState(), ...JSON.parse(raw)} : defaultState();
}
}
function saveState(){
localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
scheduleCloudSave();
}
function cloudConfigured(){
const cfg = window.APP_CONFIG || {};
return !!(cfg.supabaseUrl && cfg.supabasePublishableKey && window.supabase?.createClient);
}
function scheduleCloudSave(){
if(!supabaseClient || !currentUser || cloudPullInProgress) return;
clearTimeout(cloudSaveTimer);
cloudSaveTimer = setTimeout(pushProgress, 500);
}
async function pushProgress(){
if(!supabaseClient || !currentUser) return;
const {error} = await supabaseClient.from('user_progress').upsert({
user_id: currentUser.id,
progress: {...state},
updated_at: new Date().toISOString()
}, {onConflict:'user_id'});
if(error){
console.warn('Cloud save failed', error);
updateSyncUI('error');
}else{
updateSyncUI('saved');
}
}
async function pullProgress(){
if(!supabaseClient || !currentUser) return;
cloudPullInProgress = true;
const {data,error} = await supabaseClient
.from('user_progress')
.select('progress')
.eq('user_id', currentUser.id)
.maybeSingle();
if(!error && data?.progress){
state = {...defaultState(), ...data.progress};
localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
renderDashboard();
}else if(!error && !data){
await pushProgress();
}
cloudPullInProgress = false;
updateSyncUI(error ? 'error' : 'saved');
}
function updateSyncUI(status=''){
const banner = $('authBanner');
if(!banner) return;
banner.classList.remove('cloud-ok','cloud-warn');
if(currentUser){
$('syncTitle').textContent = 'Cloud sync active';
$('syncText').textContent = `Signed in as ${currentUser.email || 'your account'}${status==='saved' ? ' - Progress saved' : ''}`;
$('syncBtn').textContent = 'Account';
banner.classList.add('cloud-ok');
}else if(cloudConfigured()){
$('syncTitle').textContent = 'Cloud sync ready';
$('syncText').textContent = 'Sign in once to save progress across devices.';
$('syncBtn').textContent = 'Sign in';
banner.classList.add('cloud-warn');
}else{
$('syncTitle').textContent = 'Local progress active';
$('syncText').textContent = 'Your progress is saved on this device.';
$('syncBtn').textContent = 'Setup info';
}
const signed = !!currentUser;
$('signInBtn')?.classList.toggle('hidden', signed);
$('signUpBtn')?.classList.toggle('hidden', signed);
$('signOutBtn')?.classList.toggle('hidden', !signed);
if($('authStatus')) $('authStatus').textContent = signed ? `Signed in as ${currentUser.email || 'account'}` : '';
}
async function initCloud(){if(!cloudConfigured()){
updateSyncUI();
return;
}
const cfg = window.APP_CONFIG;
supabaseClient = window.supabase.createClient(
cfg.supabaseUrl,
cfg.supabasePublishableKey,
{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}
);
const {data:{session:authSession}} = await supabaseClient.auth.getSession();
currentUser = authSession?.user || null;
updateSyncUI();
if(currentUser) await pullProgress();
supabaseClient.auth.onAuthStateChange(async(_event,newSession)=>{
currentUser = newSession?.user || null;
updateSyncUI();
if(currentUser) await pullProgress();
});
}
function showView(id){
views.forEach(v => $(v)?.classList.toggle('active', v===id));
window.scrollTo({top:0,behavior:'smooth'});
}
function fmt(sec){
sec = Math.max(0, Math.floor(sec));
const h = Math.floor(sec/3600);
const m = Math.floor((sec%3600)/60);
const s = sec%60;
return h
? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
: `${m}:${String(s).padStart(2,'0')}`;
}
function modeSeconds(mode){
if(mode.id === 'full134') return SECTION_SECONDS;
return mode.fixedSeconds || Math.round(mode.count * PER_Q_SEC);
}
function renderModes(){
const grid = $('modeGrid');
if(!grid) return;
grid.innerHTML = '';
MODES.forEach(m=>{
const b = document.createElement('button');
b.className = 'mode-card';
b.type = 'button';
const total = m.id==='full134' ? '2 x 110 min' : fmt(modeSeconds(m));
b.innerHTML = `<strong>${m.name}</strong><span>${m.desc}</span><span class="mode-time">${m.count} questions - ${total}</span>`;
b.addEventListener('click',()=>startSession(m));
grid.appendChild(b);
});
}
function shuffle(arr){
const a = [...arr];
for(let i=a.length-1;i>0;i--){
const j = Math.floor(Math.random()*(i+1));
[a[i],a[j]] = [a[j],a[i]];
}
return a;
}
function weightedQuestionPool(){
const bank = window.QUESTION_BANK || [];
const weighted = [];
bank.forEach(q=>{
const d = state.domains[q.domain] || {c:0,t:0};
const acc = d.t ? d.c/d.t : .5;
const miss = state.reviewQueue[q.id] ? 2.5 : 0;
const copies = Math.max(1, Math.round((1 + (1-acc)*2 + miss)*2));
for(let i=0;i<copies;i++) weighted.push(q);
});
return weighted;
}
function chooseQuestions(count, adaptive=false){
const bank = window.QUESTION_BANK || [];
if(!bank.length) return [];
if(!adaptive){
const groups = {};
bank.forEach(q => (groups[q.domain] ||= []).push(q));
Object.keys(groups).forEach(k => groups[k] = shuffle(groups[k]));
const domains = Object.keys(groups);
const picked = [];
let idx = 0;
while(picked.length<count && picked.length<bank.length){
const d = domains[idx % domains.length];
const candidates = groups[d].filter(q => !picked.some(p => p.id===q.id));
if(candidates.length) picked.push(candidates[Math.floor(Math.random()*candidates.length)]);
idx++;
if(idx > bank.length*10) break;
}
if(picked.length<count){
shuffle(bank).forEach(q=>{
if(picked.length<count && !picked.some(p=>p.id===q.id)) picked.push(q);
});
}
return picked.slice(0,count);
}
const pool = weightedQuestionPool();
const picked = [];
let guard = 0;
while(picked.length<count && guard<5000 && pool.length){
const q = pool[Math.floor(Math.random()*pool.length)];
if(!picked.some(p=>p.id===q.id)) picked.push(q);
guard++;
}
if(picked.length<count){
shuffle(bank).forEach(q=>{
if(picked.length<count && !picked.some(p=>p.id===q.id)) picked.push(q);});
}
return picked.slice(0,count);
}
// Remap answer positions each session so answer-letter patterns cannot be memorized.
// The correct answer never stays in the same letter more than twice in a row.
function remapForSession(items){
let last = -1;
let streak = 0;
return items.map(original=>{
const q = JSON.parse(JSON.stringify(original));
let allowed = [0,1,2,3];
if(streak>=2) allowed = allowed.filter(x=>x!==last);
const target = allowed[Math.floor(Math.random()*allowed.length)];
const correctText = q.options[q.correct];
const wrong = q.options.filter((_,i)=>i!==q.correct);
for(let i=wrong.length-1;i>0;i--){
const j = Math.floor(Math.random()*(i+1));
[wrong[i],wrong[j]] = [wrong[j],wrong[i]];
}
const opts = [];
let wi = 0;
for(let p=0;p<4;p++) opts.push(p===target ? correctText : wrong[wi++]);
q.options = opts;
q.correct = target;
if(target===last) streak++;
else{
last = target;
streak = 1;
}
return q;
});
}
function assignFieldTestItems(questions){
questions.forEach(q=>q._fieldTest=false);
if(questions.length<EXAM_TOTAL) return;
shuffle(Array.from({length:EXAM_TOTAL},(_,i)=>i))
.slice(0,FIELD_TEST)
.forEach(i=>questions[i]._fieldTest=true);
}
function startSession(mode){
const full = mode.id==='full134';
const count = full ? EXAM_TOTAL : mode.count;
const selected = chooseQuestions(count, mode.adaptive);
if(selected.length<count){
alert(`This mode needs ${count} unique questions, but the current bank only supplied ${selected.length}.`);
return;
}
const qs = remapForSession(selected);
if(full) assignFieldTestItems(qs);
session = {
mode,
questions:qs,
answers:{},
flagged:{},
index:0,
section:1,
sectionStart:0,
sectionEnd:full ? SECTION_SIZE : count,
sectionLocked:false,
remaining:modeSeconds(mode),
startedAt:Date.now(),
elapsed:0,
misses:[]
};
$('sectionLockNotice')?.classList.toggle('hidden',!full);
showView('quizView');
startTimer();
renderQuestion();
}
function startTimer(){
clearInterval(timerHandle);
if(!session) return;
$('timer').textContent = fmt(session.remaining);
timerHandle = setInterval(()=>{
session.remaining--;
$('timer').textContent = fmt(session.remaining);
updatePace();
if(session.remaining<=0){
clearInterval(timerHandle);
if(session.mode.id==='full134' && session.section===1) submitSection();
else finishSession();
}
},1000);
}
function updatePace(){
if(!session) return;
const sectionCount = session.sectionEnd-session.sectionStart;
const answeredInSection = Object.keys(session.answers).filter(k=>{
const i = Number(k);
return i>=session.sectionStart && i<session.sectionEnd;
}).length;
const targetSpent = (answeredInSection/sectionCount)*modeSeconds(session.mode);
const actualSpent = modeSeconds(session.mode)-session.remaining;
const delta = targetSpent-actualSpent;
const el = $('paceIndicator');
if(!el) return;
if(answeredInSection<2){
el.className='pace neutral';
el.textContent='On pace';
return;
}
if(delta>PER_Q_SEC*2){el.className='pace good';
el.textContent='Ahead';
}else if(delta<-PER_Q_SEC*2){
el.className='pace bad';
el.textContent='Behind';
}else{
el.className='pace warn';
el.textContent='On pace';
}
}
function renderQuestion(){
if(!session) return;
const q = session.questions[session.index];
if(!q) return;
$('modeBadge').textContent = session.mode.name + (session.mode.id==='full134' ? ` - Section ${session.section}` : '');
$('domainBadge').textContent = q.domain;
$('questionProgress').textContent = `Question ${session.index-session.sectionStart+1} of ${session.sectionEnd-session.sectionStart}`;
$('questionType').textContent = `${q.type==='SJT' ? 'Situational Judgment' : 'Knowledge'} - ${q.topic}`;
$('questionText').textContent = q.question;
$('flagBtn').textContent = session.flagged[session.index] ? '★ Flagged' : '■ Flag';
$('flagBtn').classList.toggle('flagged',!!session.flagged[session.index]);
$('feedback').className='feedback hidden';
$('feedback').innerHTML='';
$('answersForm').innerHTML='';
q.options.forEach((opt,i)=>{
const lab = document.createElement('label');
lab.className = 'answer-option' + (session.answers[session.index]===i ? ' selected' : '');
const checked = session.answers[session.index]===i ? 'checked' : '';
const disabled = (session.mode.mode==='learn' && session.answers[session.index]!==undefined) ? 'disabled' : '';
lab.innerHTML = `<input type="radio" name="answer" value="${i}" ${checked} ${disabled}><span class="answer-letter">${String.fromCharCode(65+i)}.</span><span>${opt}</span>`;
$('answersForm').appendChild(lab);
});
const has = session.answers[session.index]!==undefined;
$('nextBtn').disabled = !has;
const last = session.index===session.sectionEnd-1;
$('nextBtn').textContent = last
? (session.mode.id==='full134' && session.section===1 ? 'Review Section 1' : 'Review & Submit')
: 'Next';
if(session.mode.mode==='learn' && has) showFeedback();
updatePace();
}
$('answersForm')?.addEventListener('change',e=>{
if(!e.target.matches('input[type=radio]')) return;
const pick = Number(e.target.value);
if(session.mode.mode==='learn' && session.answers[session.index]!==undefined) return;
session.answers[session.index]=pick;
[...document.querySelectorAll('.answer-option')].forEach((el,i)=>el.classList.toggle('selected',i===pick));
$('nextBtn').disabled=false;
if(session.mode.mode==='learn'){
[...$('answersForm').querySelectorAll('input')].forEach(x=>x.disabled=true);
showFeedback();
}
});
function showFeedback(){
const q = session.questions[session.index];
const pick = session.answers[session.index];
const ok = pick===q.correct;
const fb = $('feedback');
fb.className = 'feedback ' + (ok ? 'correct' : 'incorrect');
fb.innerHTML = `<strong>${ok ? '✓ Correct' : '✕ Incorrect'}</strong><div><b>Best answer: ${String.fromCharCode(65+q.correct)}.</b> ${q.options[q.correct]}</div><div class="why">${q.explanation}</div>`;
}
$('flagBtn')?.addEventListener('click',()=>{
session.flagged[session.index] = !session.flagged[session.index];
renderQuestion();
});
$('nextBtn')?.addEventListener('click',()=>{
if(session.index===session.sectionEnd-1){
openReview();
return;
}
});
session.index++;
renderQuestion();
function openReview(){
clearInterval(timerHandle);
const flagged = Object.keys(session.flagged).filter(k=>{
const i=Number(k);
return session.flagged[k] && i>=session.sectionStart && i<session.sectionEnd;
});
$('flaggedCount').textContent = `${flagged.length} flagged`;
const list = $('reviewList');
list.innerHTML='';
for(let i=session.sectionStart;i<session.sectionEnd;i++){
const q=session.questions[i];
const ans=session.answers[i];
const item=document.createElement('div');
item.className='review-item';
item.innerHTML=`<button type="button"><strong>${i-session.sectionStart+1}. ${q.question}</strong><div class="answer-state">${ans===undefined ? 'Unanswered' : `Selected ${String.fromCharCode(65+ans)}`} ${session.flagged[i] ? '- ★ Flagged' : ''}</div></button>`;
item.querySelector('button').addEventListener('click',()=>{
session.index=i;
showView('quizView');
startTimer();
renderQuestion();
});
list.appendChild(item);
}
$('submitSectionBtn').textContent = session.mode.id==='full134' && session.section===1 ? 'Submit Section 1' : 'Submit Test';
showView('reviewView');
}
$('reviewBackBtn')?.addEventListener('click',()=>{
showView('quizView');
startTimer();
renderQuestion();
});
$('submitSectionBtn')?.addEventListener('click',submitSection);function submitSection(){
clearInterval(timerHandle);
if(session.mode.id==='full134' && session.section===1){
session.sectionLocked=true;
session.section=2;
session.sectionStart=SECTION_SIZE;
session.sectionEnd=EXAM_TOTAL;
session.index=SECTION_SIZE;
session.remaining=SECTION_SECONDS;
showView('quizView');
startTimer();
renderQuestion();
return;
}
finishSession();
}
// SHRM does not publish a simple raw-to-scaled conversion table.
// This is intentionally labeled as a trainer estimate, not an official score.
function estimateScaledScore(correct,total){
if(!total) return null;
const pct=correct/total;
let score;
if(pct<=0.70){
score=120+(pct/0.70)*80;
}else{
score=200+((pct-0.70)/0.30)*40;
}
return Math.round(Math.max(120,Math.min(240,score)));
}
function readinessFromResult({pct,scaledScore,modeId,scoredCount}){
const substantial = modeId==='full134' || scoredCount>=67;
if(!substantial){
if(pct>=80) return {label:'Strong practice session',detail:'Good performance. Confirm it on a longer timed exam.'};
if(pct>=70) return {label:'Building toward readiness',detail:'You are near the trainer target. Keep strengthening weak areas.'};
return {label:'Diagnostic range',detail:'Use the misses and domain breakdown to target your next session.'};
}
if(scaledScore>=210 && pct>=75){
return {label:'Exam-ready range',detail:'Strong timed performance. Keep confirming it across multiple simulations.'};
}
if(scaledScore>=200){
return {label:'Passing-range practice',detail:'This simulation reached the trainer passing benchmark. Build a cushion before exam day.'};
}
if(scaledScore>=190){
return {label:'Close to passing range',detail:'You are within striking distance. Prioritize recurring misses and weaker domains.'};
}
return {label:'Needs more development',detail:'Use adaptive practice and focused review before relying on full simulations.'};
}
function typeLabel(q){
return q.type==='SJT' ? 'SJT' : 'KBI';
}
function finishSession(){
clearInterval(timerHandle);
session.elapsed=Math.max(1,Math.round((Date.now()-session.startedAt)/1000));
const full=session.mode.id==='full134';
let scoredCorrect=0;
let scoredAnswered=0;
let scoredCount=0;
const domainNow={};
const typeNow={KBI:{c:0,t:0},SJT:{c:0,t:0}};
session.misses=[];
session.questions.forEach((q,i)=>{
const ans=session.answers[i];
const ok=ans===q.correct;
const scored=!(full && q._fieldTest);
if(!ok) session.misses.push({q,ans});
if(!scored) return;
scoredCount++;
if(ans!==undefined) scoredAnswered++;
if(ok) scoredCorrect++;
if(ans!==undefined){
state.totalAnswered++;
if(ok) state.totalCorrect++;
state.domains[q.domain] ||= {c:0,t:0};
state.domains[q.domain].t++;
if(ok) state.domains[q.domain].c++;
state.attempts[q.id] ||= {c:0,t:0,last:null};
state.attempts[q.id].t++;
if(ok) state.attempts[q.id].c++;
state.attempts[q.id].last=Date.now();
if(ok){
delete state.reviewQueue[q.id];
}else{
state.reviewQueue[q.id]={
due:Date.now()+24*3600*1000,
misses:(state.reviewQueue[q.id]?.misses||0)+1
};
}
domainNow[q.domain] ||= {c:0,t:0};
domainNow[q.domain].t++;
if(ok) domainNow[q.domain].c++;
const bucket=typeNow[typeLabel(q)];
bucket.t++;
if(ok) bucket.c++;
}
});
const pct=scoredCount ? Math.round(scoredCorrect/scoredCount*100) : 0;
const scaledScore=estimateScaledScore(scoredCorrect,scoredCount);
const readiness=readinessFromResult({
pct,
scaledScore,
modeId:session.mode.id,
scoredCount
});
state.history.unshift({
date:Date.now(),mode:session.mode.name,
count:session.questions.length,
scoredCount,
scoredCorrect,
scoredAnswered,
correct:scoredCorrect,
pct,
scaledScore,
readiness:readiness.label,
elapsed:session.elapsed
});
state.history=state.history.slice(0,12);
saveState();
$('resultHeadline').textContent=readiness.label;
$('resultScore').textContent=`${scoredCorrect}/${scoredCount}`;
$('resultPercent').textContent=`${pct}%`;
$('resultTime').textContent=full
? `Completed in ${fmt(session.elapsed)} - ${scoredAnswered}/${scoredCount} scored items answered - ${FIELD_TEST} experimental items excluded`
: `Completed in ${fmt(session.elapsed)} - ${scoredAnswered} answered`;
const breakdown=$('resultBreakdown');
breakdown.innerHTML='';
const scoreTitle=document.createElement('p');
scoreTitle.className='eyebrow';
scoreTitle.textContent='V2 SCORE SUMMARY';
breakdown.appendChild(scoreTitle);
const scoreGrid=document.createElement('div');
scoreGrid.className='breakdown-grid';
const scaledCard=document.createElement('div');
scaledCard.className='breakdown-card';
scaledCard.innerHTML=`<strong>${scaledScore ?? '-'}</strong><span>Practice scaled-score estimate</span>`;
scoreGrid.appendChild(scaledCard);
const readinessCard=document.createElement('div');
readinessCard.className='breakdown-card';
readinessCard.innerHTML=`<strong>${pct}%</strong><span>${readiness.label}</span>`;
scoreGrid.appendChild(readinessCard);
breakdown.appendChild(scoreGrid);
const readinessText=document.createElement('p');
readinessText.className='muted';
readinessText.textContent=readiness.detail;
breakdown.appendChild(readinessText);
const typeTitle=document.createElement('p');
typeTitle.className='eyebrow';
typeTitle.textContent='KNOWLEDGE VS SITUATIONAL JUDGMENT';
breakdown.appendChild(typeTitle);
const typeGrid=document.createElement('div');
typeGrid.className='breakdown-grid';
[
['Knowledge / KBI',typeNow.KBI],
['Situational Judgment / SJT',typeNow.SJT]
].forEach(([label,s])=>{
const div=document.createElement('div');
div.className='breakdown-card';
const p=s.t ? Math.round(s.c/s.t*100) : 0;
div.innerHTML=`<strong>${s.t ? `${p}%` : '-'}</strong><span>${label}${s.t ? ` - ${s.c}/${s.t}` : ''}</span>`;
typeGrid.appendChild(div);
});
breakdown.appendChild(typeGrid);
const domainTitle=document.createElement('p');
domainTitle.className='eyebrow';
domainTitle.textContent='DOMAIN BREAKDOWN';
breakdown.appendChild(domainTitle);
const domainGrid=document.createElement('div');
domainGrid.className='breakdown-grid';
Object.entries(domainNow).forEach(([d,s])=>{
const div=document.createElement('div');
div.className='breakdown-card';
div.innerHTML=`<strong>${s.t ? Math.round(s.c/s.t*100) : 0}%</strong><span>${d} - ${s.c}/${s.t}</span>`;
domainGrid.appendChild(div);
});
breakdown.appendChild(domainGrid);
const note=document.createElement('p');
note.className='muted';
note.textContent=full
? `Full simulation scoring uses ${EXAM_SCORED} scored questions from the ${EXAM_TOTAL} presented. The ${FIELD_TEST} experimental items are selected internally and are not identified during the exam. The scaled score shown here is a trainer estimate, not an official SHRM score.`
: 'The scaled score shown here is a trainer estimate for practice only. SHRM does not publish a simple raw-to-scaled conversion table.';
breakdown.appendChild(note);
renderDashboard();
showView('resultsView');
}
$('quitBtn')?.addEventListener('click',()=>{
if(confirm('Exit this session? Current answers will not be added to your history.')){
clearInterval(timerHandle);
session=null;
showView('homeView');
}
});
$('homeBtn')?.addEventListener('click',()=>{
session=null;
showView('homeView');
});
$('reviewMissesBtn')?.addEventListener('click',()=>{
const list=$('missesList');
list.innerHTML='';
if(!session?.misses?.length){
list.innerHTML='<p class="muted">No misses in this session.</p>';
}else{
session.misses.forEach(({q,ans})=>{
const d=document.createElement('div');
d.className='miss-item';
list.appendChild(d);
});
d.innerHTML=`<div class="miss-top"><strong>${q.domain} - ${q.topic}</strong><small>${q.type==='SJT' ? 'SJT' : 'Knowledge'}</small></div><p>${q.question}</p><p><b>Your answer:</b> ${ans===undefined ? 'Unanswered' : q.options[ans]}</p><p><b>Best answer:</b> ${q.options[q.correct]}</p><p class="why">${q.explanation}</p>`;
}
showView('missesView');
});
$('missesBackBtn')?.addEventListener('click',()=>showView('resultsView'));
function renderDashboard(){$('overallAccuracy').textContent=state.totalAnswered
? `${Math.round(state.totalCorrect/state.totalAnswered*100)}%`
: '-';
const due=Object.values(state.reviewQueue).filter(x=>x.due<=Date.now()).length;
$('dueCount').textContent=`${due} due`;
const domains=['People','Organization','Workplace','Compliance'];
const box=$('domainStats');
box.innerHTML='';
domains.forEach(d=>{
const s=state.domains[d] || {c:0,t:0};
const pct=s.t ? Math.round(s.c/s.t*100) : 0;
const row=document.createElement('div');
row.className='stat-row';
box.appendChild(row);
row.innerHTML=`<span>${d}</span><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><strong>${s.t ? `${pct}%` : '-'}</strong>`;
});
const hist=$('historyList');
hist.innerHTML='';
if(!state.history.length){
hist.innerHTML='<p class="muted">Your completed tests will appear here.</p>';
}else{
state.history.slice(0,5).forEach(h=>{
const div=document.createElement('div');
div.className='history-item';
const scoredTotal=h.scoredCount ?? h.count;
const scoredCorrect=h.scoredCorrect ?? h.correct;
const scaleText=Number.isFinite(h.scaledScore) ? ` - Est. ${h.scaledScore}` : '';
div.innerHTML=`<div class="history-top"><strong>${h.mode}</strong><strong>${h.pct}%</strong></div><small>${new Date(h.date).toLocaleDateString()} - ${scoredCorrect}/${scoredTotal} - ${fmt(h.elapsed)}${scaleText}</small>`;
hist.appendChild(div);
});
}
}
$('resetDataBtn')?.addEventListener('click',()=>{
if(confirm('Reset all local practice history and adaptive data?')){
state=defaultState();
saveState();
renderDashboard();
}
});
$('syncBtn')?.addEventListener('click',()=>showView('setupView'));
$('setupBackBtn')?.addEventListener('click',()=>showView('homeView'));
window.addEventListener('beforeinstallprompt',e=>{
e.preventDefault();
deferredInstallPrompt=e;
$('installBtn')?.classList.remove('hidden');
});
$('installBtn')?.addEventListener('click',async()=>{
if(!deferredInstallPrompt) return;
deferredInstallPrompt.prompt();
await deferredInstallPrompt.userChoice;
deferredInstallPrompt=null;
$('installBtn')?.classList.add('hidden');
});
if('serviceWorker' in navigator){
window.addEventListener('load',()=>{
navigator.serviceWorker.register('./sw.js').catch(()=>{});
});
}
$('signInBtn')?.addEventListener('click',async()=>{
if(!supabaseClient){
$('authStatus').textContent='Cloud sync is not configured yet.';
return;
}
const email=$('authEmail').value.trim();
const password=$('authPassword').value;
if(!email || !password){
$('authStatus').textContent='Enter your email and password.';
return;
}
$('authStatus').textContent='Signing in...';
const {error}=await supabaseClient.auth.signInWithPassword({email,password});
$('authStatus').textContent=error ? error.message : 'Signed in.';
});
$('signUpBtn')?.addEventListener('click',async()=>{
if(!supabaseClient){
$('authStatus').textContent='Cloud sync is not configured yet.';
return;
}
const email=$('authEmail').value.trim();
const password=$('authPassword').value;
if(!email || password.length<6){
$('authStatus').textContent='Use a valid email and a password of at least 6 characters.';
return;
}
$('authStatus').textContent='Creating account...';
const {data,error}=await supabaseClient.auth.signUp({email,password});
if(error) $('authStatus').textContent=error.message;
else if(data.session) $('authStatus').textContent='Account created and signed in.';
else $('authStatus').textContent='Account created. Check your email to confirm, then sign in.';
});
$('signOutBtn')?.addEventListener('click',async()=>{
if(supabaseClient) await supabaseClient.auth.signOut();
currentUser=null;
updateSyncUI();
});
renderModes();
renderDashboard();
showView('homeView');
initCloud();
})();


