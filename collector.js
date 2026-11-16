'use strict';
const {BASE,jsonFetch,parseCandles,forecast}=require('../lib/core');
const store=require('../lib/store');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 const secret=process.env.CRON_SECRET;
 if(!secret||req.headers.authorization!==`Bearer ${secret}`)return res.status(401).json({error:'UNAUTHORIZED',detail:'Scheduled collector requires CRON_SECRET. Do not put it in browser code.'});
 if(!store.enabled())return res.status(503).json({error:'STORAGE_NOT_CONFIGURED'});
 try{
  let graded=0,unresolved=0;const records=await store.all(200);const due=records.filter(r=>!r.result&&Date.parse(r.close)+90000<Date.now()).slice(0,15);
  for(const row of due){try{let m;try{m=(await jsonFetch(`${BASE}/markets/${encodeURIComponent(row.market)}`,5000)).market;}catch{m=(await jsonFetch(`${BASE}/historical/markets/${encodeURIComponent(row.market)}`,5000)).market;}
    if(m&&['yes','no'].includes(m.result)){row.result=m.result;row.verifiedAt=new Date().toISOString();row.verifiedSource='Kalshi public market result';await store.update(row);graded++;}else unresolved++;}catch{unresolved++;}}
  const live=await jsonFetch(`${BASE}/markets?series_ticker=KXBTC15M&status=open&limit=100&mve_filter=exclude`);
  const now=Date.now(),valid=(live.markets||[]).filter(m=>['active','open'].includes(m.status)&&Number.isFinite(Number(m.floor_strike))&&Number(m.floor_strike)>0&&Date.parse(m.close_time||m.expiration_time||'')-now>=180000&&Date.parse(m.close_time||m.expiration_time||'')-now<=900000).sort((a,b)=>Date.parse(a.close_time)-Date.parse(b.close_time));
  const market=valid[0];if(!market)return res.status(200).json({ok:true,recorded:false,graded,unresolved,reason:'No eligible market with 3–15 minutes remaining'});
  if(records.some(r=>r.market===market.ticker))return res.status(200).json({ok:true,recorded:false,graded,unresolved,reason:'Already captured this market'});
  const [spotResponse,candleResponse]=await Promise.all([jsonFetch('https://api.coinbase.com/v2/prices/BTC-USD/spot'),jsonFetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60')]);
  const spot=Number(spotResponse?.data?.amount),strike=Number(market.floor_strike),close=Date.parse(market.close_time||market.expiration_time),est=forecast(parseCandles(candleResponse),spot,strike,(close-Date.now())/1000);
  if(!est)return res.status(200).json({ok:true,recorded:false,graded,unresolved,reason:'Insufficient 1-minute candles or volatility; no fabricated prediction'});
  const yes=est.yes;const row={market:market.ticker,at:new Date().toISOString(),close:new Date(close).toISOString(),side:yes>=.5?'yes':'no',baseYes:yes,predYes:yes,strike,spot,projectedFinish:est.projectedFinish,sigma:est.sigma,model_version:'coinbase-1m-baseline-v3',result:null};
  const created=await store.putNew(row);return res.status(200).json({ok:true,recorded:created,graded,unresolved,market:market.ticker,model:row.model_version,settlementPrediction:'Unvalidated Coinbase proxy'});
 }catch(e){return res.status(502).json({error:'COLLECTOR_FAILED',detail:String(e.message||e)});}
};
