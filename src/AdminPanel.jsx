import React,{useEffect,useState} from 'react';
import {ShieldCheck,Plus,Trash2,Gift,Users,Send,Youtube,RefreshCw,AlertCircle,CheckCircle2} from 'lucide-react';
import './admin.css';

function initData(){return window.Telegram?.WebApp?.initData||''}
async function api(path,options={}) {
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':initData(),...(options.headers||{})}});
  const data=await response.json().catch(()=>({error:'Unexpected server response'}));
  if(!response.ok) throw new Error(data.error||'Request failed');
  return data;
}
function Notice({message,error}){if(!message)return null;return <div className={'admin-notice '+(error?'is-error':'is-ok')}>{error?<AlertCircle/>:<CheckCircle2/>}{message}</div>}

export function RedeemPanel({onBalance}){
 const [code,setCode]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(false),[balance,setBalance]=useState(null);
 useEffect(()=>{api('/api/me').then(d=>setBalance(d.user.balance)).catch(e=>{setError(true);setMessage(e.message)})},[]);
 async function claim(e){e.preventDefault();setBusy(true);setMessage('');setError(false);try{const d=await api('/api/redeem',{method:'POST',body:JSON.stringify({code})});setBalance(d.balance);onBalance?.(Number(d.balance));setCode('');setMessage('Success! '+Number(d.points).toLocaleString()+' KVXN points added.')}catch(e){setError(true);setMessage(e.message)}finally{setBusy(false)}}
 return <section className="section admin-section"><div className="heading"><small>KAVIXO REWARDS</small><h2>Redeem code</h2></div><div className="redeem-box"><Gift/><p>Enter a code shared by the KAVIXO team to claim KVXN in-app points.</p><form onSubmit={claim}><input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="ENTER REDEEM CODE" maxLength={40}/><button disabled={busy||!code.trim()}>{busy?'CHECKING…':'CLAIM POINTS'}</button></form>{balance!==null&&<div className="redeem-balance">Current balance <b>{Number(balance).toLocaleString()} KVXN</b></div>}<Notice message={message} error={error}/></div></section>
}

export function AdminPanel(){
 const [codes,setCodes]=useState([]),[channels,setChannels]=useState([]),[code,setCode]=useState(''),[points,setPoints]=useState(''),[maxClaims,setMaxClaims]=useState(''),[platform,setPlatform]=useState('telegram'),[title,setTitle]=useState(''),[url,setUrl]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(false);
 async function load(){setBusy(true);try{const [c,h]=await Promise.all([api('/api/admin/redeem-codes'),api('/api/admin/channels')]);setCodes(c.codes);setChannels(h.channels);setError(false);setMessage('')}catch(e){setError(true);setMessage(e.message)}finally{setBusy(false)}}
 useEffect(()=>{load()},[]);
 async function createCode(e){e.preventDefault();setBusy(true);setMessage('');try{await api('/api/admin/redeem-codes',{method:'POST',body:JSON.stringify({code,points,maxClaims})});setCode('');setPoints('');setMaxClaims('');setMessage('Redeem code saved successfully');await load()}catch(e){setError(true);setMessage(e.message)}finally{setBusy(false)}}
 async function removeCode(value){if(!confirm('Deactivate redeem code '+value+'?'))return;try{await api('/api/admin/redeem-codes/'+encodeURIComponent(value),{method:'DELETE'});setMessage('Code deactivated');await load()}catch(e){setError(true);setMessage(e.message)}}
 async function addChannel(e){e.preventDefault();setBusy(true);setMessage('');try{await api('/api/admin/channels',{method:'POST',body:JSON.stringify({platform,title,url})});setTitle('');setUrl('');setMessage('Channel added');await load()}catch(e){setError(true);setMessage(e.message)}finally{setBusy(false)}}
 async function removeChannel(id){if(!confirm('Delete this channel?'))return;try{await api('/api/admin/channels/'+id,{method:'DELETE'});setMessage('Channel deleted');await load()}catch(e){setError(true);setMessage(e.message)}}
 return <section className="section admin-section"><div className="heading"><small>RESTRICTED CONTROL ROOM</small><h2>Admin console</h2></div><div className="admin-banner"><ShieldCheck/><span><b>Secure admin controls</b><small>Server verifies your Telegram identity on every request</small></span><button onClick={load} aria-label="Refresh"><RefreshCw/></button></div><Notice message={message} error={error}/>
 <div className="admin-form-card"><h3><Gift/> Create redeem code</h3><form onSubmit={createCode}><label>Redeem code<input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder="e.g. KAVIXO100" maxLength={40} required/></label><label>KVXN points<input type="number" min="1" max="1000000000" value={points} onChange={e=>setPoints(e.target.value)} placeholder="e.g. 500" required/></label><label>Maximum claims <small>(optional)</small><input type="number" min="1" value={maxClaims} onChange={e=>setMaxClaims(e.target.value)} placeholder="Unlimited"/></label><button disabled={busy}>SAVE REDEEM CODE <Plus/></button></form></div>
 <div className="admin-form-card"><h3><Users/> Redeem codes</h3>{codes.length===0?<p className="admin-empty">No codes created yet.</p>:codes.map(c=><div className="admin-list-row" key={c.code}><span><b>{c.code}</b><small>{Number(c.points).toLocaleString()} KVXN · {c.claims_count}/{c.max_claims??'∞'} claims · {c.active?'Active':'Inactive'}</small></span><button onClick={()=>removeCode(c.code)} aria-label="Deactivate code"><Trash2/></button></div>)}</div>
 <div className="admin-form-card"><h3><Send/> Telegram & YouTube channels</h3><form onSubmit={addChannel}><label>Platform<select value={platform} onChange={e=>setPlatform(e.target.value)}><option value="telegram">Telegram</option><option value="youtube">YouTube</option></select></label><label>Channel name<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="KAVIXO Community" required/></label><label>Channel URL<input type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder={platform==='telegram'?'https://t.me/yourchannel':'https://youtube.com/@yourchannel'} required/></label><button disabled={busy}>ADD CHANNEL <Plus/></button></form><div className="admin-channel-list">{channels.length===0?<p className="admin-empty">No channels added yet.</p>:channels.map(c=><div className="admin-list-row" key={c.id}><span>{c.platform==='telegram'?<Send/>:<Youtube/>}<b>{c.title}</b><small>{c.platform} · {c.url}</small></span><button onClick={()=>removeChannel(c.id)} aria-label="Delete channel"><Trash2/></button></div>)}</div></div>
 <p className="admin-footnote">KVXN values here are in-app points only. Code claims are atomic and each Telegram account can claim a code once.</p></section>
}
