// Read-only passthrough to ESPN's public scoreboard endpoint, returning just
// what the Live Scores tab needs (current score, whether it's final, and a
// short status like "Q3 8:42" or "Final"). Calling this from the browser
// directly would hit CORS restrictions on some networks, so this function
// exists purely to fetch it server-side and hand back clean JSON — no
// secrets or database access involved, since this is all public data.

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

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
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

    const games = events.map((ev) => {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const competitors = comp.competitors || [];
      const homeC = competitors.find((c) => c.homeAway === 'home') || {};
      const awayC = competitors.find((c) => c.homeAway === 'away') || {};
      const statusType = comp.status && comp.status.type;
      return {
        away_team: canonicalTeamName((awayC.team && (awayC.team.shortDisplayName || awayC.team.name)) || ''),
        home_team: canonicalTeamName((homeC.team && (homeC.team.shortDisplayName || homeC.team.name)) || ''),
        away_score: awayC.score != null ? Number(awayC.score) : null,
        home_score: homeC.score != null ? Number(homeC.score) : null,
        completed: !!(statusType && statusType.completed),
        status_detail: (statusType && statusType.shortDetail) || '',
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, games }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: err.message || String(err) }),
    };
  }
};
