// ── Config ───────────────────────────────────────────────────────────────────
const API = '';
let AUTH_TOKEN = localStorage.getItem('jwt') || '';
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  return h;
}

function apiFetch(url) {
  return fetch(API + url, { headers: authHeaders() }).then(r => {
    if (r.status === 401) {
      AUTH_TOKEN = '';
      localStorage.removeItem('jwt');
    }
    return r;
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatUsd(v) {
  if (v == null) return '$0';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n) || n === 0) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return '$' + n.toFixed(2);
  if (abs >= 0.01) return '$' + n.toFixed(4);
  return '$' + n.toPrecision(3);
}

function formatUsdFull(v) {
  if (v == null) return '$0';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n) || n === 0) return '$0';
  if (Math.abs(n) >= 1) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + n.toPrecision(4);
}

function formatEth(v) {
  if (v == null) return '0';
  const n = parseFloat(String(v));
  if (isNaN(n) || n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toFixed(4) + ' ETH';
  return n.toPrecision(4) + ' ETH';
}

function formatEthShort(v) {
  if (v == null) return '0';
  const n = parseFloat(v);
  if (isNaN(n) || n === 0) return '0 ETH';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K ETH';
  if (n >= 1) return n.toFixed(2) + ' ETH';
  if (n >= 0.01) return n.toFixed(4) + ' ETH';
  return n.toPrecision(3) + ' ETH';
}

function formatChange(v) {
  if (v == null || v === 0) return { text: '0%', cls: 'dim' };
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (isNaN(n)) return { text: '0%', cls: 'dim' };
  const sign = n > 0 ? '+' : '';
  const abs = Math.abs(n);
  const formatted = abs < 0.01 ? n.toPrecision(2) : n.toFixed(1);
  return { text: sign + formatted + '%', cls: n > 0 ? 'green' : n < 0 ? 'red' : 'dim' };
}

function formatNumber(v) {
  if (v == null) return '0';
  const n = typeof v === 'number' ? v : parseInt(v);
  if (isNaN(n)) return '0';
  return n.toLocaleString('en-US');
}

function shortenAddr(addr) {
  if (!addr) return '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function timeAgo(ts) {
  const sec = Math.floor(Date.now() / 1000) - Number(ts);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

function weiToEth(wei) {
  if (wei == null) return null;
  const s = String(wei);
  if (s.length <= 18) return '0.' + s.padStart(18, '0').replace(/0+$/, '') || '0';
  const whole = s.slice(0, s.length - 18);
  const frac = s.slice(s.length - 18).replace(/0+$/, '');
  return frac ? whole + '.' + frac : whole;
}

// ── Sparkline renderer ───────────────────────────────────────────────────────

function drawSparkline(canvas, data, isPositive) {
  if (!canvas || !data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.scale(2, 2);
  const rw = canvas.offsetWidth;
  const rh = canvas.offsetHeight;

  const values = data.map(d => {
    if (typeof d === 'object' && d.closePriceETH) return parseFloat(d.closePriceETH) || 0;
    return parseFloat(d) || 0;
  }).filter(v => v > 0);

  if (values.length < 2) return;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 3;

  ctx.beginPath();
  ctx.strokeStyle = isPositive ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';

  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * rw;
    const y = pad + (1 - (values[i] - min) / range) * (rh - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Gradient fill
  const lastY = pad + (1 - (values[values.length - 1] - min) / range) * (rh - pad * 2);
  ctx.lineTo(rw, rh);
  ctx.lineTo(0, rh);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, rh);
  grad.addColorStop(0, isPositive ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fill();
}

// ── WebSocket Manager ────────────────────────────────────────────────────────

class WsManager {
  constructor() {
    this.handlers = {};
    this.ws = null;
    this.reconnectDelay = 1000;
    this.pingInterval = null;
  }
  on(type, fn) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(fn);
  }
  connect() {
    const wsUrl = AUTH_TOKEN ? `${WS_URL}?token=${AUTH_TOKEN}` : WS_URL;
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      const el = document.getElementById('ws-status');
      if (el) { el.classList.add('connected'); el.querySelector('.live-text').textContent = 'Live'; }
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const fns = this.handlers[msg.type];
        if (fns) fns.forEach(fn => fn(msg.data, msg));
      } catch {}
    };
    this.ws.onclose = () => {
      clearInterval(this.pingInterval);
      const el = document.getElementById('ws-status');
      if (el) { el.classList.remove('connected'); el.querySelector('.live-text').textContent = 'Reconnecting...'; }
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };
    this.ws.onerror = () => this.ws.close();
  }
}

const ws = new WsManager();

// ══════════════════════════════════════════════════════════════════════════════
// HOME PAGE
// ══════════════════════════════════════════════════════════════════════════════

let tokenData = [];
let currentSort = 'marketCap';

function getCreatorAddr(t) {
  if (t.royaltyMembers && t.royaltyMembers.length > 0) return t.royaltyMembers[0].address;
  return null;
}

function renderTokenRow(t) {
  const ch = formatChange(t.twentyFourHourChangePercentage);
  const isPositive = (t.twentyFourHourChangePercentage || 0) >= 0;
  const creator = getCreatorAddr(t);

  return `<div class="token-row" data-addr="${t.tokenAddress}" onclick="location.href='/token.html?address=${t.tokenAddress}'">
    <div class="coin-cell">
      <img class="coin-img" src="${t.image}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><circle cx=%2220%22 cy=%2220%22 r=%2220%22 fill=%22%2327272a%22/></svg>'">
      <div class="coin-info">
        <div class="coin-name">${t.name || '???'}</div>
        <div class="coin-symbol">${t.symbol || '???'}</div>
      </div>
    </div>
    <div class="sparkline-cell">
      <canvas class="sparkline-canvas" data-token="${t.tokenAddress}" data-positive="${isPositive}"></canvas>
    </div>
    <div class="mcap-cell">
      <div class="mcap-value">${formatUsd(t.marketCapUSD)}</div>
      <div class="mcap-change ${ch.cls}">${ch.text}</div>
    </div>
    <div class="vol-cell">
      <div class="vol-value">${formatUsd(t.twentyFourHourVolumeUSD)}</div>
      <div class="vol-sub">${formatEthShort(t.twentyFourHourVolume)}</div>
    </div>
    <div class="holders-cell">
      <div class="holders-addr">${creator ? shortenAddr(creator) : '-'}</div>
      <div class="holders-count">${formatNumber(t.holderCount)} holder${t.holderCount !== 1 ? 's' : ''}</div>
    </div>
    <div class="earned-cell">
      <div class="earned-value">${formatUsd(t.feesEarnedUSD)}</div>
      <div class="earned-sub">${formatEthShort(t.feesEarned)}</div>
    </div>
    <div class="trade-cell">
      <button class="trade-btn" onclick="event.stopPropagation(); location.href='/token.html?address=${t.tokenAddress}'">Trade</button>
    </div>
  </div>`;
}

function renderTokenList(tokens) {
  const list = document.getElementById('token-list');
  if (!list) return;
  if (!tokens.length) { list.innerHTML = '<div class="loading-state">No tokens found</div>'; return; }
  list.innerHTML = tokens.map(t => renderTokenRow(t)).join('');

  // Draw sparklines after DOM is ready
  requestAnimationFrame(() => {
    tokens.forEach(t => {
      const canvas = list.querySelector(`canvas[data-token="${t.tokenAddress}"]`);
      if (canvas && t.hourData && t.hourData.length) {
        drawSparkline(canvas, t.hourData, canvas.dataset.positive === 'true');
      }
    });
  });
}

function sortTokens(tokens, sort) {
  const sorted = [...tokens];
  switch (sort) {
    case 'marketCap':
      return sorted.sort((a, b) => (parseFloat(b.marketCapETH) || 0) - (parseFloat(a.marketCapETH) || 0));
    case 'volume':
      return sorted.sort((a, b) => parseFloat(b.twentyFourHourVolume || 0) - parseFloat(a.twentyFourHourVolume || 0));
    case 'trades':
      return sorted.sort((a, b) => (b.tradeCount24h || 0) - (a.tradeCount24h || 0));
    case 'newest':
      return sorted.sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt));
  }
  return sorted;
}

async function loadStats() {
  try {
    const res = await apiFetch('/stats');
    const d = await res.json();
    const el = document.getElementById('platform-stats');
    if (!el) return;
    el.innerHTML = `
      <div class="stat-item"><span class="stat-value">${d.totalTokens}</span><span class="stat-label">Tokens</span></div>
      <div class="stat-item"><span class="stat-value">${formatNumber(d.totalTrades)}</span><span class="stat-label">Trades</span></div>
      <div class="stat-item"><span class="stat-value">${formatUsd(d.totalVolumeUSD)}</span><span class="stat-label">Volume</span></div>
      <div class="stat-item"><span class="stat-value">${formatNumber(d.totalHolders)}</span><span class="stat-label">Holders</span></div>
    `;
  } catch {}
}

function showActivityToast(data) {
  const feed = document.getElementById('activity-feed');
  if (!feed) return;
  const isBuy = data.type === 'buy';
  const toast = document.createElement('div');
  toast.className = 'activity-toast';
  toast.innerHTML = `
    <span class="badge ${isBuy ? 'badge-buy' : 'badge-sell'}">${isBuy ? 'BUY' : 'SELL'}</span>
    <span style="color:#71717a">${shortenAddr(data.maker)}</span>
    <span style="font-weight:600">${data.coin?.symbol || '???'}</span>
    <span style="color:#a1a1aa">${formatUsd(data.amountUSD)}</span>
  `;
  feed.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
  if (feed.children.length > 5) feed.firstChild.remove();
}

function initHomePage() {
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderTokenList(sortTokens(tokenData, currentSort));
    });
  });

  // WS handlers
  ws.on('tokenList', (data) => {
    tokenData = data;
    renderTokenList(sortTokens(tokenData, currentSort));
  });

  ws.on('priceUpdate', (data) => {
    const row = document.querySelector(`.token-row[data-addr="${data.coinAddress}"]`);
    if (!row) return;
    row.style.background = '#1a1a2e';
    setTimeout(() => row.style.background = '', 800);
  });

  ws.on('activity', (data) => showActivityToast(data));

  // Initial REST load
  apiFetch('/tokens?sort=marketCap').then(r => r.json()).then(data => {
    if (!tokenData.length) {
      tokenData = data;
      renderTokenList(sortTokens(tokenData, currentSort));
    }
  }).catch(() => {});

  loadStats();
  ws.connect();
}

// ══════════════════════════════════════════════════════════════════════════════
// TOKEN DETAIL PAGE
// ══════════════════════════════════════════════════════════════════════════════

let chart = null;
let candleSeries = null;
let volumeSeries = null;
let currentResolution = '1h';
let detailAddress = null;

function renderTokenHeader(t) {
  const el = document.getElementById('token-header');
  if (!el) return;
  const ch = formatChange(t.twentyFourHourChangePercentage);
  let socialHtml = '';
  if (t.website || t.twitter || t.telegram) {
    socialHtml = '<div class="social-links">';
    if (t.website) socialHtml += `<a href="${t.website}" target="_blank">Website</a>`;
    if (t.twitter) socialHtml += `<a href="https://x.com/${t.twitter}" target="_blank">Twitter</a>`;
    if (t.telegram) socialHtml += `<a href="https://t.me/${t.telegram}" target="_blank">Telegram</a>`;
    socialHtml += '</div>';
  }

  el.innerHTML = `
    <div class="th-main">
      <img class="th-img" src="${t.image}" alt="" onerror="this.style.display='none'">
      <div class="th-info">
        <h2>${t.name || '???'}<span>${t.symbol || ''}</span></h2>
        <div class="th-price-big" id="live-price">${formatEth(t.priceETH)}</div>
        <div class="th-price-usd" id="live-price-usd">${formatUsdFull(t.priceUSD)}</div>
        ${socialHtml}
      </div>
    </div>
    <div class="th-stats">
      <div class="th-stat"><div class="th-stat-label">Market Cap</div><div class="th-stat-value" id="live-mcap">${formatUsd(t.marketCapUSD)}</div></div>
      <div class="th-stat"><div class="th-stat-label">24h Change</div><div class="th-stat-value ${ch.cls}" id="live-change">${ch.text}</div></div>
      <div class="th-stat"><div class="th-stat-label">24h Volume</div><div class="th-stat-value">${formatUsd(t.twentyFourHourVolumeUSD)}</div></div>
      <div class="th-stat"><div class="th-stat-label">Holders</div><div class="th-stat-value">${formatNumber(t.holderCount)}</div></div>
      <div class="th-stat"><div class="th-stat-label">Fees Earned</div><div class="th-stat-value">${formatEthShort(t.feesEarned)}</div></div>
      ${t.fairLaunch ? '<div class="th-stat"><div class="th-stat-label">Fair Launch</div><div class="th-stat-value" style="color:#a78bfa">Active</div></div>' : ''}
    </div>
  `;
  document.title = `${t.symbol || t.name} - FLaunch Analytics`;
}

function initChart() {
  const container = document.getElementById('chart');
  if (!container || typeof LightweightCharts === 'undefined') return;

  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#09090b' }, textColor: '#52525b' },
    grid: { vertLines: { color: '#111113' }, horzLines: { color: '#111113' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1a1a2e' },
    rightPriceScale: { borderColor: '#1a1a2e' },
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444',
    borderUpColor: '#22c55e', borderDownColor: '#ef4444',
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
  });

  volumeSeries = chart.addHistogramSeries({
    color: '#1a2332', priceFormat: { type: 'volume' },
    priceScaleId: '', scaleMargins: { top: 0.85, bottom: 0 },
  });

  chart.timeScale().fitContent();
  new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  }).observe(container);
}

async function loadCandles(address, resolution) {
  try {
    const res = await apiFetch(`/tokens/${address}/candles?resolution=${resolution}`);
    const candles = await res.json();
    if (!candleSeries || !candles.length) return;

    const candleData = candles.map(c => ({
      time: Number(c.bucketTime),
      open: parseFloat(weiToEth(c.openEth)),
      high: parseFloat(weiToEth(c.highEth)),
      low: parseFloat(weiToEth(c.lowEth)),
      close: parseFloat(weiToEth(c.closeEth)),
    }));
    const volData = candles.map(c => ({
      time: Number(c.bucketTime),
      value: parseFloat(weiToEth(c.volumeEth)),
      color: parseFloat(weiToEth(c.closeEth)) >= parseFloat(weiToEth(c.openEth)) ? '#0a2e1a' : '#2e0a14',
    }));

    candleSeries.setData(candleData);
    volumeSeries.setData(volData);
    chart.timeScale().fitContent();
  } catch {}
}

let tradesOffset = 0;
async function loadTrades(address, append) {
  try {
    if (!append) tradesOffset = 0;
    const res = await apiFetch(`/tokens/${address}/trades?limit=20&offset=${tradesOffset}`);
    const { trades, total } = await res.json();
    const tbody = document.getElementById('trades-tbody');
    if (!tbody) return;

    const html = trades.map(t => `<tr>
      <td style="text-align:left"><span class="badge ${t.isBuy ? 'badge-buy' : 'badge-sell'}">${t.isBuy ? 'BUY' : 'SELL'}</span></td>
      <td>${formatEth(t.amountETH)}</td>
      <td>${formatUsd(t.amountUSD)}</td>
      <td>${formatEth(t.priceETH)}</td>
      <td><a href="https://basescan.org/address/${t.trader || ''}" target="_blank">${shortenAddr(t.trader)}</a></td>
      <td>${timeAgo(t.blockTimestamp)}</td>
      <td><a href="https://basescan.org/tx/${t.txHash}" target="_blank">${shortenAddr(t.txHash)}</a></td>
    </tr>`).join('');

    if (append) tbody.innerHTML += html;
    else tbody.innerHTML = html || '<tr><td colspan="7" class="loading">No trades yet</td></tr>';

    tradesOffset += trades.length;
    const btn = document.getElementById('load-more-trades');
    if (btn) btn.style.display = tradesOffset < total ? 'block' : 'none';
  } catch {}
}

let holdersOffset = 0;
async function loadHolders(address, append) {
  try {
    if (!append) holdersOffset = 0;
    const res = await apiFetch(`/tokens/${address}/holders?limit=20&offset=${holdersOffset}`);
    const { holders, total } = await res.json();
    const tbody = document.getElementById('holders-tbody');
    if (!tbody) return;

    const html = holders.map(h => `<tr>
      <td style="text-align:left"><a href="https://basescan.org/address/${h.wallet}" target="_blank">${shortenAddr(h.wallet)}</a></td>
      <td>${formatNumber(h.balance ? Math.round(parseFloat(h.balance) / 1e18) : 0)}</td>
      <td>${formatUsd(h.balanceUSD)}</td>
      <td>${h.percentage ? parseFloat(h.percentage).toFixed(2) + '%' : '-'}</td>
    </tr>`).join('');

    if (append) tbody.innerHTML += html;
    else tbody.innerHTML = html || '<tr><td colspan="4" class="loading">No holders yet</td></tr>';

    holdersOffset += holders.length;
    const btn = document.getElementById('load-more-holders');
    if (btn) btn.style.display = holdersOffset < total ? 'block' : 'none';
  } catch {}
}

function renderRoyalties(members) {
  const el = document.getElementById('royalties-content');
  if (!el) return;
  if (!members || !members.length) { el.innerHTML = '<div class="loading">No royalty members</div>'; return; }
  el.innerHTML = members.map(m => `
    <div class="royalty-card">
      <div class="royalty-addr"><a href="https://basescan.org/address/${m.address}" target="_blank">${shortenAddr(m.address)}</a></div>
      <div class="royalty-pct">${m.percentage}%</div>
    </div>
  `).join('');
}

async function initTokenPage() {
  const params = new URLSearchParams(location.search);
  detailAddress = params.get('address');
  if (!detailAddress) { document.getElementById('token-header').innerHTML = '<div class="loading">No token address</div>'; return; }

  try {
    const res = await apiFetch(`/tokens/${detailAddress}`);
    if (!res.ok) { document.getElementById('token-header').innerHTML = '<div class="loading">Token not found</div>'; return; }
    const token = await res.json();
    renderTokenHeader(token);
    renderRoyalties(token.royaltyMembers);
  } catch { document.getElementById('token-header').innerHTML = '<div class="loading">Failed to load</div>'; }

  initChart();
  loadCandles(detailAddress, currentResolution);

  document.querySelectorAll('.res-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.res-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentResolution = btn.dataset.res;
      loadCandles(detailAddress, currentResolution);
    });
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    });
  });

  loadTrades(detailAddress);
  loadHolders(detailAddress);

  document.getElementById('load-more-trades')?.addEventListener('click', () => loadTrades(detailAddress, true));
  document.getElementById('load-more-holders')?.addEventListener('click', () => loadHolders(detailAddress, true));

  // Live WS updates
  ws.on('priceUpdate', (data) => {
    if (data.coinAddress !== detailAddress?.toLowerCase()) return;
    const priceEl = document.getElementById('live-price');
    const usdEl = document.getElementById('live-price-usd');
    const mcapEl = document.getElementById('live-mcap');
    if (priceEl && data.priceETH) priceEl.textContent = formatEth(data.priceETH);
    if (usdEl && data.priceUSD) usdEl.textContent = formatUsdFull(data.priceUSD);
    if (mcapEl && data.marketCapUSD) mcapEl.textContent = formatUsd(data.marketCapUSD);
  });

  ws.on('candle', (data) => {
    if (!candleSeries || !data) return;
    if (data.tokenAddress !== detailAddress?.toLowerCase()) return;
    if (data.resolution !== currentResolution) return;
    try {
      candleSeries.update({
        time: Number(data.bucketTime),
        open: parseFloat(weiToEth(data.openEth)),
        high: parseFloat(weiToEth(data.highEth)),
        low: parseFloat(weiToEth(data.lowEth)),
        close: parseFloat(weiToEth(data.closeEth)),
      });
    } catch {}
  });

  ws.on('activity', (data) => {
    if (data.coin?.address !== detailAddress?.toLowerCase()) return;
    const tbody = document.getElementById('trades-tbody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.style.background = '#1a1a2e';
    setTimeout(() => tr.style.background = '', 1000);
    tr.innerHTML = `
      <td style="text-align:left"><span class="badge ${data.type === 'buy' ? 'badge-buy' : 'badge-sell'}">${data.type === 'buy' ? 'BUY' : 'SELL'}</span></td>
      <td>-</td><td>${formatUsd(data.amountUSD)}</td><td>-</td>
      <td><a href="https://basescan.org/address/${data.maker || ''}" target="_blank">${shortenAddr(data.maker)}</a></td>
      <td>just now</td>
      <td><a href="https://basescan.org/tx/${data.txHash || ''}" target="_blank">${shortenAddr(data.txHash)}</a></td>
    `;
    tbody.insertBefore(tr, tbody.firstChild);
  });

  ws.connect();
}

// ── Router ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (location.pathname.includes('token')) initTokenPage();
  else initHomePage();
});
