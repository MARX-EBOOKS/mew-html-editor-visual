(() => {
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 3;
  const WHEEL_SPEED = 0.0015;
  const scanStage = document.getElementById("scanStage");
  const imageDialog = document.getElementById("imageDialog");
  if (!scanStage || !imageDialog) return;

  const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  const wheelFactor = (event) => Math.exp(-event.deltaY * WHEEL_SPEED);

  function preservePoint(container, image, event, applyZoom) {
    const before = image.getBoundingClientRect();
    if (!before.width || !before.height) return;
    const pointX = (event.clientX - before.left) / before.width;
    const pointY = (event.clientY - before.top) / before.height;
    applyZoom();
    requestAnimationFrame(() => {
      if (!image.isConnected) return;
      const after = image.getBoundingClientRect();
      container.scrollLeft += after.left + pointX * after.width - event.clientX;
      container.scrollTop += after.top + pointY * after.height - event.clientY;
    });
  }

  scanStage.addEventListener("wheel", (event) => {
    const image = event.target.closest(".scan-page-image");
    if (!image) return;
    event.preventDefault();
    const nextZoom = clampZoom(state.zoom * wheelFactor(event));
    if (nextZoom === state.zoom) return;
    preservePoint(scanStage, image, event, () => setZoom(nextZoom));
  }, { passive: false });

  let dialogZoom = 1;
  function setDialogZoom(value) {
    dialogZoom = clampZoom(value);
    imageDialog.querySelectorAll(".dialog-page-image").forEach((image) => {
      if (image.naturalWidth) image.style.width = `${image.naturalWidth * dialogZoom}px`;
    });
  }

  imageDialog.addEventListener("load", (event) => {
    if (event.target.matches?.(".dialog-page-image")) setDialogZoom(dialogZoom);
  }, true);
  imageDialog.addEventListener("wheel", (event) => {
    const image = event.target.closest(".dialog-page-image");
    if (!image) return;
    event.preventDefault();
    const nextZoom = clampZoom(dialogZoom * wheelFactor(event));
    if (nextZoom === dialogZoom) return;
    preservePoint(imageDialog, image, event, () => setDialogZoom(nextZoom));
  }, { passive: false });
  document.getElementById("fullImage")?.addEventListener("click", () => setDialogZoom(1));

  function installPan(container, selector) {
    let drag = null;
    container.addEventListener("dragstart", (event) => {
      if (event.target.closest(selector)) event.preventDefault();
    });
    container.addEventListener("pointerdown", (event) => {
      const image = event.target.closest(selector);
      if (event.button !== 0 || !image) return;
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      container.classList.add("image-panning");
      image.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    container.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      container.scrollLeft -= event.clientX - drag.x;
      container.scrollTop -= event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      event.preventDefault();
    });
    const stopPan = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      container.classList.remove("image-panning");
    };
    container.addEventListener("pointerup", stopPan);
    container.addEventListener("pointercancel", stopPan);
  }

  installPan(scanStage, ".scan-page-image");
  installPan(imageDialog, ".dialog-page-image");
})();
