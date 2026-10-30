# What the dashboard shows

Placeholder for screenshots — capture these for the report:

1. **Overview** — the six KPI cards (PV harvest, load demand, net power, bus voltage,
   harvested Wh, demand reduction) with the power-flow chart and the AUTO/SAVE ribbon.
2. **Protection view** — bus-voltage chart with the 12.40 V LVD and 12.45 V gate dashed
   lines, and an alert banner active while the bus is inside a warning band.
3. **Switching events table** — at least one `AUTO_SAVE` row showing `−46.2 %`.
4. **Live serial feed** — raw frames scrolling, colour-coded by state.

Quickest way to get all four: run `node dashboard/server.js --simulate`, wait ~3 minutes
for a full AUTO → SAVE → AUTO cycle, then capture at 1440 px wide.
