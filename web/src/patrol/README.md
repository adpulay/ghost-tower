# Patrol tablet (`/patrol`)

The officer's view in the web app. It shows where to go and nothing else: a map that follows the active track, the intercept ★, an ETA countdown, the predicted route, and one status line. The status line shows the agent's latest `replan` trace; before the first replan it describes the track's heading, speed and ETA. When several tracks are active, large buttons switch between them. Dragging the map pauses the camera follow, and **Re-center** resumes it.

## Data

Reads the app's shared connection through `useTables()`, so it works on live and simulated data alike.
