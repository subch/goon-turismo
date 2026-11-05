# Goon TTs

One JSON file per Goon TT: the crew's own two-week time trial in one shared tune, run apart from the
official Time Trials and the season standings. A new one is added by hand; its laps are added by the
Goon Turismo bot after `scripts/goon-tt/check-lap.mjs` has passed the screenshot, and the screenshot
is kept as proof under `public/goon-tt/<id>/`.

Shape:

```json
{
  "id": "2026-11-04-sportsland-sugo",
  "name": "Goon TT 1",
  "track": "Sportsland SUGO",
  "timeOfDay": "Daytime",
  "penalties": "Weak",
  "car": "Nissan Fairlady 240ZG (HS30) '71",
  "tuneId": "nissan-fairlady-240zg-hs30-71-dog-nougat",
  "pp": 605.25,
  "tyres": "SS",
  "startDate": "2026-11-04",
  "endDate": "2026-11-18",
  "opensAt": "2026-11-04T06:00:00Z",
  "closesAt": "2026-11-19T05:59:00Z",
  "laps": [
    {
      "psn": "dog_nougat",
      "timeMs": 87864,
      "setOn": "2026-11-04",
      "setAt": "12:23",
      "proof": "/goon-tt/2026-11-04-sportsland-sugo/dog_nougat-87864.jpg",
      "submittedAt": "2026-11-05T05:33:28Z",
      "via": "hand"
    }
  ]
}
```

- `car` is GT7's own name for it, as the records screen prints it; `pp` is that car's PP on `tyres`
  (a GT7 tyre code: `SS` Sports Soft, `RH` Racing Hard...), to the hundredth. A screenshot must show
  both.
- `startDate` / `endDate` bound the date the records screen gives the lap (the console's own date).
  `opensAt` / `closesAt` are the instants submissions open and close: midnight and 23:59 Central on
  those dates.
- `laps` keeps every accepted lap, not just each driver's best; the board takes the best. `setOn` /
  `setAt` are the date and time on the records screen. `via` is `hand`, `command` (/goonttsubmit) or
  `message` (the right-click submit).
- Points are the site's usual percent-off-pace scale (`data/points-config.json`) within this Goon TT
  only: `board()` in `scripts/goon-tt/standings.mjs`.
