const state = { tour: "all", ch: "all", surface: "all", min: 0, doubles: false, page: "board", up: "all", data: null, live: {} };
const STORE = "linie-elo-v1";
const K = 24;
const $ = (s) => document.querySelector(s);

function rating(rank) { return 2200 - 200 * Math.log10(rank); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function pct(x) { return Math.round(x * 1000) / 10; }
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE)) || { ratings: {}, results: [] }; }
  catch (e) { return { ratings: {}, results: [] }; }
}
function saveStore(s) { localStorage.setItem(STORE, JSON.stringify(s)); }
function learnedRating(name, surface) {
  const row = loadStore().ratings[name];
  if (!row || row[surface] == null) return null;
  return row[surface];
}
function effective(player, surface) {
  const learned = learnedRating(player.name, surface);
  if (learned == null) return { value: rating(player.rank), learned: false };
  return { value: learned, learned: true };
}
function winProbRatings(ra, rb) {
  const p = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return p;
}
function quality(match) {
  const same = match.players.every((p) => p.rank_source && p.rank_source.includes("statsdream.com"));
  return same ? 0.72 : 0.64;
}
function confidence(p, q) { return Math.round(Math.min(92, Math.abs(p - 0.5) * 200) * q); }
function setWinFromMatch(p) {
  let lo = 0.001, hi = 0.999;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const pm = mid * mid * (3 - 2 * mid);
    if (pm < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function scoreModel(p) {
  const s = setWinFromMatch(p);
  const straight = s * s;
  const three = 2 * s * s * (1 - s);
  return { sets: straight >= three ? "2:0" : "2:1", straight, three, s };
}
function gameWin(p) {
  const q = 1 - p;
  const deuce = (p * p) / (p * p + q * q);
  return Math.pow(p, 4) * (1 + 4 * q + 10 * q * q) + 20 * Math.pow(p, 3) * Math.pow(q, 3) * deuce;
}
function tiebreakWin(p1s, p2s, firstServer) {
  const memo = new Map();
  function serverAt(n) {
    if (n === 0) return firstServer;
    return Math.floor((n - 1) / 2) % 2 === 0 ? 1 - firstServer : firstServer;
  }
  function f(a, b) {
    if ((a >= 7 && a - b >= 2) || a >= 20) return a > b ? 1 : 0;
    if ((b >= 7 && b - a >= 2) || b >= 20) return a > b ? 1 : 0;
    const key = a * 40 + b;
    if (memo.has(key)) return memo.get(key);
    const srv = serverAt(a + b);
    const p1 = srv === 0 ? p1s : 1 - p2s;
    const val = p1 * f(a + 1, b) + (1 - p1) * f(a, b + 1);
    memo.set(key, val);
    return val;
  }
  return f(0, 0);
}
function setWinProb(ga, gb, server, g1, g2) {
  const memo = new Map();
  function f(a, b, srv) {
    if (a >= 6 && a - b >= 2) return 1;
    if (b >= 6 && b - a >= 2) return 0;
    if (a > 7 || b > 7) return a > b ? 1 : 0;
    const key = (a * 8 + b) * 2 + srv;
    if (memo.has(key)) return memo.get(key);
    let val;
    if (a === 6 && b === 6) val = tiebreakWin(null, null, srv, g1, g2);
    else {
      const pGame = srv === 0 ? g1 : 1 - g2;
      val = pGame * f(a + 1, b, 1 - srv) + (1 - pGame) * f(a, b + 1, 1 - srv);
    }
    memo.set(key, val);
    return val;
  }
  return f(ga, gb, server);
}
function tiebreakWin(unusedA, unusedB, firstServer, p1s, p2s) {
  const memo = new Map();
  function serverAt(n) {
    if (n === 0) return firstServer;
    return Math.floor((n - 1) / 2) % 2 === 0 ? 1 - firstServer : firstServer;
  }
  function f(a, b) {
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
    if (a + b > 40) return a === b ? 0.5 : a > b ? 1 : 0;
    const key = a * 50 + b;
    if (memo.has(key)) return memo.get(key);
    const srv = serverAt(a + b);
    const p1 = srv === 0 ? p1s : 1 - p2s;
    const val = p1 * f(a + 1, b) + (1 - p1) * f(a, b + 1);
    memo.set(key, val);
    return val;
  }
  return f(0, 0);
}
function matchOutlook(s1, s2, g1, g2, server, p1s, p2s) {
  if (s1 >= 2) return { p: 1, setP: 1, dist: { "2:0": s2 === 0 ? 1 : 0, "2:1": s2 === 1 ? 1 : 0 } };
  if (s2 >= 2) return { p: 0, setP: 0, dist: { "0:2": s1 === 0 ? 1 : 0, "1:2": s1 === 1 ? 1 : 0 } };
  const gw1 = gameWin(p1s), gw2 = gameWin(p2s);
  const setP = setWinProb(g1, g2, server, gw1, gw2);
  const fut = (setWinProb(0, 0, 0, gw1, gw2) + setWinProb(0, 0, 1, gw1, gw2)) / 2;
  const dist = {};
  function add(key, mass) { dist[key] = (dist[key] || 0) + mass; }
  let p = 0;
  if (s1 === 1 && s2 === 1) {
    p = setP;
    add(setP >= 0.5 ? "2:1" : "1:2", 1);
    add("2:1", setP);
    add("1:2", 1 - setP);
    dist["2:1"] = setP; dist["1:2"] = 1 - setP;
  } else if (s1 === 1 && s2 === 0) {
    p = setP + (1 - setP) * fut;
    dist["2:0"] = setP;
    dist["2:1"] = (1 - setP) * fut;
    dist["1:2"] = (1 - setP) * (1 - fut);
  } else if (s1 === 0 && s2 === 1) {
    p = setP * fut;
    dist["2:1"] = setP * fut;
    dist["0:2"] = 1 - setP;
    dist["1:2"] = setP * (1 - fut);
  } else {
    const p20 = setP * fut;
    const p02 = (1 - setP) * (1 - fut);
    const p21 = setP * (1 - fut) * fut + (1 - setP) * fut * fut;
    const p12 = 1 - p20 - p02 - p21;
    p = p20 + p21;
    dist["2:0"] = p20; dist["2:1"] = p21; dist["0:2"] = p02; dist["1:2"] = p12;
  }
  let best = null, bestM = -1;
  Object.entries(dist).forEach(([k, v]) => { if (v > bestM) { best = k; bestM = v; } });
  return { p, setP, dist, best, bestM, fut };
}
function fatigueServes(p1, p2, games) {
  const factor = Math.max(0.75, 1 - 0.004 * games);
  return [0.5 + (p1 - 0.5) * factor, 0.5 + (p2 - 0.5) * factor];
}
function baseServes(pTarget) {
  let lo = -0.16, hi = 0.16;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    const a = clamp(0.63 + mid, 0.52, 0.8);
    const b = clamp(0.63 - mid, 0.52, 0.8);
    const pm = matchOutlook(0, 0, 0, 0, 0, a, b).p * 0.5 + matchOutlook(0, 0, 0, 0, 1, a, b).p * 0.5;
    if (pm < pTarget) lo = mid; else hi = mid;
  }
  const d = (lo + hi) / 2;
  return [clamp(0.63 + d, 0.52, 0.8), clamp(0.63 - d, 0.52, 0.8)];
}
function liveModel(match, a) {
  const ui = state.live[match.id] || { s1: 0, s2: 0, g1: 0, g2: 0, server: 0 };
  const s1 = clamp(ui.s1 | 0, 0, 2), s2 = clamp(ui.s2 | 0, 0, 2);
  const g1 = clamp(ui.g1 | 0, 0, 7), g2 = clamp(ui.g2 | 0, 0, 7);
  const server = ui.server ? 1 : 0;
  const [b1, b2] = baseServes(a.p);
  const games = (s1 + s2) * 10 + g1 + g2;
  const noFat = matchOutlook(s1, s2, g1, g2, server, b1, b2);
  const [f1, f2] = fatigueServes(b1, b2, games);
  const fat = matchOutlook(s1, s2, g1, g2, server, f1, f2);
  return { ui: { s1, s2, g1, g2, server }, b1, b2, f1, f2, games, noFat, fat,
    scoreShift: noFat.p - a.p, fatigueShift: fat.p - noFat.p };
}
function analyze(match) {
  const [p1, p2] = match.players;
  if (!p1.rank || !p2.rank) return null;
  const e1 = effective(p1, match.surface);
  const e2 = effective(p2, match.surface);
  const p = winProbRatings(e1.value, e2.value);
  const q = quality(match);
  const conf = confidence(p, q);
  const fav = p >= 0.5 ? 0 : 1;
  const pf = fav === 0 ? p : 1 - p;
  const score = scoreModel(pf);
  let odds = null;
  if (match.odds && match.odds.player1 && match.odds.player2) {
    const o1 = match.odds.player1, o2 = match.odds.player2;
    const i1 = 1 / o1, i2 = 1 / o2, sum = i1 + i2;
    const kelly = (pp, o) => Math.max(0, (pp * o - 1) / (o - 1)) / 4;
    odds = { o1, o2, overround: sum - 1, fair1: i1 / sum, fair2: i2 / sum, raw1: i1, raw2: i2,
      ev1: p * o1 - 1, ev2: (1 - p) * o2 - 1, k1: kelly(p, o1), k2: kelly(1 - p, o2), meta: match.odds };
  }
  return { p, ra: e1.value, rb: e2.value, priorA: rating(p1.rank), priorB: rating(p2.rank), e1, e2, q, conf, fav, score, odds };
}
function timeLabel(m) {
  if (m.time_kind === "start" && m.time_prague) return m.time_prague;
  if (m.time_kind === "not_before" && m.time_prague) return "ne dříve " + m.time_prague;
  if (m.time_kind === "followed_by") return "po předchozím";
  if (m.time_kind === "published_unconfirmed_tz") return (m.time_local || "") + " pásmo nejisté";
  return "čas nepublikován";
}
function tourOk(tour) {
  if (state.tour === "all") return true;
  if (state.tour === "atp") return tour === "atp";
  if (state.tour === "wta") return tour === "wta";
  if (state.tour === "challenger") {
    if (tour !== "atp_challenger" && tour !== "wta_125") return false;
    return state.ch === "all" || tour === state.ch;
  }
  return false;
}
function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  const months = ["ledna","února","března","dubna","května","června","července","srpna","září","října","listopadu","prosince"];
  return Number(d) + ". " + months[Number(m) - 1] + " " + y;
}
function signed(x) {
  const v = pct(x);
  const cls = v > 0 ? "delta-pos" : v < 0 ? "delta-neg" : "";
  return `<span class="${cls}">${v > 0 ? "+" : ""}${v} b.</span>`;
}

function renderBoard() {
  const data = state.data;
  const box = $("#board");
  const rows = data.matches.filter((m) => {
    if (!tourOk(m.tour) || (state.surface !== "all" && m.surface !== state.surface)) return false;
    const a = analyze(m);
    return a && a.conf >= state.min;
  });
  const groups = new Map();
  rows.forEach((m) => {
    const key = m.tournament + "|" + m.city;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  if (!groups.size && !state.doubles) {
    box.innerHTML = `<div class="empty-hero"><p class="empty-kicker">Žádný zápas ve filtru</p><p>Uvolněte jistotu nebo okruh. Data tím nezmizela.</p></div>`;
  } else {
    box.innerHTML = [...groups.entries()].map(([, list]) => {
      const m0 = list[0];
      const body = list.map((m) => {
        const a = analyze(m);
        const elo = a.e1.learned || a.e2.learned;
        const names = m.players.map((p, i) => {
          const pr = i === 0 ? a.p : 1 - a.p;
          const seed = p.seed ? ` [${p.seed}]` : "";
          const entry = p.entry ? ` ${p.entry}` : "";
          const mark = (i === 0 ? a.e1 : a.e2).learned ? " · Elo" : "";
          return `<div class="p"><strong>${p.name}${seed}${entry}</strong><span class="rk">${p.country ? p.country + " · " : ""}#${p.rank}${mark} · ${pct(pr)} %</span></div>`;
        }).join("");
        const oddsHtml = a.odds
          ? `<div class="odds-col has">${a.odds.o1.toFixed(2)} / ${a.odds.o2.toFixed(2)}<br>EV ${pct(a.odds.ev1)} / ${pct(a.odds.ev2)} %</div>`
          : `<div class="odds-col">kurzy nedostupné</div>`;
        return `<button class="row" type="button" data-id="${m.id}">
          <div class="when">${timeLabel(m)}<div class="meta">${m.round}${elo ? " · online Elo" : ""}</div></div>
          <div class="players">${names}</div>
          <div>
            <div class="bar"><i style="width:${pct(a.p)}%"></i><i class="b" style="width:${pct(1 - a.p)}%"></i></div>
            <div class="pct">model ${pct(a.p)} / ${pct(1 - a.p)}</div>
          </div>
          <div class="conf">jistota <b>${a.conf}</b><div class="meta">skóre ${a.score.sets}</div></div>
          ${oddsHtml}
        </button>`;
      }).join("");
      return `<section class="tournament"><header><h2>${m0.tournament}</h2><div class="meta">${m0.city} · ${m0.level} · ${m0.surface_label}</div></header>${body}</section>`;
    }).join("");
  }
  if (state.doubles) {
    const ds = data.doubles.filter((d) => tourOk(d.tour));
    box.insertAdjacentHTML("beforeend", `<section class="tournament"><header><h2>Čtyřhra</h2><div class="meta">bez modelu · kurzy nedostupné</div></header>` +
      (ds.length ? ds.map((d) => `<div class="row" style="cursor:default"><div class="when">${timeLabel(d)}<div class="meta">${d.round}</div></div><div class="players"><div class="p"><strong>${d.teams[0]}</strong></div><div class="p"><strong>${d.teams[1]}</strong></div></div><div class="meta">${d.tournament}</div><div class="odds-col">model nedostupný</div><div class="odds-col">kurzy nedostupné</div></div>`).join("") : `<p class="meta">Ve filtru není ověřená čtyřhra.</p>`) + `</section>`);
  }
  box.querySelectorAll("button.row").forEach((btn) => btn.addEventListener("click", () => openDrawer(btn.dataset.id)));
}

function openDrawer(id) {
  const m = state.data.matches.find((x) => x.id === id);
  const a = analyze(m);
  const live = liveModel(m, a);
  const [p1, p2] = m.players;
  const fav = m.players[a.fav];
  if (!state.live[m.id]) state.live[m.id] = { s1: 0, s2: 0, g1: 0, g2: 0, server: 0 };
  const ui = state.live[m.id];
  let oddsBlock = `<p class="why"><span class="tag">kurzy nedostupné</span> Veřejný desetinný kurz tohoto zápasu se při sestavení snímku nepodařilo stáhnout. EV ani Kelly se proto nepočítají.</p>`;
  if (a.odds) {
    const o = a.odds;
    oddsBlock = `<h4>Snímek kurzu</h4>
      <p class="why">${p1.name} ${o.o1.toFixed(2)} · ${p2.name} ${o.o2.toFixed(2)}. Overround ${(o.overround * 100).toFixed(1)} %. Férová implikace ${pct(o.fair1)} / ${pct(o.fair2)} %.</p>
      <p class="why">EV proti modelu: ${pct(o.ev1)} % a ${pct(o.ev2)} %. Čtvrtinový Kelly: ${(o.k1 * 100).toFixed(2)} % a ${(o.k2 * 100).toFixed(2)} % banku. ${o.meta.note}</p>
      <p class="src">Zdroj kurzu: <a href="${o.meta.source}" target="_blank" rel="noopener">${o.meta.source}</a><br>Publikováno ${o.meta.published}, staženo ${o.meta.fetched_at}.</p>`;
  }
  const dist = Object.entries(live.fat.dist).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pct(v)} %`).join(" · ");
  $("#drawer-body").innerHTML = `
    <p class="meta">${m.level} · ${m.tournament} · ${m.city} · ${m.surface_label} · ${m.round}${m.round_inferred ? " (kolo odvozené)" : ""}</p>
    <h3>${p1.name}<br>proti<br>${p2.name}</h3>
    <p class="why">${timeLabel(m)}${m.court ? " · " + m.court : ""}</p>
    <p class="why">Předzápasový model dává <b style="color:var(--ink)">${pct(a.p)} %</b> / <b style="color:var(--ink)">${pct(1 - a.p)} %</b>. Jistota ${a.conf}. Modus setů pro favorita (${fav.name}) před zápasem: ${a.score.sets}. To je pořád model z ratingu, ne průběh.</p>
    <p class="why">Rating ${a.ra.toFixed(0)} proti ${a.rb.toFixed(0)}. ${a.e1.learned ? p1.name + " má online Elo na tomto povrchu (prior " + a.priorA.toFixed(0) + ")." : p1.name + " je na žebříčkovém prioru."} ${a.e2.learned ? p2.name + " má online Elo (prior " + a.priorB.toFixed(0) + ")." : p2.name + " je na žebříčkovém prioru."} Povrchový posun žebříčku je 0. ${m.source_note || ""}</p>
    <div class="live" id="live-box">
      <h4>Živě</h4>
      <p class="why">Prior z ratingu, ne změřený servis. Bod na podání teď ${pct(live.f1)} % a ${pct(live.f2)} % po únavě (bez únavy ${pct(live.b1)} / ${pct(live.b2)}).</p>
      <div class="live-grid">
        <label>Sety ${p1.name}<input id="lv-s1" type="number" min="0" max="2" value="${ui.s1}"></label>
        <label>Sety ${p2.name}<input id="lv-s2" type="number" min="0" max="2" value="${ui.s2}"></label>
        <label>Gemy v setu<input id="lv-g1" type="number" min="0" max="7" value="${ui.g1}"></label>
        <label>Gemy soupeře<input id="lv-g2" type="number" min="0" max="7" value="${ui.g2}"></label>
        <label>Podává<select id="lv-srv"><option value="0" ${ui.server==0?"selected":""}>${p1.name}</option><option value="1" ${ui.server==1?"selected":""}>${p2.name}</option></select></label>
      </div>
      <div id="live-readout"></div>
    </div>
    <div class="live">
      <h4>Zapsat výsledek</h4>
      <p class="why">Online Elo, K = ${K}, jen tento povrch (${m.surface_label}). Sety se uloží, krok je za celý zápas.</p>
      <label class="check"><input type="radio" name="win" value="0" checked> ${p1.name}</label>
      <label class="check"><input type="radio" name="win" value="1"> ${p2.name}</label>
      ${[1,2,3].map((n) => `<div class="sets-form"><input id="sa${n}" inputmode="numeric" placeholder="set ${n}"><span>:</span><input id="sb${n}" inputmode="numeric" placeholder=""></div>`).join("")}
      <p id="res-err" class="err"></p>
      <button type="button" id="save-res" class="ghost">Posunout Elo</button>
    </div>
    ${oddsBlock}
    <h4>Zdroje sestavy</h4>
    <ul class="src">${m.sources.map((u) => `<li><a href="${u}" target="_blank" rel="noopener">${u}</a></li>`).join("")}</ul>
  `;
  $("#drawer").hidden = false;
  function readLive() {
    state.live[m.id] = {
      s1: Number($("#lv-s1").value || 0), s2: Number($("#lv-s2").value || 0),
      g1: Number($("#lv-g1").value || 0), g2: Number($("#lv-g2").value || 0),
      server: Number($("#lv-srv").value || 0)
    };
  }
  function paint() {
    readLive();
    const live = liveModel(m, a);
    const dist = Object.entries(live.fat.dist).sort((x, y) => y[1] - x[1]).map(([k, v]) => k + " " + pct(v) + " %").join(" · ");
    $("#live-readout").innerHTML = `<p class="why">Výhra zápasu živě: <b style="color:var(--ink)">${pct(live.fat.p)} %</b> pro ${p1.name}. Aktuální set: ${pct(live.fat.setP)} % / ${pct(1 - live.fat.setP)} %. Nejpravděpodobnější skóre zápasu: ${live.fat.best} (${pct(live.fat.bestM)} %).</p>
      <p class="why">Prior z ratingu, ne změřený servis. Bod na podání ${pct(live.f1)} % a ${pct(live.f2)} % po únavě (bez únavy ${pct(live.b1)} / ${pct(live.b2)}).</p>
      <div class="factors">
        <div><span>Rating (předzápas)</span><b>${pct(a.p)} %</b></div>
        <div><span>Skóre a podání</span>${signed(live.scoreShift)}</div>
        <div><span>Únava (${live.games} gemů, hotový set = 10)</span>${signed(live.fatigueShift)}</div>
        <div><span>Dohromady</span><b>${pct(live.fat.p)} %</b></div>
      </div>
      <p class="meta">Rozložení skóre: ${dist}</p>`;
  }
  ["lv-s1","lv-s2","lv-g1","lv-g2","lv-srv"].forEach((id) => $("#" + id).addEventListener("input", paint));
  $("#save-res").addEventListener("click", () => saveResult(m));
  paint();
}

function setWon(a, b) {
  if (a === 7 && (b === 6 || b === 5)) return true;
  if (a >= 6 && a - b >= 2 && a <= 7 && b <= 7) return true;
  return false;
}
function saveResult(m) {
  const err = $("#res-err");
  const winnerIdx = Number(document.querySelector("input[name=win]:checked").value);
  const sets = [];
  for (let n = 1; n <= 3; n++) {
    const sa = $("#sa" + n).value.trim(), sb = $("#sb" + n).value.trim();
    if (sa === "" && sb === "") continue;
    const a = Number(sa), b = Number(sb);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 7 || b > 7) {
      err.textContent = "Set " + n + " nedává tenisové skóre.";
      return;
    }
    if (!setWon(a, b) && !setWon(b, a)) { err.textContent = "Set " + n + " není uzavřený (6 s rozdílem dvou, nebo 7:5 a 7:6)."; return; }
    sets.push([a, b]);
  }
  if (!sets.length) { err.textContent = "Doplňte aspoň jeden set."; return; }
  const w1 = sets.filter(([a, b]) => setWon(a, b)).length;
  const w2 = sets.length - w1;
  if (Math.max(w1, w2) < 2 || (winnerIdx === 0 && w1 <= w2) || (winnerIdx === 1 && w2 <= w1)) {
    err.textContent = "Vítěz nesedí na zapsané sety.";
    return;
  }
  const [p1, p2] = m.players;
  const store = loadStore();
  const surf = m.surface;
  function cur(name, rank) {
    if (!store.ratings[name]) store.ratings[name] = {};
    if (store.ratings[name][surf] == null) store.ratings[name][surf] = rating(rank);
    return store.ratings[name][surf];
  }
  const ra0 = cur(p1.name, p1.rank), rb0 = cur(p2.name, p2.rank);
  const ea = 1 / (1 + Math.pow(10, (rb0 - ra0) / 400));
  const sa = winnerIdx === 0 ? 1 : 0;
  const ra1 = ra0 + K * (sa - ea);
  const rb1 = rb0 + K * ((1 - sa) - (1 - ea));
  store.ratings[p1.name][surf] = Math.round(ra1 * 10) / 10;
  store.ratings[p2.name][surf] = Math.round(rb1 * 10) / 10;
  store.results.unshift({
    id: m.id, at: new Date().toISOString(), tournament: m.tournament, surface: m.surface_label,
    winner: winnerIdx === 0 ? p1.name : p2.name, loser: winnerIdx === 0 ? p2.name : p1.name,
    sets: sets.map(([a, b]) => a + "-" + b).join(" "),
    dWinner: Math.round((winnerIdx === 0 ? ra1 - ra0 : rb1 - rb0) * 10) / 10,
    dLoser: Math.round((winnerIdx === 0 ? rb1 - rb0 : ra1 - ra0) * 10) / 10
  });
  saveStore(store);
  err.textContent = "";
  renderBoard();
  renderRecord();
  openDrawer(m.id);
  $("#res-err").textContent = `Elo: ${p1.name} ${ra0.toFixed(0)} → ${ra1.toFixed(0)} (${(ra1-ra0)>=0?"+":""}${(ra1-ra0).toFixed(1)}), ${p2.name} ${rb0.toFixed(0)} → ${rb1.toFixed(0)} (${(rb1-rb0)>=0?"+":""}${(rb1-rb0).toFixed(1)}).`;
}

function renderUpcoming() {
  const box = $("#upcoming-list");
  if (!box) return;
  const list = state.data.upcoming.filter((e) => {
    if (state.up === "all") return true;
    if (state.up === "atp") return e.tour === "atp";
    if (state.up === "wta") return e.tour === "wta";
    return e.tour === "atp_challenger" || e.tour === "wta_125";
  });
  const events = list.map((e) => {
    const matches = (e.matches && e.matches.length) ? e.matches.map((x) => `<p>${x}</p>`).join("") : `<p><span class="tag">pavouk zatím není</span></p>`;
    return `<article class="event"><div class="meta">${fmtDate(e.start)} – ${fmtDate(e.end)}</div><div><h3>${e.name}</h3><p class="meta">${e.city} · ${e.level} · ${e.surface_label}</p>${matches}<p class="why">${e.note || ""}</p><p class="src">${e.sources.map((u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).join("<br>")}</p></div></article>`;
  }).join("");
  const notes = (state.data.upcoming_notes || []).map((n) => `<div class="gap">${n}</div>`).join("");
  box.innerHTML = events + notes || `<div class="empty-hero"><p class="empty-kicker">Nic ve filtru</p></div>`;
}

function renderRecord() {
  const box = $("#record-body");
  if (!box) return;
  const store = loadStore();
  const rows = store.results || [];
  if (!rows.length) {
    box.innerHTML = `<div class="empty-hero"><p class="empty-kicker">zatím žádné uzavřené tipy</p><p>V tomto prohlížeči není zapsaný výsledek. Historické ROI se nevymýšlí. Až zápas zapíšete v detailu, objeví se tady i s posunem Elo. Výnos by šel počítat jen tam, kde byl v okamžiku zápasu uložen skutečný kurz. Tady ten výpočet schválně není, protože skoro nikde kurz nebyl.</p></div>`;
    return;
  }
  box.innerHTML = `<p>Zápisy jen z tohoto prohlížeče. Žádné historické ROI.</p>` +
    rows.map((r) => `<div class="gap"><strong>${r.winner}</strong> porazil ${r.loser} ${r.sets}<br><span class="meta">${r.tournament} · ${r.surface} · Elo vítěze ${r.dWinner > 0 ? "+" : ""}${r.dWinner}, poraženého ${r.dLoser > 0 ? "+" : ""}${r.dLoser}</span></div>`).join("") +
    `<p><button type="button" id="wipe" class="ghost">Smazat místní Elo</button></p>`;
  $("#wipe").addEventListener("click", () => { localStorage.removeItem(STORE); renderBoard(); renderRecord(); });
}

function renderGaps() {
  const d = state.data;
  $("#gaps").innerHTML = `<h2>Co v datech chybí</h2>` +
    d.unavailable.map((u) => `<div class="unav"><strong>${u.circuit}</strong> — ${u.state}. ${u.detail}<div class="src">${u.sources.map((s) => `<a href="${s}">${s}</a>`).join("<br>")}</div></div>`).join("") +
    d.gaps.map((g) => `<div class="gap">${g}</div>`).join("") +
    `<div class="gap">Další pokus o kurzy 3. 10.: Oddsportal ATP Beijing bez čísel, Flashscore bez desetinných linií zápasů. Původní dva snímky Tennis Tonic zůstávají. Obnovení načítá jen data.json.</div>`;
}
function renderLede() {
  const d = state.data;
  const n = d.matches.length;
  const o = d.matches.filter((m) => m.odds).length;
  $("#lede-text").textContent = `${n} ověřených zápasů dvouhry na 3. 10. 2026. Kurzy jsou u ${o} z nich. Kde je v prohlížeči Elo, deska ho použije místo žebříčkového prioru.`;
  $("#odds-banner").textContent = "Kurzy: snímek, ne websocket. Obnovení znovu načte data.json. Nové kurzy se samy nestáhnou.";
  $("#foot-time").textContent = "Snímek sestaven " + d.fetched_at + " (Evropa/Praha).";
}
function showPage(page) {
  state.page = page;
  ["board","upcoming","method","record"].forEach((p) => $("#page-" + p).classList.toggle("hidden", p !== page));
  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.page === page));
  if (page === "record") renderRecord();
  if (page === "upcoming") renderUpcoming();
}
async function load() {
  const res = await fetch("data.json?t=" + Date.now());
  state.data = await res.json();
  renderLede();
  renderBoard();
  renderGaps();
  renderUpcoming();
  if (state.page === "record") renderRecord();
}
document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));
$("#tour-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.tour = btn.dataset.tour;
  [...$("#tour-filter").children].forEach((c) => c.classList.toggle("on", c === btn));
  $("#ch-filter").classList.toggle("hidden", state.tour !== "challenger");
  renderBoard();
});
$("#ch-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.ch = btn.dataset.ch;
  [...$("#ch-filter").children].forEach((c) => c.classList.toggle("on", c === btn));
  renderBoard();
});
$("#up-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.up = btn.dataset.uptour;
  [...$("#up-filter").children].forEach((c) => c.classList.toggle("on", c === btn));
  renderUpcoming();
});
$("#surface").addEventListener("change", (e) => { state.surface = e.target.value; renderBoard(); });
$("#minconf").addEventListener("input", (e) => { state.min = Number(e.target.value); $("#minconf-label").textContent = state.min + " %"; renderBoard(); });
$("#doubles").addEventListener("change", (e) => { state.doubles = e.target.checked; renderBoard(); });
$("#reload").addEventListener("click", load);
$("#drawer-close").addEventListener("click", () => { $("#drawer").hidden = true; });
$("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") $("#drawer").hidden = true; });
load();
