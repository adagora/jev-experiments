---
name: turbo-rerank-e2e
description: Browser-test Turbo Rerank live searches, streaming benchmark, and explicit mock-mode labeling.
---

# Turbo Rerank runtime testing

Run from `turbo-rerank/` with Node >=22. Use `npm ci` when dependencies are absent; `npm run dev` starts Vite on 5173 and the Node proxy on 8787. No browser authentication is required. Reuse existing processes when appropriate; stop the entire concurrently process tree before switching modes so neither port remains occupied.

## Devin Secrets Needed

- `TYPESAFE_API_KEY`: export into the proxy environment for live requests. Never write the value into source or screenshots.

Maximize Chrome before recording. Search automatically runs after approximately 250 ms without Enter. Search and Benchmark are top navigation tabs. The benchmark runs via `Run benchmark` and streams 40 rows; capture partial progress and completed results. Navigating away unmounts the benchmark, so save completed screenshots before leaving it.

Use the parental-leave example to demonstrate rank movement, and the office-Wi-Fi question to demonstrate the no-good-answer banner. Record actual values, not fixed latency promises: cold connections and API variability can produce outliers. BM25 returns up to 50 positive-score matches, so some searches score fewer than 50 candidates.

For an explicit offline indicator check, stop live dev, start `MOCK=1 npm run dev`, refresh the browser, and verify the red MOCK pill. Stop mock, restart normal dev, and refresh to verify the live pill. Keep mock evidence separate from live ranking/accuracy evidence.

Export screenshots before mode switches. Animated WebP can be generated using ffmpeg with `fps=8,scale=1280:-1`; use a real search-to-benchmark recording segment and check duration/file size. ImageMagick can verify frame delays and dimensions without Python image dependencies.
