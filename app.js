"use strict";
// ARB BOT v3 — RichChain (modal WRIC) — versi Node.js headless (cPanel / Passenger)
// Private key dari environment: PRIVATE_KEY. Opsional: DRY_RUN=1, DEBUG=1, GAS_GWEI, RPC.
const http = require("http"), ethers = require("ethers"), { utils, BigNumber } = ethers, env = process.env;
const fs = require("fs"), path = require("path"), LOGF = path.join(__dirname, "bot.log");
const wlog = (...a) => { try { fs.appendFileSync(LOGF, new Date().toISOString() + " " + a.join(" ") + "\n") } catch {} };
// Mode cron: baca PRIVATE_KEY dst. dari file .env di folder ini (di luar public_html) bila belum ada di environment.
try { for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "") } } catch {}
const DEBUG = !!env.DEBUG, log = DEBUG ? wlog : () => {};
const fatal = m => { console.error(m); wlog("FATAL", m); process.exit(1) };
if (DEBUG) { try { fs.writeFileSync(LOGF, "") } catch {} log("start node", process.version, "dry=" + (env.DRY_RUN === "1")) }
process.on("unhandledRejection", e => log("unhandledRejection", e && e.message));
process.on("uncaughtException", e => log("uncaughtException", e && e.message));

const PK_RAW = (env.PRIVATE_KEY || "").trim();
if (!/^(0x)?[0-9a-fA-F]{64}$/.test(PK_RAW)) fatal("PRIVATE_KEY tidak ada / tidak valid (64 hex)");
const PK = PK_RAW.startsWith("0x") ? PK_RAW : "0x" + PK_RAW;

// Passenger (cPanel) butuh app yang listen HTTP; mode cron tidak membuka port. Tidak menampilkan data apa pun.
if (env.PORT || typeof PhusionPassenger !== "undefined") http.createServer((q, s) => s.end("ok")).on("error", () => {}).listen(env.PORT || 3000);

const lc = s => s.toLowerCase();
const C = {
  rpc: env.RPC || "wss://seed-richechain.com:8586/",
  chainId: 132026,
  wrapped: lc("0xEa126036c94Ab6A384A25A70e29E2fE2D4a91e68"),
  multicall: "0xa24707355a47A3D3Befff53A6a66Db0915645897",
  exec: "0x0F6Bcfb465161fD28A1E710fF4e32d0D3B15D6fB",
  execx: "0x585f5B6167cFa8cEe1C8fF3E9d55276190D11201",
  exf: lc("0x360eD4124Cd5a78F793876407c320016f8A0e8BE"),
  dexes: {
    dex1: { factory: "0xaeedf8b9925c6316171f7c2815e387de596fa11b", router: "0x8e9556415124b6c726d5c3610d25c24be8ac2304" },
    dex3: { factory: "0x6ed514bc91cbd202c21bbc494d05c49fce4babef", router: "0x2125ea3c076298f13ca95e807607ae7a1369e1a8" }
  },
  gwei: +env.GAS_GWEI > 0 ? +env.GAS_GWEI : 0, // 0 = auto (eth_gasPrice asli jaringan)
  maxHops: 3, minLiq: 1000000000000000n, minNet: 0n, maxTax: 5000, resync: 20000,
  exMax: 12, maxRoutes: 400000, maxTx: 4, lockMs: 4000, probeTtl: 600000, badTtl: 600000, txWait: 30000,
  dry: env.DRY_RUN === "1"
};

const TEN4 = 10000n, TAXD = 100000000n, ZERO = "0x" + "0".repeat(40), MINTRADE = 1000000000n;
const SYNC = utils.id("Sync(uint112,uint112)"), PAIRC = utils.id("PairCreated(address,address,address,uint256)");
const FEES = [9970, 9975, 9980, 9985, 9990, 9950, 9900, 9800, 9700, 10000];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const FACT = ["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"];
const PAIR = ["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"];
const ROUTER = ["function getAmountsOut(uint256,address[]) view returns (uint256[])"];
const MC = ["function tryAggregate(bool,tuple(address target,bytes callData)[]) view returns (tuple(bool success,bytes returnData)[])", "function aggregate(tuple(address target,bytes callData)[]) view returns (uint256,bytes[])"];
const HOP = "tuple(address pair,address tokenOut,uint32 fee,bool hold)[]";
const EXEC = ["function owner() view returns (address)", "function run(" + HOP + " hops,uint256 amountIn,uint256 minProfit)", "function probeRoute(" + HOP + " hops,uint256 amountIn) returns (uint256[] rec,uint256 before,uint256 afterBal)", "function probeToken(address pair,address token,uint256 amountIn,uint32 fee) returns (uint256 expectedOut,uint256 gotOut,uint256 pairGot)", "event Arb(uint256 amountIn,uint256 profit)"];
const HOPX = "tuple(address pair,address tokenOut,uint32 fee,bool hold,uint8 kind,uint256[] ids,uint256 limit)[]";
const EXF = ["function count() view returns (uint256)", "function list(uint256 offset,uint256 limit) view returns (tuple(address market,address base,address quote,uint8 status,uint256 createdBlock,string meta)[])"];
const MKT = ["function config() view returns (address,address,uint8,uint8,uint256,uint256,uint256,bool,address)", "function SCALE() view returns (uint256)", "function getActive(uint256 offset,uint256 limit) view returns (uint256[] ids, tuple(address maker,bool isBuy,bool active,uint256 price,uint256 remaining,uint256 escrow)[] list)"];
const EXECX = ["function owner() view returns (address)", "function run(" + HOPX + " hops,uint256 amountIn,uint256 minProfit)", "function probeRoute(" + HOPX + " hops,uint256 amountIn) returns (uint256[] rec,uint256 before,uint256 afterBal)", "event Arb(uint256 amountIn,uint256 profit)"];
const EX_TOPICS = ["Trade(uint256,address,address,bool,uint256,uint256,uint256,uint256)", "OrderPlaced(uint256,address,bool,uint256,uint256)", "OrderCancelled(uint256)", "OrderClosed(uint256)"].map(x => utils.id(x));
const execXI = new utils.Interface(EXECX), execI = new utils.Interface(EXEC), pairI = new utils.Interface(PAIR), factI = new utils.Interface(FACT);
const bn = x => BigNumber.from(x.toString()), big = x => BigInt(x.toString()), fw = x => utils.formatUnits(x.toString(), 18);
const word = (h, i) => "0x" + h.slice(2 + i * 64, 2 + (i + 1) * 64), addrOf = (h, i) => "0x" + h.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
const sleep = ms => new Promise(r => setTimeout(r, ms)), wt = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error("timeout")), ms))]);
function isqrt(n) { if (n < 2n) return n; let x = 1n << BigInt((n.toString(2).length + 1) >> 1); for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y } }

for (const d in C.dexes) { C.dexes[d].factory = lc(C.dexes[d].factory); C.dexes[d].router = lc(C.dexes[d].router) }

// ---------- state
let provider, wallet, account, multicall, executor, executorX, wricC, sessionNo = 0, closeResolve = null;
let ready = false, nonce = 0, wricBal = 0n, inflight = 0n, lastBlock = 0, mcMode = null, routes = [], routesByPair = new Map(), scanSched = false, rebuildT = null;
const pairs = new Map(), tokenPairs = new Map(), tokens = new Map(), dexFee = {}, factoryCount = {}, locks = new Map(), dirty = new Set(), probing = new Map(), timers = [], exMarkets = new Map(), penal = new Map();
const gasModel = { base: 60000, perHop: 60000, perHold: 30000, exBase: 90000, perFill: 260000, perWrap: 45000 };

// Gas = harga asli jaringan (eth_gasPrice), tanpa tip/buffer; dijaga tidak di bawah baseFee blok terakhir.
let liveGp = 0n, liveGpAt = 0;
const gasPriceWei = () => C.gwei > 0 ? BigInt(Math.round(C.gwei * 1e9)) : liveGp;
async function refreshGas(force) {
  if (C.gwei > 0) return; const now = Date.now(); if (!force && now - liveGpAt < 2000) return; liveGpAt = now;
  let g = big(await wt(provider.getGasPrice(), 4000));
  try { const b = await wt(provider.getBlock("latest"), 4000); if (b && b.baseFeePerGas) { const bf = big(b.baseFeePerGas); if (bf > g) g = bf } } catch {}
  if (g > 0n) liveGp = g; else if (liveGp === 0n) throw new Error("Executor: eth_gasPrice RPC bernilai 0 — set env GAS_GWEI");
}

const rkey = r => r.pairAddrs.join();
function penalize(r) { const k = rkey(r), p = Math.min((penal.get(k) ? penal.get(k).n : 0) + 1, 6); penal.set(k, { n: p, until: Date.now() + Math.min(1000 * 2 ** p, 60000) }) }
const reward = r => penal.delete(rkey(r));
const cooling = r => { const p = penal.get(rkey(r)); return !!p && p.until > Date.now() };

function tok(a) { let t = tokens.get(a); if (!t) { t = { buy: 0, sell: 0, probedAt: 0, bad: false, badUntil: 0 }; tokens.set(a, t) } return t }
function isBad(a) { const t = tokens.get(a); if (!t || !t.bad) return false; if (Date.now() > t.badUntil) { t.bad = false; return false } return true }
const isTaxed = t => !!t && t.buy + t.sell > 0;

// ---------- multicall
const single = part => Promise.all(part.map(async c => { try { return { ok: true, data: await provider.call({ to: c.target, data: c.callData }) } } catch { return { ok: false, data: "0x" } } }));
async function mcallChunk(part) {
  if (mcMode === null && (await provider.getCode(C.multicall)) === "0x") mcMode = "single";
  if (mcMode === "single") return single(part);
  if (mcMode !== "agg") { try { const r = await multicall.callStatic.tryAggregate(false, part); mcMode = "try"; return r.map(x => ({ ok: x.success, data: x.returnData })) } catch (e) { if (mcMode === "try") throw e } }
  try { const r = await multicall.callStatic.aggregate(part); mcMode = "agg"; return r[1].map(d => ({ ok: true, data: d })) } catch {}
  return single(part);
}
async function mcall(calls, ch = 300) { const o = []; for (let i = 0; i < calls.length; i += ch) o.push(...await mcallChunk(calls.slice(i, i + ch))); return o }

// ---------- load pairs
function addPair(dex, a, t0, t1, r0, r1, blk) {
  a = lc(a); t0 = lc(t0); t1 = lc(t1); if (pairs.has(a) || t0 === ZERO || t1 === ZERO) return false;
  const p = { addr: a, dex, t0, t1, r0, r1, blk, li: Number.MAX_SAFE_INTEGER }; pairs.set(a, p);
  for (const t of [t0, t1]) { if (!tokenPairs.has(t)) tokenPairs.set(t, []); tokenPairs.get(t).push(p); tok(t) } return true;
}
async function loadFactory(dex) {
  try {
    const fa = C.dexes[dex].factory, f = new ethers.Contract(fa, FACT, provider), total = (await f.allPairsLength()).toNumber(), from = factoryCount[dex] || 0; if (total <= from) return 0;
    const blk = await provider.getBlockNumber(); let added = 0;
    for (let s = from; s < total; s += 300) {
      const e = Math.min(total, s + 300), calls = []; for (let i = s; i < e; i++) calls.push({ target: fa, callData: factI.encodeFunctionData("allPairs", [i]) });
      const res = await mcall(calls), todo = res.filter(r => r.ok && r.data.length >= 66).map(r => addrOf(r.data, 0)).filter(a => !pairs.has(lc(a))); if (!todo.length) continue;
      const c2 = []; for (const a of todo) for (const fn of ["token0", "token1", "getReserves"]) c2.push({ target: a, callData: pairI.encodeFunctionData(fn) });
      const r2 = await mcall(c2);
      for (let i = 0; i < todo.length; i++) {
        const a = r2[i * 3], b = r2[i * 3 + 1], c = r2[i * 3 + 2]; if (!a.ok || !b.ok || !c.ok || c.data.length < 130) continue;
        if (addPair(dex, todo[i], addrOf(a.data, 0), addrOf(b.data, 0), BigInt(word(c.data, 0)), BigInt(word(c.data, 1)), blk)) added++;
      }
    }
    factoryCount[dex] = total; return added;
  } catch (e) { log("loadFactory gagal", dex, String(e.message).slice(0, 60)); return 0 }
}
async function syncReserves(list) {
  list = (list ? list.map(a => pairs.get(a)).filter(Boolean) : [...pairs.values()]).filter(p => !p.ex); if (!list.length) return;
  const blk = await provider.getBlockNumber(), res = await mcall(list.map(p => ({ target: p.addr, callData: pairI.encodeFunctionData("getReserves") })), 400);
  for (let i = 0; i < list.length; i++) {
    const r = res[i], p = list[i]; if (!r.ok || r.data.length < 130 || p.blk > blk) continue; const r0 = BigInt(word(r.data, 0)), r1 = BigInt(word(r.data, 1));
    if (r0 !== p.r0 || r1 !== p.r1) { p.r0 = r0; p.r1 = r1; dirty.add(p.addr) } p.blk = blk; p.li = Number.MAX_SAFE_INTEGER;
  }
}
async function calibrateFees() {
  for (const dex of Object.keys(C.dexes)) {
    dexFee[dex] = 9970; const rtr = new ethers.Contract(C.dexes[dex].router, ROUTER, provider);
    const ps = [...pairs.values()].filter(p => p.dex === dex && p.r0 > 0n && p.r1 > 0n).sort((a, b) => { const ma = a.r0 < a.r1 ? a.r0 : a.r1, mb = b.r0 < b.r1 ? b.r0 : b.r1; return mb > ma ? 1 : mb < ma ? -1 : 0 }).slice(0, 5); let found = false;
    for (const p of ps) {
      try {
        const bnum = await provider.getBlockNumber(), pc = new ethers.Contract(p.addr, PAIR, provider), sample = p.r0 / 1000n > 0n ? p.r0 / 1000n : 1n;
        const [rs, out] = await Promise.all([pc.getReserves({ blockTag: bnum }), rtr.getAmountsOut(bn(sample), [p.t0, p.t1], { blockTag: bnum })]); const r0 = big(rs[0]), r1 = big(rs[1]), o = big(out[1]);
        for (const f of FEES) { const F = BigInt(f); if ((sample * F * r1) / (r0 * TEN4 + sample * F) === o) { dexFee[dex] = f; found = true; break } } if (found) break;
      } catch {}
    }
  }
}

// ---------- routes
function buildRoutes() {
  const W = C.wrapped, adj = new Map(), hasW = new Set();
  for (const p of pairs.values()) {
    if (p.r0 === 0n || p.r1 === 0n) continue; if (p.t0 === W || p.t1 === W) { const wr = p.t0 === W ? p.r0 : p.r1; if (wr < C.minLiq) continue; hasW.add(p.t0 === W ? p.t1 : p.t0) }
    for (const t of [p.t0, p.t1]) { if (!adj.has(t)) adj.set(t, []); adj.get(t).push(p) }
  }
  const out = [], used = new Set(), visited = new Set([W]), path = []; let capped = false;
  const dfs = token => {
    if (capped) return;
    for (const p of adj.get(token) || []) {
      if (used.has(p.addr)) continue; const next = p.t0 === token ? p.t1 : p.t0, hop = { pair: p.addr, tokenIn: token, tokenOut: next, dex: p.dex, ex: !!p.ex, side: p.ex ? (token === p.t1 ? "buy" : "sell") : null };
      if (next === W) { if (path.length >= 1) { const hops = [...path, hop]; out.push({ hops, pairAddrs: hops.map(h => h.pair), hasEx: hops.some(x => x.ex) }); if (out.length >= C.maxRoutes) { capped = true; return } } continue }
      if (visited.has(next) || !hasW.has(next) || isBad(next) || path.length + 1 >= C.maxHops) continue;
      used.add(p.addr); visited.add(next); path.push(hop); dfs(next); path.pop(); visited.delete(next); used.delete(p.addr);
    }
  };
  dfs(W); routes = out; routesByPair = new Map(); for (const r of routes) for (const a of r.pairAddrs) { let l = routesByPair.get(a); if (!l) routesByPair.set(a, l = []); l.push(r) }
}
function scheduleRebuild() { if (rebuildT) return; rebuildT = setTimeout(() => { rebuildT = null; try { buildRoutes(); for (const p of pairs.keys()) dirty.add(p); scheduleScan() } catch (e) { log("rebuild:", e.message) } }, 200) }

// ---------- math (BigInt eksak)
const rf = (p, t) => t === p.t0 ? [p.r0, p.r1] : [p.r1, p.r0];
function quote(route, x) {
  const hops = route.hops, n = hops.length;
  for (let i = 0; i < n; i++) {
    const h = hops[i], p = pairs.get(h.pair), [ri, ro] = rf(p, h.tokenIn); if (ri === 0n || ro === 0n) return 0n;
    const inF = x * BigInt(dexFee[h.dex]); x = (inF * ro) / (ri * TEN4 + inF); if (x === 0n) return 0n;
    if (i < n - 1) { const t = tokens.get(h.tokenOut); if (isTaxed(t)) { x = x * BigInt(10000 - t.buy) / TEN4; x = x * BigInt(10000 - t.sell) / TEN4 } }
  }
  return x;
}
function holdsOf(route) { let h = 0; for (let i = 0; i < route.hops.length - 1; i++) if (isTaxed(tokens.get(route.hops[i].tokenOut))) h++; return h }
function analyze(route, maxIn) {
  const hops = route.hops, n = hops.length; let A = 1n, Cc = 0n, D = 1n;
  for (let i = 0; i < n; i++) {
    const h = hops[i], p = pairs.get(h.pair), [ri, ro] = rf(p, h.tokenIn); if (ri === 0n || ro === 0n) return null; const fee = BigInt(dexFee[h.dex]); let a2 = fee * ro, c2 = fee, d2 = ri * TEN4;
    if (i < n - 1) { const t = tokens.get(h.tokenOut); if (isTaxed(t)) { a2 *= BigInt(10000 - t.buy) * BigInt(10000 - t.sell); c2 *= TAXD; d2 *= TAXD } }
    const nA = A * a2, nC = c2 * A + d2 * Cc, nD = d2 * D; A = nA; Cc = nC; D = nD;
  }
  if (A <= D) return null; let x = (isqrt(A * D) - D) / Cc; if (x > maxIn) x = maxIn; if (x < MINTRADE) return null;
  const out = quote(route, x), gross = out - x, holds = holdsOf(route), gu = gasModel.base + gasModel.perHop * n + gasModel.perHold * holds, gp = gasPriceWei(), cost = BigInt(gu) * gp;
  return { route, amountIn: x, out, gross, net: gross - cost - C.minNet, gasUnits: gu, gasPrice: gp, gasCost: cost, v2: n, holds };
}

// ---------- EXCHANGE RecehMarket (order book)
const NEG = -(1n << 200n), routeTok = a => a === ZERO ? C.wrapped : lc(a);
function addExPair(m) { if (pairs.has(m.addr)) return; const p = { addr: m.addr, dex: "ex", ex: true, t0: m.bT, t1: m.qT, r0: 0n, r1: 0n, blk: 0, li: Number.MAX_SAFE_INTEGER }; pairs.set(m.addr, p); for (const t of [m.bT, m.qT]) { if (!tokenPairs.has(t)) tokenPairs.set(t, []); tokenPairs.get(t).push(p); tok(t) } }
async function loadExchange() {
  const f = new ethers.Contract(C.exf, EXF, provider), total = (await f.count()).toNumber(), infos = []; for (let o = 0; o < total; o += 50) infos.push(...await f.list(o, Math.min(50, total - o)));
  await Promise.all(infos.map(async inf => {
    const addr = lc(inf.market), status = Number(inf.status); let m = exMarkets.get(addr);
    if (!m) {
      if (status !== 0) return;
      try {
        const c = new ethers.Contract(addr, MKT, provider), [cfg, scale] = await Promise.all([c.config(), c.SCALE()]), bRaw = lc(cfg[0]), qRaw = lc(cfg[1]), bT = routeTok(bRaw), qT = routeTok(qRaw); if (bT === qT) return;
        m = { addr, status, bT, qT, bNative: bRaw === ZERO, qNative: qRaw === ZERO, scale: big(scale), minBase: 0n, minQuote: 0n, feeBps: 0n, paused: false, asks: [], bids: [], depthW: 0n, refreshing: false, again: false, sub: -1 }; exMarkets.set(addr, m); addExPair(m);
      } catch (e) { log("exchange gagal memuat", addr, String(e.message).slice(0, 60)); return }
    }
    m.contract = new ethers.Contract(addr, MKT, provider); m.status = status; await refreshMarket(m, true); if (ready) subscribeMarket(m);
  }));
}
async function refreshMarket(m, withCfg) {
  if (m.refreshing) { m.again = true; return } m.refreshing = true;
  try {
    do {
      m.again = false; if (withCfg || !m.cfgAt || Date.now() - m.cfgAt > 10000) { const c = await m.contract.config(); m.feeBps = big(c[4]); m.minBase = big(c[5]); m.minQuote = big(c[6]); m.paused = !!c[7]; m.cfgAt = Date.now() }
      const asks = [], bids = []; for (let off = 0; ; off += 500) { const r = await m.contract.getActive(off, 500); r[0].forEach((id, i) => { const o = r[1][i]; (o.isBuy ? bids : asks).push({ id: big(id), price: big(o.price), remaining: big(o.remaining), escrow: big(o.escrow) }) }); if (r[0].length < 500) break }
      asks.sort((x, y) => x.price === y.price ? (x.id < y.id ? -1 : 1) : x.price < y.price ? -1 : 1); bids.sort((x, y) => x.price === y.price ? (x.id < y.id ? -1 : 1) : x.price > y.price ? -1 : 1); m.asks = asks; m.bids = bids;
      let d = 0n; if (m.qNative) { for (const o of asks) d += (o.remaining * o.price + m.scale - 1n) / m.scale; for (const o of bids) d += o.escrow } else if (m.bNative) { for (const o of asks) d += o.remaining; for (const o of bids) d += o.remaining } else d = asks.length + bids.length > 0 ? 1n : 0n;
      const was = m.depthW; m.depthW = d; const p = pairs.get(m.addr), usable = m.status === 0 && !m.paused; p.r0 = p.r1 = usable ? d : 0n; if ((was === 0n) !== (d === 0n) || (m.wasUsable !== undefined && m.wasUsable !== usable)) scheduleRebuild(); m.wasUsable = usable;
    } while (m.again);
  } catch (e) { log("refresh market", m.addr.slice(0, 10), String(e.message).slice(0, 70)) } finally { m.refreshing = false } dirty.add(m.addr); scheduleScan();
}
function subscribeMarket(m) { if (m.sub === sessionNo) return; m.sub = sessionNo; provider.on({ address: m.addr, topics: [EX_TOPICS] }, () => { const lk = locks.get(m.addr); if (lk && lastBlock > lk.blk) locks.delete(m.addr); refreshMarket(m, false).catch(() => {}) }) }
function exWalkBuy(m, budget) {
  const res = { out: 0n, used: 0n, ids: [], limit: 0n, fills: 0 }; if (m.paused || m.status !== 0 || budget <= 0n) return res; let left = budget;
  for (const o of m.asks) {
    if (left <= 0n || res.ids.length >= C.exMax) break; let amt = o.remaining, cost = (amt * o.price + m.scale - 1n) / m.scale;
    if (cost > left) { amt = left * m.scale / o.price; if (amt < m.minBase) break; cost = (amt * o.price + m.scale - 1n) / m.scale; if (cost < m.minQuote) break }
    if (amt === 0n) break; left -= cost; res.out += amt - amt * m.feeBps / TEN4; res.ids.push(o.id); res.limit = o.price;
  }
  res.used = budget - left; res.fills = res.ids.length; return res;
}
function exWalkSell(m, amountIn) {
  const res = { out: 0n, used: 0n, ids: [], limit: 0n, fills: 0 }; if (m.paused || m.status !== 0 || amountIn <= 0n) return res; let left = amountIn;
  for (const o of m.bids) {
    if (left <= 0n || res.ids.length >= C.exMax) break; const amt = left < o.remaining ? left : o.remaining; if (amt === 0n) break;
    if (amt < o.remaining) { if (amt < m.minBase) break; if (amt * o.price / m.scale < m.minQuote) break }
    const q = amt * o.price / m.scale; if (q === 0n || q > o.escrow) continue; left -= amt; res.out += q - q * m.feeBps / TEN4; res.ids.push(o.id); res.limit = o.price;
  }
  res.used = amountIn - left; res.fills = res.ids.length; return res;
}
function quoteX(route, x, plan) {
  const hops = route.hops, n = hops.length, info = { out: 0n, fills: 0, v2: 0, wraps: 0, holds: 0 };
  for (let i = 0; i < n; i++) {
    const h = hops[i];
    if (h.ex) {
      const m = exMarkets.get(h.pair); if (!m) return info; const r = h.side === "buy" ? exWalkBuy(m, x) : exWalkSell(m, x); if (r.out === 0n) return info; info.fills += r.fills;
      info.wraps += h.side === "buy" ? (m.qNative ? 2 : 0) + (m.bNative ? 1 : 0) : (m.bNative ? 2 : 0) + (m.qNative ? 1 : 0); if (plan) plan[i] = { ids: r.ids, limit: r.limit }; x = r.out;
    } else {
      const p = pairs.get(h.pair), [ri, ro] = rf(p, h.tokenIn); if (ri === 0n || ro === 0n) return info; const inF = x * BigInt(dexFee[h.dex]); x = inF * ro / (ri * TEN4 + inF); if (x === 0n) return info; info.v2++;
      if (i < n - 1) { const t = tokens.get(h.tokenOut); if (isTaxed(t)) { x = x * BigInt(10000 - t.buy) / TEN4; x = x * BigInt(10000 - t.sell) / TEN4; info.holds++ } }
    }
  }
  info.out = x; return info;
}
const gasUnitsX = i => gasModel.exBase + gasModel.perHop * i.v2 + gasModel.perFill * i.fills + gasModel.perWrap * i.wraps + gasModel.perHold * i.holds;
// rute campuran: profit cekung -> grid geometris + ternary search
function analyzeX(route, maxIn) {
  if (maxIn < MINTRADE) return null; const gp = gasPriceWei(), K = 40, lo = maxIn / 1000000n > MINTRADE ? maxIn / 1000000n : MINTRADE, ratio = Math.pow(Number(maxIn / lo), 1 / (K - 1)), grid = [];
  for (let i = 0; i < K; i++) { let v = i === K - 1 ? maxIn : BigInt(Math.floor(Number(lo) * Math.pow(ratio, i))); if (grid.length && v <= grid[grid.length - 1]) v = grid[grid.length - 1] + 1n; if (v > maxIn) v = maxIn; if (!grid.length || v > grid[grid.length - 1]) grid.push(v) }
  const memo = new Map(), val = x => { const k = x.toString(); if (memo.has(k)) return memo.get(k); const q = quoteX(route, x); let r; if (q.out === 0n) r = { net: NEG, gross: NEG, q }; else { const g = q.out - x; r = { net: g - BigInt(gasUnitsX(q)) * gp - C.minNet, gross: g, q } } memo.set(k, r); return r };
  let a = 0, b = grid.length - 1; if (val(grid[b]).q.out === 0n) return null; while (a < b) { const mid = (a + b) >> 1; if (val(grid[mid]).q.out > 0n) b = mid; else a = mid + 1 } const first = a;
  if (val(grid[first]).gross <= 0n && val(grid[grid.length - 1]).gross <= 0n) return null;
  let best = first; for (let i = first; i < grid.length; i++) if (val(grid[i]).net > val(grid[best]).net) best = i;
  let l = grid[Math.max(first, best - 1)], h = grid[Math.min(grid.length - 1, best + 1)], bx = grid[best], bv = val(bx).net;
  for (let it = 0; it < 70 && h - l > 2n; it++) { const m1 = l + (h - l) / 3n, m2 = h - (h - l) / 3n, v1 = val(m1).net, v2 = val(m2).net; if (v1 > bv) { bv = v1; bx = m1 } if (v2 > bv) { bv = v2; bx = m2 } if (v1 > v2) h = m2; else l = m1 }
  for (let d = -2n; d <= 2n; d++) { const x = bx + d; if (x >= grid[first] && x <= maxIn) { const v = val(x).net; if (v > bv) { bv = v; bx = x } } }
  const plan = [], q = quoteX(route, bx, plan); if (q.out === 0n) return null; const gross = q.out - bx, gu = gasUnitsX(q), cost = BigInt(gu) * gp;
  return { route, amountIn: bx, out: q.out, gross, net: gross - cost - C.minNet, gasUnits: gu, gasPrice: gp, gasCost: cost, plan, exInfo: q };
}
const analyzeAny = (r, m) => r.hasEx ? analyzeX(r, m) : analyze(r, m);
const buildHops = r => r.hops.map((h, i) => ({ pair: h.pair, tokenOut: h.tokenOut, fee: dexFee[h.dex], hold: i < r.hops.length - 1 && isTaxed(tokens.get(h.tokenOut)) }));
const buildHopsX = (route, plan) => route.hops.map((h, i) => h.ex ? { pair: h.pair, tokenOut: h.tokenOut, fee: 0, hold: false, kind: h.side === "buy" ? 1 : 2, ids: plan[i].ids.map(x => x.toString()), limit: plan[i].limit.toString() } : { pair: h.pair, tokenOut: h.tokenOut, fee: dexFee[h.dex], hold: i < route.hops.length - 1 && isTaxed(tokens.get(h.tokenOut)), kind: 0, ids: [], limit: "0" });
const canProbe = t => (tokenPairs.get(t) || []).some(p => !p.ex && (p.t0 === C.wrapped || p.t1 === C.wrapped));
// model gas belajar dari data nyata (estimateGas & receipt)
function learn(used, c) {
  const u = Number(used);
  if (c.exInfo) { const i = c.exInfo; if (i.fills < 1) return; const obs = (u - gasModel.exBase - gasModel.perHop * i.v2 - gasModel.perWrap * i.wraps - gasModel.perHold * i.holds) / i.fills; if (obs > 60000 && obs < 700000) gasModel.perFill = Math.round(gasModel.perFill * .7 + obs * .3) }
  else { const obs = (u - gasModel.base - gasModel.perHold * c.holds) / c.v2; if (obs > 30000 && obs < 400000) gasModel.perHop = Math.round(gasModel.perHop * .7 + obs * .3) }
}

// ---------- scan & dispatch
const locked = r => { const t = Date.now(); for (const a of r.pairAddrs) { const l = locks.get(a); if (l) { if (t < l.until) return true; locks.delete(a) } } return false };
const routeBad = r => { for (let i = 0; i < r.hops.length - 1; i++) if (isBad(r.hops[i].tokenOut)) return true; for (const h of r.hops) if (h.ex && (isTaxed(tokens.get(h.tokenIn)) || isTaxed(tokens.get(h.tokenOut)))) return true; return false };
const lock = l => l.forEach(a => locks.set(a, { blk: lastBlock, until: Date.now() + C.lockMs })), unlock = l => l.forEach(a => locks.delete(a));
function scheduleScan() { if (scanSched) return; scanSched = true; setTimeout(runScan, 0) }
function runScan() {
  scanSched = false; if (!ready) { dirty.clear(); return }
  const avail = wricBal - inflight, set = new Set(); for (const a of dirty) { const l = routesByPair.get(a); if (l) for (const r of l) set.add(r) } dirty.clear(); if (!set.size || avail < MINTRADE) return;
  const cands = []; for (const r of set) { if (routeBad(r) || locked(r) || cooling(r)) continue; const a = analyzeAny(r, avail); if (a && a.net > 0n) cands.push(a) }
  cands.sort((x, y) => y.net > x.net ? 1 : y.net < x.net ? -1 : 0); if (cands.length) dispatch(cands);
}
// Modal dicadangkan per tx (inflight) supaya tx paralel tidak memakai saldo yang sama.
function dispatch(cands) {
  const used = new Set(); let sent = 0;
  for (let c of cands) {
    if (sent >= C.maxTx) break; if (c.route.pairAddrs.some(a => used.has(a))) continue;
    const avail = wricBal - inflight; if (avail < MINTRADE) break;
    if (c.amountIn > avail) { c = analyzeAny(c.route, avail); if (!c || c.net <= 0n) continue }
    c.route.pairAddrs.forEach(a => used.add(a)); sent++; lock(c.route.pairAddrs);
    const rsv = c.amountIn; inflight += rsv;
    handle(c, rsv).catch(e => { unlock(c.route.pairAddrs); log("handle:", e.message) }).finally(() => { inflight -= rsv });
  }
}

// ---------- probe pajak
function needsProbe(route) { const t = Date.now(); for (let i = 0; i < route.hops.length - 1; i++) { if (!canProbe(route.hops[i].tokenOut)) continue; const k = tokens.get(route.hops[i].tokenOut); if (!k || !k.probedAt || t - k.probedAt > C.probeTtl) return true } return false }
const ensureProbed = r => Promise.all(r.hops.slice(0, -1).map(h => probeTax(h.tokenOut)));
function probeTax(token) {
  const t = tok(token); if (t.probedAt && Date.now() - t.probedAt < C.probeTtl) return Promise.resolve(); if (probing.has(token)) return probing.get(token);
  const pr = (async () => {
    const W = C.wrapped; let best = null, bR = 0n; for (const p of tokenPairs.get(token) || []) { if (p.ex || (p.t0 !== W && p.t1 !== W)) continue; const wr = p.t0 === W ? p.r0 : p.r1; if (wr > bR) { bR = wr; best = p } }
    if (!best || wricBal <= 0n) return; let amt = bR / 500n; if (amt > wricBal) amt = wricBal; if (amt < 1000n) return;
    try {
      const r = await executor.callStatic.probeToken(best.addr, token, bn(amt), dexFee[best.dex], { from: account }), exp = big(r.expectedOut), got = big(r.gotOut), pg = big(r.pairGot); if (exp === 0n || got === 0n) throw new Error("revert zero");
      t.buy = exp > got ? Number(((exp - got) * TEN4 + exp / 2n) / exp) : 0; t.sell = got > pg ? Number(((got - pg) * TEN4 + got / 2n) / got) : 0; t.probedAt = Date.now(); t.bad = false;
      if (t.buy + t.sell > C.maxTax) { t.bad = true; t.badUntil = Date.now() + C.badTtl }
    } catch (e) {
      const m = String(e.message || e), reason = e.reason || (e.error && e.error.reason) || ""; if (reason === "TF") return;
      if (/revert|CALL_EXCEPTION|execution/i.test(m)) { t.bad = true; t.badUntil = Date.now() + C.badTtl; t.probedAt = Date.now() }
    }
  })().finally(() => probing.delete(token));
  probing.set(token, pr); return pr;
}
async function probeAll() {
  const list = [...tokens.keys()].filter(a => a !== C.wrapped && canProbe(a)); let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => { while (ready && i < list.length) await probeTax(list[i++]) }));
}

// ---------- eksekusi
async function handle(c, rsv) {
  const pa = c.route.pairAddrs;
  if (needsProbe(c.route)) { await ensureProbed(c.route); const a2 = analyzeAny(c.route, rsv); if (!a2 || a2.net <= 0n || routeBad(c.route)) { unlock(pa); return } c = a2 }
  if (C.dry) {
    try {
      const r = c.route.hasEx ? await executorX.callStatic.probeRoute(buildHopsX(c.route, c.plan), bn(c.amountIn), { from: account }) : await executor.callStatic.probeRoute(buildHops(c.route), bn(c.amountIn), { from: account });
      log("[DRY] prediksi", fw(c.gross), "on-chain", fw(big(r.afterBal) - big(r.before)), "net", fw(c.net));
    } catch (e) { log("[DRY] simulasi gagal", String(e.message).slice(0, 90)) }
    unlock(pa); return;
  }
  await sendArb(c);
}
// Pengiriman diserialkan: nonce dialokasikan & tx dikirim berurutan, resync bila gagal (tidak ada gap nonce).
let sendQ = Promise.resolve();
const serial = fn => { const p = sendQ.then(fn); sendQ = p.catch(() => {}); return p };
const resyncNonce = async () => { try { nonce = await provider.getTransactionCount(account, "pending") } catch {} };
const refreshBal = async () => { try { wricBal = big(await wricC.balanceOf(account)) } catch {} };
function broadcast(to, data, gasLimit, gasPrice) {
  return serial(async () => {
    for (let at = 0; at < 2; at++) {
      const n = nonce++;
      try { const raw = await wallet.signTransaction({ to, data, value: 0, gasLimit, gasPrice: bn(gasPrice), nonce: n, chainId: C.chainId }); return { hash: await provider.send("eth_sendRawTransaction", [raw]), n } }
      catch (e) { const m = String(e.message || e); await resyncNonce(); if (!/nonce/i.test(m) || /already known/i.test(m)) throw e }
    }
    throw new Error("send gagal");
  });
}
async function sendArb(c) {
  const pa = c.route.pairAddrs, useX = !!c.route.hasEx, to = useX ? C.execx : C.exec, I = useX ? execXI : execI, amt = bn(c.amountIn),
    hopsArg = useX ? buildHopsX(c.route, c.plan) : buildHops(c.route), enc = mp => I.encodeFunctionData("run", [hopsArg, amt, bn(mp)]);
  // Simulasi on-chain dengan minProfit = biaya gas prediksi: kontrak sendiri menolak bila profit nyata < biaya gas.
  let est;
  try { est = big(await wt(provider.estimateGas({ from: account, to, data: enc(c.gasCost > 1n ? c.gasCost : 1n) }), 5000)) }
  catch { penalize(c.route); unlock(pa); return }
  learn(est, c);
  try { await refreshGas() } catch {}
  const gp = gasPriceWei();
  if (c.gross - est * gp - C.minNet <= 0n) { unlock(pa); return } // gas nyata (estimateGas x harga gas terkini) >= profit
  let sent;
  // Gas limit hanya batas atas: yang ditagih tetap gas terpakai. Headroom mencegah out-of-gas bila state bergeser.
  try { sent = await broadcast(to, enc(1n), Math.ceil(Number(est) * 1.35) + 30000, gp) } catch { unlock(pa); return }
  await track(sent.hash, sent.n, c, gp);
}
async function track(hash, n, c, gp) {
  const rc = await provider.waitForTransaction(hash, 1, C.txWait).catch(() => null);
  if (!rc) { await unstick(n, gp); unlock(c.route.pairAddrs); return }
  if (rc.status === 1) { reward(c.route); learn(big(rc.gasUsed), c) }
  else { penalize(c.route); for (let i = 0; i < c.route.hops.length - 1; i++) tok(c.route.hops[i].tokenOut).probedAt = 0 }
  await refreshBal();
}
// Tx macet (mis. baseFee naik) memblokir semua nonce berikutnya -> ganti dengan transfer 0 ke diri sendiri (nonce sama).
async function unstick(n, gp) {
  try {
    if (await provider.getTransactionCount(account, "latest") > n) return;
    try { await refreshGas(true) } catch {}
    const min = gp * 11n / 10n + 1n, p = liveGp > min ? liveGp : min;
    await serial(async () => { const raw = await wallet.signTransaction({ to: account, value: 0, gasLimit: 21000, gasPrice: bn(p), nonce: n, chainId: C.chainId }); await provider.send("eth_sendRawTransaction", [raw]) });
  } catch (e) { log("unstick gagal", String(e.message).slice(0, 80)) }
}

// ---------- event
function onSync(l) {
  const p = pairs.get(lc(l.address)); if (!p) return; if (l.removed) { syncReserves([p.addr]).then(scheduleScan).catch(() => {}); return }
  const b = l.blockNumber, li = l.logIndex; if (b < p.blk || (b === p.blk && li <= p.li)) return; const was = p.r0 === 0n || p.r1 === 0n;
  p.r0 = BigInt("0x" + l.data.slice(2, 66)); p.r1 = BigInt("0x" + l.data.slice(66, 130)); p.blk = b; p.li = li; if (was && p.r0 > 0n && p.r1 > 0n) scheduleRebuild();
  const lk = locks.get(p.addr); if (lk && b > lk.blk) locks.delete(p.addr); dirty.add(p.addr); scheduleScan();
}
async function onPairCreated(l) {
  try {
    const dex = Object.keys(C.dexes).find(d => C.dexes[d].factory === lc(l.address)); if (!dex) return; const pair = addrOf(l.data, 0), pc = new ethers.Contract(pair, PAIR, provider);
    const [t0, t1, rs] = await Promise.all([pc.token0(), pc.token1(), pc.getReserves()]); if (addPair(dex, pair, t0, t1, big(rs[0]), big(rs[1]), lastBlock)) scheduleRebuild();
  } catch (e) { log("pairCreated:", e.message) }
}

// ---------- sesi
async function teardown() { ready = false; while (timers.length) clearInterval(timers.pop()); try { provider.removeAllListeners() } catch {} try { provider._websocket.close() } catch {} }
async function approveIfNeeded(spender) {
  if (big(await wricC.allowance(account, spender)) >= (1n << 200n)) return;
  const est = await wt(wricC.estimateGas.approve(spender, ethers.constants.MaxUint256), 8000), tx = await wricC.approve(spender, ethers.constants.MaxUint256, { gasPrice: bn(gasPriceWei()), gasLimit: Math.ceil(Number(est) * 1.2) });
  await tx.wait(); await resyncNonce();
}
// Tx sisa dari proses sebelumnya yang macet (nonce pending > nonce terkonfirmasi) dibatalkan dulu agar tx baru tidak terblokir.
async function clearStuck() {
  const latest = await provider.getTransactionCount(account, "latest"); if (nonce <= latest) return;
  await sleep(C.txWait); const l2 = await provider.getTransactionCount(account, "latest"); if (nonce <= l2) return;
  try { await refreshGas(true) } catch {}
  const p = gasPriceWei() * 2n;
  for (let n = l2; n < nonce; n++) { try { const raw = await wallet.signTransaction({ to: account, value: 0, gasLimit: 21000, gasPrice: bn(p), nonce: n, chainId: C.chainId }); await provider.send("eth_sendRawTransaction", [raw]) } catch {} }
  await sleep(C.txWait); await resyncNonce();
}
async function session() {
  const closed = new Promise(r => closeResolve = r);
  try {
    provider = new ethers.providers.WebSocketProvider(C.rpc); provider._websocket.onclose = () => closeResolve && closeResolve("ws-close"); provider._websocket.onerror = () => log("WS error");
    await wt(provider.getNetwork(), 10000); wallet = new ethers.Wallet(PK, provider); account = wallet.address; multicall = new ethers.Contract(C.multicall, MC, provider); wricC = new ethers.Contract(C.wrapped, ERC20, wallet); await refreshGas(true);
    if (!utils.isAddress(C.exec)) throw new Error("Executor alamat salah"); executor = new ethers.Contract(C.exec, EXEC, wallet);
    const owner = lc(await executor.owner()); if (owner !== lc(account)) throw new Error(`Owner executor (${owner}) != wallet (${account})`);
    sessionNo++;
    if (C.execx) { if (!utils.isAddress(C.execx)) throw new Error("Executor X alamat salah"); executorX = new ethers.Contract(C.execx, EXECX, wallet); const oX = lc(await executorX.owner()); if (oX !== lc(account)) throw new Error(`Owner executor X (${oX}) != wallet (${account})`) }
    await refreshBal(); lastBlock = await provider.getBlockNumber(); await resyncNonce(); await clearStuck(); inflight = 0n;
    await approveIfNeeded(C.exec); if (C.execx) await approveIfNeeded(C.execx);
    for (const d of Object.keys(C.dexes)) await loadFactory(d); await syncReserves(); await calibrateFees(); if (C.execx) await loadExchange(); buildRoutes();
    provider.on({ topics: [SYNC] }, onSync); provider.on("block", n => { lastBlock = n; refreshGas().catch(() => {}); refreshBal().catch(() => {}) });
    for (const d of Object.values(C.dexes)) provider.on({ address: d.factory, topics: [PAIRC] }, onPairCreated);
    if (C.execx) for (const m of exMarkets.values()) subscribeMarket(m);
    ready = true; for (const p of pairs.keys()) dirty.add(p); scheduleScan(); log("Bot aktif", C.dry ? "(DRY RUN)" : "", "wallet", account, "WRIC", fw(wricBal), "gas", (Number(gasPriceWei()) / 1e9).toFixed(4), "gwei", "rute", routes.length);
    let hb = 0; timers.push(setInterval(async () => { try { await wt(provider.getBlockNumber(), 4000); hb = 0 } catch { if (++hb >= 2) closeResolve && closeResolve("heartbeat") } }, 5000));
    timers.push(setInterval(async () => { try { let a = 0; for (const d of Object.keys(C.dexes)) a += await loadFactory(d); if (a) scheduleRebuild(); if (C.execx) await loadExchange(); await syncReserves(); scheduleScan() } catch (e) { log("resync:", e.message) } }, C.resync));
    timers.push(setInterval(scheduleRebuild, 300000));
    probeAll().catch(e => log("probeAll:", e.message));
    return await closed;
  } finally { await teardown() }
}
async function loop() {
  let back = 2000;
  for (;;) {
    const t0 = Date.now();
    try { const why = await session(); log("sesi berakhir:", why) }
    catch (e) { if (/Executor|Owner/.test(e.message)) { fatal(e.message) } log("error:", e.message) }
    back = Date.now() - t0 > 60000 ? 2000 : Math.min(back * 2, 30000); await sleep(back);
  }
}
loop();
