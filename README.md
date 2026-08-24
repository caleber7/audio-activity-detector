# Audio Activity Detector

A local-first desktop-style tool that analyzes a video audio track and pinpoints spans where much more is happening than usual.

## What it does

- Processes local video files in the browser; no media is uploaded.
- Measures short-window audio energy and spectral change.
- Compares activity against the video own baseline.
- Merges nearby detections into useful timestamp spans.
- Lets you adjust sensitivity, seek to a detected moment, copy timestamps, or export CSV.

## Run

Run `pnpm install`, then `pnpm --filter @workspace/audio-activity-detector run dev`.
