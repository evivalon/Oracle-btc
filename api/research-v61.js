'use strict';
// Forward-only, fixed-parameter shadow evaluation. No writes, no trading, no promotion.
const store = require('../lib/store');
const FREEZE_AT = '2026-11-22T04:00:00.000Z';
const TEMPERATURE = 1.15;
const OFFSET = -0.5;
const MIN_FORWARD = 75;
const clip = p => Math.max(1e-6, Math.min(1-1e-6,p));
const sigmoid = z => 1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));
const challenger = p => sigmoid(Math.log(clip(p)/(1-clip(p)))/TEMPERATURE+OFFSET);
const rounded = n => Number.isFinite(n) ? Number(n.toFixed(6)) : null;
function summarize(rows, fn) {
  if (!rows.length) return {n:0,brier:null,accuracy:null,logLoss:null};
  let b=0, correct=0, loss=0;
  for (const r of rows) {
    const p=clip(fn(r)), y=r.result==='yes'?1:0;
    b+=(p-y)**2;
    correct+=Number((p>=0.5?1:0)===y);
    loss-=y*Math.log(p)+(1-y)*Math.log(1-p);
  }
  return {n:rows.length,brier:rounded(b/rows.length),accuracy:rounded(correct/rows.length),logLoss:rounded(loss/rows.length)};
}
function report(records) {
  const freeze=Date.parse(FREEZE_AT);
  const after=(records||[]).filter(r=>r && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at)>=freeze);
  const unique=new Map();
  for(const r of after.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))) {
    if(typeof r.market==='string' && r.market && !unique.has(r.market)) unique.set(r.market,r);
  }
  const rows=[...unique.values()];
  const verified=rows.filter(r=> ['yes','no'].includes(r.result) && Number.isFinite(Date.parse(r.verifiedAt)) && Date.parse(r.verifiedAt)>=Date.parse(r.close) && Number.isFinite(Date.parse(r.close)) && Date.parse(r.close)>Date.parse(r.at) && typeof r.baseYes==='number' && Number.isFinite(r.baseYes) && r.baseYes>0 && r.baseYes<1);
  const baseline=summarize(verified,r=>r.baseYes);
  const shadow=summarize(verified,r=>challenger(r.baseYes));
  const improvement=baseline.brier!==null?rounded(baseline.brier-shadow.brier):null;
  return {ok:true,mode:'forward-only-fixed-shadow',freezeAt:FREEZE_AT,configuration:{champion:'stored baseYes',challenger:'fixed temperature-offset calibration',temperature:TEMPERATURE,offset:OFFSET,minimumForwardSettlements:MIN_FORWARD},counts:{postFreezeRecords:after.length,uniqueMarkets:rows.length,verifiedForwardSettlements:verified.length,pendingOrExcluded:rows.length-verified.length},champion:baseline,challenger:shadow,absoluteBrierImprovement:improvement,preliminaryReviewReady:verified.length>=MIN_FORWARD,modelPromotionAllowed:false,productionModelUnchanged:true,warnings:['Frozen parameters are from earlier exploratory work; do not retune using this forward window.','This endpoint evaluates only rows whose forecast timestamp is on or after the freeze.','Scheduled runs may be delayed; a missing market is not a failed prediction.','Small samples and correlated BTC intervals can make apparent gains misleading.','No simulated or actual fill, fees, spread, trading P&L, or profitability claim is calculated.','Read-only endpoint; production forecasts and trading behavior are unchanged.']};
}
module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  if(!store.enabled()) return res.status(503).json({error:'STORAGE_NOT_CONFIGURED'});
  try{return res.status(200).json(report(await store.all(1500)));}
  catch(e){return res.status(502).json({error:'FORWARD_RESEARCH_FAILED',detail:String(e.message||e)});}
};
module.exports._report=report;
