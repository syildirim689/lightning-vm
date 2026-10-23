"use client";
import { useEffect, useState } from 'react';
export default function Status() {
 const [state,setState]=useState({status:'Kontrol ediliyor',worker:'Bekleniyor'});
 useEffect(()=>{ let active=true; const controller=new AbortController();
 async function load(){try{
  const ready=await fetch('/api/ready',{signal:controller.signal}); if(!ready.ok)throw Error();
  const response=await fetch('/api/system',{signal:controller.signal}); if(!response.ok)throw Error();
  const data=await response.json();
  if(active)setState({status:'API, PostgreSQL ve Redis erişilebilir',worker:data.worker.some(w=>w.healthy)?'Çalışıyor':'Heartbeat bekleniyor'});
 }catch{if(active)setState({status:'Bağlantı kurulamadı',worker:'Bilinmiyor'});}}
 load();const timer=setInterval(load,15000);return()=>{active=false;controller.abort();clearInterval(timer);};},[]);
 return <article><h2>Sistem sağlığı</h2><p>{state.status}</p><p>Arka plan çalışanı: {state.worker}</p><small>Bu kontrol VMware veya müşteri VM sağlığını ölçmez.</small></article>;
}
