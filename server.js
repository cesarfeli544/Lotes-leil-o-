import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

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

const getSettings = db.prepare(
  'SELECT * FROM settings WHERE id=1'
);

const saveSettings = db.prepare(`
UPDATE settings
SET auction_fee=?,
    discount_market=?,
    card_fee=?,
    freight=?,
    other_costs=?,
    safety_margin=?
WHERE id=1
`);

const insertLot = db.prepare(`
INSERT INTO lots(
  lot_number,
  created_at,
  raw_list,
  settings_json,
  summary_json,
  products_json
)
VALUES(?,?,?,?,?,?)
`);


// =========================
// CONFIGURAÇÕES
// =========================

app.get('/api/settings', (req, res) => {
  res.json(getSettings.get());
});

app.put('/api/settings', (req, res) => {
  const s = normalizeSettings(req.body);

  saveSettings.run(
    s.auction_fee,
    s.discount_market,
    s.card_fee,
    s.freight,
    s.other_costs,
    s.safety_margin
  );

  res.json(getSettings.get());
});


// =========================
// HISTÓRICO
// =========================

app.get('/api/lots', (req, res) => {
  const rows = db
    .prepare(`
      SELECT id, lot_number, created_at, summary_json
      FROM lots
      ORDER BY id DESC
    `)
    .all();

  res.json(
    rows.map(r => ({
      ...r,
      summary: JSON.parse(r.summary_json)
    }))
  );
});

app.get('/api/lots/:id', (req, res) => {
  const r = db
    .prepare('SELECT * FROM lots WHERE id=?')
    .get(req.params.id);

  if (!r) {
    return res.status(404).json({
      error: 'Lote não encontrado'
    });
  }

  res.json({
    ...r,
    settings: JSON.parse(r.settings_json),
    summary: JSON.parse(r.summary_json),
    products: JSON.parse(r.products_json)
  });
});


// =========================
// ANÁLISE DO LOTE
// =========================

app.post('/api/analyze', async (req, res) => {
  try {
    const raw = String(req.body.rawList || '').trim();

    if (!raw) {
      return res.status(400).json({
        error: 'Cole a lista de produtos primeiro.'
      });
    }

    const s = normalizeSettings(
      req.body.settings || getSettings.get()
    );

    const parsed = parseList(raw);

    if (!parsed.length) {
      return res.status(400).json({
        error: 'Não consegui identificar produtos na lista.'
      });
    }

    // Pesquisa automática
    const market = await researchMarket(parsed);

    const quantity = parsed.reduce(
      (n, p) => n + p.quantity,
      0
    );

    const lotValue = Number(req.body.lotValue || 0);

    const auctionCost =
      lotValue * (s.auction_fee / 100);

    const totalCost =
      lotValue +
      auctionCost +
      s.freight +
      s.other_costs;

    const baseCost =
      quantity
        ? totalCost / quantity
        : 0;

    const products = market.map((p, i) => {
      const source = parsed[i];

      const marketValue = Math.max(
        0,
        Number(p.market_value || 0)
      );

      const baseResale =
        marketValue *
        (1 - s.discount_market / 100);

      const cardPrice =
        s.card_fee >= 100
          ? baseResale
          : baseResale /
            (1 - s.card_fee / 100);

      const minimum =
        Math.max(
          baseCost + s.safety_margin,
          0
        );

      return {
        ...source,
        ...p,

        market_value: round(marketValue),

        base_resale: round(baseResale),

        card_price: round(cardPrice),

        minimum_price: round(minimum),

        base_cost: round(baseCost)
      };
    });

    const marketTotal =
      products.reduce(
        (n, p) =>
          n +
          p.market_value *
          p.quantity,
        0
      );

    const resaleTotal =
      products.reduce(
        (n, p) =>
          n +
          p.card_price *
          p.quantity,
        0
      );

    const profitPotential =
      resaleTotal - totalCost;

    const summary = {
      lot_value: lotValue,
      auction_cost: round(auctionCost),
      freight: s.freight,
      other_costs: s.other_costs,
      total_cost: round(totalCost),
      quantity,
      market_total: round(marketTotal),
      resale_total: round(resaleTotal),
      profit_potential: round(profitPotential)
    };

    const next =
      db
        .prepare(`
          SELECT COALESCE(MAX(lot_number),0)+1 n
          FROM lots
        `)
        .get().n;

    const createdAt =
      new Date().toISOString();

    const result =
      insertLot.run(
        next,
        createdAt,
        raw,
        JSON.stringify(s),
        JSON.stringify(summary),
        JSON.stringify(products)
      );

    res.json({
      id: result.lastInsertRowid,
      lot_number: next,
      created_at: createdAt,
      settings: s,
      summary,
      products
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error:
        e.message ||
        'Falha na análise.'
    });
  }
});


// =========================
// NORMALIZAÇÃO
// =========================

function normalizeSettings(x = {}) {
  const num = (v, d = 0) =>
    Number.isFinite(Number(v))
      ? Number(v)
      : d;

  return {
    auction_fee: num(
      x.auction_fee,
      10
    ),

    discount_market: num(
      x.discount_market,
      30
    ),

    card_fee: num(
      x.card_fee,
      6
    ),

    freight: num(
      x.freight,
      0
    ),

    other_costs: num(
      x.other_costs,
      0
    ),

    safety_margin: num(
      x.safety_margin,
      0
    )
  };
}


function round(n) {
  return Math.round(n * 100) / 100;
}


// =========================
// LEITURA DA LISTA
// =========================

function parseList(raw) {
  return raw
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, idx) => {

      let quantity = 1;

      let text = line
        .replace(/^[-•*]\s*/, '')
        .trim();

      const m = text.match(
        /^(\d+)\s*(?:x|×|un(?:id(?:ades)?)?\.?)?\s*[-–:]?\s*(.*)$/i
      );

      if (m) {
        quantity = Number(m[1]);
        text = m[2].trim();
      }

      text = text
        .replace(/^\d+\s*[-–.]\s*/, '')
        .trim();

      return {
        index: idx + 1,
        quantity,
        name: text
      };
    })
    .filter(p => p.name);
}


// =========================
// PESQUISA AUTOMÁTICA
// MERCADO LIVRE
// =========================

async function researchMarket(products) {

  const results = [];

  for (const product of products) {

    try {

      const result =
        await searchMercadoLivre(
          product.name
        );

      results.push(result);

    } catch (error) {

      console.error(
        'Erro pesquisando:',
        product.name,
        error.message
      );

      results.push({
        market_value: 0,
        confidence: 'baixa',
        note:
          'Não foi possível realizar a pesquisa automática.',
        sources: []
      });
    }
  }

  return results;
}


// =========================
// BUSCA MERCADO LIVRE
// =========================

async function searchMercadoLivre(query) {

  const url =
    'https://api.mercadolibre.com/sites/MLB/search?' +
    new URLSearchParams({
      q: query,
      limit: '50'
    });

  const response =
    await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent':
          'LeilaoInteligente/1.0'
      }
    });

  if (!response.ok) {

    throw new Error(
      `Mercado Livre respondeu HTTP ${response.status}`
    );
  }

const responseText = await response.text();

if (!responseText || !responseText.trim()) {
  throw new Error(
    'O Mercado Livre retornou uma resposta vazia.'
  );
}

let data;

try {
  data = JSON.parse(responseText);
} catch (error) {
  console.error(
    'Resposta recebida do Mercado Livre:',
    responseText.slice(0, 500)
  );

  throw new Error(
    'O Mercado Livre não retornou um JSON válido.'
  );
}

const rawResults =
  Array.isArray(data.results)
    ? data.results
    : [];

  const filtered =
    rawResults
      .filter(item =>
        Number(item.price) > 0
      )
      .filter(item =>
        isLikelyNewProduct(item)
      )
      .filter(item =>
        isRelevantTitle(
          query,
          item.title || ''
        )
      );

  if (!filtered.length) {

    return {
      market_value: 0,
      confidence: 'baixa',
      note:
        'Nenhum anúncio suficientemente semelhante foi encontrado.',
      sources: []
    };
  }

  const prices =
    filtered
      .map(item => Number(item.price))
      .filter(price =>
        Number.isFinite(price) &&
        price > 0
      );

  const cleanPrices =
    removeOutliers(prices);

  const marketValue =
    median(cleanPrices);

  const confidence =
    getConfidence(
      cleanPrices.length
    );

  const sources =
    filtered
      .slice(0, 10)
      .map(item => ({
        title: item.title,
        url: item.permalink,
        price: Number(item.price)
      }));

  return {
    market_value: round(marketValue),

    confidence,

    note:
      `${cleanPrices.length} anúncio(s) considerado(s) na estimativa.`,

    sources
  };
}


// =========================
// FILTRO DE PRODUTO NOVO
// =========================

function isLikelyNewProduct(item) {

  const title =
    String(item.title || '')
      .toLowerCase();

  const badWords = [
    'usado',
    'usada',
    'semi novo',
    'seminovo',
    'semi-novo',
    'defeito',
    'com defeito',
    'quebrado',
    'para conserto',
    'para concerto',
    'sucata',
    'peça',
    'peca',
    'placa',
    'carcaça',
    'carcaca',
    'tela avulsa',
    'display avulso',
    'cabo',
    'carregador',
    'controle remoto',
    'manual',
    'case',
    'capa',
    'suporte',
    'adaptador'
  ];

  if (
    badWords.some(word =>
      title.includes(word)
    )
  ) {
    return false;
  }

  if (
    item.condition &&
    item.condition !== 'new'
  ) {
    return false;
  }

  return true;
}


// =========================
// RELEVÂNCIA DO TÍTULO
// =========================

function isRelevantTitle(
  query,
  title
) {

  const queryWords =
    normalizeText(query)
      .split(/\s+/)
      .filter(word =>
        word.length >= 3
      );

  const titleText =
    normalizeText(title);

  if (!queryWords.length) {
    return true;
  }

  let matches = 0;

  for (const word of queryWords) {

    if (
      titleText.includes(word)
    ) {
      matches++;
    }
  }

  const percentage =
    matches /
    queryWords.length;

  return percentage >= 0.45;
}


// =========================
// NORMALIZA TEXTO
// =========================

function normalizeText(text) {

  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// =========================
// REMOVE PREÇOS FORA DA CURVA
// =========================

function removeOutliers(values) {

  if (values.length < 5) {
    return values;
  }

  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  const start =
    Math.floor(
      sorted.length * 0.10
    );

  const end =
    Math.ceil(
      sorted.length * 0.90
    );

  const trimmed =
    sorted.slice(start, end);

  return trimmed.length
    ? trimmed
    : sorted;
}


// =========================
// MEDIANA
// =========================

function median(values) {

  if (!values.length) {
    return 0;
  }

  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  const middle =
    Math.floor(
      sorted.length / 2
    );

  if (
    sorted.length % 2 === 0
  ) {

    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;

  }

  return sorted[middle];
}


// =========================
// CONFIANÇA
// =========================

function getConfidence(count) {

  if (count >= 8) {
    return 'alta';
  }

  if (count >= 4) {
    return 'média';
  }

  return 'baixa';
}


// =========================
// HEALTH CHECK
// =========================

app.get('/healthz', (req, res) => {

  res.json({
    ok: true,
    service: 'Leilão Inteligente'
  });

});


// =========================
// SERVIDOR
// =========================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Leilão Inteligente rodando na porta ${PORT}`
    );

  }
);
