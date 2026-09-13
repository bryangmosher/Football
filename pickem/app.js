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
    if (weeks.length) activeWeekId = weeks[weeks.length - 1].id;

    render();
  })();

  // ---------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------
  async function loadPlayers() {
    const { data, error } = await sb.from('players').select('id,name,claimed_by').order('name');
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

  // ---------------------------------------------------------------------
  // Render dispatch
  // ---------------------------------------------------------------------
  function render() {
    renderWhoBox();
    if (currentView === 'home') renderHome();
    else renderWeekView();
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
    if (!weeks.length) {
      return '<p class="hint">No weeks loaded yet. Use the sync buttons below to pull the current week.</p>';
    }
    let h = '<div class="week-list">';
    weeks.slice().reverse().forEach((w) => {
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
      if (weeks.length) activeWeekId = weeks[weeks.length - 1].id;
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
    if (!activeWeekId) activeWeekId = weeks[weeks.length - 1].id;

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

    let html = `<div class="week-nav">
      <button id="prevWeekBtn" ${idx <= 0 ? 'disabled' : ''}>&larr; Prev</button>
      <span class="week-title display">${escapeHtml(weekLabel(week))}</span>
      <button id="nextWeekBtn" ${idx >= weeks.length - 1 ? 'disabled' : ''}>Next &rarr;</button>
    </div>`;

    const passed = isPast(week.pick_deadline);
    html += `<div class="deadline-banner ${passed ? 'passed' : ''}">
      ${passed ? 'Picks closed' : 'Picks lock'} <strong>${escapeHtml(fmtDeadline(week.pick_deadline))}</strong>
    </div>`;

    if (revealed) {
      html += await renderRevealSection(week, games);
    } else if (myPicks.length > 0) {
      html += renderLockedSection(games, myPicks, submissionStatus);
    } else if (passed) {
      html += `<div class="card"><h2>Picks are closed</h2><p class="hint">The deadline passed and you didn't submit picks for this week.</p></div>`;
      html += renderSubmissionStatus(submissionStatus);
    } else {
      html += renderPickForm(week, games, submissionStatus);
    }

    contentEl.innerHTML = html;
    wireWeekNav(idx);
    if (!revealed && myPicks.length === 0 && !passed) wirePickForm(week, games);
  }

  function renderPlayerGate() {
    contentEl.innerHTML = `<div class="card" style="text-align:center;">
      <h2>Who are you?</h2>
      <p class="hint">Pick your name to see this week's games and make picks.</p>
      <div class="player-select" id="playerSelect"></div>
      <div class="status-msg error" id="claimStatus"></div>
    </div>`;
    const el = document.getElementById('playerSelect');
    el.innerHTML = players
      .map((p) => {
        const takenByOther = p.claimed_by && p.claimed_by !== myUid;
        return `<button class="player-btn" data-id="${p.id}" ${takenByOther ? 'disabled' : ''}>${escapeHtml(p.name)}${takenByOther ? ' (in use)' : ''}</button>`;
      })
      .join('');
    el.querySelectorAll('.player-btn:not(:disabled)').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const { data, error } = await sb.rpc('claim_player', { p_player_id: btn.dataset.id });
        if (error) {
          document.getElementById('claimStatus').textContent = error.message;
          return;
        }
        myPlayer = data;
        await loadPlayers();
        render();
      });
    });
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
      html += `<div class="row"><span>${escapeHtml(g.away_team)} at ${escapeHtml(g.home_team)}</span><strong>${p ? escapeHtml(p.selected_team) : '&mdash;'}</strong></div>`;
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

  async function renderRevealSection(week, games) {
    const results = await loadPickResults(week.id);
    const byGame = {};
    games.forEach((g) => (byGame[g.id] = {}));
    const weeklyTally = {}; // player_id -> {W,L,T}
    results.forEach((r) => {
      if (byGame[r.game_id]) byGame[r.game_id][r.player_id] = r;
      if (r.result === 'win' || r.result === 'loss' || r.result === 'push') {
        if (!weeklyTally[r.player_id]) weeklyTally[r.player_id] = { W: 0, L: 0, T: 0 };
        if (r.result === 'win') weeklyTally[r.player_id].W++;
        else if (r.result === 'loss') weeklyTally[r.player_id].L++;
        else weeklyTally[r.player_id].T++;
      }
    });

    const anyGraded = results.some((r) => r.result != null);

    let html = `<div class="reveal-banner">
      <div class="headline">All picks are in!</div>
      <div class="hint">${anyGraded ? "Correct picks are highlighted as game results come in." : "Every player submitted — results will highlight automatically once games are final and synced."}</div>
    </div>
    <div class="card"><h2>This week's picks</h2>
    <table class="compare-table"><thead><tr><th>Game</th>${players.map((p) => `<th>${escapeHtml(p.name)}</th>`).join('')}</tr></thead><tbody>`;

    games.forEach((g) => {
      const rowForGame = byGame[g.id] || {};
      const anyResult = Object.values(rowForGame)[0];
      const scoreTxt = anyResult && anyResult.completed && anyResult.away_score != null
        ? ` <span class="hint">(${anyResult.away_score}-${anyResult.home_score} final)</span>`
        : '';
      html += `<tr><td>${escapeHtml(g.away_team)} @ ${escapeHtml(g.home_team)}${scoreTxt}</td>`;
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

    html += '</tbody></table>';

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
