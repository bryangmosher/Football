# NFL Pick'em

A tiny 3-player pick-'em site: pick every game against the spread each week,
picks stay private until all three of you have submitted, then everyone's
picks reveal automatically. Includes a season leaderboard.

This README assumes no prior experience deploying a web app. Follow it top to
bottom — it should take about 20–30 minutes the first time.

---

## How it works, in plain terms

- **Frontend**: plain HTML/CSS/JavaScript. No build step, no framework — just
  static files. This is what you deploy to Netlify.
- **Database**: [Supabase](https://supabase.com) (free tier). Holds players,
  weeks, games, and picks. Security (who can see what) is enforced by the
  database itself via Row Level Security (RLS), not just by hiding things in
  the browser.
- **"Login"**: there are no passwords. Each browser gets an anonymous
  Supabase session automatically, and a player "claims" one of the 3 names
  once. That claim is what the database uses to know who's who — it can't be
  faked by editing browser JavaScript.
- **Schedule & spreads**: a small serverless function (runs on Netlify, not
  in the browser) fetches the NFL schedule and point spreads and writes them
  into Supabase. It uses ESPN's public scoreboard data by default (free, no
  key required) and can fall back to [The Odds API](https://the-odds-api.com)
  if you set up a free key there.

---

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up (free).
2. Click **New project**. Pick any name and a database password (save that
   password somewhere — you likely won't need it again, but keep it safe).
3. Wait ~2 minutes for it to finish provisioning.

### Run the database schema

1. In your Supabase project, open **SQL Editor** (left sidebar) → **New query**.
2. Open `supabase/migrations/0001_init.sql` from this project, copy the whole
   file, paste it into the SQL editor, and click **Run**.
3. This creates all the tables, security rules, and the three player rows
   (**Joe, Mike, Bryan** by default — see "Changing player names" below).

### Enable anonymous sign-ins

This is required — the whole privacy model depends on it.

1. In Supabase, go to **Authentication** → **Sign In / Providers** (the exact
   label has moved around Supabase's dashboard over time — look for
   "Anonymous Sign-Ins" under Authentication settings if it's not there).
2. Turn on **Allow anonymous sign-ins**.

### Get your API keys

1. Go to **Settings** → **API**.
2. Copy the **Project URL**.
3. Copy the **anon / public** key. This one is *safe* to put in client-side
   code — it's designed for that, and RLS is what actually protects your data.
4. Copy the **service_role** key too, but treat it like a password — it
   bypasses all security rules. It only ever goes into Netlify's server-side
   environment variables (step 3 below), never into any file that gets
   deployed to the browser.

### Changing player names

Open `supabase/migrations/0001_init.sql`, find this line near the top:

```sql
insert into players (name) values ('Joe'), ('Mike'), ('Bryan')
on conflict (name) do nothing;
```

Edit the names *before* running the migration, or if you've already run it,
just run this once in the SQL Editor instead:

```sql
update players set name = 'NewName' where name = 'Joe';
```

---

## 2. Configure the frontend

Open `config.js` in this project and fill in the two values from Supabase:

```js
window.SUPABASE_URL = "https://your-project-ref.supabase.co";
window.SUPABASE_ANON_KEY = "your-anon-public-key";
```

Leave `ADMIN_SYNC_KEY` blank unless you set up `ADMIN_SYNC_SECRET` (see the
optional hardening note near the bottom).

---

## 3. Get an odds/schedule data source

The sync function uses **ESPN's public scoreboard endpoint** by default —
this needs no signup and no key. It's not an official paid API, but it's the
same data ESPN's own apps use and it's free and reliable in practice. This
alone is enough to run the site.

**Optional backup**: if you want a documented, official fallback in case
ESPN's endpoint ever changes or blocks requests:

1. Go to [the-odds-api.com](https://the-odds-api.com) and sign up for a free
   API key (no credit card required, free tier is ~500 requests/month).
2. You'll add this as an environment variable in Netlify in the next step.

---

## 4. Deploy to Netlify

1. Push this project to a GitHub repository (or GitLab/Bitbucket).
2. Go to [netlify.com](https://netlify.com), sign up/log in, click
   **Add new site** → **Import an existing project**, and connect your repo.
3. Build settings: leave them as detected (this project's `netlify.toml`
   already tells Netlify where the functions live and to run `npm install`).
4. Before or after the first deploy, go to **Site configuration** →
   **Environment variables** and add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | same Project URL as above |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (server-side only) |
   | `ODDS_API_KEY` | *(optional)* your the-odds-api.com key |
   | `ADMIN_SYNC_SECRET` | *(optional)* see hardening note below |

5. Trigger a deploy (push a commit, or click **Trigger deploy** in Netlify).
6. Once deployed, open the site URL Netlify gives you.

### Loading the first week

On the **Home** tab, expand **Admin: sync schedule & spreads**, and click
**Sync current week**. This calls the serverless function, which fetches the
schedule and writes it into Supabase. Do this once a week (any time after the
previous week's games are complete works well — e.g. Tuesday) to pull in the
new week and backfill final scores for the leaderboard from the week before.

There's no automatic scheduler set up (kept out on purpose to keep this
simple) — someone just needs to tap that button. If you'd like it automated,
Netlify supports [Scheduled
Functions](https://docs.netlify.com/functions/scheduled-functions/); ask me
and I can wire that up.

---

## 5. Local development (optional)

You don't need this to just use the site, but if you want to test changes:

```bash
npm install -g netlify-cli
npm install
netlify dev
```

`netlify dev` serves the static files and runs the function locally,
reading environment variables from a local `.env` file (copy `.env.example`
to `.env` and fill in real values — `.env` should never be committed).

---

## 6. Custom domain (optional)

In Netlify: **Site configuration** → **Domain management** → **Add a
domain**. Netlify will either let you buy one through them or walk you
through pointing your existing domain's DNS at Netlify (usually a couple of
CNAME/A records at your domain registrar). This part is entirely on
Netlify's side — the app itself needs no changes.

---

## Design notes / things worth knowing

- **Pick deadline**: this app uses a single deadline per week — 10:00 AM
  America/New_York on the Thursday of that game week — matching the
  `pick_deadline` column design you asked for. It is enforced **server-side**
  in the `submit_picks` database function, not just hidden in the UI, so it
  can't be bypassed by editing the page.
- **Privacy enforcement**: nobody's unsubmitted picks are ever sent to
  another player's browser. The database's Row Level Security policy only
  returns a player's own picks, or everyone's picks once a `SECURITY DEFINER`
  function confirms all 3 players have submitted. "Who has submitted" (without
  their selections) is exposed through a separate function built for exactly
  that.
- **Submitted picks are locked**: there's no update/delete policy on picks at
  all — the only way to write picks is the `submit_picks` function, and it
  refuses if you've already submitted for that week. If someone genuinely
  needs a redo, you (or whoever has Supabase dashboard access) can delete
  their rows from the `picks` table in **Table Editor**.
- **If someone loses their claim** (new phone, cleared browser data): claims
  are permanent by design (no passwords means no other way to prove it's
  really them). To free up a name again, open Supabase **Table Editor** →
  `players` → clear that row's `claimed_by` value.
- **Draft picks** (selections made before hitting Submit) are stored only in
  that browser's local storage, so they survive a refresh but don't sync
  across devices — intentional, since nothing should be readable by others
  before submission anyway.
- **The odds data source** (ESPN's public endpoint) is unofficial and could
  change format. The sync function is written so swapping providers means
  editing one file (`netlify/functions/sync-week.js`) — the rest of the app
  doesn't care where the data came from.

### Optional: locking down the sync button

By default, anyone who finds your Netlify function URL could trigger a sync
(worst case: it just re-fetches accurate public schedule data, or eats into
your free Odds API quota — low stakes for a 3-friend project). If you'd
rather require a shared secret:

1. Set `ADMIN_SYNC_SECRET` in Netlify's environment variables to any string
   you choose.
2. Put the same string in `config.js` as `window.ADMIN_SYNC_KEY`.

---

## Project files

```
index.html                        Main page
style.css                         Styling
app.js                            All frontend logic
config.js                         Supabase URL/anon key (safe to be public)
netlify.toml                      Netlify build/functions config
package.json                      Dependency for the serverless function
.env.example                      Reference for Netlify env var names
netlify/functions/sync-week.js    Fetches schedule/spreads, writes to Supabase
supabase/migrations/0001_init.sql Database schema, RLS policies, RPC functions
```
