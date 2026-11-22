'use strict';
const {BASE,jsonFetch,parseCandles,forecast,quoteFromBook,paperScreen,strategyChoices}=require('../lib/core');
const store=require('../lib/store');

module.exports=async(req,res)=>{
  const started=Date.now();
  const runId=`collector-${new Date(started).toISOString()}`;
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({ok:false,error:'GET_ONLY'});
  const secret=process.env.CRON_SECRET;
  if(!secret||req.headers.authorization!==`Bearer ${secret}`)return res.status(401).json({ok:false,error:'UNAUTHORIZED'});
  if(!store.enabled())return res.status(503).json({ok:false,error:'STORAGE_NOT_CONFIGURED'});
  const respond=(status,payload)=>{
    const result={...payload,runId,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-started};
    console.log(JSON.stringify({event:'dagger_collector_run',httpStatus:status,...result}));
    return res.status(status).json(result);
  };
  try{
    let graded=0,unresolved=0;
    const records=await store.all(200);
    const due=records.filter(r=>!r.result&&Date.parse(r.close)+90000<Date.now()).slice(0,15);
    for(const row of due){
      try{
        let m;
        try{m=(await jsonFetch(`${BASE}/markets/${encodeURIComponent(row.market)}`,5000)).market;}
        catch{m=(await jsonFetch(`${BASE}/historical/markets/${encodeURIComponent(row.market)}`,5000)).market;}
        if(m&&['yes','no'].includes(m.result)){
          row.result=m.result;
          row.verifiedAt=new Date().toISOString();
          row.verifiedSource='Kalshi public market result';
          await store.update(row);graded++;
        }else unresolved++;
      }catch(e){
        unresolved++;
        console.warn(JSON.stringify({event:'dagger_settlement_error',runId,market:row.market,message:String(e.message||e)}));
      }
    }
    const live=await jsonFetch(`${BASE}/markets?series_ticker=KXBTC15M&status=open&limit=100&mve_filter=exclude`);
    const now=Date.now();
    const valid=(live.markets||[]).filter(m=>['active','open'].includes(m.status)&&Number.isFinite(Number(m.floor_strike))&&Number(m.floor_strike)>0&&Date.parse(m.close_time||m.expiration_time||'')-now>=180000&&Date.parse(m.close_time||m.expiration_time||'')-now<=900000).sort((a,b)=>Date.parse(a.close_time||a.expiration_time)-Date.parse(b.close_time||b.expiration_time));
    const market=valid[0];
    if(!market)return respond(200,{ok:true,recorded:false,graded,unresolved,reason:'No eligible market with 3-15 minutes remaining'});
    if(records.some(r=>r.market===market.ticker))return respond(200,{ok:true,recorded:false,graded,unresolved,reason:'Already captured this market'});
    const [spotResponse,candleResponse]=await Promise.all([
      jsonFetch('https://api.coinbase.com/v2/prices/BTC-USD/spot'),
      jsonFetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60')
    ]);
    const spot=Number(spotResponse?.data?.amount),strike=Number(market.floor_strike);
    const close=Date.parse(market.close_time||market.expiration_time);
    const candles=parseCandles(candleResponse);
    const est=forecast(candles,spot,strike,(close-Date.now())/1000);
    if(!est)return respond(200,{ok:true,recorded:false,graded,unresolved,reason:'Insufficient 1-minute candles or volatility; no fabricated prediction'});
    const yes=est.yes;
    const tail=candles.slice(-11);
    const momentumZ=tail.length>=10?Math.max(-3,Math.min(3,Math.log(tail[tail.length-1].c/tail[0].c)/Math.max(est.sigma,1e-8))):0;
    let paper={decision:'SKIP',reason:'Order book unavailable',assumedFill:false};
    let quote=null;
    try{
      const book=await jsonFetch(`${BASE}/markets/${encodeURIComponent(market.ticker)}/orderbook`,5000);
      quote=quoteFromBook(book);
      paper=paperScreen(yes,quote,(close-Date.now())/60000);
    }catch(e){
      paper.reason='Order book fetch failed';
      console.warn(JSON.stringify({event:'dagger_orderbook_error',runId,market:market.ticker,message:String(e.message||e)}));
    }
    const strategies=strategyChoices(yes,quote,(close-Date.now())/60000);
    const row={strategies,quoteAt:new Date().toISOString(),quote,paper,market:market.ticker,at:new Date().toISOString(),close:new Date(close).toISOString(),side:yes>=.5?'yes':'no',baseYes:yes,predYes:yes,strike,spot,projectedFinish:est.projectedFinish,sigma:est.sigma,momentumZ,minutesRemaining:(close-Date.now())/60000,model_version:'coinbase-1m-baseline-v3',result:null};
    const created=await store.putNew(row);
    return respond(200,{ok:true,recorded:created,graded,unresolved,market:market.ticker,model:row.model_version,settlementPrediction:'Unvalidated Coinbase proxy'});
  }catch(e){
    return respond(502,{ok:false,error:'COLLECTOR_FAILED',detail:String(e.message||e)});
  }
};
