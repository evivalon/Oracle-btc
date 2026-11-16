// Read-only authenticated CF Benchmarks BRTI passthrough for Vercel.
// NEVER put API credentials into GitHub, the browser bundle, or this file.
// Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in Vercel Project Settings.
const crypto = require('node:crypto');
const PATH = '/trade-api/v2/cfbenchmarks/values';
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  const keyId = (process.env.KALSHI_API_KEY_ID || '').trim();
  const privateKey = (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!keyId || !privateKey) {
    return res.status(503).json({
      error:'BRTI_NOT_CONFIGURED',
      detail:'Missing Kalshi credentials. In Vercel > Project > Settings > Environment Variables, add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY for Production, then redeploy.',
      missing:[...(!keyId?['KALSHI_API_KEY_ID']:[]), ...(!privateKey?['KALSHI_PRIVATE_KEY']:[])]
    });
  }
  let signature;
  const timestamp=String(Date.now());
  try {
    signature=crypto.sign('sha256', Buffer.from(timestamp+'GET'+PATH), {
      key:privateKey,
      padding:crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64');
  } catch (_err) {
    return res.status(503).json({error:'BRTI_INVALID_PRIVATE_KEY',detail:'The Kalshi private key in Vercel is not a usable RSA PEM. Preserve the BEGIN/END lines and line breaks. Do not share it.'});
  }
  try {
    const upstream=await fetch('https://external-api.kalshi.com'+PATH+'?id=BRTI', {
      headers:{
        'KALSHI-ACCESS-KEY':keyId,
        'KALSHI-ACCESS-SIGNATURE':signature,
        'KALSHI-ACCESS-TIMESTAMP':timestamp,
        'Accept':'application/json'
      },
      signal:AbortSignal.timeout(11000)
    });
    const rawText=await upstream.text();
    let payload;try{payload=JSON.parse(rawText);}catch{payload=null;}
    if (!upstream.ok) {
      // Never return upstream authorization headers, request, keys, or unfiltered response.
      const auth=upstream.status===401;
      const access=upstream.status===403;
      const code=auth?'BRTI_AUTH_FAILED':access?'BRTI_ACCESS_DENIED':'BRTI_UPSTREAM_ERROR';
      const detail=auth?'Kalshi rejected the API key or signature. Verify the key ID and private key in Vercel.':access?'Kalshi has not authorized this account to access the CF Benchmarks passthrough. Ask Kalshi about entitlement.':'Kalshi BRTI passthrough returned HTTP '+upstream.status+'.';
      return res.status(auth?401:access?403:502).json({error:code,detail,upstream_status:upstream.status});
    }
    // Kalshi responds with {data:{serverTime,payload:[{time,value},...]}}.
    // Keep the data envelope expected by the existing dashboard.
    const data=payload?.data??payload;
    if (!data || !Array.isArray(data.payload)) {
      return res.status(502).json({error:'BRTI_UNEXPECTED_RESPONSE',detail:'Kalshi responded, but no BRTI samples array was returned.'});
    }
    return res.status(200).json({source:'Kalshi CF Benchmarks passthrough',received_at:new Date().toISOString(),data});
  } catch (err) {
    return res.status(502).json({error:'BRTI_REQUEST_FAILED',detail:err?.name==='TimeoutError'?'Kalshi request timed out.':'Could not reach Kalshi BRTI upstream.'});
  }
};
