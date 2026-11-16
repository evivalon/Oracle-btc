// Vercel Node.js function. Authenticated Kalshi CF Benchmarks passthrough.
// Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in Vercel environment variables.
const crypto = require('node:crypto');
module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const key=process.env.KALSHI_API_KEY_ID, pem=process.env.KALSHI_PRIVATE_KEY;
  if(!key||!pem)return res.status(503).json({error:'BRTI_NOT_CONFIGURED',detail:'Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in Vercel. Kalshi CF Benchmarks entitlement is required.'});
  const path='/trade-api/v2/cfbenchmarks/values';
  const timestamp=String(Date.now());
  try{
    const signature=crypto.sign('sha256',Buffer.from(timestamp+'GET'+path),{key:pem.replace(/\\n/g,'\n'),padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST}).toString('base64');
    const upstream=await fetch('https://external-api.kalshi.com'+path+'?id=BRTI',{headers:{'KALSHI-ACCESS-KEY':key,'KALSHI-ACCESS-SIGNATURE':signature,'KALSHI-ACCESS-TIMESTAMP':timestamp,'Accept':'application/json'},signal:AbortSignal.timeout(10000)});
    const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok)return res.status(upstream.status===401||upstream.status===403?403:502).json({error:'BRTI_UPSTREAM_ERROR',status:upstream.status,detail:upstream.status===403?'Check Kalshi API credentials and CF Benchmarks entitlement.':'Kalshi BRTI upstream request failed.'});
    // The upstream response is left unmodified. Frontend only accepts explicitly timestamped index samples.
    return res.status(200).json({source:'Kalshi CF Benchmarks passthrough',received_at:new Date().toISOString(),data:data.data??data});
  }catch(e){return res.status(502).json({error:'BRTI_REQUEST_FAILED',detail:e.message});}
};
