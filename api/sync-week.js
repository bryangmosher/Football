// Pulls the NFL schedule + point spreads and writes them into Supabase.
//
// Primary source: ESPN's public scoreboard endpoint (site.api.espn.com). It's
// not an official, versioned/paid API, but it's free, requires no key, and is
// widely used for exactly this. It gives us real NFL week numbers, which is
// what makes "which week is this" automatic.
//
// Backup source (only used if ESPN fails and ODDS_API_KEY is set): The Odds
// API (https://the-odds-api.com). It's an official, documented API with a
// free tier, but it doesn't group games into NFL week numbers — it just
// returns whatever games are currently upcoming.
//
// This function runs server-side only. It uses the Supabase SERVICE ROLE key
// (SUPABASE_SERVICE_ROLE_KEY), which must be set as a Netlify environment
// variable and must NEVER be put in any client-side file.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  try {
    const adminSecret = process.env.ADMIN_SYNC_SECRET;
    if (adminSecret) {
      const provided = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
      if (provided !== adminSecret) {
        return json(401, { ok: false, error: 'unauthorized' });
      }
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    let normalized, year, seasonType, weekNumber, usedSource, manualDeadline;
    let scoresOnly = false;

    if (event.httpMethod === 'POST') {
      // Manual entry: the admin typed in games/spreads themselves.
      const body = JSON.parse(event.body || '{}');
      if (!body.week || !body.year || !Array.isArray(body.games) || !body.games.length) {
        return json(400, { ok: false, error: 'Manual entry needs week, year, and at least one game.' });
      }
      year = Number(body.year);
      seasonType = Number(body.seasontype) || 2;
      weekNumber = Number(body.week);
      usedSource = 'manual';
      manualDeadline = body.pick_deadline ? new Date(body.pick_deadline) : null;
      normalized = body.games.map((g, i) => ({
        external_game_id: 'manual-' + slugify(g.away_team) + '-' + slugify(g.home_team) + '-' + weekNumber + '-' + year,
        away_team: canonicalTeamName(g.away_team),
        home_team: canonicalTeamName(g.home_team),
        spread: g.spread === '' || g.spread == null ? null : Number(g.spread),
        commence_time: null,
        away_score: null,
        home_score: null,
        completed: false,
      }));
    } else {
      const params = event.queryStringParameters || {};
      scoresOnly = params.scores_only === '1';
      // Only ESPN provides scores, so scores-only mode always uses it,
      // regardless of what source param (if any) was passed.
      const requestedSource = scoresOnly ? 'espn' : params.source;
      const result = await fetchSchedule(params, requestedSource);
      normalized = result.events.map(normalizeEvent);
      usedSource = result.usedSource;
      year = result.seasonInfo.year || Number(params.year) || new Date().getFullYear();
      seasonType = result.seasonInfo.seasonType || Number(params.seasontype) || 2;
      weekNumber = result.seasonInfo.week || Number(params.week);
    }

    if (!normalized.length) {
      return json(200, { ok: true, message: 'No games came back for that query.', games: [] });
    }
    if (!weekNumber) {
      return json(500, { ok: false, error: 'Could not determine an NFL week number from the response.' });
    }

    let pickDeadline = manualDeadline;
    if (!pickDeadline) {
      pickDeadline = computeFixedDeadline(weekNumber);
    }

    // Only set pick_deadline the FIRST time this week is created. On later
    // auto-syncs (refreshing spreads/scores), leave whatever deadline is
    // already there alone — including if someone manually adjusted it in
    // Supabase. A manual-entry submission (this form has its own deadline
    // field) always applies the deadline the admin explicitly chose.
    const { data: existingWeek } = await supabase
      .from('weeks')
      .select('id, pick_deadline')
      .eq('season', year)
      .eq('season_type', seasonType)
      .eq('week_number', weekNumber)
      .maybeSingle();

    if (scoresOnly && !existingWeek) {
      return json(400, {
        ok: false,
        error: `Week ${weekNumber} (${year}) hasn't been synced yet — pull its schedule/lines with Use ESPN, Use Backup, or Use Manual Lines first, then come back for scores.`,
      });
    }

    const weekPayload = {
      season: year,
      season_type: seasonType,
      week_number: weekNumber,
    };
    if (existingWeek && !manualDeadline) {
      weekPayload.id = existingWeek.id;
      weekPayload.pick_deadline = existingWeek.pick_deadline;
    } else if (existingWeek) {
      weekPayload.id = existingWeek.id;
      weekPayload.pick_deadline = pickDeadline.toISOString();
    } else {
      if (!pickDeadline) {
        return json(500, { ok: false, error: 'Could not determine a pick deadline (no kickoff times and none provided).' });
      }
      weekPayload.pick_deadline = pickDeadline.toISOString();
    }

    const { data: weekRow, error: weekErr } = await supabase
      .from('weeks')
      .upsert(weekPayload, { onConflict: 'season,season_type,week_number' })
      .select()
      .single();
    if (weekErr) throw weekErr;

    let written = 0;
    let skipped = 0;
    for (const g of normalized) {
      const { data: existing } = await supabase
        .from('games')
        .select('id, completed')
        .eq('week_id', weekRow.id)
        .eq('away_team', g.away_team)
        .eq('home_team', g.home_team)
        .maybeSingle();

      if (scoresOnly && !existing) {
        // Don't create games in scores-only mode — only update ones already
        // synced from a schedule/lines pull.
        skipped++;
        continue;
      }

      const payload = {
        week_id: weekRow.id,
        external_game_id: g.external_game_id,
        away_team: g.away_team,
        home_team: g.home_team,
        away_score: g.away_score,
        home_score: g.home_score,
        completed: g.completed,
      };
      if (existing) payload.id = existing.id;

      if (scoresOnly) {
        // Scores-only: touch nothing about the line at all, ever.
        if (g.commence_time) payload.commence_time = g.commence_time;
      } else {
        payload.commence_time = g.commence_time;
        payload.spread_updated_at = new Date().toISOString();
        payload.spread_source = usedSource;
        // Never overwrite the spread once a game is completed — keep the
        // closing line rather than clobbering it with a stale/blank value.
        if (g.spread != null && !(existing && existing.completed)) {
          payload.spread = g.spread;
        }
      }

      const { error: gameErr } = await supabase
        .from('games')
        .upsert(payload, { onConflict: 'week_id,away_team,home_team' });
      if (gameErr) throw gameErr;
      written++;
    }

    return json(200, {
      ok: true,
      source: usedSource,
      scores_only: scoresOnly,
      season: year,
      season_type: seasonType,
      week: weekNumber,
      games_written: written,
      games_skipped: skipped,
      pick_deadline: pickDeadline ? pickDeadline.toISOString() : (weekPayload.pick_deadline || null),
      games: normalized.map((g) => ({
        away_team: g.away_team,
        home_team: g.home_team,
        spread: g.spread,
        away_score: g.away_score,
        home_score: g.home_score,
        completed: g.completed,
      })),
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// requestedSource: 'espn' | 'odds_api' | undefined.
// When explicitly requested, that source is used on its own with NO silent
// fallback to the other — if it fails, the caller finds out why. Fallback
// only happens when no source is specified at all.
async function fetchSchedule(params, requestedSource) {
  const fetchEspn = async () => {
    let espnUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
    const qp = [];
    if (params.year) qp.push('year=' + encodeURIComponent(params.year));
    if (params.week) qp.push('week=' + encodeURIComponent(params.week));
    if (params.seasontype) qp.push('seasontype=' + encodeURIComponent(params.seasontype));
    if (qp.length) espnUrl += '?' + qp.join('&');

    const res = await fetch(espnUrl);
    if (!res.ok) throw new Error('ESPN HTTP ' + res.status);
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) throw new Error('ESPN returned no events');
    return {
      events,
      usedSource: 'espn',
      seasonInfo: {
        year: data.season && data.season.year,
        seasonType: data.season && data.season.type,
        week: data.week && data.week.number,
      },
    };
  };

  const fetchOddsApi = async () => {
    if (!process.env.ODDS_API_KEY) throw new Error('No ODDS_API_KEY is configured for the backup source.');
    const oddsUrl =
      'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=' +
      encodeURIComponent(process.env.ODDS_API_KEY) +
      '&regions=us&markets=spreads&oddsFormat=american';
    const res2 = await fetch(oddsUrl);
    if (!res2.ok) throw new Error('Backup Odds API HTTP ' + res2.status);
    const data2 = await res2.json();
    const events = data2.map((ev) => ({ __odds: ev }));
    if (!events.length) throw new Error('Backup Odds API returned no events');
    return {
      events,
      usedSource: 'odds_api',
      seasonInfo: {
        year: params.year || new Date().getFullYear(),
        seasonType: params.seasontype || 2,
        week: params.week ? Number(params.week) : null,
      },
    };
  };

  if (requestedSource === 'espn') return fetchEspn();
  if (requestedSource === 'odds_api') return fetchOddsApi();

  // No explicit source: try ESPN, fall back to backup automatically.
  try {
    return await fetchEspn();
  } catch (espnErr) {
    return await fetchOddsApi().catch(() => {
      throw new Error('ESPN failed (' + espnErr.message + ') and no working backup is configured.');
    });
  }
}

// The Odds API returns full names ("Green Bay Packers"); ESPN returns short
// names ("Packers"); manual entry could be either. Without normalizing these
// to one canonical form, the same real game gets stored as two different
// database rows depending on which source was used last.
const TEAM_NAME_MAP = {
  'Arizona Cardinals': 'Cardinals',
  'Atlanta Falcons': 'Falcons',
  'Baltimore Ravens': 'Ravens',
  'Buffalo Bills': 'Bills',
  'Carolina Panthers': 'Panthers',
  'Chicago Bears': 'Bears',
  'Cincinnati Bengals': 'Bengals',
  'Cleveland Browns': 'Browns',
  'Dallas Cowboys': 'Cowboys',
  'Denver Broncos': 'Broncos',
  'Detroit Lions': 'Lions',
  'Green Bay Packers': 'Packers',
  'Houston Texans': 'Texans',
  'Indianapolis Colts': 'Colts',
  'Jacksonville Jaguars': 'Jaguars',
  'Kansas City Chiefs': 'Chiefs',
  'Las Vegas Raiders': 'Raiders',
  'Los Angeles Chargers': 'Chargers',
  'Los Angeles Rams': 'Rams',
  'Miami Dolphins': 'Dolphins',
  'Minnesota Vikings': 'Vikings',
  'New England Patriots': 'Patriots',
  'New Orleans Saints': 'Saints',
  'New York Giants': 'Giants',
  'New York Jets': 'Jets',
  'Philadelphia Eagles': 'Eagles',
  'Pittsburgh Steelers': 'Steelers',
  'San Francisco 49ers': '49ers',
  'Seattle Seahawks': 'Seahawks',
  'Tampa Bay Buccaneers': 'Buccaneers',
  'Tennessee Titans': 'Titans',
  'Washington Commanders': 'Commanders',
};

function canonicalTeamName(name) {
  const trimmed = String(name || '').trim();
  return TEAM_NAME_MAP[trimmed] || trimmed;
}

function normalizeEvent(ev) {
  if (ev.__odds) {
    const o = ev.__odds;
    let spread = null;
    const book = o.bookmakers && o.bookmakers[0];
    const market = book && book.markets && book.markets.find((m) => m.key === 'spreads');
    const awayOutcome = market && market.outcomes && market.outcomes.find((x) => x.name === o.away_team);
    if (awayOutcome && typeof awayOutcome.point === 'number') spread = awayOutcome.point;
    return {
      external_game_id: o.id,
      away_team: canonicalTeamName(o.away_team),
      home_team: canonicalTeamName(o.home_team),
      spread,
      commence_time: o.commence_time,
      away_score: null,
      home_score: null,
      completed: false,
    };
  }

  const comp = (ev.competitions && ev.competitions[0]) || {};
  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === 'home') || {};
  const awayC = competitors.find((c) => c.homeAway === 'away') || {};

  let spread = null;
  const odds = comp.odds && comp.odds[0];
  if (odds && typeof odds.details === 'string' && odds.details.trim()) {
    const m = odds.details.trim().match(/^(.*)\s(-?\d+(\.\d+)?)$/);
    if (m) {
      const favAbbrev = m[1].trim();
      const num = Math.abs(parseFloat(m[2]));
      const homeAbbrev = homeC.team && homeC.team.abbreviation;
      const awayAbbrev = awayC.team && awayC.team.abbreviation;
      if (favAbbrev === awayAbbrev) spread = -num;
      else if (favAbbrev === homeAbbrev) spread = num;
    }
  }

  const completed = !!(comp.status && comp.status.type && comp.status.type.completed);

  return {
    external_game_id: String(ev.id),
    away_team: canonicalTeamName((awayC.team && (awayC.team.shortDisplayName || awayC.team.name)) || 'Away'),
    home_team: canonicalTeamName((homeC.team && (homeC.team.shortDisplayName || homeC.team.name)) || 'Home'),
    spread,
    commence_time: comp.date || ev.date,
    away_score: awayC.score != null ? Number(awayC.score) : null,
    home_score: homeC.score != null ? Number(homeC.score) : null,
    completed,
  };
}


// Computes 10:00 AM America/New_York on the Thursday of the game week that
// `earliestGameDate` falls in (i.e. the Thursday on or before that date).
// Same fixed week boundaries used everywhere else in the app (Week 1 = Sep 6,
// Week 2+ = 7-day Tue-Mon blocks starting Sep 15). Keep in sync with the
// WEEK1_START/WEEK2_START constants in app.js and week_start_date() in
// Postgres if these ever change (e.g. a new season).
const WEEK1_START_UTC = Date.UTC(2026, 8, 6); // Sept 6, 2026
const WEEK2_START_UTC = Date.UTC(2026, 8, 15); // Sept 15, 2026

function weekStartDateParts(weekNumber) {
  const startMs = weekNumber <= 1 ? WEEK1_START_UTC : WEEK2_START_UTC + (weekNumber - 2) * 7 * 86400000;
  const d = new Date(startMs);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// Picks lock Thursday 1:00 PM ET of that week (2 days after the Tuesday
// start), regardless of the actual games' kickoff times.
function computeFixedDeadline(weekNumber) {
  const start = weekStartDateParts(weekNumber);
  const thuMs = Date.UTC(start.y, start.m - 1, start.d) + 2 * 86400000;
  const thu = new Date(thuMs);
  return nyWallTimeToUtc(thu.getUTCFullYear(), thu.getUTCMonth() + 1, thu.getUTCDate(), 13, 0);
}

// Converts a Y/M/D H:M wall-clock time in America/New_York into the correct
// UTC instant, accounting for EST/EDT automatically.
function nyWallTimeToUtc(year, month, day, hour, minute) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(guess).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asIfLocalWereUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = asIfLocalWereUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}
