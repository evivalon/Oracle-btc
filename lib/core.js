'use strict';
const BASE='https://external-api.kalshi.com/trade-api/v2';
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30)));
const logit=p=>Math.log(clamp(p,.01,.99)/(1-clamp(p,.01,.99)));
function normCDF(x){const t=1/(1+.2316419*Math.abs(x)),d=.3989422804014327*Math.exp(-x*x/2),p=1-d*t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return x>=0?p:1-p;}
async function jsonFetch(url,ms=8500){let ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),ms);try{const r=await fetch(url,{signal:ctl.signal,headers:{Accept:'application/json','User-Agent':'DaggerBTC-Validation/3.0'}});if(!r.ok)throw Error('Upstream HTTP '+r.status+' from '+new URL(url).hostname);return await r.json();}finally{clearTimeout(timer);}}
function parseCandles(rows){if(!Array.isArray(rows))return[];return rows.map(k=>({t:Number(k[0])*1000,c:Number(k[4])})).filter(c=>Number.isFinite(c.t)&&Number.isFinite(c.c)&&c.c>0).sort((a,b)=>a.t-b.t).filter((c,i,a)=>i===0||c.t!==a[i-1].t);}
function forecast(candles,spot,strike,seconds){if(candles.length<75||!Number.isFinite(spot)||!Number.isFinite(strike)||spot<=0||strike<=0||seconds<60||seconds>900)return null;
 const tail=candles.slice(-180);let returns=[];for(let i=1;i<tail.length;i++){let dt=(tail[i].t-tail[i-1].t)/60000;if(dt>0&&dt<=3)returns.push({r:Math.log(tail[i].c/tail[i-1].c),dt});}if(returns.length<60)return null;
 const avg=returns.reduce((s,x)=>s+x.r,0)/returns.length;let variance=returns.reduce((s,x)=>s+(x.r-avg)**2/x.dt,0)/(returns.length-1);if(!(variance>0))return null;
 const sigma=Math.sqrt(variance*Math.max(seconds/60,1)+.0008**2);
 const recent=returns.slice(-20);const minutes=recent.reduce((s,x)=>s+x.dt,0);const drift=clamp(.15*recent.reduce((s,x)=>s+x.r,0)/minutes*(seconds/60),-.35*sigma,.35*sigma);
 return {yes:clamp(normCDF(Math.log((spot*Math.exp(drift))/strike)/sigma),.01,.99), projectedFinish:spot*Math.exp(drift),sigma,observations:returns.length};}
// Feature-aware probability model. Only pre-settlement inputs are allowed.
function features(row){
 const spot=Number(row.spot),strike=Number(row.strike),sigma=Number(row.sigma);
 const minutes=(Date.parse(row.close)-Date.parse(row.at))/60000;
 if(!(spot>0&&strike>0&&sigma>0&&minutes>0&&minutes<=16))return null;
 const gap=Math.log(spot/strike)/sigma;
 const p=clamp(Number(row.baseYes),.001,.999);
 return [1,clamp(logit(p),-5,5),clamp(gap,-5,5),clamp(Math.log(minutes/15),-3,0),clamp(Number(row.momentumZ)||0,-3,3)];
}
function fitLogistic(rows){
 let weights=[0,1,0,0,0];
 for(let epoch=0;epoch<600;epoch++){
  let gradients=weights.map(()=>0);
  for(const row of rows){const x=features(row),y=row.result==='yes'?1:0;
   const delta=sigmoid(x.reduce((v,z,i)=>v+z*weights[i],0))-y;
   x.forEach((v,i)=>gradients[i]+=delta*v);
  }
  const lr=.08/(1+epoch/250);
  weights=weights.map((w,i)=>clamp(w-lr*(gradients[i]/rows.length+.08*(w-(i===1?1:0))),-5,5));
 }
 return weights;
}
function learnedProb(row,w){const x=features(row);return x?clamp(sigmoid(x.reduce((s,v,i)=>s+v*w[i],0)),.001,.999):row.baseYes;}
function walkForward(rows){
 const eligible=rows.filter(r=>features(r)&&['yes','no'].includes(r.result)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const split=Math.floor(eligible.length*.75);
 if(split<100||eligible.length-split<50)return {status:'collecting',train:Math.min(split,eligible.length),test:eligible.length-split,minimum:200,model:'threshold-logistic-v1',promoted:false};
 const train=eligible.slice(0,split),test=eligible.slice(split),weights=fitLogistic(train);
 const base=brier(test,r=>r.baseYes),candidate=brier(test,r=>learnedProb(r,weights));
 const brierGain=base-candidate;
 return {status:brierGain>.002?'candidate-outperformed-baseline':'baseline-preferred',train:train.length,test:test.length,baselineBrier:base,candidateBrier:candidate,brierGain,model:'threshold-logistic-v1',promoted:false,
 note:'Chronological holdout diagnostic only. No automatic model promotion; future data is required for independent validation.'};
}
// Paper-only execution screen: one contract, taker fee estimate. Never assumes a fill.
function takerFee(price){return Math.ceil((.07*price*(1-price)-1e-10)*100)/100;}
function bestBid(levels,unit){if(!Array.isArray(levels))return null;let best=null;for(const level of levels){if(!Array.isArray(level)||level.length<2)continue;let price=Number(level[0]),size=Number(level[1]);if(unit==='cents')price/=100;if(price>0&&price<1&&size>=1&&(!best||price>best.price))best={price,size};}return best;}
function quoteFromBook(book){const fp=book?.orderbook_fp,legacy=book?.orderbook;
 const y=bestBid(fp?.yes_dollars,'dollars')||bestBid(legacy?.yes,'cents');
 const n=bestBid(fp?.no_dollars,'dollars')||bestBid(legacy?.no,'cents');
 if(!y||!n)return null;
 const yesAsk=1-n.price,noAsk=1-y.price;
 return {yesBid:y.price,noBid:n.price,yesAsk,noAsk,yesAskSize:n.size,noAskSize:y.size,yesSpread:yesAsk-y.price,noSpread:noAsk-n.price};
}
function paperScreen(pYes,quote,minutes){if(!quote||!(pYes>0&&pYes<1)||!(minutes>=3))return {decision:'SKIP',reason:'Missing executable book or insufficient time',assumedFill:false};
 const options=[{side:'yes',prob:pYes,ask:quote.yesAsk,spread:quote.yesSpread,size:quote.yesAskSize},{side:'no',prob:1-pYes,ask:quote.noAsk,spread:quote.noSpread,size:quote.noAskSize}].map(o=>({...o,fee:takerFee(o.ask),netEdge:o.prob-o.ask-takerFee(o.ask)}));
 const best=options.sort((a,b)=>b.netEdge-a.netEdge)[0];
 const passes=best.prob>=.65&&best.netEdge>=.08&&best.spread<=.08&&best.size>=1;
 return {decision:passes?'PAPER_CANDIDATE':'SKIP',reason:passes?'Experimental edge screen passed; fill NOT verified':'Confidence, net edge, spread, or liquidity gate failed',side:best.side,probability:best.prob,ask:best.ask,fee:best.fee,netEdge:best.netEdge,spread:best.spread,availableContracts:best.size,assumedFill:false,modelValidated:false};
}

// Forward-only research comparison. Uses one pre-expiry quote snapshot per market.
// Snapshot-based P&L is counterfactual; a displayed ask is not a verified fill.
function strategyChoices(pYes,quote,minutes){
 if(!quote||!Number.isFinite(pYes)||pYes<=0||pYes>=1||!(minutes>=3))return {conservative:null,value:null};
 const candidates=[{side:'yes',probability:pYes,ask:quote.yesAsk,spread:quote.yesSpread,size:quote.yesAskSize},
 {side:'no',probability:1-pYes,ask:quote.noAsk,spread:quote.noSpread,size:quote.noAskSize}]
 .filter(o=>Number.isFinite(o.ask)&&o.ask>0&&o.ask<1&&Number.isFinite(o.spread)&&o.spread>=0&&o.spread<=.08&&Number(o.size)>=1)
 .map(o=>({...o,fee:takerFee(o.ask),netEdge:o.probability-o.ask-takerFee(o.ask)}))
 .sort((a,b)=>b.netEdge-a.netEdge);
 const conservative=candidates.find(o=>o.probability>=.65&&o.netEdge>=.08)||null;
 const value=candidates.find(o=>o.netEdge>=.08)||null;
 return {conservative,value};
}
function strategyComparison(records){
 const names=['conservative','value'];let output={};
 for(const name of names){
  const selected=records.filter(r=>r.strategies&&r.strategies[name]&&r.quoteAt&&Date.parse(r.quoteAt)<Date.parse(r.close));
  const settled=selected.filter(r=>['yes','no'].includes(r.result)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  let equity=0,peak=0,maxDrawdown=0,wins=0,stake=0;
  for(const r of settled){const o=r.strategies[name];if(o.side===r.result)wins++;stake+=o.ask+o.fee;equity+=(o.side===r.result?1:0)-o.ask-o.fee;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
  output[name]={candidates:selected.length,settled:settled.length,pending:selected.length-settled.length,wins,losses:settled.length-wins,winRate:settled.length?wins/settled.length:null,hypotheticalNetPnl:Math.round(equity*10000)/10000,totalHypotheticalStake:Math.round(stake*10000)/10000,returnOnStake:stake>0?equity/stake:null,maxDrawdown:Math.round(maxDrawdown*10000)/10000};
 }
 return {strategies:output,eligibleQuoteSnapshots:records.filter(r=>r.strategies).length,unit:'USD, one hypothetical contract per candidate',fillVerified:false,modelValidated:false,notes:'Prospective quote-snapshot research only. No verified fills, slippage, latency, or BRTI alignment. Do not interpret as realized or achievable returns. Existing records without strategy snapshots are not retroactively backfilled.'};
}

function paperMetrics(records){const quoted=records.filter(r=>r.paper&&Number.isFinite(r.paper.ask));const selected=quoted.filter(r=>r.paper.decision==='PAPER_CANDIDATE');const settled=selected.filter(r=>['yes','no'].includes(r.result));const wins=settled.filter(r=>r.paper.side===r.result).length;
 const pnl=settled.reduce((v,r)=>v+(r.paper.side===r.result?1:0)-r.paper.ask-r.paper.fee,0);
 let peak=0,equity=0,maxDrawdown=0;for(const r of settled.slice().sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))){equity+=(r.paper.side===r.result?1:0)-r.paper.ask-r.paper.fee;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);}
 return {quoted:quoted.length,screened:records.filter(r=>r.paper).length,candidates:selected.length,settled: settled.length,pending:selected.length-settled.length,wins,losses:settled.length-wins,winRate:settled.length?wins/settled.length:null,hypotheticalNetPnl:Math.round(pnl*100)/100,maxDrawdown:Math.round(maxDrawdown*100)/100,unit:'USD per one hypothetical contract',fillVerified:false,disclaimer:'Quote-snapshot counterfactual only. No orders, fills, latency, slippage, market impact, or portfolio returns are simulated. Not realized or executable P&L.'};}
function fitPlatt(rows){let a=0,b=1;for(let epoch=0;epoch<500;epoch++){let ga=0,gb=0;for(const r of rows){const x=clamp(logit(r.baseYes),-4,4),y=r.result==='yes'?1:0,d=sigmoid(a+b*x)-y;ga+=d;gb+=d*x;}const rate=.12/(1+epoch/180);a=clamp(a-rate*(ga/rows.length+.08*a),-2,2);b=clamp(b-rate*(gb/rows.length+.12*(b-1)),.1,2.5);}return{a,b};}
const brier=(rows,fn)=>rows.reduce((s,r)=>s+(fn(r)-(r.result==='yes'?1:0))**2,0)/rows.length;
function metrics(records){const rows=records.filter(r=>['yes','no'].includes(r.result)&&Number.isFinite(r.baseYes)&&r.baseYes>0&&r.baseYes<1).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));const n=rows.length,correct=rows.filter(r=>(r.baseYes>=.5?'yes':'no')===r.result).length;const buckets=[];for(let lo=0;lo<10;lo++){const arr=rows.filter(r=>r.baseYes>=lo/10&&(lo===9?r.baseYes<=1:r.baseYes<(lo+1)/10));if(arr.length)buckets.push({range:`${lo*10}-${(lo+1)*10}%`,n:arr.length,predicted:arr.reduce((s,r)=>s+r.baseYes,0)/arr.length,observed:arr.filter(r=>r.result==='yes').length/arr.length});}
 let validation={status:'collecting',train:0,test:0,baseBrier:null,learnedBrier:null,version:'baseline-v3',diagnostic:false};if(n>=130){let split=n-30,train=rows.slice(0,split),test=rows.slice(split),p=fitPlatt(train),base=brier(test,r=>r.baseYes),learned=brier(test,r=>sigmoid(p.a+p.b*logit(r.baseYes)));validation={status:learned+.002<base?'calibration-promising-not-promoted':'baseline-preferred',train:train.length,test:test.length,baseBrier:base,learnedBrier:learned,version:'platt-evaluation-v1',diagnostic:true};}
 return{strategyComparison:strategyComparison(records),paper:paperMetrics(records),thresholdModel:walkForward(rows),total:records.length,settled:n,pending:records.filter(r=>!r.result).length,accuracy:n?correct/n:null,baselineBrier:n?brier(rows,r=>r.baseYes):null,calibration:buckets,validation,latest:records.slice().sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,12).map(r=>({market:r.market,at:r.at,baseYes:r.baseYes,side:r.side,result:r.result||'pending',model:r.model_version}))};}
module.exports={BASE,jsonFetch,parseCandles,forecast,metrics,quoteFromBook,paperScreen,takerFee,strategyChoices,strategyComparison};
