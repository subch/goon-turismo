# Tunes

One JSON file per submitted GT7 tune (car setup with parts that deviate from stock), written by
`scripts/process-tune-submission.mjs` when a "Submit a tune" GitHub Issue Form is processed.

Shape:

```json
{
  "id": "toyota-mr2-gt-s-97-superpharts-1",
  "car": "Toyota MR2 GT-S '97",
  "owner": "superpharts",
  "class": "SH / N400",
  "drivetrain": "FR",
  "description": "Time trial setup, stiff and pointy for Lago Maggiore East End.",
  "parts": [
    { "category": "Engine", "name": "Stage 3 Turbo Kit" },
    { "category": "Suspension", "name": "Fully Customizable Suspension" },
    { "category": "Drivetrain", "name": "Fully Customizable LSD" }
  ],
  "settings": {
    "Power/Weight": "420 HP / 980 kg",
    "Ride Height (F/R)": "95 / 100",
    "Camber (F/R)": "1.5 / 1.0",
    "LSD Initial/Accel/Braking": "10 / 30 / 20",
    "Gearing": "Max speed set to 240 km/h"
  },
  "notes": "",
  "createdFromIssue": 15
}
```

`parts` and `settings` are freeform -- there's no fixed GT7 parts taxonomy enforced here, just
whatever the submitter listed.
