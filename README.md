# SHRM Adaptive Trainer

Mobile-first SHRM-CP practice PWA.

## Included in V1
- 3,200 original SHRM-style practice-question instances
- Learn Mode with immediate right/wrong feedback and explanations
- Timed mock modes
- 10, 20, 40, 67, and 134-question formats
- Full 134-question simulation split into two 67-question / 110-minute sections
- Flag-and-review workflow
- Adaptive mode that weights weak domains and missed questions
- Session-level answer-position randomization; correct-letter streaks capped at 2
- Missed-question review
- Domain accuracy and session history
- PWA/offline caching
- Local device persistence by default
- Supabase-ready schema and config

## Run locally
Open `index.html` in a local web server. The easiest desktop option is:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Deploy
This is a static site and can be deployed to GitHub Pages, Netlify, Vercel, Cloudflare Pages, or similar.

## Supabase
1. Create a Supabase project.
2. Run `supabase/schema.sql`.
3. Copy `config.example.js` to `config.js`.
4. Add your Supabase project URL and publishable key.

The app works without Supabase using local browser storage.

## Exam pacing
Practice timers scale from a 220-minute / 134-question pace. Full simulation uses two 67-question sections at 110 minutes each.

## Disclaimer
Independent study tool. Not affiliated with or endorsed by SHRM. Questions are original practice items and are not copied from the SHRM exam.
