'use strict';
// Read-only champion/challenger evaluation. Never changes production forecasts.
const store=require('../lib/store');
const clip=p=>Math.max(0.000001,Math.min(0.999999,p));
const logit=p=>Math.log(clip(p)/(1-clip(p)));
const sigmoid=x=>1/(1+Math.exp(-Math.max(-35,Math.min(35,x))));
const rnd=x=>Number.isFinite(x)?+x.toFixed(6):null;
const usable=r=>r&&['yes','no'].includes(r.result)&&Number.isFinite(+r.baseYes)&&+r.baseYes>0&&+r.baseYes<1&&Number.isFinite(Date.parse(r.at))&&Number.isFinite(Date.parse(r.close))&&Date.parse(r.close)>Date.parse(r.at)&&Number.isFinite(Date.parse(r.verifiedAt||''));
const y=r=>r.result==='yes'?1:0;
function metrics(rows,predict){if(!rows.length)return {n:0,brier:null,accuracy:null,logLoss:null};let b=0,a=0,l=0;for(const r of rows){const p=clip(predict(r)),v=y(r);b+=(p-v)**2;a+=(p>=.5?1:0)===v?1:0;l+=-(v*Math.log(p)+(1-v)*Math.log(1-p));}return {n:rows.length,brier:rnd(b/rows.length),accuracy:rnd(a/rows.length),logLoss:rnd(l/rows.length)};}
// Fit only on earlier resolved observations, with small regularization to discourage overfit.
function fit(train){let best={temperature:1,offset:0,loss:Infinity};for(const temperature of [0.7,0.85,1,1.15,1.3,1.5,1.8,2.2])for(const offset of [-0.5,-0.25,0,0.25,0.5]){let loss=0;for(const r of train){const p=clip(sigmoid(logit(+r.baseYes)/temperature+offset));loss+=-(y(r)*Math.log(p)+(1-y(r))*Math.log(1-p));}loss=loss/train.length+0.004*(temperature-1)**2+0.004*offset**2;if(loss<best.loss)best={temperature,offset,loss};}return {temperature:best.temperature,offset:best.offset};}
function report(all){const rows=all.filter(usable).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));const cut=Math.floor(rows.length*0.7);const earlier=rows.slice(0,cut),later=rows.slice(cut);const minimum={train:150,holdout:75};const eligible=earlier.length>=minimum.train&&later.length>=minimum.holdout;const baseline=r=>+r.baseYes;const parameters=earlier.length>=20?fit(earlier):null;const challenger=r=>sigmoid(logit(+r.baseYes)/parameters.temperature+parameters.offset);const base=metrics(later,baseline);const candidate=parameters?metrics(later,challenger):null;const delta=candidate&&base.brier!==null?rnd(base.brier-candidate.brier):null;
// Prevent lookahead: settlement verification must predate the first holdout forecast.
const boundary=later.length?Date.parse(later[0].at):Infinity;
const cleanTrain=earlier.filter(r=>Date.parse(r.verifiedAt)<boundary);
const cleanParams=cleanTrain.length>=20?fit(cleanTrain):null;
const cleanCandidate=cleanParams?metrics(later,r=>sigmoid(logit(+r.baseYes)/cleanParams.temperature+cleanParams.offset)):null;
const cleanDelta=cleanCandidate?rnd(base.brier-cleanCandidate.brier):null;
return {ok:true,mode:'read-only-shadow-research',data:{stored:all.length,settledWithVerifiedTimestamp:rows.length,chronologicalTrainCount:earlier.length,holdoutCount:later.length,trainSettledBeforeHoldout:cleanTrain.length,minimumSampleRequirements:minimum,sampleThresholdMet:eligible,baselineHoldout:base,challengerHoldout:cleanCandidate,challengerParameters:cleanParams,holdoutBrierImprovement:cleanDelta,exploratoryOnly:true,modelPromotionAllowed:false,productionModelUnchanged:true},warnings:['Holdout results are exploratory and become contaminated by repeated review or tuning.','No independent future-window validation or market-dependence-adjusted confidence interval is provided.','Missing verifiedAt timestamps are excluded; historical data is not backfilled.','Challenger probabilities are not used to select historical trades; no execution or profitability claim.','Even if sample thresholds are met, automatic promotion is disabled.']};}
module.exports=async(req,res)=>{res.setHeader('Cache-Control','no-store');if(req.method!=='GET')return res.status(405).json({error:'GET only'});if(!store.enabled())return res.status(503).json({error:'STORAGE_NOT_CONFIGURED'});try{return res.status(200).json(report(await store.all(1500)));}catch(e){return res.status(502).json({error:'RESEARCH_V60_FAILED',detail:String(e.message||e)});}};
module.exports._report=report;
