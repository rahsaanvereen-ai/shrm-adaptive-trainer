
(() => {
  const $ = (id) => document.getElementById(id);
  const views = ['homeView','setupView','quizView','reviewView','resultsView','missesView'];
  const PER_Q_SEC = 220 * 60 / 134; // mirrors 220 minutes / 134 questions
  const STORAGE_KEY = 'shrm-adaptive-trainer-v1';

  const MODES = [
    {id:'quick10', name:'Quick 10', count:10, mode:'learn', desc:'Instant feedback after every answer.'},
    {id:'practice20', name:'Practice 20', count:20, mode:'learn', desc:'Balanced learning session.'},
    {id:'practice40', name:'Timed 40', count:40, mode:'mock', desc:'No feedback until submission.'},
    {id:'half67', name:'Half Exam', count:67, mode:'mock', fixedSeconds:110*60, desc:'67 questions · 110 minutes.'},
    {id:'full134', name:'Full Simulation', count:134, mode:'full', fixedSeconds:220*60, desc:'2 sections · 67 questions · 110 min each.'},
    {id:'adaptive25', name:'Adaptive 25', count:25, mode:'learn', adaptive:true, desc:'Weights weak areas and missed concepts.'}
  ];

  let state = loadState();
  let session = null;
  let timerHandle = null;
  let deferredInstallPrompt = null;

  function defaultState(){
    return {
      attempts:{}, domains:{}, history:[], reviewQueue:{}, totalCorrect:0, totalAnswered:0
    };
  }

  function loadState(){
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      return raw ? {...defaultState(), ...JSON.parse(raw)} : defaultState();
    }catch{ return defaultState(); }
  }
  function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

  function showView(id){
    views.forEach(v=>$(v).classList.toggle('active',v===id));
    window.scrollTo({top:0,behavior:'smooth'});
  }

  function fmt(sec){
    sec=Math.max(0,Math.floor(sec));
    const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  }

  function scaledSeconds(count){ return Math.round(count*PER_Q_SEC); }

  function modeSeconds(mode){
    if(mode.id==='full134') return 110*60; // each section separately
    return mode.fixedSeconds || scaledSeconds(mode.count);
  }

  function renderModes(){
    $('modeGrid').innerHTML='';
    MODES.forEach(m=>{
      const b=document.createElement('button');
      b.className='mode-card';
      b.type='button';
      const total=m.id==='full134' ? '2 × 110 min' : fmt(modeSeconds(m));
      b.innerHTML=`<strong>${m.name}</strong><span>${m.desc}</span><span class="mode-time">${m.count} questions · ${total}</span>`;
      b.addEventListener('click',()=>startSession(m));
      $('modeGrid').appendChild(b);
    });
  }

  function shuffle(arr){
    const a=[...arr];
    for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
    return a;
  }

  function weightedQuestionPool(){
    const bank=window.QUESTION_BANK;
    const weighted=[];
    bank.forEach(q=>{
      const d=state.domains[q.domain]||{c:0,t:0};
      const acc=d.t?d.c/d.t:.5;
      const miss=state.reviewQueue[q.id]?2.5:0;
      const weight=1 + (1-acc)*2 + miss;
      const copies=Math.max(1,Math.round(weight*2));
      for(let i=0;i<copies;i++) weighted.push(q);
    });
    return weighted;
  }

  function chooseQuestions(count, adaptive=false){
    const bank=window.QUESTION_BANK;
    if(!adaptive){
      // balance domains, then fill randomly
      const groups={};
      bank.forEach(q=>(groups[q.domain]||(groups[q.domain]=[])).push(q));
      Object.values(groups).forEach(g=>shuffle(g));
      const domains=Object.keys(groups);
      const picked=[];
      let idx=0;
      while(picked.length<count && picked.length<bank.length){
        const d=domains[idx%domains.length];
        const candidates=groups[d].filter(q=>!picked.some(p=>p.id===q.id));
        if(candidates.length) picked.push(candidates[Math.floor(Math.random()*candidates.length)]);
        idx++;
        if(idx>bank.length*10) break;
      }
      if(picked.length<count){
        shuffle(bank).forEach(q=>{if(picked.length<count && !picked.some(p=>p.id===q.id)) picked.push(q)});
      }
      return picked.slice(0,count);
    }
    const pool=weightedQuestionPool();
    const picked=[];
    let guard=0;
    while(picked.length<count && guard<5000){
      const q=pool[Math.floor(Math.random()*pool.length)];
      if(!picked.some(p=>p.id===q.id)) picked.push(q);
      guard++;
    }
    if(picked.length<count) shuffle(bank).forEach(q=>{if(picked.length<count&&!picked.some(p=>p.id===q.id))picked.push(q)});
    return picked.slice(0,count);
  }


  // Re-map answer positions for every session so users cannot learn answer-letter patterns.
  // The correct answer letter is balanced and never repeats more than twice consecutively.
  function remapForSession(items){
    let last=-1, streak=0;
    return items.map((original, idx)=>{
      const q=JSON.parse(JSON.stringify(original));
      let allowed=[0,1,2,3];
      if(streak>=2) allowed=allowed.filter(x=>x!==last);
      // Favor the least predictable deterministic position for this session.
      const target=allowed[Math.floor(Math.random()*allowed.length)];
      const correctText=q.options[q.correct];
      const wrong=q.options.filter((_,i)=>i!==q.correct);
      // shuffle wrong answers
      for(let i=wrong.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[wrong[i],wrong[j]]=[wrong[j],wrong[i]]}
      const opts=[]; let wi=0;
      for(let p=0;p<4;p++) opts.push(p===target?correctText:wrong[wi++]);
      q.options=opts; q.correct=target;
      if(target===last) streak++; else {last=target;streak=1}
      return q;
    });
  }

  function startSession(mode){
    const full=mode.id==='full134';
    const count=full ? 134 : mode.count;
    const qs=remapForSession(chooseQuestions(count,mode.adaptive));
    session={
      mode, questions:qs, answers:{}, flagged:{}, index:0, section:1,
      sectionStart:0, sectionEnd:full?67:count, sectionLocked:false,
      remaining:modeSeconds(mode), startedAt:Date.now(), elapsed:0, misses:[]
    };
    $('sectionLockNotice').classList.toggle('hidden',!full);
    showView('quizView');
    startTimer();
    renderQuestion();
  }

  function startTimer(){
    clearInterval(timerHandle);
    $('timer').textContent=fmt(session.remaining);
    timerHandle=setInterval(()=>{
      session.remaining--;
      $('timer').textContent=fmt(session.remaining);
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
    const sectionCount=session.sectionEnd-session.sectionStart;
    const answeredInSection=Object.keys(session.answers).filter(k=>{
      const i=Number(k); return i>=session.sectionStart && i<session.sectionEnd;
    }).length;
    const targetSpent=(answeredInSection/sectionCount)*modeSeconds(session.mode);
    const actualSpent=modeSeconds(session.mode)-session.remaining;
    const delta=targetSpent-actualSpent;
    const el=$('paceIndicator');
    if(answeredInSection<2){el.className='pace neutral';el.textContent='On pace';return}
    if(delta>PER_Q_SEC*2){el.className='pace good';el.textContent='Ahead'}
    else if(delta<-PER_Q_SEC*2){el.className='pace bad';el.textContent='Behind'}
    else {el.className='pace warn';el.textContent='On pace'}
  }

  function renderQuestion(){
    const q=session.questions[session.index];
    $('modeBadge').textContent=session.mode.name + (session.mode.id==='full134'?` · Section ${session.section}`:'');
    $('domainBadge').textContent=q.domain;
    $('questionProgress').textContent=`Question ${session.index-session.sectionStart+1} of ${session.sectionEnd-session.sectionStart}`;
    $('questionType').textContent=`${q.type==='SJT'?'Situational Judgment':'Knowledge'} · ${q.topic}`;
    $('questionText').textContent=q.question;
    $('flagBtn').textContent=session.flagged[session.index]?'★ Flagged':'☆ Flag';
    $('flagBtn').classList.toggle('flagged',!!session.flagged[session.index]);
    $('feedback').className='feedback hidden';
    $('feedback').innerHTML='';
    $('answersForm').innerHTML='';

    q.options.forEach((opt,i)=>{
      const lab=document.createElement('label');
      lab.className='answer-option'+(session.answers[session.index]===i?' selected':'');
      const checked=session.answers[session.index]===i?'checked':'';
      const disabled=(session.mode.mode==='learn' && session.answers[session.index]!==undefined)?'disabled':'';
      lab.innerHTML=`<input type="radio" name="answer" value="${i}" ${checked} ${disabled}><span class="answer-letter">${String.fromCharCode(65+i)}.</span><span>${opt}</span>`;
      $('answersForm').appendChild(lab);
    });

    const has=session.answers[session.index]!==undefined;
    $('nextBtn').disabled=!has;
    const last=session.index===session.sectionEnd-1;
    $('nextBtn').textContent=last ? (session.mode.id==='full134'&&session.section===1?'Review Section 1':'Review & Submit') : 'Next';

    if(session.mode.mode==='learn' && has) showFeedback();
    updatePace();
  }

  $('answersForm').addEventListener('change',(e)=>{
    if(!e.target.matches('input[type=radio]')) return;
    const pick=Number(e.target.value);
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
    const q=session.questions[session.index], pick=session.answers[session.index], ok=pick===q.correct;
    const fb=$('feedback');
    fb.className='feedback '+(ok?'correct':'incorrect');
    fb.innerHTML=`<strong>${ok?'✓ Correct':'✕ Incorrect'}</strong><div><b>Best answer: ${String.fromCharCode(65+q.correct)}.</b> ${q.options[q.correct]}</div><div class="why">${q.explanation}</div>`;
  }

  $('flagBtn').addEventListener('click',()=>{
    session.flagged[session.index]=!session.flagged[session.index];
    renderQuestion();
  });

  $('nextBtn').addEventListener('click',()=>{
    if(session.index===session.sectionEnd-1){ openReview(); return; }
    session.index++;
    renderQuestion();
  });

  function openReview(){
    clearInterval(timerHandle);
    const flagged=Object.keys(session.flagged).filter(k=>session.flagged[k]&&Number(k)>=session.sectionStart&&Number(k)<session.sectionEnd);
    $('flaggedCount').textContent=`${flagged.length} flagged`;
    const list=$('reviewList');list.innerHTML='';
    for(let i=session.sectionStart;i<session.sectionEnd;i++){
      const q=session.questions[i], ans=session.answers[i];
      const item=document.createElement('div');item.className='review-item';
      item.innerHTML=`<button type="button"><strong>${i-session.sectionStart+1}. ${q.question}</strong><div class="answer-state">${ans===undefined?'Unanswered':`Selected ${String.fromCharCode(65+ans)}`} ${session.flagged[i]?'· ★ Flagged':''}</div></button>`;
      item.querySelector('button').addEventListener('click',()=>{session.index=i;showView('quizView');startTimer();renderQuestion()});
      list.appendChild(item);
    }
    $('submitSectionBtn').textContent=session.mode.id==='full134'&&session.section===1?'Submit Section 1':'Submit Test';
    showView('reviewView');
  }

  $('reviewBackBtn').addEventListener('click',()=>{showView('quizView');startTimer();renderQuestion()});
  $('submitSectionBtn').addEventListener('click',submitSection);

  function submitSection(){
    clearInterval(timerHandle);
    if(session.mode.id==='full134' && session.section===1){
      session.sectionLocked=true;
      session.section=2;
      session.sectionStart=67; session.sectionEnd=134; session.index=67;
      session.remaining=110*60;
      showView('quizView'); startTimer(); renderQuestion();
      return;
    }
    finishSession();
  }

  function finishSession(){
    clearInterval(timerHandle);
    session.elapsed=Math.max(1,Math.round((Date.now()-session.startedAt)/1000));
    let correct=0, answered=0;
    const domainNow={};
    session.misses=[];

    session.questions.forEach((q,i)=>{
      const ans=session.answers[i];
      const ok=ans===q.correct;
      if(ans!==undefined) answered++;
      if(ok) correct++; else session.misses.push({q,ans});
      if(ans!==undefined){
        state.totalAnswered++; if(ok) state.totalCorrect++;
        state.domains[q.domain] ||= {c:0,t:0};
        state.domains[q.domain].t++; if(ok) state.domains[q.domain].c++;
        state.attempts[q.id] ||= {c:0,t:0,last:null};
        state.attempts[q.id].t++; if(ok) state.attempts[q.id].c++;
        state.attempts[q.id].last=Date.now();
        if(ok) delete state.reviewQueue[q.id];
        else state.reviewQueue[q.id]={due:Date.now()+24*3600*1000, misses:(state.reviewQueue[q.id]?.misses||0)+1};
        domainNow[q.domain] ||= {c:0,t:0};
        domainNow[q.domain].t++; if(ok) domainNow[q.domain].c++;
      }
    });

    const pct=Math.round(correct/session.questions.length*100);
    state.history.unshift({date:Date.now(),mode:session.mode.name,count:session.questions.length,correct,pct,elapsed:session.elapsed});
    state.history=state.history.slice(0,12);
    saveState();

    $('resultHeadline').textContent=pct>=80?'Strong session':pct>=70?'Building toward exam pace':'Good diagnostic session';
    $('resultScore').textContent=`${correct}/${session.questions.length}`;
    $('resultPercent').textContent=`${pct}%`;
    $('resultTime').textContent=`Completed in ${fmt(session.elapsed)} · ${answered} answered`;

    const grid=document.createElement('div');grid.className='breakdown-grid';
    Object.entries(domainNow).forEach(([d,s])=>{
      const div=document.createElement('div');div.className='breakdown-card';
      div.innerHTML=`<strong>${Math.round(s.c/s.t*100)}%</strong><span>${d} · ${s.c}/${s.t}</span>`;grid.appendChild(div);
    });
    $('resultBreakdown').innerHTML='<p class="eyebrow">DOMAIN BREAKDOWN</p>';
    $('resultBreakdown').appendChild(grid);
    renderDashboard();
    showView('resultsView');
  }

  $('quitBtn').addEventListener('click',()=>{
    if(confirm('Exit this session? Current answers will not be added to your history.')){
      clearInterval(timerHandle); session=null; showView('homeView');
    }
  });

  $('homeBtn').addEventListener('click',()=>{session=null;showView('homeView')});
  $('reviewMissesBtn').addEventListener('click',()=>{
    const list=$('missesList');list.innerHTML='';
    if(!session?.misses?.length){list.innerHTML='<p class="muted">No misses in this session.</p>'}
    else session.misses.forEach(({q,ans})=>{
      const d=document.createElement('div');d.className='miss-item';
      d.innerHTML=`<div class="miss-top"><strong>${q.domain} · ${q.topic}</strong><small>${q.type==='SJT'?'SJT':'Knowledge'}</small></div><p>${q.question}</p><p><b>Your answer:</b> ${ans===undefined?'Unanswered':q.options[ans]}</p><p><b>Best answer:</b> ${q.options[q.correct]}</p><p class="why">${q.explanation}</p>`;
      list.appendChild(d);
    });
    showView('missesView');
  });
  $('missesBackBtn').addEventListener('click',()=>showView('resultsView'));

  function renderDashboard(){
    $('overallAccuracy').textContent=state.totalAnswered?`${Math.round(state.totalCorrect/state.totalAnswered*100)}%`:'—';
    const due=Object.values(state.reviewQueue).filter(x=>x.due<=Date.now()).length;
    $('dueCount').textContent=`${due} due`;

    const domains=['People','Organization','Workplace','Compliance'];
    const box=$('domainStats');box.innerHTML='';
    domains.forEach(d=>{
      const s=state.domains[d]||{c:0,t:0};const pct=s.t?Math.round(s.c/s.t*100):0;
      const row=document.createElement('div');row.className='stat-row';
      row.innerHTML=`<span>${d}</span><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><strong>${s.t?pct+'%':'—'}</strong>`;
      box.appendChild(row);
    });

    const hist=$('historyList');hist.innerHTML='';
    if(!state.history.length){hist.innerHTML='<p class="muted">Your completed tests will appear here.</p>'}
    else state.history.slice(0,5).forEach(h=>{
      const div=document.createElement('div');div.className='history-item';
      div.innerHTML=`<div class="history-top"><strong>${h.mode}</strong><strong>${h.pct}%</strong></div><small>${new Date(h.date).toLocaleDateString()} · ${h.correct}/${h.count} · ${fmt(h.elapsed)}</small>`;
      hist.appendChild(div);
    });
  }

  $('resetDataBtn').addEventListener('click',()=>{
    if(confirm('Reset all local practice history and adaptive data?')){
      state=defaultState();saveState();renderDashboard();
    }
  });

  $('syncBtn').addEventListener('click',()=>showView('setupView'));
  $('setupBackBtn').addEventListener('click',()=>showView('homeView'));

  // PWA install
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();deferredInstallPrompt=e;$('installBtn').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click',async()=>{
    if(!deferredInstallPrompt)return;
    deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installBtn').classList.add('hidden');
  });

  // Optional service worker
  if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}))}

  // Optional Supabase status only; cloud adapter can be enabled without breaking local use.
  const cfg=window.APP_CONFIG||{};
  if(cfg.supabaseUrl&&cfg.supabasePublishableKey){
    $('syncTitle').textContent='Cloud sync configured';
    $('syncText').textContent='Supabase values are present. Local data remains available as a fallback.';
  }

  renderModes();renderDashboard();showView('homeView');
})();
