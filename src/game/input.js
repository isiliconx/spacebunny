/**
 * Input: keyboard for movement, pointer drag to orbit the camera, wheel to
 * zoom. Exposes "held" state separately from "pressed this frame" so the
 * controller can do things like variable jump height without missing a tap.
 */

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set();     // cleared at the end of every frame
    this.orbitDX = 0;
    this.orbitDY = 0;
    this.zoomDelta = 0;
    this.dragging = false;
    this.pointerId = null;
    this.lastX = 0;
    this.lastY = 0;
    this.enabled = true;
    this._bind();
  }

  _bind() {
    const onKey = (e, down) => {
      if (!this.enabled) return;
      // Let the browser keep its own shortcuts (devtools, reload, tab switch).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const code = e.code;
      if (down) {
        if (!this.keys.has(code)) this.pressed.add(code);
        this.keys.add(code);
      } else {
        this.keys.delete(code);
      }
      // Space and the arrows scroll the page otherwise.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.dragging = false;
    });

    const dom = this.dom;
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
      dom.classList.add('dragging');
    });

    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      this.orbitDX += e.clientX - this.lastX;
      this.orbitDY += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });

    const endDrag = (e) => {
      if (e.pointerId !== undefined && e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = null;
      dom.classList.remove('dragging');
    };
    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.zoomDelta += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 + 0.35);
    }, { passive: false });
  }

  isDown(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  /** True only on the frame the key went down. */
  consumePress(...codes) {
    for (const c of codes) {
      if (this.pressed.has(c)) {
        this.pressed.delete(c);
        return true;
      }
    }
    return false;
  }

  /** Movement intent in local space: x = strafe, y = forward. */
  axis() {
    let x = 0;
    let y = 0;
    if (this.isDown('KeyW', 'ArrowUp')) y += 1;
    if (this.isDown('KeyS', 'ArrowDown')) y -= 1;
    if (this.isDown('KeyA', 'ArrowLeft')) x -= 1;
    if (this.isDown('KeyD', 'ArrowRight')) x += 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  get sprinting() { return this.isDown('ShiftLeft', 'ShiftRight'); }
  get jumpHeld() { return this.isDown('Space'); }

  /** Call once at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.orbitDX = 0;
    this.orbitDY = 0;
    this.zoomDelta = 0;
  }
}
