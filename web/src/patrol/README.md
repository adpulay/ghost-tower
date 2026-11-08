# Patrol tablet (`/patrol`)

Role 1's view inside Role 3's web app. It shows where to go and nothing else: a map that follows the active track, the intercept ★, an ETA countdown, the predicted route, and one status line. The status line shows the agent's latest `replan` trace; before the first replan it describes the track's heading, speed and ETA. When several tracks are active, large buttons switch between them. Dragging the map pauses the camera follow, and **Re-center** resumes it.

## Mounting (Role 3)

```tsx
import PatrolView from './patrol/PatrolView';
<Route path="/patrol" element={<PatrolView />} />   // under your <SpacetimeDBProvider>
```

Requirements for the shell:
- deps: `react@18`, `leaflet@1.9`, `react-leaflet@4`, `spacetimedb@2.14.1`
- bindings at `web/src/module_bindings`, from `spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path spacetime`, or by re-exporting `spacetime/bindings/index.ts`

Nothing in this folder edits your files. Only `patrolModel.ts` (pure logic) is unit-tested in Node (`npm test`). The view itself was typechecked against React 18, react-leaflet 4 and the bindings, but has **not** yet been run in a browser or on the demo tablet (TESTING.md §2h, last two items).
