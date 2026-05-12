async function api(url, opts={}){const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Ошибка');return d}
function nav(){return `<div class="nav"><b>Smart Energy</b><a href="/dashboard.html">Панель</a><a href="/devices.html">Устройства</a><a href="/history.html">История</a><a href="/report.html">Отчёт</a><a href="/settings.html">Настройки</a><a href="/admin.html">Admin</a><span class="right"><button class="smallbtn danger" onclick="logout()">Выйти</button></span></div>`}
async function logout(){await api('/api/logout',{method:'POST'});location='/login.html'}
async function guard(){try{await api('/api/me')}catch{location='/login.html'}}
function msg(t){const el=document.getElementById('msg');if(el)el.textContent=t}

let ws = null;
function initWebSocket(userId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', userId }));
    };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'price_update') {
        if (window.onPriceUpdate) window.onPriceUpdate(data);
      }
    };
    ws.onerror = (err) => console.error('WebSocket error:', err);
    ws.onclose = () => {
      setTimeout(() => initWebSocket(userId), 5000);
    };
  } catch(err) {
    console.error('WebSocket init failed:', err);
  }
}
