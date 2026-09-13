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
    const params = event.queryStringParameters || {};

    const { events, seasonInfo, usedSource } = await fetchSchedule(params);
    const normalized = events.map(normalizeEvent);

    if (!normalized.length) {
      return json(200, { ok: true, message: 'No games came back for that query.', games: 0 });
    }

    const year = seasonInfo.year || Number(params.year) || new Date().getFullYear();
    const seasonType = seasonInfo.seasonType || Number(params.seasontype) || 2;
    const weekNumber = seasonInfo.week || Number(params.week);
    if (!weekNumber) {
      return json(500, { ok: false, error: 'Could not determine an NFL week number from the response.' });
    }

    const commenceTimes = normalized
      .map((g) => new Date(g.commence_time))
      .filter((d) => !isNaN(d.getTime()));
    if (!commenceTimes.length) {
      return json(500, { ok: false, error: 'None of the games had a usable kickoff time.' });
    }
    const earliest = new Date(Math.min(...commenceTimes.map((d) => d.getTime())));
    const pickDeadline = computeThursdayDeadlineEt(earliest);

    // Only set pick_deadline the FIRST time this week is created. On later
    // syncs (refreshing spreads/scores), leave whatever deadline is already
    // there alone — including if someone manually adjusted it in Supabase.
    const { data: existingWeek } = await supabase
      .from('weeks')
      .select('id, pick_deadline')
      .eq('season', year)
      .eq('season_type', seasonType)
      .eq('week_number', weekNumber)
      .maybeSingle();

    const weekPayload = {
      season: year,
      season_type: seasonType,
      week_number: weekNumber,
    };
    if (existingWeek) {
      weekPayload.id = existingWeek.id;
      weekPayload.pick_deadline = existingWeek.pick_deadline;
    } else {
      weekPayload.pick_deadline = pickDeadline.toISOString();
    }

    const { data: weekRow, error: weekErr } = await supabase
      .from('weeks')
      .upsert(weekPayload, { onConflict: 'season,season_type,week_number' })
      .select()
      .single();
    if (weekErr) throw weekErr;

    let written = 0;
    for (const g of normalized) {
      const { data: existing } = await supabase
        .from('games')
        .select('id, completed')
        .eq('week_id', weekRow.id)
        .eq('external_game_id', g.external_game_id)
        .maybeSingle();

      const payload = {
        week_id: weekRow.id,
        external_game_id: g.external_game_id,
        away_team: g.away_team,
        home_team: g.home_team,
        commence_time: g.commence_time,
        away_score: g.away_score,
        home_score: g.home_score,
        completed: g.completed,
        spread_updated_at: new Date().toISOString(),
        spread_source: usedSource,
      };
      // Never overwrite the spread once a game is completed — keep the
      // closing line rather than clobbering it with a stale/blank value.
      if (g.spread != null && !(existing && existing.completed)) {
        payload.spread = g.spread;
      }
      if (existing) payload.id = existing.id;

      const { error: gameErr } = await supabase
        .from('games')
        .upsert(payload, { onConflict: 'week_id,external_game_id' });
      if (gameErr) throw gameErr;
      written++;
    }

    return json(200, {
      ok: true,
      source: usedSource,
      season: year,
      season_type: seasonType,
      week: weekNumber,
      games_written: written,
      pick_deadline: pickDeadline.toISOString(),
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function fetchSchedule(params) {
  let espnUrl = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  const qp = [];
  if (params.year) qp.push('year=' + encodeURIComponent(params.year));
  if (params.week) qp.push('week=' + encodeURIComponent(params.week));
  if (params.seasontype) qp.push('seasontype=' + encodeURIComponent(params.seasontype));
  if (qp.length) espnUrl += '?' + qp.join('&');

  try {
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
  } catch (espnErr) {
    if (!process.env.ODDS_API_KEY) throw new Error('ESPN failed (' + espnErr.message + ') and no ODDS_API_KEY is configured for a backup.');
    const oddsUrl =
      'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=' +
      encodeURIComponent(process.env.ODDS_API_KEY) +
      '&regions=us&markets=spreads&oddsFormat=american';
    const res2 = await fetch(oddsUrl);
    if (!res2.ok) throw new Error('ESPN failed and backup Odds API also failed (HTTP ' + res2.status + ')');
    const data2 = await res2.json();
    const events = data2.map((ev) => ({ __odds: ev }));
    return {
      events,
      usedSource: 'odds_api',
      seasonInfo: {
        year: params.year || new Date().getFullYear(),
        seasonType: params.seasontype || 2,
        week: params.week ? Number(params.week) : null,
      },
    };
  }
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
      away_team: o.away_team,
      home_team: o.home_team,
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
    away_team: (awayC.team && (awayC.team.shortDisplayName || awayC.team.name)) || 'Away',
    home_team: (homeC.team && (homeC.team.shortDisplayName || homeC.team.name)) || 'Home',
    spread,
    commence_time: comp.date || ev.date,
    away_score: awayC.score != null ? Number(awayC.score) : null,
    home_score: homeC.score != null ? Number(homeC.score) : null,
    completed,
  };
}

// Computes 10:00 AM America/New_York on the Thursday of the game week that
// `earliestGameDate` falls in (i.e. the Thursday on or before that date).
function computeThursdayDeadlineEt(earliestGameDate) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(earliestGameDate).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const wd = weekdayMap[parts.weekday];
  const daysBack = (wd - 4 + 7) % 7;
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day) - daysBack;
  return nyWallTimeToUtc(y, m, d, 10, 0);
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
