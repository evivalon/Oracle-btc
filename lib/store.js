'use strict';
function enabled(){return !!(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN);}
async function cmd(...args){if(!enabled())throw Error('STORAGE_NOT_CONFIGURED');const r=await fetch(process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/,'') ,{method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(args)});if(!r.ok)throw Error('Storage HTTP '+r.status);let body=await r.json();if(body.error)throw Error('Storage error: '+body.error);return body.result;}
const key=ticker=>'dagger:forecast:v3:'+ticker;
async function all(limit=500){const ids=await cmd('ZREVRANGE','dagger:forecast:index',0,Math.min(limit,1500)-1);if(!ids||!ids.length)return[];let results=[];for(let i=0;i<ids.length;i+=60){let raw=await cmd('MGET',...ids.slice(i,i+60).map(key));for(let x of raw||[])if(x){try{results.push(JSON.parse(x));}catch{}}}return results;}
async function putNew(row){const ok=await cmd('SET',key(row.market),JSON.stringify(row),'NX');if(ok==='OK'){await cmd('ZADD','dagger:forecast:index',Date.parse(row.at),row.market);return true;}return false;}
async function update(row){await cmd('SET',key(row.market),JSON.stringify(row));}
module.exports={enabled,all,putNew,update};
