# Project contract

Every project under `projects/` obeys these rules. Read this whole file before
writing any code — it exists because the first eight demos shipped bugs that
these rules prevent.

## 1. One self-contained file

Each project is exactly one `index.html` in its own folder:

```
projects/<slug>/index.html
projects/<slug>/preview.png     (you generate this; see §7)
```

Inline all CSS and JS. **Zero external requests**: no CDN, no `fetch`, no
`<link>` to a font, no remote images, no `import` of a bare module specifier.
It must run when opened directly from disk over `file://` — a user double-clicks
it with the network unplugged and it works.

Exception: if your project genuinely needs three.js, vendor it as a local file
in your folder and use an import map. Do not link a CDN.

## 2. Signals the harness depends on

```js
window.__ready = true;   // scene is stable, controls live, safe to screenshot
window.__probe = {};     // live stats: fps, counts, whatever is worth reporting
```

Set `__ready` only once the first real frame is on screen — after any warm-up,
seeding, or accumulation. A harness waits on this flag; setting it early means
the screenshot catches a loading screen and the project is marked broken.

## 3. Deterministic

Seed every random draw (`mulberry32` or similar) and keep it in the render path.
`Math.random()` may appear only inside a user-triggered handler (a "shuffle"
button, for example) — never in something that runs on load. Two cold loads must
produce the same image.

If you simulate time, advance it by a fixed delta per frame, not by wall clock,
so a slow machine produces the same scene as a fast one.

## 4. Calibrated for software rendering

The verification machine has **no GPU**. It runs Chrome's SwiftShader on 4 CPU
cores, and it is **fill-rate bound** — fullscreen fragment work is the entire
cost.

- Target an internal render resolution of **512×320 to 640×400**, then upscale.
  A full 1280×800 heavy shader can take 100 ms+ per frame.
- Expect **1–5 fps**. That is normal and fine. Do not "optimise" for a framerate
  you will never see.
- `EXT_color_buffer_float` must be requested via
  `gl.getExtension('EXT_color_buffer_float')` **before** creating any float FBO,
  or `checkFramebufferStatus` silently reports incomplete.
- If you use float render targets, probe the format and fall back to `RGBA8`.
  `RG16F` is broken on this driver; `RGBA16F` and `RGBA32F` work.
- `gl.finish()` does not synchronise. If you need a real timing, do a 1px
  `readPixels` drain *before* starting the timer.
- Do not add per-pixel loops over neighbours beyond ~9 taps; cost is
  texture-fetch-bound, not ALU-bound.

## 5. Built to be looked at

This is a portfolio. A correct demo that renders as grey mush is a failure.

- **Composed, not centred by default.** Move the focal point, vary the scale,
  use the frame deliberately.
- **Considered palette.** Pick 3–5 colours with a relationship. Dark grounds
  with luminous subjects read best here.
- **Legible UI.** Panels in the corners, monospace, small. Text under ~11px is
  invisible at normal viewing.
- **Real controls.** At least three that visibly change the scene. A demo with
  no controls is a video, not a project.
- **No default state that looks broken.** If your first frame is mid-warm-up,
  warm up before showing it.

## 6. Name the technique in the UI

Put a short technical line somewhere visible — the pipeline, the algorithm, the
model. It is a showpiece; let the technique be part of the presentation.

## 7. Verify before you declare done

From the repo root:

```bash
cd /home/ubuntu/spacebunny
node demos/tools/render.mjs "file://$PWD/projects/<slug>/index.html" \
     projects/<slug>/preview.png --w 1280 --h 800 \
     --ready "window.__ready===true" --timeout 120
python3 demos/tools/imginfo.py projects/<slug>/preview.png
```

`imginfo.py` prints colour count, clipping, and a verdict. You want:

- `VERDICT: OK`
- **more than ~1,500 colours** (a flat image scores in the hundreds)
- **top colour under ~8%** of pixels
- **no page errors** in the render output

Then **look at the PNG**. Load it with `vision_analyze` and ask whether the
subject is visible, whether it is composed, and whether anything is blown out.
Pixel statistics catch blank and flat output; only vision catches "technically
correct, visually mush". Fix what it reports and re-render. Budget for several
iterations — the first frame is rarely the final one.

If your project renders at a fixed internal resolution and would look better
captured larger, render the preview at 1280×800 regardless; the upscale is
already in your pipeline.

## 8. Rules of engagement

- Write **only** inside your own project folder. Never touch `projects/*/`
  belonging to another project, `demos/`, `index.html`, `js/`, or `css/`.
- **Do not run any `git` command.** The parent agent handles commits and the PR.
- Do not create extra files beyond `index.html` and `preview.png`, except a
  vendored library if §1's exception applies.
- Do not leave scratch files, logs, or build artifacts in the repo.
- If you are stuck or the technique is not working, say so in your final report
  rather than shipping something that renders wrong. A truthful failure report
  is more useful than a confident broken demo.
