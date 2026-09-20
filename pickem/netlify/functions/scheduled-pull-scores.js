// Runs every 15 minutes, always — but only does real work during these
// windows (all times Mountain):
//   Sunday, once per hour from 1:00 PM through 11:59 PM
//   Monday, once around 11:59 PM
//   Thursday, once around 11:59 PM (Thursday Night Football)
// Every other invocation exits immediately without calling any API, so it
// costs nothing outside those windows.
//
// Why a 15-minute cron instead of exact cron times: Netlify's scheduler runs
// in fixed UTC with no daylight-saving awareness. Hardcoding UTC times would
// drift by an hour whenever MDT/MST changes (which happens mid-NFL-season,
// in early November). Instead, this checks the *actual* current Mountain
// wall-clock time on every tick — the same DST-safe technique already used
// elsewhere in this project for the Thursday pick deadline — so it's correct
// all season long with no manual adjustment.
//
// Which week to grade: this asks ESPN's scoreboard endpoint for its own
// current-week label (year/season type/week number), then finds that same
// week in our database. If that week hasn't been synced into the app yet
// (lines never pulled for it), this just logs and does nothing that run.

const { schedule } = require('@netlify/functions');
const { createClient } = require('@supabase/supabase-js');

const TEAM_NAME_MAP = {
  'Arizona Cardinals': 'Cardinals', 'Atlanta Falcons': 'Falcons', 'Baltimore Ravens': 'Ravens',
  'Buffalo Bills': 'Bills', 'Carolina Panthers': 'Panthers', 'Chicago Bears': 'Bears',
  'Cincinnati Bengals': 'Bengals', 'Cleveland Browns': 'Browns', 'Dallas Cowboys': 'Cowboys',
  'Denver Broncos': 'Broncos', 'Detroit Lions': 'Lions', 'Green Bay Packers': 'Packers',
  'Houston Texans': 'Texans', 'Indianapolis Colts': 'Colts', 'Jacksonville Jaguars': 'Jaguars',
  'Kansas City Chiefs': 'Chiefs', 'Las Vegas Raiders': 'Raiders', 'Los Angeles Chargers': 'Chargers',
  'Los Angeles Rams': 'Rams', 'Miami Dolphins': 'Dolphins', 'Minnesota Vikings': 'Vikings',
  'New England Patriots': 'Patriots', 'New Orleans Saints': 'Saints', 'New York Giants': 'Giants',
  'New York Jets': 'Jets', 'Philadelphia Eagles': 'Eagles', 'Pittsburgh Steelers': 'Steelers',
  'San Francisco 49ers': '49ers', 'Seattle Seahawks': 'Seahawks', 'Tampa Bay Buccaneers': 'Buccaneers',
  'Tennessee Titans': 'Titans', 'Washington Commanders': 'Commanders',
};
function canonicalTeamName(name) {
  const trimmed = String(name || '').trim();
  return TEAM_NAME_MAP[trimmed] || trimmed;
}

function getMountainNow() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date()).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return { weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function isInWindow() {
  const { weekday, hour, minute } = getMountainNow();

  if (weekday === 'Sun') {
    // Once per hour, on the hour, from 1pm through 11pm.
    return hour >= 13 && hour <= 23 && minute < 15;
  }
  if (weekday === 'Mon' || weekday === 'Thu') {
    // Once, right near the end of the day.
    return hour === 23 && minute >= 45;
  }
  return false;
}

const handler = async () => {
  if (!isInWindow()) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'outside scheduled window' }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'missing env vars' }) };
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
    if (!res.ok) throw new Error('ESPN HTTP ' + res.status);
    const data = await res.json();
    const events = data.events || [];
    const season = data.season && data.season.year;
    const seasonType = data.season && data.season.type;
    const weekNumber = data.week && data.week.number;

    if (!season || !seasonType || !weekNumber) {
      console.log('ESPN did not return a current week label — nothing to do.');
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'no current week from ESPN' }) };
    }

    const { data: week, error: weekErr } = await supabase
      .from('weeks')
      .select('*')
      .eq('season', season)
      .eq('season_type', seasonType)
      .eq('week_number', weekNumber)
      .maybeSingle();

    if (weekErr) throw weekErr;
    if (!week) {
      console.log(`ESPN says week ${weekNumber} (${season}), but it hasn't been synced into the app yet — nothing to grade.`);
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'current week not yet synced' }) };
    }

    let written = 0;
    let skipped = 0;
    for (const ev of events) {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const competitors = comp.competitors || [];
      const homeC = competitors.find((c) => c.homeAway === 'home') || {};
      const awayC = competitors.find((c) => c.homeAway === 'away') || {};
      const awayTeam = canonicalTeamName((awayC.team && (awayC.team.shortDisplayName || awayC.team.name)) || '');
      const homeTeam = canonicalTeamName((homeC.team && (homeC.team.shortDisplayName || homeC.team.name)) || '');
      const completed = !!(comp.status && comp.status.type && comp.status.type.completed);
      const awayScore = awayC.score != null ? Number(awayC.score) : null;
      const homeScore = homeC.score != null ? Number(homeC.score) : null;

      const { data: existing } = await supabase
        .from('games')
        .select('id')
        .eq('week_id', week.id)
        .eq('away_team', awayTeam)
        .eq('home_team', homeTeam)
        .maybeSingle();

      if (!existing) {
        skipped++;
        continue;
      }

      const { error: updateErr } = await supabase
        .from('games')
        .update({ away_score: awayScore, home_score: homeScore, completed })
        .eq('id', existing.id);
      if (updateErr) throw updateErr;
      written++;
    }

    console.log(`Scheduled score pull: week ${week.week_number} (${week.season}) — ${written} updated, ${skipped} skipped.`);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, week: week.week_number, season: week.season, games_updated: written, games_skipped: skipped }),
    };
  } catch (err) {
    console.error('Scheduled score pull failed:', err.message || err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message || String(err) }) };
  }
};

exports.handler = schedule('*/15 * * * *', handler);
