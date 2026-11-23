'use strict';
// Read-only counterfactual analysis of quotes captured at forecast time.
// No orders, verified fills, database writes, retraining, or model promotion.
const store=require('../lib/store');
const {takerFee}=require('../lib/core');
const FREEZE='2026-11-22T04:00:00.000Z';
const TEMP=1.15, OFFSET=-0.5;
const clip=p=>Math.max(1e-6,Math.min(1-1e-6,p));
const shadow=p=>1/(1+Math.exp(-(Math.log(clip(p)/(1-clip(p)))/TEMP+OFFSET)));
const round=x=>Number.isFinite(x)?Math.round(x*1e6)/1e6:null;
const COSTS=[0,0.02,0.05,0.10]; // extra adverse cost per hypothetical contract
function eligible(row){
 const at=Date.parse(row.at),qt=Date.parse(row.quoteAt),close=Date.parse(row.close);
 return row && typeof row.market==='string' && at>=Date.parse(FREEZE) &&
 Number.isFinite(qt)&&qt>=at-60000&&qt<=at+60000&&qt<close&&
 Number.isFinite(close)&&close>at&&
 Number.isFinite(row.baseYes)&&row.baseYes>0&&row.baseYes<1 &&
 row.quote && ['yes','no'].includes(row.result) &&
 Number.isFinite(Date.parse(row.verifiedAt))&&Date.parse(row.verifiedAt)>=close;
}
function choice(row,prob,extraCost=0){
 const q=row.quote;
 const options=['yes','no'].map(side=>{
  const ask=Number(q[side+'Ask']),bid=Number(q[side+'Bid']);
  const size=Number(q[side+'AskSize']);
  const spread=ask-bid;
  const fee=Number.isFinite(ask)&&ask>0&&ask<1?takerFee(ask):NaN;
  const p=side==='yes'?prob:1-prob;
  return {side,ask,bid,size,spread,fee,prob:p,edge:p-ask-fee-extraCost};
 }).filter(o=>o.ask>0&&o.ask<1&&o.bid>=0&&o.bid<o.ask&&o.size>=1&&o.spread<=0.08&&Number.isFinite(o.fee));
 options.sort((a,b)=>b.edge-a.edge);
 const best=options[0];
 if(!best||best.prob<0.65||best.edge<0.08)return null;
 return {side:best.side,ask:best.ask,fee:best.fee,edge:best.edge,
  pnl:(row.result===best.side?1:0)-best.ask-best.fee-extraCost};
}
function summarize(rows,fn,extra){
 let selected=[],peak=0,equity=0,drawdown=0,wins=0,stake=0;
 for(const row of rows){
  const c=choice(row,fn(row.baseYes),extra);
  if(!c)continue;
  selected.push(c);wins+=Number(c.side===row.result);
  stake+=c.ask+c.fee+extra;equity+=c.pnl;
  peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);
 }
 const n=selected.length;
 return {eligibleQuotes:rows.length,candidates:n,wins,losses:n-wins,
  hypotheticalNetPnl:round(equity),hypotheticalStake:round(stake),
  returnOnHypotheticalStake:stake?round(equity/stake):null,
  maximumDrawdown:round(drawdown),winRate:n?round(wins/n):null,
  fillVerified:false};
}
function report(records){
 const map=new Map();
 for(const r of (records||[]).filter(r=>r&&Number.isFinite(Date.parse(r.at))&&Date.parse(r.at)>=Date.parse(FREEZE)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))){
  if(r.market&&!map.has(r.market))map.set(r.market,r);
 }
 const all=[...map.values()],rows=all.filter(eligible);
 const scenarios=COSTS.map(c=>({additionalAdverseCostDollars:c,champion:summarize(rows,p=>p,c),challenger:summarize(rows,shadow,c)}));
 return {ok:true,mode:'read-only-quote-counterfactual',freezeAt:FREEZE,
  modelParameters:{champion:'stored baseYes',challenger:'fixed temperature-offset',temperature:TEMP,offset:OFFSET},
  selectionPolicy:{minimumProbability:0.65,minimumNetEdgeAfterEstimatedFeeAndStress:0.08,maximumSpread:0.08,minimumDisplayedSize:1,oneContractPerMarket:true},
  counts:{postFreezeUniqueMarkets:all.length,eligibleVerifiedQuoteSnapshots:rows.length,excludedOrPending:all.length-rows.length},
  scenarios,preliminaryTradeReviewReady:scenarios[0].champion.candidates>=100&&scenarios[0].challenger.candidates>=100,
  modelPromotionAllowed:false,liveTradingEnabled:false,
  caveats:['Retrospective counterfactual of previously stored quote snapshots, not independently logged forward paper orders.',
   'Quotes and displayed size do not verify execution; fees are estimates from existing core logic, not verified transaction charges.',
   'Adverse-cost scenarios are fixed stress assumptions; no latency, queue position, market impact, or actual fills are modeled.',
   'Selection uses frozen thresholds and model parameters; avoid optimizing against this evaluation window.',
   'Correlated 15-minute BTC outcomes and selection bias limit statistical conclusions.',
   'No realized profitability claim. Endpoint does not place trades or write data.']};
}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'GET_ONLY'});
 if(!store.enabled())return res.status(503).json({error:'STORAGE_NOT_CONFIGURED'});
 try{return res.status(200).json(report(await store.all(1500)));}
 catch(e){return res.status(502).json({error:'PAPER_RESEARCH_FAILED',detail:String(e.message||e)});}
};
module.exports._report=report;
