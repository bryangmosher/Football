// Runs once a day. Checks whether Week 18 (the last week of the season) has
// actually finished — plus a one-day buffer, so Monday Night Football has
// time to get graded — and if so, automatically snapshots the live
// leaderboard into the Champions history tables. Safe to run repeatedly:
// it just re-upserts the same season's numbers each day after that, so a
// late score correction still gets picked up.
//
// NOTE: WEEK1_START_UTC/WEEK2_START_UTC mirror the same fixed week-boundary
// constants used in app.js and sync-week.js. Update all three together at
// the start of a new season.

const { schedule } = require('@netlify/functions');
const { createClient } = require('@supabase/supabase-js');

const WEEK1_START_UTC = Date.UTC(2026, 8, 6); // Sept 6, 2026
const WEEK2_START_UTC = Date.UTC(2026, 8, 15); // Sept 15, 2026
const ONE_DAY_MS = 86400000;

function weekStartMs(weekNumber) {
  return weekNumber <= 1 ? WEEK1_START_UTC : WEEK2_START_UTC + (weekNumber - 2) * 7 * ONE_DAY_MS;
}

const handler = async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'missing env vars' }) };
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: week18, error: weekErr } = await supabase
      .from('weeks')
      .select('*')
      .eq('week_number', 18)
      .order('season', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (weekErr) throw weekErr;
    if (!week18) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'week 18 not synced yet' }) };
    }

    // Week 18 ends at the start of week 19 (7 days after week 18 starts).
    // Add a one-day buffer so a late Monday night game has time to grade.
    const seasonEndsMs = weekStartMs(18) + 7 * ONE_DAY_MS;
    const readyAtMs = seasonEndsMs + ONE_DAY_MS;

    if (Date.now() < readyAtMs) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'season not over yet' }) };
    }

    const seasonLabel = `${week18.season}-${week18.season + 1}`;

    const { data: leaderboard, error: lbErr } = await supabase.from('v_leaderboard').select('*');
    if (lbErr) throw lbErr;
    if (!leaderboard || !leaderboard.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'no leaderboard data yet' }) };
    }

    const { error: champErr } = await supabase
      .from('season_champions')
      .upsert({ season_label: seasonLabel, note: null }, { onConflict: 'season_label' });
    if (champErr) throw champErr;

    for (const row of leaderboard) {
      const { error: recErr } = await supabase
        .from('season_player_records')
        .upsert(
          {
            season_label: seasonLabel,
            player_name: row.name,
            correct_picks: row.wins,
            incorrect_picks: row.losses,
            ties: row.pushes,
          },
          { onConflict: 'season_label,player_name' }
        );
      if (recErr) throw recErr;
    }

    console.log(`Recorded season champion for ${seasonLabel}.`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, season_label: seasonLabel, players_recorded: leaderboard.length }) };
  } catch (err) {
    console.error('Season champion recording failed:', err.message || err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message || String(err) }) };
  }
};

exports.handler = schedule('0 15 * * *', handler);
