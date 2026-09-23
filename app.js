/* AURA V3 application core — local-first, defensive and dependency-free */
(() => {
  "use strict";

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const uid = () => crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clamp = (n,min,max) => Math.min(max, Math.max(min,n));
  const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = s => { if (!Number.isFinite(s) || s < 0) return "0:00"; const m=Math.floor(s/60), sec=Math.floor(s%60).toString().padStart(2,"0"); return `${m}:${sec}`; };

  const state = {
    tracks: [], playlists: [], favorites: new Set(), queue: [], currentId: null,
    view: "home", filter: "", shuffle: false, repeat: "off", sort: "recent",
    theme: localStorage.getItem("aura-theme") || "dark", objectUrls: new Map(),
    deferredInstall: null, db: null, audioCtx: null, analyser: null, sourceNode: null
  };

  const audio = $("#audio");
  const content = $("#content");
  const modal = $("#modal");
  const toastEl = $("#toast");

  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.remove("show"), 2300);
  }

  function openModal(html) { $("#modalBody").innerHTML=html; modal.showModal(); }
  function closeModal() { if(modal.open) modal.close(); }

  async function openDB() {
    if (!("indexedDB" in window)) return null;
    return new Promise(resolve => {
      const req=indexedDB.open("aura-v3",1);
      req.onupgradeneeded=() => {
        const db=req.result;
        if(!db.objectStoreNames.contains("tracks")) db.createObjectStore("tracks",{keyPath:"id"});
        if(!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs",{keyPath:"id"});
        if(!db.objectStoreNames.contains("playlists")) db.createObjectStore("playlists",{keyPath:"id"});
        if(!db.objectStoreNames.contains("meta")) db.createObjectStore("meta",{keyPath:"key"});
      };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>resolve(null);
    });
  }
  const tx = (store, mode="readonly") => state.db?.transaction(store,mode).objectStore(store);
  const reqPromise = req => new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});

  async function loadDB() {
    state.db=await openDB();
    if(!state.db) { loadMetaFallback(); return; }
    try {
      state.tracks=await reqPromise(tx("tracks").getAll());
      const pls=await reqPromise(tx("playlists").getAll()); state.playlists=pls || [];
      const meta=await reqPromise(tx("meta").get("state"));
      if(meta?.value){state.favorites=new Set(meta.value.favorites||[]); state.theme=meta.value.theme||state.theme; state.sort=meta.value.sort||"recent";}
      applyTheme();
    } catch(e) { console.warn("DB load:",e); toast("Library storage is unavailable; using session mode."); }
  }
  function loadMetaFallback(){ try{const x=JSON.parse(localStorage.getItem("aura-meta")||"{}");state.favorites=new Set(x.favorites||[]);state.playlists=x.playlists||[];}catch{} }
  async function saveMeta() {
    const value={favorites:[...state.favorites],theme:state.theme,sort:state.sort};
    if(state.db){try{await reqPromise(tx("meta","readwrite").put({key:"state",value}));}catch(e){console.warn(e)}}
    else localStorage.setItem("aura-meta",JSON.stringify({...value,playlists:state.playlists}));
  }
  async function saveTrack(t, blob) {
    if(!state.db){ return; }
    try { await reqPromise(tx("tracks","readwrite").put(t)); if(blob) await reqPromise(tx("blobs","readwrite").put({id:t.id,blob})); }
    catch(e){console.error(e);toast("Could not save this track.");}
  }
  async function getBlob(id) {
    if(!state.db) return null;
    try { return (await reqPromise(tx("blobs").get(id)))?.blob || null; } catch{return null}
  }

  function parseName(name) {
    const clean=name.replace(/\.[^/.]+$/,"").trim();
    const parts=clean.split(/\s[-–—]\s/);
    if(parts.length>=2) return {artist:parts[0].trim(),title:parts.slice(1).join(" - ").trim()};
    return {artist:"Unknown artist",title:clean||"Untitled"};
  }
  function durationFor(t){return Number.isFinite(t.duration)?t.duration:0}
  function trackView(t, i=0) {
    return `<div class="track" data-track="${esc(t.id)}">
      <div class="track-no">${i+1}</div><div class="track-cover">${esc((t.title||"A")[0].toUpperCase())}</div>
      <div class="track-main"><strong>${esc(t.title)}</strong><span>${esc(t.artist||"Unknown artist")}</span></div>
      <div class="track-album">${esc(t.album||"Single")}</div><div class="track-time">${fmt(durationFor(t))}</div>
      <button class="track-more" data-track-menu="${esc(t.id)}" aria-label="Track menu">•••</button>
    </div>`;
  }
  function card(t) {
    return `<div class="card" data-track="${esc(t.id)}"><div class="cover">${esc((t.title||"A")[0].toUpperCase())}</div><h3>${esc(t.title)}</h3><p>${esc(t.artist||"Unknown artist")}</p></div>`;
  }
  function filteredTracks() {
    const q=state.filter.trim().toLowerCase();
    let arr=state.tracks.filter(t => !q || [t.title,t.artist,t.album,t.genre].join(" ").toLowerCase().includes(q));
    if(state.sort==="title") arr.sort((a,b)=>a.title.localeCompare(b.title));
    else if(state.sort==="artist") arr.sort((a,b)=>(a.artist||"").localeCompare(b.artist||""));
    else arr.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
    return arr;
  }

  function render() {
    const nav=$$(".nav-item[data-view]"); nav.forEach(n=>n.classList.toggle("active",n.dataset.view===state.view));
    if(state.view==="home") renderHome();
    else if(state.view==="library") renderLibrary();
    else if(state.view==="playlists") renderPlaylists();
    else if(state.view==="albums") renderAlbums();
    else if(state.view==="artists") renderArtists();
    else if(state.view==="favorites") renderFavorites();
    updatePlayer();
  }

  function renderHome() {
    const tracks=filteredTracks();
    const recent=[...state.tracks].sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,6);
    content.innerHTML=`
      <div class="hero"><div class="hero-card"><div class="eyebrow">AURA V3 • LOCAL-FIRST</div><div class="hero"><h1>Your music.<br>Everywhere.</h1></div><p>One responsive player for phone and PC. Import your audio once, keep your library on-device, and play offline.</p>
      <div class="hero-actions"><button class="primary" data-action="import">＋ Add music</button><button class="secondary" data-view="library">Open library</button></div></div>
      <div class="hero-card"><div class="eyebrow">SYSTEM</div><h2>${state.tracks.length} tracks</h2><p>Offline-ready interface, queue, playlists, favorites, search, keyboard controls, visualizer hooks and installable PWA shell.</p><button class="secondary" data-action="settings">Settings & diagnostics</button></div></div>
      <div class="section"><div class="section-head"><h2>Recently added</h2><button data-view="library">See all</button></div>
      ${recent.length?`<div class="cards">${recent.map(card).join("")}</div>`:`<div class="empty"><strong>Your library is empty</strong>Import MP3, WAV, OGG, M4A or other browser-supported audio files to start.</div>`}</div>
      ${tracks.length?`<div class="section"><div class="section-head"><h2>Quick play</h2></div><div class="track-list">${tracks.slice(0,8).map((t,i)=>trackView(t,i)).join("")}</div></div>`:""}`;
  }

  function renderLibrary() {
    const tracks=filteredTracks();
    content.innerHTML=`<div class="section-head"><h2>Library <span style="color:var(--muted);font-size:12px">${tracks.length} tracks</span></h2><div><button class="secondary" data-action="sort">Sort: ${esc(state.sort)}</button> <button class="primary" data-action="import">＋ Add music</button></div></div>
      ${tracks.length?`<div class="track-list">${tracks.map((t,i)=>trackView(t,i)).join("")}</div>`:`<div class="empty"><strong>No music yet</strong>Use “Add music” and choose audio files from your device.</div>`}`;
  }

  function renderFavorites() {
    const arr=filteredTracks().filter(t=>state.favorites.has(t.id));
    content.innerHTML=`<div class="section-head"><h2>Favorites</h2></div>${arr.length?`<div class="track-list">${arr.map((t,i)=>trackView(t,i)).join("")}</div>`:`<div class="empty"><strong>No favorites</strong>Tap the heart while a song is playing.</div>`}`;
  }

  function renderAlbums() {
    const map=new Map(); state.tracks.forEach(t=>{const k=t.album||"Singles"; if(!map.has(k))map.set(k,t)});
    content.innerHTML=`<div class="section-head"><h2>Albums</h2></div><div class="cards">${[...map.entries()].map(([name,t])=>`<div class="card" data-album="${esc(name)}"><div class="cover">${esc(name[0].toUpperCase())}</div><h3>${esc(name)}</h3><p>${esc(t.artist||"Various artists")}</p></div>`).join("")||`<div class="empty"><strong>No albums</strong>Album grouping appears as you add tagged files.</div>`}</div>`;
  }

  function renderArtists() {
    const map=new Map(); state.tracks.forEach(t=>{const k=t.artist||"Unknown artist";map.set(k,(map.get(k)||0)+1)});
    content.innerHTML=`<div class="section-head"><h2>Artists</h2></div><div class="cards">${[...map.entries()].sort().map(([name,n])=>`<div class="card" data-artist="${esc(name)}"><div class="cover">${esc(name[0].toUpperCase())}</div><h3>${esc(name)}</h3><p>${n} track${n===1?"":"s"}</p></div>`).join("")||`<div class="empty"><strong>No artists</strong>Add music to build your artist library.</div>`}</div>`;
  }

  function renderPlaylists() {
    content.innerHTML=`<div class="section-head"><h2>Playlists</h2><button class="primary" data-action="new-playlist">＋ New playlist</button></div><div class="cards">${state.playlists.map(p=>`<div class="card" data-playlist="${esc(p.id)}"><div class="cover">♫</div><h3>${esc(p.name)}</h3><p>${p.trackIds.length} tracks</p></div>`).join("")||`<div class="empty"><strong>No playlists</strong>Create a playlist and add songs from the track menu.</div>`}</div>`;
  }

  function showCollection(title, tracks) {
    openModal(`<h2>${esc(title)}</h2><div class="track-list">${tracks.map((t,i)=>trackView(t,i)).join("")||`<div class="empty">No tracks found.</div>`}</div><div class="modal-actions"><button class="secondary" data-action="close-modal">Close</button></div>`);
  }

  function updatePlayer() {
    const t=state.tracks.find(x=>x.id===state.currentId);
    $("#nowTitle").textContent=t?.title||"Nothing playing"; $("#nowArtist").textContent=t?.artist||"Choose a song from your library";
    $("#playerTitle").textContent=t?.title||"Nothing playing"; $("#playerArtist").textContent=t?.artist||"AURA V3";
    $("#playerThumb").textContent=(t?.title||"A")[0].toUpperCase();
    $("#favoriteBtn").textContent=t&&state.favorites.has(t.id)?"♥":"♡";
    $("#playBtn").textContent=audio.paused?"▶":"Ⅱ";
    $("#currentTime").textContent=fmt(audio.currentTime); $("#duration").textContent=fmt(audio.duration);
    $("#seek").value=audio.duration?((audio.currentTime/audio.duration)*100):0;
    $("#shuffleBtn").textContent=state.shuffle?"⤨•":"⤨"; $("#repeatBtn").textContent=state.repeat==="one"?"↻1":state.repeat==="all"?"↻":"↻";
  }

  async function ensureObjectURL(t) {
    if(state.objectUrls.has(t.id)) return state.objectUrls.get(t.id);
    const blob=await getBlob(t.id); if(!blob) return t.src||"";
    const url=URL.createObjectURL(blob); state.objectUrls.set(t.id,url); return url;
  }

  async function playTrack(id, autoplay=true) {
    const t=state.tracks.find(x=>x.id===id); if(!t) return;
    try {
      const src=await ensureObjectURL(t); if(!src) {toast("Audio data is missing. Re-import this file.");return;}
      state.currentId=id; audio.src=src; audio.load(); updatePlayer();
      if(autoplay) await audio.play();
      setMediaSession(t); updatePlayer();
      if(window.innerWidth<760) $("#nowPanel")?.classList.remove("open");
    } catch(e){console.error(e);toast("Playback could not start. Try the track again.");}
  }
  function setMediaSession(t) {
    if(!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata=new MediaMetadata({title:t.title||"Untitled",artist:t.artist||"Unknown artist",album:t.album||"AURA V3"});
      navigator.mediaSession.playbackState=audio.paused?"paused":"playing";
    } catch{}
  }
  function nextTrack() {
    if(!state.tracks.length)return;
    const list=state.queue.length?state.queue.map(id=>state.tracks.find(t=>t.id===id)).filter(Boolean):filteredTracks();
    if(!list.length)return;
    const idx=Math.max(0,list.findIndex(t=>t.id===state.currentId));
    let next;
    if(state.repeat==="one"){next=state.currentId}
    else if(state.shuffle){next=list[Math.floor(Math.random()*list.length)].id}
    else next=list[(idx+1)%list.length].id;
    if(state.repeat==="off" && !state.shuffle && idx===list.length-1 && state.queue.length===0) return;
    playTrack(next);
  }
  function prevTrack(){const list=state.queue.length?state.queue.map(id=>state.tracks.find(t=>t.id===id)).filter(Boolean):filteredTracks();const i=list.findIndex(t=>t.id===state.currentId);if(audio.currentTime>4){audio.currentTime=0;return}if(i>0)playTrack(list[i-1].id);else if(list.length)playTrack(list[list.length-1].id)}
  function togglePlay(){if(!state.currentId){const t=filteredTracks()[0];if(t)playTrack(t.id);return}if(audio.paused)audio.play().catch(()=>toast("Tap play again to allow audio."));else audio.pause();}

  async function importFiles(files) {
    const arr=[...files].filter(f=>f.type.startsWith("audio/")||/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.name));
    if(!arr.length){toast("No supported audio files selected.");return}
    let added=0;
    for(const file of arr){
      const meta=parseName(file.name);
      const t={id:uid(),title:meta.title,artist:meta.artist,album:"Local files",genre:"",duration:0,size:file.size,mime:file.type,addedAt:Date.now(),fileName:file.name};
      try{const u=URL.createObjectURL(file); const probe=new Audio(); probe.preload="metadata"; probe.src=u; await new Promise(r=>{probe.onloadedmetadata=r;probe.onerror=r;setTimeout(r,2500)}); if(Number.isFinite(probe.duration))t.duration=probe.duration; URL.revokeObjectURL(u);}catch{}
      await saveTrack(t,file); state.tracks.push(t); added++;
    }
    await saveMeta(); render(); toast(`${added} track${added===1?"":"s"} added to AURA.`);
  }

  function newPlaylist() {
    openModal(`<h2>New playlist</h2><div class="form-row"><label>Name</label><input id="playlistName" maxlength="60" placeholder="My playlist" autofocus></div><div class="modal-actions"><button class="secondary" data-action="close-modal">Cancel</button><button class="primary" data-action="save-playlist">Create</button></div>`);
  }
  async function savePlaylist() {
    const name=$("#playlistName")?.value.trim(); if(!name){toast("Enter a playlist name.");return}
    const p={id:uid(),name,trackIds:[],createdAt:Date.now()}; state.playlists.push(p);
    if(state.db) try{await reqPromise(tx("playlists","readwrite").put(p));}catch(e){console.error(e)}
    await saveMeta();closeModal();render();toast("Playlist created.");
  }

  function trackMenu(id) {
    const t=state.tracks.find(x=>x.id===id); if(!t)return;
    openModal(`<h2>${esc(t.title)}</h2><p>${esc(t.artist||"Unknown artist")}</p>
      <div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">
      <button class="primary" data-play-now="${esc(id)}">▶ Play</button>
      <button class="secondary" data-add-queue="${esc(id)}">＋ Add to queue</button>
      <button class="secondary" data-fav-track="${esc(id)}">${state.favorites.has(id)?"♥ Unfavorite":"♡ Favorite"}</button>
      <button class="secondary" data-add-playlist="${esc(id)}">Add to playlist</button></div>
      <div class="modal-actions"><button class="secondary" data-action="close-modal">Close</button></div>`);
  }
  async function addToPlaylist(id) {
    if(!state.playlists.length){closeModal();newPlaylist();toast("Create a playlist first.");return}
    openModal(`<h2>Add to playlist</h2><div class="form-row"><select id="playlistSelect">${state.playlists.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></div><div class="modal-actions"><button class="secondary" data-action="close-modal">Cancel</button><button class="primary" data-action="confirm-add-playlist" data-track-id="${esc(id)}">Add</button></div>`);
  }
  async function confirmAddPlaylist(id) {
    const p=state.playlists.find(x=>x.id===$("#playlistSelect")?.value);if(!p)return;
    if(!p.trackIds.includes(id))p.trackIds.push(id);
    if(state.db)try{await reqPromise(tx("playlists","readwrite").put(p));}catch(e){console.error(e)}
    closeModal();toast(`Added to ${p.name}`);
  }

  function queueDrawer(){
    let el=$("#queueDrawer"); if(el){el.remove();return}
    el=document.createElement("div");el.id="queueDrawer";el.className="queue-drawer";
    el.innerHTML=`<h3>Queue <button class="track-more" data-action="queue-clear">Clear</button></h3>${state.queue.map(id=>state.tracks.find(t=>t.id===id)).filter(Boolean).map(t=>`<div class="queue-item"><div><strong>${esc(t.title)}</strong><span>${esc(t.artist)}</span></div><button class="track-more" data-play-now="${esc(t.id)}">▶</button></div>`).join("")||`<div class="empty">Queue is empty.</div>`}`;
    document.body.appendChild(el);
  }

  function settings(){
    openModal(`<h2>AURA V3 Settings</h2>
      <div class="form-row"><label>Library</label><div>${state.tracks.length} tracks stored locally. Audio files remain on this device/browser profile.</div></div>
      <div class="form-row"><label>Theme</label><select id="themeSelect"><option value="dark" ${state.theme==="dark"?"selected":""}>Dark</option><option value="light" ${state.theme==="light"?"selected":""}>Light</option></select></div>
      <div class="form-row"><label>Keyboard</label><div>Space play/pause · ←/→ seek · Ctrl/Cmd+K search · N next · P previous</div></div>
      <div class="form-row"><label>Cloud sync</label><div style="color:var(--muted)">V3 is deliberately local-first. A future sync service can be connected without changing the player UI.</div></div>
      <div class="modal-actions"><button class="secondary" data-action="export-data">Export library data</button><button class="secondary" data-action="close-modal">Close</button></div>`);
  }
  function applyTheme(){document.documentElement.classList.toggle("light",state.theme==="light");localStorage.setItem("aura-theme",state.theme)}
  function exportData(){const data={version:3,tracks:state.tracks.map(({id,title,artist,album,genre,duration,size,mime,addedAt,fileName})=>({id,title,artist,album,genre,duration,size,mime,addedAt,fileName})),playlists:state.playlists,favorites:[...state.favorites]};const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="aura-v3-library.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);toast("Library data exported.");}

  document.addEventListener("click", async e=>{
    const nav=e.target.closest("[data-view]"); if(nav){state.view=nav.dataset.view;render();$("#sidebar")?.classList.remove("open");return}
    const act=e.target.closest("[data-action]"); if(act){
      const a=act.dataset.action;
      if(a==="import")$("#fileInput").click();
      else if(a==="settings")settings();
      else if(a==="close-modal")closeModal();
      else if(a==="save-playlist")savePlaylist();
      else if(a==="new-playlist")newPlaylist();
      else if(a==="play")togglePlay();
      else if(a==="next")nextTrack();
      else if(a==="prev")prevTrack();
      else if(a==="shuffle"){state.shuffle=!state.shuffle;updatePlayer()}
      else if(a==="repeat"){state.repeat=state.repeat==="off"?"all":state.repeat==="all"?"one":"off";updatePlayer()}
      else if(a==="favorite"){if(state.currentId){state.favorites.has(state.currentId)?state.favorites.delete(state.currentId):state.favorites.add(state.currentId);saveMeta();updatePlayer();}}
      else if(a==="queue-add"){if(state.currentId&&!state.queue.includes(state.currentId)){state.queue.push(state.currentId);toast("Added to queue.");}}
      else if(a==="queue")queueDrawer();
      else if(a==="queue-clear"){state.queue=[];queueDrawer()}
      else if(a==="theme"){state.theme=state.theme==="dark"?"light":"dark";applyTheme();saveMeta()}
      else if(a==="menu")$(".sidebar").classList.toggle("open");
      else if(a==="sort"){state.sort=state.sort==="recent"?"title":state.sort==="title"?"artist":"recent";render()}
      else if(a==="install")installPWA();
      else if(a==="export-data")exportData();
      else if(a==="confirm-add-playlist")confirmAddPlaylist(act.dataset.trackId);
      return;
    }
    const tr=e.target.closest("[data-track]"); if(tr && !e.target.closest("[data-track-menu]")){playTrack(tr.dataset.track);return}
    const menu=e.target.closest("[data-track-menu]"); if(menu){trackMenu(menu.dataset.trackMenu);return}
    const pn=e.target.closest("[data-play-now]"); if(pn){const id=pn.dataset.playNow;closeModal();playTrack(id);return}
    const aq=e.target.closest("[data-add-queue]"); if(aq){if(!state.queue.includes(aq.dataset.addQueue))state.queue.push(aq.dataset.addQueue);closeModal();toast("Added to queue.");return}
    const fav=e.target.closest("[data-fav-track]"); if(fav){const id=fav.dataset.favTrack;state.favorites.has(id)?state.favorites.delete(id):state.favorites.add(id);saveMeta();closeModal();render();return}
    const ap=e.target.closest("[data-add-playlist]"); if(ap){addToPlaylist(ap.dataset.addPlaylist);return}
    const cap=e.target.closest("[data-confirm-add-playlist]"); if(cap){confirmAddPlaylist(cap.dataset.trackId);return}
    const album=e.target.closest("[data-album]"); if(album){showCollection(album.dataset.album,state.tracks.filter(t=>(t.album||"Singles")===album.dataset.album));return}
    const artist=e.target.closest("[data-artist]"); if(artist){showCollection(artist.dataset.artist,state.tracks.filter(t=>(t.artist||"Unknown artist")===artist.dataset.artist));return}
    const pl=e.target.closest("[data-playlist]"); if(pl){const p=state.playlists.find(x=>x.id===pl.dataset.playlist);if(p)showCollection(p.name,p.trackIds.map(id=>state.tracks.find(t=>t.id===id)).filter(Boolean));}
  });

  $("#fileInput").addEventListener("change",e=>{importFiles(e.target.files);e.target.value=""});
  $("#searchInput").addEventListener("input",e=>{state.filter=e.target.value;render()});
  $("#seek").addEventListener("input",e=>{if(audio.duration)audio.currentTime=(Number(e.target.value)/100)*audio.duration});
  $("#volume").addEventListener("input",e=>audio.volume=Number(e.target.value));
  audio.volume=.85;
  audio.addEventListener("timeupdate",updatePlayer);
  audio.addEventListener("loadedmetadata",updatePlayer);
  audio.addEventListener("play",()=>{updatePlayer();const t=state.tracks.find(x=>x.id===state.currentId);if(t)setMediaSession(t)});
  audio.addEventListener("pause",()=>{updatePlayer();if("mediaSession"in navigator)navigator.mediaSession.playbackState="paused"});
  audio.addEventListener("ended",nextTrack);
  audio.addEventListener("error",()=>toast("This audio file cannot be decoded by the browser."));

  document.addEventListener("keydown",e=>{
    if(e.target.matches("input,textarea,select"))return;
    if(e.code==="Space"){e.preventDefault();togglePlay()}
    else if(e.key==="ArrowRight"){audio.currentTime=clamp(audio.currentTime+5,0,audio.duration||Infinity)}
    else if(e.key==="ArrowLeft"){audio.currentTime=clamp(audio.currentTime-5,0,audio.duration||Infinity)}
    else if(e.key.toLowerCase()==="n")nextTrack();
    else if(e.key.toLowerCase()==="p")prevTrack();
    else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("#searchInput").focus()}
  });
  if("mediaSession"in navigator){
    const actions={play:togglePlay,pause:togglePlay,previoustrack:prevTrack,nexttrack:nextTrack,seekbackward:()=>audio.currentTime=clamp(audio.currentTime-10,0,audio.duration||0),seekforward:()=>audio.currentTime=clamp(audio.currentTime+10,0,audio.duration||0)};
    for(const [k,fn] of Object.entries(actions))try{navigator.mediaSession.setActionHandler(k,fn)}catch{}
  }

  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();state.deferredInstall=e;$("#installBtn").hidden=false});
  window.addEventListener("appinstalled",()=>{state.deferredInstall=null;$("#installBtn").hidden=true;toast("AURA installed.")});
  async function installPWA(){if(!state.deferredInstall){toast("Use your browser's Install/Add to Home Screen option.");return}state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;$("#installBtn").hidden=true}

  window.addEventListener("error",e=>console.error("AURA runtime error:",e.error||e.message));
  window.addEventListener("unhandledrejection",e=>console.error("AURA async error:",e.reason));

  (async()=>{await loadDB();applyTheme();if("serviceWorker"in navigator && location.protocol!=="file:")navigator.serviceWorker.register("./sw.js").catch(console.warn);render()})();
})();
