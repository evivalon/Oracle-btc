const {metrics,jsonFetch,BASE}=require('../lib/core');
const store=require('../lib/store');
module.exports=async(req,res)=>{res.setHeader('Cache-Control','no-store');if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 try{if(req.query.history==='1'){
  const urls=[`${BASE}/markets?series_ticker=KXBTC15M&status=settled&limit=100&mve_filter=exclude`,`${BASE}/historical/markets?series_ticker=KXBTC15M&limit=100`];
  const results=await Promise.allSettled(urls.map(u=>jsonFetch(u)));const sources=results.map((r,i)=>r.status==='fulfilled'?{type:i?'archive':'recent',count:(r.value.markets||[]).filter(m=>['yes','no'].includes(m.result)).length,nextPage:!!r.value.cursor,error:null}:{type:i?'archive':'recent',count:0,error:String(r.reason?.message||r.reason)});
  return res.status(200).json({sources,warning:'Historical settlement records are NOT historical forecasts. They are excluded from accuracy and training.'});}
 if(!store.enabled())return res.status(200).json({configured:false,explanation:'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel to enable persistent server validation.'});
 const records=await store.all(1000);return res.status(200).json({configured:true,...metrics(records)});
 }catch(e){return res.status(502).json({error:'VALIDATION_DATA_ERROR',detail:String(e.message||e)});}};
