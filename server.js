import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auction_fee REAL NOT NULL DEFAULT 10,
  discount_market REAL NOT NULL DEFAULT 30,
  card_fee REAL NOT NULL DEFAULT 6,
  freight REAL NOT NULL DEFAULT 0,
  other_costs REAL NOT NULL DEFAULT 0,
  safety_margin REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  raw_list TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  products_json TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(id) VALUES (1);
`);

const getSettings = db.prepare('SELECT * FROM settings WHERE id=1');
const saveSettings = db.prepare(`UPDATE settings SET auction_fee=?, discount_market=?, card_fee=?, freight=?, other_costs=?, safety_margin=? WHERE id=1`);
const insertLot = db.prepare(`INSERT INTO lots(lot_number, created_at, raw_list, settings_json, summary_json, products_json) VALUES(?,?,?,?,?,?)`);

app.get('/api/settings', (req,res)=>res.json(getSettings.get()));
app.put('/api/settings', (req,res)=>{
  const s = normalizeSettings(req.body);
  saveSettings.run(s.auction_fee,s.discount_market,s.card_fee,s.freight,s.other_costs,s.safety_margin);
  res.json(getSettings.get());
});

app.get('/api/lots', (req,res)=>{
  const rows = db.prepare('SELECT id, lot_number, created_at, summary_json FROM lots ORDER BY id DESC').all();
  res.json(rows.map(r=>({...r, summary:JSON.parse(r.summary_json)})));
});
app.get('/api/lots/:id', (req,res)=>{
  const r = db.prepare('SELECT * FROM lots WHERE id=?').get(req.params.id);
  if(!r) return res.status(404).json({error:'Lote não encontrado'});
  res.json({...r, settings:JSON.parse(r.settings_json), summary:JSON.parse(r.summary_json), products:JSON.parse(r.products_json)});
});

app.post('/api/analyze', async (req,res)=>{
  try {
    const raw = String(req.body.rawList || '').trim();
    if(!raw) return res.status(400).json({error:'Cole a lista de produtos primeiro.'});
    const s = normalizeSettings(req.body.settings || getSettings.get());
    const parsed = parseList(raw);
    if(!parsed.length) return res.status(400).json({error:'Não consegui identificar produtos na lista.'});

    const market = await researchMarket(parsed);
    const quantity = parsed.reduce((n,p)=>n+p.quantity,0);
    const lotValue = Number(req.body.lotValue || 0);
    const auctionCost = lotValue * (s.auction_fee/100);
    const totalCost = lotValue + auctionCost + s.freight + s.other_costs;
    const baseCost = quantity ? totalCost/quantity : 0;

    const products = market.map((p,i)=>{
      const source = parsed[i];
      const marketValue = Math.max(0, Number(p.market_value || 0));
      const baseResale = marketValue * (1 - s.discount_market/100);
      const cardPrice = s.card_fee >= 100 ? baseResale : baseResale / (1 - s.card_fee/100);
      const minimum = Math.max(baseCost + s.safety_margin, 0);
      return {...source, ...p, market_value:round(marketValue), base_resale:round(baseResale), card_price:round(cardPrice), minimum_price:round(minimum), base_cost:round(baseCost)};
    });
    const marketTotal = products.reduce((n,p)=>n+(p.market_value*p.quantity),0);
    const resaleTotal = products.reduce((n,p)=>n+(p.card_price*p.quantity),0);
    const profitPotential = resaleTotal-totalCost;
    const summary = {lot_value:lotValue, auction_cost:round(auctionCost), freight:s.freight, other_costs:s.other_costs, total_cost:round(totalCost), quantity, market_total:round(marketTotal), resale_total:round(resaleTotal), profit_potential:round(profitPotential)};
    const next = (db.prepare('SELECT COALESCE(MAX(lot_number),0)+1 n FROM lots').get().n);
    const createdAt = new Date().toISOString();
    const result = insertLot.run(next,createdAt,raw,JSON.stringify(s),JSON.stringify(summary),JSON.stringify(products));
    res.json({id:result.lastInsertRowid, lot_number:next, created_at:createdAt, settings:s, summary, products});
  } catch (e) {
    console.error(e);
    res.status(500).json({error:e.message || 'Falha na análise.'});
  }
});

function normalizeSettings(x={}) {
  const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
  return {auction_fee:num(x.auction_fee,10), discount_market:num(x.discount_market,30), card_fee:num(x.card_fee,6), freight:num(x.freight,0), other_costs:num(x.other_costs,0), safety_margin:num(x.safety_margin,0)};
}
function round(n){return Math.round(n*100)/100}
function parseList(raw){
  return raw.split(/\n+/).map(line=>line.trim()).filter(Boolean).map((line,idx)=>{
    let quantity=1, text=line.replace(/^[-•*]\s*/, '').trim();
    const m=text.match(/^(\d+)\s*(?:x|×|un(?:id(?:ades)?)?\.?)?\s*[-–:]?\s*(.*)$/i);
    if(m){quantity=Number(m[1]); text=m[2].trim();}
    text=text.replace(/^\d+\s*[-–.]\s*/, '').trim();
    return {index:idx+1, quantity, name:text};
  }).filter(p=>p.name);
}

async function researchMarket(products){
  if(!process.env.OPENAI_API_KEY) return products.map(p=>({market_value:0, confidence:'sem chave', note:'Configure OPENAI_API_KEY para ativar a pesquisa automática.', sources:[]}));
  const client = new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const prompt = `Você é um pesquisador de preços para revenda no Brasil. Pesquise na web os produtos abaixo e estime um PREÇO MÉDIO DE MERCADO PARA PRODUTO NOVO, apenas como referência. Priorize o modelo/código exato, capacidade e voltagem quando disponíveis. Ignore anúncios claramente incompatíveis, usados, peças, acessórios isolados e kits que mudem a comparação. Se houver poucos resultados, faça uma estimativa conservadora e marque baixa confiança.\n\nRetorne SOMENTE JSON válido, sem markdown, neste formato: [{"market_value":1234.56,"confidence":"alta|média|baixa","note":"breve explicação","sources":[{"title":"...","url":"https://..."}]}]. A ordem deve ser exatamente a dos produtos enviados.\n\nProdutos:\n${products.map((p,i)=>`${i+1}. ${p.name}`).join('\n')}`;
  const response = await client.responses.create({model:process.env.OPENAI_MODEL || 'gpt-6-luna', tools:[{type:'web_search'}], input:prompt});
  let text=response.output_text?.trim() || '';
  text=text.replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  const start=text.indexOf('['), end=text.lastIndexOf(']');
  if(start>=0 && end>start) text=text.slice(start,end+1);
  let data;
  try{data=JSON.parse(text)}catch{throw new Error('A pesquisa de mercado retornou um formato inválido. Tente novamente.');}
  if(!Array.isArray(data) || data.length!==products.length) throw new Error('A pesquisa não retornou todos os produtos. Tente novamente.');
  return data;
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Leilão Inteligente rodando na porta ${PORT}`);
});
