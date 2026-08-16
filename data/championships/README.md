# Championships

Team-based championship standings, modeled on the "Goon Standings" Google Sheet
(https://docs.google.com/spreadsheets/d/1wdFWxWGjS-J8nxp5U8970XsMWuS7ZpuqNGAfm2CMBZ8). Each
season is a team competition: teams of drivers (size varies by season -- solo, duo, or trio),
racing a fixed schedule of rounds (track + date), each round scoring Place / Pole+FL / Points per
team, with a running total per team.

One JSON file per championship season in this folder, plus `index.json` listing season ids in
order. Updated via the "Update championship standings" GitHub Issue Form
(`.github/ISSUE_TEMPLATE/update-championship.yml`), processed by
`scripts/process-championship-update.mjs` -- there is deliberately no scraper for this one, it's
manually reported after each round same as the sheet was.

Shape:

```json
{
  "id": "2026-fall-championship",
  "name": "Fall Championship 2026",
  "format": "trio",
  "rounds": [
    { "id": "r1", "track": "Laguna Seca", "date": "2026-09-01" },
    { "id": "r2", "track": "Dragon Trail - Seaside", "date": "2026-09-08" }
  ],
  "teams": [
    {
      "id": "team-red",
      "name": "Team Red",
      "color": "#ff3b3b",
      "roster": ["rickiep00h"],
      "results": {
        "r1": { "place": null, "poleFl": null, "points": 0 }
      },
      "totalPoints": 0
    }
  ]
}
```

`roster` entries should be PSNs from `data/players.json` where known; a plain display name string
is fine as a placeholder until it's confirmed which tracked PSN a sheet nickname maps to (a few
from the original sheet -- "Dr K", "Fairfax", "Rammy" -- didn't have a confirmed PSN match at
seed time).
