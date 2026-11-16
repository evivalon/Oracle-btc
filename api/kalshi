// Vercel Node.js function: public, read-only Kalshi market data proxy.
// Restrict to known endpoints; never forward credentials or arbitrary URLs.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  const ticker = typeof req.query.ticker === 'string' ? req.query.ticker : '';
  const single = Boolean(ticker);
  if (single && !/^KXBTC15M-[A-Za-z0-9-]{1,100}$/.test(ticker)) return res.status(400).json({error:'Invalid market ticker'});
  const path = single ? '/markets/' + encodeURIComponent(ticker) : '/markets?series_ticker=KXBTC15M&status=open&limit=100';
  const url = 'https://api.elections.kalshi.com/trade-api/v2' + path;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let upstream;
    try { upstream = await fetch(url, {signal:controller.signal, headers:{Accept:'application/json', 'User-Agent':'OracleBTC-Research/1.0'}}); }
    finally { clearTimeout(timer); }
    const raw = await upstream.text();
    if (!upstream.ok) return res.status(502).json({error:'Kalshi upstream HTTP '+upstream.status, detail:raw.slice(0,300)});
    let payload;
    try {payload=JSON.parse(raw);} catch {return res.status(502).json({error:'Invalid Kalshi JSON'});}
    return res.status(200).json(payload);
  } catch (err) {return res.status(502).json({error:'Kalshi upstream request failed', detail:String(err.message||err)});}
};
