# Trace panel (Role 2)

Live view of what the Nemotron agent is doing for the selected track. Role 3 drops it into the
analyst map's side panel; no shell files need to change.

```tsx
import { TracePanel } from "./trace-panel";

// Rows from the shared Spacetime subscription hook (Role 3):
<TracePanel
  track={selectedTrack}                                   // live `track` row: id, status, confidence
  traces={agentTrace.filter(t => t.track_id === selectedTrack?.id)}
/>
```

No shared hook yet? Use the HTTP polling fallback:

```tsx
import { TracePanel, usePolledTraceData } from "./trace-panel";

const { track, traces } = usePolledTraceData(selectedTrackId, { host: SPACETIME_HOST, database: "ghost-tower" });
<TracePanel track={track} traces={traces} />
```

What it does:
- Rows sorted oldest → newest, newest at the bottom. It auto-scrolls while you're at the
  bottom and stops when you scroll up to read. "↓ Latest" jumps back down.
- Each `kind` has its own style: plan (blue), tool call (mono, grey), tool result (indented),
  **re-plan (amber band + badge, pulses when it arrives)**, summary (green).
- Tool results the agent marked with a trailing `[simulated]` (the carrier SMSC mock) show a
  small "simulated" tag instead.
- The header shows track number, status and confidence exactly as the `track` row has them.
  The panel computes nothing.
- The panel fills its container's height (min 240 px), so give the side panel a height. Light
  and dark mode follow the OS. Override the `--gt-*` CSS variables on `.gt-trace` to theme it.

Peer deps: `react >= 18`. The CSS is imported by the component, which works with Vite out of
the box.
