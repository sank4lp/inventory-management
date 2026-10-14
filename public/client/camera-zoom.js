// Digital zoom works with the rear camera on Safari and Chrome, including
// devices that do not expose a native camera zoom constraint.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value) || MIN_ZOOM));
}

// Match object-fit: cover, then the centred scale shown in the preview. Decode
// only that rectangle: a QR outside the visible camera area must not be read.
export function cameraCrop(width, height, viewWidth, viewHeight, zoom = 1) {
  const aspect = viewWidth > 0 && viewHeight > 0 ? viewWidth / viewHeight : width / height;
  let cropWidth = width, cropHeight = height;
  if (width / height > aspect) cropWidth = height * aspect;
  else cropHeight = width / aspect;
  cropWidth /= clampZoom(zoom); cropHeight /= clampZoom(zoom);
  return {x:(width-cropWidth)/2, y:(height-cropHeight)/2, width:cropWidth, height:cropHeight};
}

export function mountCameraZoom(video) {
  const doc = video.ownerDocument;
  const dialog = video.closest('dialog'), wasCameraDialog = dialog?.classList.contains('qr-camera-dialog');
  dialog?.classList.add('qr-camera-dialog');
  const viewport = doc.createElement('div');
  viewport.className = 'qr-camera-viewport';
  viewport.setAttribute('aria-label', 'Camera preview. Pinch to zoom.');
  video.before(viewport); viewport.append(video);
  const controls = doc.createElement('div');
  controls.className = 'qr-camera-zoom';
  controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Camera zoom');
  controls.innerHTML = '<button type="button" class="icon-button" data-zoom-out aria-label="Zoom out"><span aria-hidden="true">−</span></button><output aria-label="Zoom level">1×</output><button type="button" class="icon-button" data-zoom-in aria-label="Zoom in"><span aria-hidden="true">+</span></button>';
  viewport.append(controls);
  const minus = controls.querySelector('[data-zoom-out]'), plus = controls.querySelector('[data-zoom-in]'), output = controls.querySelector('output');
  const listeners = [], pointers = new Map();
  let zoom = MIN_ZOOM, pinch = null, disposed = false;
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };
  const setZoom = value => {
    if (disposed) return zoom;
    zoom = clampZoom(value);
    video.style.transform = `scale(${zoom})`;
    output.value = `${Number(zoom.toFixed(2))}×`;
    minus.disabled = zoom <= MIN_ZOOM; plus.disabled = zoom >= MAX_ZOOM;
    return zoom;
  };
  listen(minus, 'click', () => setZoom(zoom - .25));
  listen(plus, 'click', () => setZoom(zoom + .25));
  const distance = () => {
    const [a,b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x-b.x, a.y-b.y) : 0;
  };
  listen(viewport, 'pointerdown', event => {
    if (event.pointerType !== 'touch' || event.target.closest('button')) return;
    pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
    viewport.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) pinch = {distance:distance(), zoom};
  });
  listen(viewport, 'pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, {x:event.clientX, y:event.clientY});
    if (pinch?.distance && pointers.size === 2) {
      event.preventDefault(); setZoom(pinch.zoom * distance() / pinch.distance);
    }
  });
  const release = event => {
    pointers.delete(event.pointerId); pinch = pointers.size === 2 ? {distance:distance(), zoom} : null;
  };
  for (const type of ['pointerup','pointercancel','lostpointercapture']) listen(viewport, type, release);
  setZoom(MIN_ZOOM);
  return {
    get zoom() { return zoom; },
    setZoom,
    drawFrame(canvas, context) {
      if (disposed || !video.videoWidth || !video.videoHeight) return false;
      const crop = cameraCrop(video.videoWidth, video.videoHeight, viewport.clientWidth, viewport.clientHeight, zoom);
      // Avoid decoding a multi-megapixel phone frame on every animation tick.
      const scale = Math.min(1, 1280 / Math.max(crop.width, crop.height));
      const width = Math.max(1, Math.round(crop.width * scale)), height = Math.max(1, Math.round(crop.height * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of listeners) remove();
      for (const id of pointers.keys()) if (viewport.hasPointerCapture?.(id)) viewport.releasePointerCapture(id);
      pointers.clear(); pinch = null; controls.remove();
      video.style.removeProperty('transform');
      if (viewport.parentNode) { viewport.before(video); viewport.remove(); }
      if (!wasCameraDialog) dialog?.classList.remove('qr-camera-dialog');
    },
  };
}

if (typeof window !== 'undefined') globalThis.WarehouseCamera = {mountCameraZoom};
