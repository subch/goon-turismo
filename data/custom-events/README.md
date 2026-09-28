# Custom events

One JSON file per group-run custom event (our own lobbies, not official GT7 Time Trials),
written by `scripts/process-issue-result.mjs` when a GitHub Issue Form submission is
processed. A submission marked as an official Time Trial goes to `data/official-events/`
instead, attached to the sync's record of that TT when there is one.

Shape:

```json
{
  "id": "2026-08-16-friday-night-drags",
  "source": "custom",
  "seasonId": "summer-2026",
  "name": "Friday Night Drags",
  "track": "Tokyo Expressway - South Outer Loop",
  "car": "Open",
  "date": "2026-08-16",
  "createdFromIssue": 12,
  "notes": ""
}
```

`seasonId` (whichever season is `current` in `data/seasons.json` at the time the event was
created) is what puts it on the right season's standings page.
