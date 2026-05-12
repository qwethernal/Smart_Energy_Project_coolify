async function login(){try{await api('/api/login',{method:'POST',body:JSON.stringify({username:username.value,password:password.value})});location='/dashboard.html'}catch(e){msg(e.message)}}
