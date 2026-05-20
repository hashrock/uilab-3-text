# uilab-3-text

Wavy text field experiment — a single-line input rendered along a rope that
sags under the weight of its own text.

Live demo: https://hashrock.github.io/uilab-3-text/

## What it does

The text field's curve is not a fixed parabola: it's a 50-segment polyline
driven by a Verlet rope simulation. Each frame:

1. Text width along the path is mapped onto the segments to compute a
   per-segment "load" (skipping leading whitespace).
2. The load adds extra gravity to the adjacent rope nodes — heavier
   sections of text sag more.
3. Distance constraints are relaxed for 30 iterations so the chain stays
   inextensible across all 51 nodes.
4. The polyline becomes the `textPath` and drives the ribbon's outline.

The endpoints are pinned, so the field has fixed left/right anchors and
the middle behaves like a hanging chain.

### Debug overlay

Press `.` (with the field unfocused) to toggle 50 segment markers that
visualise where the load is concentrated.

## Develop

```bash
pnpm install
pnpm dev
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
