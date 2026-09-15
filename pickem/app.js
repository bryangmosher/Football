(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------
  if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
    document.getElementById('content').innerHTML =
      '<div class="empty-state"><div class="display">Not configured yet</div>' +
      '<div>Edit config.js with your Supabase URL and anon key.</div></div>';
    return;
  }

  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  let myUid = null;
  let players = [];       // [{id, name, claimed_by}]
  let myPlayer = null;    // the row in `players` claimed by me, once known
  let weeks = [];         // [{id, week_number, season, season_type, pick_deadline, status}]
  let activeWeekId = null;
  let gamesCache = {};    // weekId -> games[]
  let currentView = 'home';

  const contentEl = document.getElementById('content');
  const whoBoxEl = document.getElementById('whoBox');

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      render();
    });
  });

  document.getElementById('weekPicker').addEventListener('change', (e) => {
    const weekId = e.target.value;
    if (!weekId) return;
    activeWeekId = weekId;
    currentView = 'week';
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'week'));
    render();
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  (async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) {
        contentEl.innerHTML = '<div class="empty-state"><div class="display">Sign-in failed</div><div>' +
          escapeHtml(error.message) + ' — make sure Anonymous Sign-ins are enabled in your Supabase project (Authentication &rarr; Sign In / Providers).</div></div>';
        return;
      }
      myUid = data.user.id;
    } else {
      myUid = session.user.id;
    }

    await loadPlayers();
    myPlayer = players.find((p) => p.claimed_by === myUid) || null;

    await loadWeeks();
    activeWeekId = determineCurrentWeekId();

    render();
  })();

  // ---------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------
  async function loadPlayers() {
    const { data, error } = await sb.from('players').select('id,name,claimed_by,has_pin').order('name');
    players = error ? [] : data;
  }

  async function loadWeeks() {
    const { data, error } = await sb
      .from('weeks')
      .select('*')
      .order('season', { ascending: true })
      .order('season_type', { ascending: true })
      .order('week_number', { ascending: true });
    weeks = error ? [] : data;
  }

  // The "current" week is determined by explicit calendar-date ranges (all
  // Mountain time), not by pick_deadline or sync order:
  //   Week 1: Sept 6 – Sept 15
  //   Week 2: Sept 16 – Sept 22
  //   Week 3: Sept 23 – Sept 29
  //   ...and every week after that is a consecutive 7-day block from there.
  //
  // NOTE: WEEK1_START/WEEK1_END/WEEK2_START are specific to the 2026 season.
  // Update these three lines at the start of each new NFL season.
  const WEEK1_START = '2026-09-06';
  const WEEK1_END = '2026-09-14';
  const WEEK2_START = '2026-09-15';

  function getMountainDateString(date) {
    // en-CA formats as YYYY-MM-DD, which also sorts/compares correctly as a string.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(date || new Date());
  }

  function addDaysToDateString(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function weekDateRange(weekNumber) {
    if (weekNumber <= 1) return { start: WEEK1_START, end: WEEK1_END };
    const start = addDaysToDateString(WEEK2_START, (weekNumber - 2) * 7);
    const end = addDaysToDateString(start, 6);
    return { start, end };
  }

  // Converts a Y/M/D H:M wall-clock time in America/New_York into the
  // correct UTC instant, accounting for EDT/EST automatically.
  function nyWallTimeToUtc(year, month, day, hour, minute) {
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(guess).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
    const asIfLocalWereUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const offset = asIfLocalWereUtc - guess.getTime();
    return new Date(guess.getTime() - offset);
  }

  // Picks open Tuesday 8:00 AM ET of that week (matches the server-side check).
  function weekOpensAt(weekNumber) {
    const [y, m, d] = weekDateRange(weekNumber).start.split('-').map(Number);
    return nyWallTimeToUtc(y, m, d, 10, 0);
  }

  function determineCurrentWeekId() {
    if (!weeks.length) return null;
    const today = getMountainDateString();

    // Exact match: today falls within a synced week's date range.
    for (const w of weeks) {
      const { start, end } = weekDateRange(w.week_number);
      if (today >= start && today <= end) return w.id;
    }

    // No exact match (e.g. a gap week hasn't been synced yet) — fall back to
    // whichever synced week's range most recently started.
    let best = null;
    let bestStart = null;
    for (const w of weeks) {
      const { start } = weekDateRange(w.week_number);
      if (start <= today && (bestStart === null || start > bestStart)) {
        best = w;
        bestStart = start;
      }
    }
    if (best) return best.id;

    // Today is before Week 1 even starts — default to the earliest known week.
    return weeks[0].id;
  }

  async function loadGames(weekId) {
    if (gamesCache[weekId]) return gamesCache[weekId];
    const { data, error } = await sb.from('games').select('*').eq('week_id', weekId).order('commence_time');
    gamesCache[weekId] = error ? [] : data;
    return gamesCache[weekId];
  }

  async function loadSubmissionStatus(weekId) {
    const { data, error } = await sb.rpc('submission_status', { p_week_id: weekId });
    return error ? [] : data;
  }

  async function loadMyPicks(weekId, playerId) {
    const { data, error } = await sb.from('picks').select('*').eq('week_id', weekId).eq('player_id', playerId);
    return error ? [] : data;
  }

  async function loadPickResults(weekId) {
    const { data, error } = await sb.from('v_pick_results').select('*').eq('week_id', weekId);
    return error ? [] : data;
  }

  async function loadLeaderboard() {
    const { data, error } = await sb.from('v_leaderboard').select('*');
    return error ? [] : data;
  }

  async function loadParlayPicker(weekId) {
    const { data, error } = await sb.rpc('parlay_picker_for_week', { p_week_id: weekId });
    return error ? null : data;
  }

  async function loadParlay(weekId) {
    const { data, error } = await sb
      .from('parlays')
      .select('*, parlay_picks(*)')
      .eq('week_id', weekId)
      .maybeSingle();
    return error ? null : data;
  }

  async function loadParlayIsSet(weekId) {
    const { data, error } = await sb.rpc('parlay_is_set', { p_week_id: weekId });
    return error ? false : data;
  }

  async function loadSuggestedParlayAmount(currentIdx) {
    if (currentIdx <= 0) return null;
    const prevWeek = weeks[currentIdx - 1];
    const { data, error } = await sb
      .from('v_weekly_pot_contribution')
      .select('parlay_contribution')
      .eq('week_id', prevWeek.id)
      .maybeSingle();
    if (error || !data) return null;
    return Number(data.parlay_contribution);
  }

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------
  function render() {
    renderWhoBox();
    populateWeekPicker();
    if (currentView === 'home') renderHome();
    else if (currentView === 'champions') renderChampions();
    else renderWeekView();
  }

  function populateWeekPicker() {
    const el = document.getElementById('weekPicker');
    if (!el) return;
    const options = ['<option value="">Choose Week</option>']
      .concat(weeks.map((w) => `<option value="${w.id}">${escapeHtml(weekLabel(w))}</option>`));
    el.innerHTML = options.join('');
    el.value = '';
  }

  function renderWhoBox() {
    if (myPlayer) {
      whoBoxEl.innerHTML = `Playing as <strong>${escapeHtml(myPlayer.name)}</strong>`;
    } else {
      whoBoxEl.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------------
  // Home view: leaderboard + week list + admin sync
  // ---------------------------------------------------------------------
  function weekListHtml() {
    const openWeeks = weeks.filter((w) => new Date() >= weekOpensAt(w.week_number));
    if (!openWeeks.length) {
      return '<p class="hint">No weeks are open for picks yet.</p>';
    }
    let h = '<div class="week-list">';
    openWeeks.slice().reverse().forEach((w) => {
      const label = weekLabel(w);
      const passed = isPast(w.pick_deadline);
      h += `<div class="week-list-item" data-week="${w.id}">
        <span>${escapeHtml(label)}</span>
        <span class="badge">${passed ? 'Picks closed' : 'Picks open'}</span>
      </div>`;
    });
    h += '</div>';
    return h;
  }

  function wireWeekListClicks(container) {
    container.querySelectorAll('.week-list-item').forEach((el) => {
      el.addEventListener('click', () => {
        activeWeekId = el.dataset.week;
        currentView = 'week';
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === 'week'));
        render();
      });
    });
  }

  async function loadMoneySummary() {
    const [parlayRes, potRes, recordRes] = await Promise.all([
      sb.from('v_parlay_summary').select('*'),
      sb.from('v_weekly_pot_contribution').select('*'),
      sb.from('v_weekly_player_record').select('*'),
    ]);
    const parlays = parlayRes.error ? [] : parlayRes.data;
    const potRows = potRes.error ? [] : potRes.data;
    const recordRows = recordRes.error ? [] : recordRes.data;

    const totalParlayWinnings = parlays.reduce((sum, p) => sum + (Number(p.payout_collected) || 0), 0);
    const totalWeeklyContributions = potRows.reduce((sum, r) => sum + (Number(r.pot_contribution) || 0), 0);
    const totalPot = totalParlayWinnings + totalWeeklyContributions;

    // Winner(s) per week — whoever has the most wins that week; ties show everyone tied.
    const recordsByWeek = {};
    recordRows.forEach((r) => {
      if (!recordsByWeek[r.week_id]) recordsByWeek[r.week_id] = [];
      recordsByWeek[r.week_id].push(r);
    });
    const winnersByWeek = {};
    Object.keys(recordsByWeek).forEach((weekId) => {
      const rows = recordsByWeek[weekId];
      const maxWins = Math.max(...rows.map((r) => r.wins));
      winnersByWeek[weekId] = rows.filter((r) => r.wins === maxWins).map((r) => playerNameById(r.player_id));
    });

    return { totalPot, totalWeeklyContributions, totalParlayWinnings, parlays, potRows, winnersByWeek };
  }


  async function loadSeasonChampions() {
    const [seasonsRes, recordsRes] = await Promise.all([
      sb.from('season_champions').select('*'),
      sb.from('season_player_records').select('*'),
    ]);
    const seasons = seasonsRes.error ? [] : seasonsRes.data;
    const records = recordsRes.error ? [] : recordsRes.data;
    seasons.sort((a, b) => (a.season_label < b.season_label ? 1 : -1));
    const recordsBySeason = {};
    records.forEach((r) => {
      if (!recordsBySeason[r.season_label]) recordsBySeason[r.season_label] = [];
      recordsBySeason[r.season_label].push(r);
    });
    return { seasons, recordsBySeason };
  }

  async function renderChampions() {
    contentEl.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
    const { seasons, recordsBySeason } = await loadSeasonChampions();

    let html = `<div class="champions-hero">
      <div class="champions-hero-title">🏆 Hall of Champions 🏆</div>
      <div class="champions-hero-sub">Every season, one champion. Here's who's earned bragging rights.</div>
    </div>`;

    if (!seasons.length) {
      html += '<div class="empty-state"><div class="display">No seasons recorded yet</div></div>';
    } else {
      seasons.forEach((s) => {
        const rows = (recordsBySeason[s.season_label] || []).slice().sort((a, b) => b.correct_picks - a.correct_picks);
        html += `<div class="card champion-card">`;
        html += `<h2>${escapeHtml(s.season_label)}</h2>`;
        if (s.note) {
          html += `<p class="hint champion-note">🔒 ${escapeHtml(s.note)}</p>`;
        } else if (!rows.length) {
          html += `<p class="hint">No records for this season yet.</p>`;
        } else {
          const topScore = rows[0].correct_picks;
          html += `<table class="leaderboard-table"><thead><tr><th>Player</th><th class="num">Correct</th><th class="num">Incorrect</th><th class="num">Ties</th></tr></thead><tbody>`;
          rows.forEach((r) => {
            const isChamp = r.correct_picks === topScore;
            html += `<tr class="${isChamp ? 'champion-row' : ''}">
              <td>${isChamp ? '🏆 ' : ''}${escapeHtml(r.player_name)}</td>
              <td class="num">${r.correct_picks}</td>
              <td class="num">${r.incorrect_picks}</td>
              <td class="num">${r.ties}</td>
            </tr>`;
          });
          html += '</tbody></table>';
        }
        html += '</div>';
      });
    }

    html += `<details class="admin-box">
      <summary>Admin: record this season's champion</summary>
      <p class="hint">Snapshots the current live leaderboard into the Champions history under the season label you enter. Safe to re-run later if you record early and want to refresh it once the season's truly done.</p>
      <div class="admin-row">
        <input type="text" id="seasonLabelInput" placeholder="e.g. 2026-2027"/>
        <button class="btn" id="recordSeasonBtn">Record champion</button>
      </div>
      <div class="status-msg" id="recordSeasonStatus"></div>
    </details>`;

    contentEl.innerHTML = html;

    document.getElementById('recordSeasonBtn').addEventListener('click', async () => {
      const statusEl = document.getElementById('recordSeasonStatus');
      const label = document.getElementById('seasonLabelInput').value.trim();
      if (!label) {
        statusEl.className = 'status-msg error';
        statusEl.textContent = 'Enter a season label first.';
        return;
      }
      statusEl.className = 'status-msg';
      statusEl.textContent = 'Recording…';
      const { error } = await sb.rpc('record_season_champion', { p_season_label: label });
      if (error) {
        statusEl.className = 'status-msg error';
        statusEl.textContent = error.message;
        return;
      }
      statusEl.className = 'status-msg ok';
      statusEl.textContent = `Recorded ${label}.`;
      renderChampions();
    });
  }

  async function renderHome() {
    contentEl.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
    const leaderboard = await loadLeaderboard();

    let html = '<div class="card"><h2>Season leaderboard</h2>';
    if (!leaderboard.length || leaderboard.every((r) => r.wins + r.losses + r.pushes === 0)) {
      html += '<p class="hint">No graded picks yet — the leaderboard fills in once weeks are played and revealed.</p>';
    } else {
      html += `<table class="leaderboard-table"><thead><tr><th>Player</th><th class="num">W</th><th class="num">L</th><th class="num">T</th></tr></thead><tbody>`;
      leaderboard.forEach((r) => {
        html += `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.wins}</td><td class="num">${r.losses}</td><td class="num">${r.pushes}</td></tr>`;
      });
      html += '</tbody></table>';
    }
    html += '</div>';

    const money = await loadMoneySummary();
    const potByWeek = {};
    money.potRows.forEach((r) => (potByWeek[r.week_id] = r));
    const parlayByWeek = {};
    money.parlays.forEach((p) => (parlayByWeek[p.week_id] = p));

    html += `<div class="card"><h2>Money</h2>
      <div style="display:flex;gap:20px;flex-wrap:wrap;">
        <div><div class="hint">Total pot</div><div class="record display" style="font-size:22px;">$${money.totalPot.toFixed(2)}</div></div>
        <div><div class="hint">Weekly contributions</div><div class="record display" style="font-size:22px;">$${money.totalWeeklyContributions.toFixed(2)}</div></div>
        <div><div class="hint">Parlay winnings</div><div class="record display" style="font-size:22px;">$${money.totalParlayWinnings.toFixed(2)}</div></div>
      </div>`;

    if (weeks.length) {
      html += `<div class="table-scroll"><table class="leaderboard-table" style="margin-top:14px;">
        <thead><tr><th>Week</th><th>Winner</th><th class="num">Into the Pot</th><th class="num">Next week's parlay bet</th><th class="num">Parlay winnings</th></tr></thead><tbody>`;
      weeks.forEach((w) => {
        const potRow = potByWeek[w.id];
        const contribCell = potRow ? `$${Number(potRow.pot_contribution).toFixed(2)}` : '';
        const nextParlayCell = potRow ? `$${Number(potRow.parlay_contribution).toFixed(2)}` : '';
        const winnerNames = money.winnersByWeek[w.id];
        const winnerCell = winnerNames && winnerNames.length ? escapeHtml(winnerNames.join(', ')) : '';

        const parlay = parlayByWeek[w.id];
        const collected = parlay ? Number(parlay.payout_collected) || 0 : 0;
        const winningsCell = collected > 0
          ? `$${collected.toFixed(2)}`
          : `<span class="result-push" style="opacity:0.8;">$0.00</span>`;

        html += `<tr>
          <td>${escapeHtml(weekLabel(w))}</td>
          <td>${winnerCell}</td>
          <td class="num">${contribCell}</td>
          <td class="num">${nextParlayCell}</td>
          <td class="num">${winningsCell}</td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    }

    html += '</div>';

    html += '<div class="card"><h2>Weeks</h2><div id="weekListContainer">';
    html += weekListHtml();
    html += '</div></div>';

    html += `<details class="admin-box">
      <summary>Admin: sync schedule &amp; spreads</summary>
      <p class="hint">Choose which source to pull from. Nothing falls back silently — if you pick ESPN and it fails, it fails, so you know to try the backup or enter lines yourself.</p>
      <div class="admin-row">
        <input type="text" id="syncWeekInput" placeholder="Week #"/>
        <input type="text" id="syncYearInput" placeholder="${new Date().getFullYear()}"/>
        <select id="syncSeasonType">
          <option value="2">Regular season</option>
          <option value="1">Preseason</option>
          <option value="3">Playoffs</option>
        </select>
      </div>
      <p class="hint">Leave week/year blank to auto-detect the current week (ESPN and Backup only — Manual always needs them filled in).</p>
      <div class="admin-row">
        <button class="btn" id="useEspnBtn">Use ESPN</button>
        <button class="btn secondary" id="useBackupBtn">Use Backup</button>
        <button class="btn secondary" id="useManualBtn">Use Manual Lines</button>
      </div>
      <div class="status-msg" id="syncStatus"></div>
      <div id="syncResultGames"></div>

      <div style="margin-top:18px;padding-top:14px;border-top:1px dashed var(--line);">
        <h3 style="font-family:'Oswald',sans-serif;font-size:15px;font-weight:500;margin:0 0 4px;">Final scores</h3>
        <p class="hint">Separate from the lines above — this only fills in final scores for games already synced, so correct picks get highlighted. It never touches spreads. Fill in the week/year above, then use once games are final.</p>
        <div class="admin-row">
          <button class="btn" id="pullScoresBtn">Pull final scores</button>
        </div>
        <div class="status-msg" id="scoresStatus"></div>
      </div>

      <div id="manualEntryForm" style="display:none;margin-top:16px;padding-top:14px;border-top:1px dashed var(--line);">
        <h3 style="font-family:'Oswald',sans-serif;font-size:15px;font-weight:500;margin:0 0 8px;">Manual lines</h3>
        <p class="hint">One game per line: Away, Spread, Home (spread optional). Example:<br>Chiefs, -3.5, Broncos</p>
        <textarea id="manualGamesText" placeholder="Chiefs, -3.5, Broncos&#10;Cowboys, 2, Eagles" style="width:100%;min-height:100px;background:var(--surface-raised);border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:10px;font-size:13px;font-family:'Inter',sans-serif;margin-bottom:10px;"></textarea>
        <div class="admin-row">
          <label class="hint" style="display:flex;flex-direction:column;gap:4px;">Pick deadline
            <input type="datetime-local" id="manualDeadlineInput" style="background:var(--surface-raised);border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:7px 9px;font-size:13px;"/>
          </label>
          <button class="btn" id="saveManualBtn">Save manual lines</button>
        </div>
      </div>
    </details>`;

    contentEl.innerHTML = html;
    wireWeekListClicks(contentEl);

    function currentAdminInputs() {
      return {
        week: document.getElementById('syncWeekInput').value.trim(),
        year: document.getElementById('syncYearInput').value.trim(),
        seasontype: document.getElementById('syncSeasonType').value,
      };
    }

    document.getElementById('useEspnBtn').addEventListener('click', () => {
      document.getElementById('manualEntryForm').style.display = 'none';
      const { week, year, seasontype } = currentAdminInputs();
      runSync({ ...(week ? { week } : {}), ...(year ? { year } : {}), seasontype, source: 'espn' });
    });

    document.getElementById('useBackupBtn').addEventListener('click', () => {
      document.getElementById('manualEntryForm').style.display = 'none';
      const { week, year, seasontype } = currentAdminInputs();
      runSync({ ...(week ? { week } : {}), ...(year ? { year } : {}), seasontype, source: 'odds_api' });
    });

    document.getElementById('useManualBtn').addEventListener('click', () => {
      const form = document.getElementById('manualEntryForm');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('pullScoresBtn').addEventListener('click', async () => {
      const { week, year, seasontype } = currentAdminInputs();
      const statusEl = document.getElementById('scoresStatus');
      if (!week || !year) {
        statusEl.className = 'status-msg error';
        statusEl.textContent = 'Enter the week number and season year above first.';
        return;
      }
      statusEl.className = 'status-msg';
      statusEl.textContent = 'Pulling final scores…';
      try {
        const headers = window.ADMIN_SYNC_KEY ? { 'x-admin-key': window.ADMIN_SYNC_KEY } : {};
        const qp = new URLSearchParams({ week, year, seasontype, scores_only: '1' }).toString();
        const res = await fetch('/.netlify/functions/sync-week?' + qp, { headers });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'failed to pull scores');
        const finalCount = (data.games || []).filter((g) => g.completed).length;
        statusEl.className = 'status-msg ok';
        statusEl.textContent = `Checked ${data.games_written} games — ${finalCount} final so far.`;
        gamesCache = {};
      } catch (e) {
        statusEl.className = 'status-msg error';
        statusEl.textContent = e.message;
      }
    });

    document.getElementById('saveManualBtn').addEventListener('click', async () => {
      const { week, year, seasontype } = currentAdminInputs();
      const deadlineVal = document.getElementById('manualDeadlineInput').value;
      const text = document.getElementById('manualGamesText').value;
      const games = parseGameLines(text);
      if (!week || !year) {
        setSyncStatus('Enter a week number and season year above first.', 'error');
        return;
      }
      if (!games.length) {
        setSyncStatus('Enter at least one game.', 'error');
        return;
      }
      if (!deadlineVal) {
        setSyncStatus('Set a pick deadline.', 'error');
        return;
      }
      await runSync(
        { week, year, seasontype },
        { method: 'POST', body: { week, year, seasontype, pick_deadline: new Date(deadlineVal).toISOString(), games } }
      );
    });
  }

  function parseGameLines(text) {
    const games = [];
    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split(trimmed.includes('\t') ? '\t' : ',').map((p) => p.trim());
      if (parts.length < 2) return;
      const numeric = (v) => v !== '' && !isNaN(Number(v));
      if (parts.length === 2) {
        games.push({ away_team: parts[0], home_team: parts[1], spread: '' });
      } else if (numeric(parts[1])) {
        games.push({ away_team: parts[0], spread: parts[1], home_team: parts[2] });
      } else if (numeric(parts[2])) {
        games.push({ away_team: parts[0], home_team: parts[1], spread: parts[2] });
      } else {
        games.push({ away_team: parts[0], home_team: parts[1], spread: '' });
      }
    });
    return games.filter((g) => g.away_team && g.home_team);
  }

  async function runSync(queryParams, opts) {
    setSyncStatus('Syncing…', '');
    document.getElementById('syncResultGames').innerHTML = '';
    try {
      const headers = window.ADMIN_SYNC_KEY ? { 'x-admin-key': window.ADMIN_SYNC_KEY } : {};
      let res;
      if (opts && opts.method === 'POST') {
        res = await fetch('/.netlify/functions/sync-week', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(opts.body),
        });
      } else {
        const qp = new URLSearchParams(queryParams).toString();
        res = await fetch('/.netlify/functions/sync-week' + (qp ? '?' + qp : ''), { headers });
      }
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'sync failed');
      setSyncStatus(`Loaded week ${data.week} (${data.season}) — ${data.games_written} games from ${data.source}.`, 'ok');
      renderSyncedGames(data.games || []);
      gamesCache = {};
      await loadWeeks();
      activeWeekId = determineCurrentWeekId();
      const listContainer = document.getElementById('weekListContainer');
      if (listContainer) {
        listContainer.innerHTML = weekListHtml();
        wireWeekListClicks(listContainer);
      }
    } catch (e) {
      setSyncStatus(e.message, 'error');
    }
  }

  function renderSyncedGames(games) {
    const el = document.getElementById('syncResultGames');
    if (!el || !games.length) return;
    el.innerHTML = '<div class="hint" style="margin-top:10px;">' +
      games.map((g) => {
        const spreadTxt = g.spread == null || g.spread === '' ? 'no line' : (g.spread < 0 ? g.spread : '+' + g.spread);
        return `${escapeHtml(g.away_team)} (${spreadTxt}) at ${escapeHtml(g.home_team)}`;
      }).join('<br>') +
      '</div>';
  }

  function setSyncStatus(msg, cls) {
    const el = document.getElementById('syncStatus');
    if (el) {
      el.textContent = msg;
      el.className = 'status-msg' + (cls ? ' ' + cls : '');
    }
  }

  // ---------------------------------------------------------------------
  // Week view
  // ---------------------------------------------------------------------
  async function renderWeekView() {
    contentEl.innerHTML = '<div class="empty-state">Loading&hellip;</div>';

    if (!weeks.length) {
      contentEl.innerHTML = '<div class="empty-state"><div class="display">No weeks yet</div><div>Go to Home and use "Sync now" to load the current week.</div></div>';
      return;
    }
    if (!activeWeekId) activeWeekId = determineCurrentWeekId();

    if (!myPlayer) {
      renderPlayerGate();
      return;
    }

    const week = weeks.find((w) => w.id === activeWeekId);
    const idx = weeks.findIndex((w) => w.id === activeWeekId);
    const games = await loadGames(week.id);
    const revealed = await sb.rpc('is_week_revealed', { p_week_id: week.id }).then((r) => (r.error ? false : r.data));
    const submissionStatus = await loadSubmissionStatus(week.id);
    const myPicks = await loadMyPicks(week.id, myPlayer.id);
    const parlayPicker = await loadParlayPicker(week.id);
    const parlay = await loadParlay(week.id);
    const parlayIsSet = await loadParlayIsSet(week.id);
    const suggestedAmount = await loadSuggestedParlayAmount(idx);

    let html = `<div class="week-nav">
      <button id="prevWeekBtn" ${idx <= 0 ? 'disabled' : ''}>&larr; Prev</button>
      <span class="week-title display">${escapeHtml(weekLabel(week))}</span>
      <button id="nextWeekBtn" ${idx >= weeks.length - 1 ? 'disabled' : ''}>Next &rarr;</button>
    </div>`;

    const passed = isPast(week.pick_deadline);
    const opensAt = weekOpensAt(week.week_number);
    const notOpenYet = new Date() < opensAt;
    if (notOpenYet) {
      html += `<div class="deadline-banner">
        Picks for this week open <strong>${escapeHtml(fmtDeadline(opensAt.toISOString()))}</strong>
      </div>`;
    } else {
      html += `<div class="deadline-banner ${passed ? 'passed' : ''}">
        ${passed ? 'Picks closed' : 'Picks lock'} <strong>${escapeHtml(fmtDeadline(week.pick_deadline))}</strong>
      </div>`;
    }

    html += renderParlaySection(week, games, parlayPicker, parlay, passed || notOpenYet, suggestedAmount, notOpenYet, parlayIsSet);

    if (revealed) {
      html += await renderRevealSection(week, games);
    } else if (myPicks.length > 0) {
      html += renderLockedSection(games, myPicks, submissionStatus);
    } else if (notOpenYet) {
      html += `<div class="card"><h2>Not open yet</h2><p class="hint">This week's picks open ${escapeHtml(fmtDeadline(opensAt.toISOString()))}, once real spreads have been synced in.</p></div>`;
    } else if (passed) {
      html += `<div class="card"><h2>Picks are closed</h2><p class="hint">The deadline passed and you didn't submit picks for this week.</p></div>`;
      html += renderSubmissionStatus(submissionStatus);
    } else {
      html += renderPickForm(week, games, submissionStatus);
    }

    contentEl.innerHTML = html;
    wireWeekNav(idx);
    if (!revealed && myPicks.length === 0 && !passed && !notOpenYet) wirePickForm(week, games);
    if (!parlay && parlayPicker && myPlayer && parlayPicker.id === myPlayer.id && !passed && !notOpenYet) {
      wireParlayForm(week, games);
    }
    if (parlay) {
      wireParlayAmountSave(parlay);
      wireParlayPayoutSave(parlay);
      wireParlayCollectedSave(parlay);
    }
  }

  function wireParlayAmountSave(parlay) {
    const btn = document.getElementById('saveAmountBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const statusEl = document.getElementById('amountStatus');
      const val = document.getElementById('parlayAmountEdit').value;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      statusEl.textContent = '';
      statusEl.className = 'status-msg';
      const { error } = await sb.rpc('set_parlay_amount', {
        p_parlay_id: parlay.id,
        p_amount: val === '' ? null : Number(val),
      });
      if (error) {
        statusEl.textContent = error.message;
        statusEl.className = 'status-msg error';
        btn.disabled = false;
        btn.textContent = 'Save';
        return;
      }
      renderWeekView();
    });
  }

  function wireParlayPayoutSave(parlay) {
    const btn = document.getElementById('savePayoutBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const statusEl = document.getElementById('payoutStatus');
      const val = document.getElementById('parlayPayoutEdit').value;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      statusEl.textContent = '';
      statusEl.className = 'status-msg';
      const { error } = await sb.rpc('set_parlay_payout', {
        p_parlay_id: parlay.id,
        p_payout: val === '' ? null : Number(val),
      });
      if (error) {
        statusEl.textContent = error.message;
        statusEl.className = 'status-msg error';
        btn.disabled = false;
        btn.textContent = 'Save';
        return;
      }
      renderWeekView();
    });
  }

  function wireParlayCollectedSave(parlay) {
    const btn = document.getElementById('saveCollectedBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const statusEl = document.getElementById('collectedStatus');
      const val = document.getElementById('parlayCollectedEdit').value;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      statusEl.textContent = '';
      statusEl.className = 'status-msg';
      const { error } = await sb.rpc('set_parlay_collected', {
        p_parlay_id: parlay.id,
        p_amount: val === '' ? null : Number(val),
      });
      if (error) {
        statusEl.textContent = error.message;
        statusEl.className = 'status-msg error';
        btn.disabled = false;
        btn.textContent = 'Save';
        return;
      }
      renderWeekView();
    });
  }

  function renderPlayerGate() {
    contentEl.innerHTML = `<div class="card" style="text-align:center;">
      <h2>Who are you?</h2>
      <p class="hint">Pick your name, then enter your 4-digit PIN.</p>
      <div class="player-select" id="playerSelect"></div>
      <div id="pinEntry" style="display:none;"></div>
      <div class="status-msg error" id="claimStatus"></div>
    </div>`;
    const el = document.getElementById('playerSelect');
    el.innerHTML = players
      .map((p) => `<button class="player-btn" data-id="${p.id}" data-name="${escapeAttr(p.name)}">${escapeHtml(p.name)}</button>`)
      .join('');
    el.querySelectorAll('.player-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const player = players.find((p) => p.id === btn.dataset.id);
        if (player && player.has_pin) {
          showPinEntry(btn.dataset.id, btn.dataset.name);
        } else {
          showSetPinEntry(btn.dataset.id, btn.dataset.name);
        }
      });
    });
  }

  function showSetPinEntry(playerId, playerName) {
    document.getElementById('claimStatus').textContent = '';
    document.getElementById('playerSelect').style.display = 'none';
    const pinEl = document.getElementById('pinEntry');
    pinEl.style.display = 'block';
    pinEl.innerHTML = `
      <p class="hint">This is ${escapeHtml(playerName)}'s first time here — choose a 4-digit PIN.<br>You'll enter this same PIN next time to be recognized as ${escapeHtml(playerName)}.</p>
      <div style="display:flex;flex-direction:column;gap:10px;align-items:center;">
        <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" id="newPinInput" placeholder="Choose PIN"
          style="font-size:26px;text-align:center;width:130px;letter-spacing:10px;background:var(--surface-raised);
          border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:10px;font-family:'Oswald',sans-serif;"/>
        <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" id="confirmPinInput" placeholder="Confirm PIN"
          style="font-size:26px;text-align:center;width:130px;letter-spacing:10px;background:var(--surface-raised);
          border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:10px;font-family:'Oswald',sans-serif;"/>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;">
        <button class="btn secondary" id="pinBackBtn">Back</button>
        <button class="btn" id="setPinBtn">Set PIN</button>
      </div>
    `;
    document.getElementById('newPinInput').focus();

    document.getElementById('pinBackBtn').addEventListener('click', () => {
      pinEl.style.display = 'none';
      document.getElementById('playerSelect').style.display = 'flex';
    });

    const submitNewPin = async () => {
      const statusEl = document.getElementById('claimStatus');
      const setBtn = document.getElementById('setPinBtn');
      const pin = document.getElementById('newPinInput').value.trim();
      const confirmVal = document.getElementById('confirmPinInput').value.trim();
      if (!/^\d{4}$/.test(pin)) {
        statusEl.textContent = 'Choose a 4-digit PIN.';
        return;
      }
      if (pin !== confirmVal) {
        statusEl.textContent = "PINs don't match — try again.";
        return;
      }
      setBtn.disabled = true;
      setBtn.textContent = 'Saving…';
      statusEl.textContent = '';
      try {
        const { data, error } = await sb.rpc('set_player_pin', { p_player_id: playerId, p_pin: pin });
        if (error) {
          statusEl.textContent = error.message;
          setBtn.disabled = false;
          setBtn.textContent = 'Set PIN';
          return;
        }
        myPlayer = data;
        await loadPlayers();
        render();
      } catch (e) {
        statusEl.textContent = 'Something went wrong: ' + (e.message || e);
        setBtn.disabled = false;
        setBtn.textContent = 'Set PIN';
      }
    };

    document.getElementById('setPinBtn').addEventListener('click', submitNewPin);
    document.getElementById('confirmPinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitNewPin();
    });
  }

  function showPinEntry(playerId, playerName) {
    document.getElementById('claimStatus').textContent = '';
    document.getElementById('playerSelect').style.display = 'none';
    const pinEl = document.getElementById('pinEntry');
    pinEl.style.display = 'block';
    pinEl.innerHTML = `
      <p class="hint">Enter ${escapeHtml(playerName)}'s PIN</p>
      <input type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="4" id="pinInput"
        style="font-size:26px;text-align:center;width:130px;letter-spacing:10px;background:var(--surface-raised);
        border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:10px;font-family:'Oswald',sans-serif;"/>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;">
        <button class="btn secondary" id="pinBackBtn">Back</button>
        <button class="btn" id="pinConfirmBtn">Confirm</button>
      </div>
    `;
    document.getElementById('pinInput').focus();

    document.getElementById('pinBackBtn').addEventListener('click', () => {
      pinEl.style.display = 'none';
      document.getElementById('playerSelect').style.display = 'flex';
    });

    const confirmPin = async () => {
      const statusEl = document.getElementById('claimStatus');
      const confirmBtn = document.getElementById('pinConfirmBtn');
      const pin = document.getElementById('pinInput').value.trim();
      if (!/^\d{4}$/.test(pin)) {
        statusEl.textContent = 'Enter your 4-digit PIN.';
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Checking…';
      statusEl.textContent = '';
      try {
        const { data, error } = await sb.rpc('claim_player_with_pin', { p_player_id: playerId, p_pin: pin });
        if (error) {
          statusEl.textContent = error.message;
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm';
          return;
        }
        myPlayer = data;
        await loadPlayers();
        render();
      } catch (e) {
        statusEl.textContent = 'Something went wrong: ' + (e.message || e);
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm';
      }
    };

    document.getElementById('pinConfirmBtn').addEventListener('click', confirmPin);
    document.getElementById('pinInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPin();
    });
  }

  // ---------------------------------------------------------------------
  // Weekly parlay: one player per week (rotating Joe -> Mike -> Bryan)
  // picks a 3-game parlay. Amount and payout are just numbers they type in.
  // ---------------------------------------------------------------------
  function gradeLeg(game, selectedTeam, spreadAtPick) {
    if (!game.completed || game.away_score == null || game.home_score == null) return null;
    const margin = (game.away_score - game.home_score) + (spreadAtPick != null ? spreadAtPick : 0);
    if (margin === 0) return 'push';
    const coveringTeam = margin > 0 ? game.away_team : game.home_team;
    return coveringTeam === selectedTeam ? 'win' : 'loss';
  }

  function renderParlaySection(week, games, parlayPicker, parlay, passed, suggestedAmount, notOpenYet, parlayIsSet) {
    let html = '<div class="card">';
    html += '<h2>Weekly parlay</h2>';

    if (parlay) {
      const gamesById = {};
      games.forEach((g) => (gamesById[g.id] = g));
      const legs = (parlay.parlay_picks || []).map((leg) => {
        const g = gamesById[leg.game_id];
        const result = g ? gradeLeg(g, leg.selected_team, leg.spread_at_pick) : null;
        return { leg, g, result };
      });
      const anyGraded = legs.some((l) => l.result != null);
      const allGraded = legs.length === 3 && legs.every((l) => l.result != null);
      const allWin = allGraded && legs.every((l) => l.result === 'win' || l.result === 'push');

      if (allGraded) {
        html += `<p class="hint" style="font-size:15px;">${allWin ? '<strong style="color:var(--win);">Parlay hit!</strong>' : '<strong style="color:var(--loss);">Parlay missed.</strong>'}</p>`;
      }

      html += '<div class="own-picks-list">';
      legs.forEach(({ leg, g, result }) => {
        const cls = result === 'win' ? 'result-win' : result === 'loss' ? 'result-loss' : result === 'push' ? 'result-push' : '';
        const matchup = g ? `${escapeHtml(g.away_team)} at ${escapeHtml(g.home_team)}` : 'Unknown game';
        html += `<div class="row"><span class="game-name">${matchup}</span><strong class="${cls}">${escapeHtml(leg.selected_team)}</strong></div>`;
      });
      html += '</div>';

      html += `<div style="margin-top:12px;display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end;">
        <div class="hint" style="display:flex;flex-direction:column;gap:4px;">Bet amount ($)
          <div style="display:flex;gap:6px;">
            <input type="number" step="0.01" id="parlayAmountEdit" value="${parlay.amount != null ? parlay.amount : (suggestedAmount != null ? suggestedAmount : '')}"
              style="width:100px;background:var(--surface-raised);border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:6px 8px;font-size:14px;"/>
            <button class="btn secondary" id="saveAmountBtn" style="padding:6px 10px;font-size:12px;">Save</button>
          </div>
        </div>
        <div class="hint" style="display:flex;flex-direction:column;gap:4px;">Payout if it hits ($)
          <div style="display:flex;gap:6px;">
            <input type="number" step="0.01" id="parlayPayoutEdit" value="${parlay.payout != null ? parlay.payout : ''}"
              style="width:100px;background:var(--surface-raised);border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:6px 8px;font-size:14px;"/>
            <button class="btn secondary" id="savePayoutBtn" style="padding:6px 10px;font-size:12px;">Save</button>
          </div>
        </div>
        <div class="hint" style="display:flex;flex-direction:column;gap:4px;">Parlay Payout ($)
          <div style="display:flex;gap:6px;">
            <input type="number" step="0.01" id="parlayCollectedEdit" value="${parlay.payout_collected != null ? parlay.payout_collected : ''}"
              style="width:100px;background:var(--surface-raised);border:1px solid var(--line);color:var(--chalk);border-radius:var(--radius);padding:6px 8px;font-size:14px;"/>
            <button class="btn secondary" id="saveCollectedBtn" style="padding:6px 10px;font-size:12px;">Save</button>
          </div>
        </div>
      </div>
      <div class="status-msg" id="amountStatus"></div>
      <div class="status-msg" id="payoutStatus"></div>
      <div class="status-msg" id="collectedStatus"></div>`;
      if (suggestedAmount != null && parlay.amount == null) {
        html += `<p class="hint" style="margin-top:6px;">Bet amount suggested from last week's non-winners' losses — adjust and save if needed.</p>`;
      }
      if (!anyGraded) {
        html += `<p class="hint" style="margin-top:8px;">Set by ${escapeHtml(playerNameById(parlay.picker_player_id))}. Will show as hit/missed once games are graded.</p>`;
      }
    } else if (!parlayPicker) {
      html += '<p class="hint">Could not determine whose turn it is this week.</p>';
    } else if (myPlayer && parlayPicker.id === myPlayer.id) {
      if (notOpenYet) {
        html += `<p class="hint">This week hasn't opened yet — the parlay can be set once it does.</p>`;
      } else if (passed) {
        html += '<p class="hint">The deadline passed and the parlay for this week was never set.</p>';
      } else {
        html += `<p class="hint">It's your turn to set this week's 3-game parlay. Tap a team on exactly 3 games below, then submit — the bet amount and payout can be added afterward.</p>`;
        html += '<div id="parlayGameList">' + renderParlayGameList(week, games) + '</div>';
        html += `<div class="pick-progress" id="parlayProgress">0 of 3 games selected</div>
        <button class="submit-btn" id="submitParlayBtn" disabled>Submit Parlay</button>
        <div class="submit-error" id="parlayError"></div>`;
      }
    } else if (parlayIsSet) {
      html += `<p class="hint"><strong style="color:var(--chalk);">${escapeHtml(parlayPicker.name)}</strong> has set this week's parlay — it stays hidden until everyone's weekly picks are in.</p>`;
    } else {
      html += `<p class="hint">Waiting on <strong style="color:var(--chalk);">${escapeHtml(parlayPicker.name)}</strong> to set this week's 3-game parlay.</p>`;
    }

    html += '</div>';
    return html;
  }

  function playerNameById(id) {
    const p = players.find((x) => x.id === id);
    return p ? p.name : 'someone';
  }

  function renderParlayGameList(week, games) {
    const draft = loadParlayDraft(week.id);
    return games
      .map((g) => {
        const pickedAway = draft[g.id] === g.away_team;
        const pickedHome = draft[g.id] === g.home_team;
        const awaySpreadTxt = spreadLabel(g.spread, 'away');
        const homeSpreadTxt = spreadLabel(g.spread, 'home');
        return `<div class="game-row" data-game="${g.id}" style="padding:10px 14px;margin-bottom:6px;">
          <div class="matchup-line" style="font-size:14px;margin-bottom:6px;">${escapeHtml(g.away_team)} at ${escapeHtml(g.home_team)}</div>
          <div class="pick-buttons">
            <button type="button" class="pick-btn parlay-leg-btn ${pickedAway ? 'selected' : ''}" style="padding:9px 8px;font-size:14px;" data-team="${escapeAttr(g.away_team)}">${escapeHtml(g.away_team)}<span class="spread-sub">${awaySpreadTxt}</span></button>
            <button type="button" class="pick-btn parlay-leg-btn ${pickedHome ? 'selected' : ''}" style="padding:9px 8px;font-size:14px;" data-team="${escapeAttr(g.home_team)}">${escapeHtml(g.home_team)}<span class="spread-sub">${homeSpreadTxt}</span></button>
          </div>
        </div>`;
      })
      .join('');
  }

  function wireParlayForm(week, games) {
    let draft = loadParlayDraft(week.id);

    const updateProgress = () => {
      const count = Object.keys(draft).length;
      const progressEl = document.getElementById('parlayProgress');
      if (progressEl) progressEl.textContent = `${count} of 3 games selected`;
      const btn = document.getElementById('submitParlayBtn');
      if (btn) btn.disabled = count !== 3;
    };

    function wireLegButtons() {
      document.querySelectorAll('.parlay-leg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.game-row');
          const gameId = row.dataset.game;
          const alreadyThisTeam = draft[gameId] === btn.dataset.team;
          if (alreadyThisTeam) {
            delete draft[gameId];
          } else {
            if (!draft[gameId] && Object.keys(draft).length >= 3) {
              document.getElementById('parlayError').textContent = 'You can only pick 3 games — tap one of your current picks to remove it first.';
              return;
            }
            draft[gameId] = btn.dataset.team;
          }
          document.getElementById('parlayError').textContent = '';
          saveParlayDraft(week.id, draft);
          document.getElementById('parlayGameList').innerHTML = renderParlayGameList(week, games);
          wireLegButtons();
          updateProgress();
        });
      });
    }
    wireLegButtons();
    updateProgress();

    const submitBtn = document.getElementById('submitParlayBtn');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const errEl = document.getElementById('parlayError');
        errEl.textContent = '';
        if (Object.keys(draft).length !== 3) {
          errEl.textContent = 'Pick exactly 3 games first.';
          return;
        }
        const payload = Object.keys(draft).map((gameId) => ({ game_id: gameId, selected_team: draft[gameId] }));
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        const { error } = await sb.rpc('submit_parlay', {
          p_week_id: week.id,
          p_player_id: myPlayer.id,
          p_picks: payload,
          p_amount: null,
          p_payout: null,
        });
        if (error) {
          errEl.textContent = error.message;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Parlay';
          return;
        }
        clearParlayDraft(week.id);
        renderWeekView();
      });
    }
  }

  function parlayDraftKey(weekId) {
    return `pickem-parlay-draft:${weekId}`;
  }
  function loadParlayDraft(weekId) {
    try {
      const raw = localStorage.getItem(parlayDraftKey(weekId));
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveParlayDraft(weekId, draft) {
    try { localStorage.setItem(parlayDraftKey(weekId), JSON.stringify(draft)); } catch (e) {}
  }
  function clearParlayDraft(weekId) {
    try { localStorage.removeItem(parlayDraftKey(weekId)); } catch (e) {}
  }

  function renderPickForm(week, games, submissionStatus) {
    const draft = loadDraft(week.id);
    let html = '<div class="card">';
    games.forEach((g) => {
      const pickedAway = draft[g.id] === g.away_team;
      const pickedHome = draft[g.id] === g.home_team;
      const awaySpreadTxt = spreadLabel(g.spread, 'away');
      const homeSpreadTxt = spreadLabel(g.spread, 'home');
      html += `<div class="game-row" data-game="${g.id}" data-away="${escapeAttr(g.away_team)}" data-home="${escapeAttr(g.home_team)}">
        <div class="game-top"><span class="matchup-line">${escapeHtml(g.away_team)} at ${escapeHtml(g.home_team)}</span></div>
        <div class="pick-buttons">
          <button class="pick-btn ${pickedAway ? 'selected' : ''}" data-team="${escapeAttr(g.away_team)}">${escapeHtml(g.away_team)}<span class="spread-sub">${awaySpreadTxt}</span></button>
          <button class="pick-btn ${pickedHome ? 'selected' : ''}" data-team="${escapeAttr(g.home_team)}">${escapeHtml(g.home_team)}<span class="spread-sub">${homeSpreadTxt}</span></button>
        </div>
      </div>`;
    });
    const pickedCount = Object.keys(draft).filter((gid) => games.some((g) => g.id === gid)).length;
    html += `<div class="pick-progress" id="pickProgress">${pickedCount} of ${games.length} picks selected</div>
      <button class="submit-btn" id="submitBtn" ${pickedCount === games.length ? '' : 'disabled'}>Submit Picks</button>
      <div class="submit-error" id="submitError"></div>
    </div>`;
    html += renderSubmissionStatus(submissionStatus);
    return html;
  }

  function wirePickForm(week, games) {
    const draft = loadDraft(week.id);

    contentEl.querySelectorAll('.pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.game-row');
        const gameId = row.dataset.game;
        draft[gameId] = btn.dataset.team;
        saveDraft(week.id, draft);
        row.querySelectorAll('.pick-btn').forEach((b) => b.classList.toggle('selected', b.dataset.team === draft[gameId]));
        const pickedCount = Object.keys(draft).filter((gid) => games.some((g) => g.id === gid)).length;
        document.getElementById('pickProgress').textContent = `${pickedCount} of ${games.length} picks selected`;
        document.getElementById('submitBtn').disabled = pickedCount !== games.length;
      });
    });

    document.getElementById('submitBtn').addEventListener('click', async () => {
      const errEl = document.getElementById('submitError');
      errEl.textContent = '';
      const payload = games.map((g) => ({ player_id: myPlayer.id, game_id: g.id, selected_team: draft[g.id] }));
      const { error } = await sb.rpc('submit_picks', { p_week_id: week.id, p_picks: payload });
      if (error) {
        errEl.textContent = error.message;
        return;
      }
      clearDraft(week.id);
      renderWeekView();
    });
  }

  function renderLockedSection(games, myPicks, submissionStatus) {
    const byGame = {};
    myPicks.forEach((p) => (byGame[p.game_id] = p));
    let html = `<div class="locked-banner">
      <div class="headline">Your picks are locked.</div>
      <div class="hint">Everyone's picks will be revealed automatically once all 3 players have submitted.</div>
    </div>
    <div class="card"><h2>Your picks</h2><div class="own-picks-list">`;
    games.forEach((g) => {
      const p = byGame[g.id];
      const spreadUsed = p && p.spread_at_pick != null ? p.spread_at_pick : g.spread;
      const lineTxt = spreadUsed == null
        ? 'No line was set'
        : `${escapeHtml(g.away_team)} ${spreadLabel(spreadUsed, 'away')} / ${escapeHtml(g.home_team)} ${spreadLabel(spreadUsed, 'home')}`;
      html += `<div class="row">
        <span class="game-name">${escapeHtml(g.away_team)} at ${escapeHtml(g.home_team)}<span class="game-spread">${lineTxt}</span></span>
        <strong>${p ? escapeHtml(p.selected_team) : '&mdash;'}</strong>
      </div>`;
    });
    html += '</div></div>';
    html += renderSubmissionStatus(submissionStatus);
    return html;
  }

  function renderSubmissionStatus(submissionStatus) {
    let html = '<div class="card"><h2>Picks submitted</h2><div class="submission-status">';
    submissionStatus.forEach((s) => {
      html += `<span class="item"><span class="dot ${s.submitted ? 'yes' : 'no'}"></span>${escapeHtml(s.name)}</span>`;
    });
    html += '</div></div>';
    return html;
  }

  async function loadWeeklyPlayerRecord(weekId) {
    const { data, error } = await sb.from('v_weekly_player_record').select('*').eq('week_id', weekId);
    return error ? [] : data;
  }

  async function renderRevealSection(week, games) {
    const results = await loadPickResults(week.id);
    const weeklyRecordRows = await loadWeeklyPlayerRecord(week.id);
    const byGame = {};
    games.forEach((g) => (byGame[g.id] = {}));
    results.forEach((r) => {
      if (byGame[r.game_id]) byGame[r.game_id][r.player_id] = r;
    });

    const weeklyTally = {}; // player_id -> {W,L,T}
    weeklyRecordRows.forEach((r) => {
      weeklyTally[r.player_id] = { W: r.wins, L: r.losses, T: r.pushes };
    });
    const didNotSubmit = {}; // player_id -> true if they have zero actual picks this week
    const submittedPlayerIds = new Set(results.map((r) => r.player_id));
    players.forEach((p) => {
      didNotSubmit[p.id] = !submittedPlayerIds.has(p.id);
    });

    const anyGraded = Object.values(weeklyTally).some((t) => t.W + t.L + t.T > 0);

    let html = '';
    if (anyGraded) {
      const maxWins = Math.max(...players.map((p) => (weeklyTally[p.id] || { W: 0 }).W));
      let potShare = 0;
      let parlayShare = 0;
      players.forEach((p) => {
        const t = weeklyTally[p.id] || { W: 0, L: 0, T: 0 };
        if (t.W === maxWins) potShare += t.L;
        else parlayShare += t.L;
      });

      html += '<div class="card"><h2>Weekly summary</h2>';

      html += `<table class="leaderboard-table"><thead><tr><th>Player</th><th class="num">W</th><th class="num">L</th><th class="num">T</th></tr></thead><tbody>`;
      players.forEach((p) => {
        const t = weeklyTally[p.id] || { W: 0, L: 0, T: 0 };
        const note = didNotSubmit[p.id] ? ' <span class="hint">(no picks submitted)</span>' : '';
        html += `<tr><td>${escapeHtml(p.name)}${note}</td><td class="num">${t.W}</td><td class="num">${t.L}</td><td class="num">${t.T}</td></tr>`;
      });
      html += '</tbody></table>';

      html += '<div class="own-picks-list" style="margin-top:14px;">';
      players.forEach((p) => {
        const t = weeklyTally[p.id] || { W: 0, L: 0, T: 0 };
        html += `<div class="row"><span>${escapeHtml(p.name)}</span><strong>owes $${t.L}</strong></div>`;
      });
      html += '</div>';

      html += `<p class="hint" style="margin-top:10px;">$${potShare} goes to the pot and $${parlayShare} is for next week's parlay bet.</p>`;

      html += '</div>';
    }

    const missedNames = players.filter((p) => didNotSubmit[p.id]).map((p) => p.name);
    const allSubmitted = missedNames.length === 0;

    html += `<div class="reveal-banner">
      <div class="headline">${allSubmitted ? 'All picks are in!' : 'Picks are locked.'}</div>
      <div class="hint">${
        allSubmitted
          ? (anyGraded ? 'Correct picks are highlighted as game results come in.' : 'Every player submitted — results will highlight automatically once games are final and synced.')
          : `The deadline passed before ${escapeHtml(missedNames.join(' and '))} submitted — ${missedNames.length > 1 ? 'they count' : 'that counts'} as a loss on every game this week.`
      }</div>
    </div>
    <div class="card"><h2>This week's picks</h2>
    <div class="table-scroll">
    <table class="compare-table"><thead><tr><th>Game</th>${players.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('')}</tr></thead><tbody>`;

    games.forEach((g) => {
      const rowForGame = byGame[g.id] || {};
      const anyResult = Object.values(rowForGame)[0];
      const scoreTxt = anyResult && anyResult.completed && anyResult.away_score != null
        ? ` <span class="hint">(${anyResult.away_score}-${anyResult.home_score} final)</span>`
        : '';
      const lineTxt = g.spread == null
        ? 'No line was set'
        : `${escapeHtml(g.away_team)} ${spreadLabel(g.spread, 'away')} / ${escapeHtml(g.home_team)} ${spreadLabel(g.spread, 'home')}`;
      html += `<tr><td>${escapeHtml(g.away_team)} @ ${escapeHtml(g.home_team)}${scoreTxt}<span class="game-spread">${lineTxt}</span></td>`;
      players.forEach((p) => {
        const r = rowForGame[p.id];
        if (!r) {
          html += `<td>&mdash;</td>`;
        } else {
          const cls = r.result === 'win' ? 'win' : r.result === 'loss' ? 'loss' : r.result === 'push' ? 'push' : '';
          html += `<td class="${cls}">${escapeHtml(r.selected_team)}</td>`;
        }
      });
      html += '</tr>';
    });

    html += '</tbody></table></div>';

    if (anyGraded) {
      html += '<div style="margin-top:14px;display:flex;gap:16px;flex-wrap:wrap;">';
      players.forEach((p) => {
        const t = weeklyTally[p.id] || { W: 0, L: 0, T: 0 };
        html += `<div class="hint"><strong style="color:var(--chalk);">${escapeHtml(p.name)}</strong>: ${t.W}-${t.L}${t.T ? '-' + t.T : ''} this week</div>`;
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function wireWeekNav(idx) {
    const prevBtn = document.getElementById('prevWeekBtn');
    const nextBtn = document.getElementById('nextWeekBtn');
    if (prevBtn) prevBtn.addEventListener('click', () => { activeWeekId = weeks[idx - 1].id; renderWeekView(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { activeWeekId = weeks[idx + 1].id; renderWeekView(); });
  }

  // ---------------------------------------------------------------------
  // Draft storage (client-side only, purely a convenience so an in-progress
  // set of picks survives a refresh before you hit Submit — nothing here is
  // trusted; the server re-validates everything on submit)
  // ---------------------------------------------------------------------
  function draftKey(weekId) {
    return `pickem-draft:${weekId}:${myPlayer ? myPlayer.id : 'anon'}`;
  }
  function loadDraft(weekId) {
    try {
      const raw = localStorage.getItem(draftKey(weekId));
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function saveDraft(weekId, draft) {
    try { localStorage.setItem(draftKey(weekId), JSON.stringify(draft)); } catch (e) {}
  }
  function clearDraft(weekId) {
    try { localStorage.removeItem(draftKey(weekId)); } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------
  function weekLabel(w) {
    const typeLabel = w.season_type === 1 ? 'Preseason' : w.season_type === 3 ? 'Playoffs' : 'Week';
    return `${typeLabel} ${w.week_number} · ${w.season}`;
  }
  function fmtDeadline(iso) {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  }
  function isPast(iso) {
    return new Date(iso).getTime() <= Date.now();
  }
  function spreadLabel(spread, side) {
    if (spread == null) return 'No line yet';
    // spread is away-team-relative: negative = away favored
    if (spread === 0) return 'Even';
    if (side === 'away') return spread < 0 ? `-${Math.abs(spread)}` : `+${spread}`;
    return spread < 0 ? `+${Math.abs(spread)}` : `-${spread}`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
