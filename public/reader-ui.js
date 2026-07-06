(() => {
  const root = document.documentElement;
  const body = document.body;
  const grid = document.querySelector(".reader-grid");
  const scanPane = document.querySelector(".scan-pane");
  const tocButton = document.getElementById("tocBtn");
  const tocClose = document.getElementById("tocClose");
  const tocBackdrop = document.getElementById("tocBackdrop");
  const darkButton = document.getElementById("darkBtn");
  if (!grid || !scanPane) return;

  const splitter = document.createElement("div");
  splitter.className = "pane-splitter";
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-label", "调整正文与扫描原图宽度");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.tabIndex = 0;
  grid.insertBefore(splitter, scanPane);

  const savedWidth = Number(localStorage.getItem("readerLeftPane"));
  if (savedWidth >= 25 && savedWidth <= 75) {
    grid.style.setProperty("--left-pane", `${savedWidth}%`);
  }

  const resizeTo = (clientX) => {
    const bounds = grid.getBoundingClientRect();
    const percent = Math.min(75, Math.max(25, ((clientX - bounds.left) / bounds.width) * 100));
    grid.style.setProperty("--left-pane", `${percent}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(percent)));
    return percent;
  };

  let dragging = false;
  let currentWidth = savedWidth || 54;

  splitter.addEventListener("pointerdown", (event) => {
    if (matchMedia("(max-width: 850px)").matches) return;
    dragging = true;
    splitter.classList.add("dragging");
    body.classList.add("resizing");
    splitter.setPointerCapture?.(event.pointerId);
    currentWidth = resizeTo(event.clientX);
    event.preventDefault();
  });

  splitter.addEventListener("pointermove", (event) => {
    if (dragging) currentWidth = resizeTo(event.clientX);
  });

  const stopResize = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    body.classList.remove("resizing");
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  };

  splitter.addEventListener("pointerup", stopResize);
  splitter.addEventListener("pointercancel", stopResize);
  splitter.addEventListener("dblclick", () => {
    currentWidth = 54;
    grid.style.setProperty("--left-pane", "54%");
    localStorage.removeItem("readerLeftPane");
  });

  splitter.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") currentWidth = 54;
    else currentWidth = Math.min(75, Math.max(25, currentWidth + (event.key === "ArrowRight" ? 2 : -2)));
    grid.style.setProperty("--left-pane", `${currentWidth}%`);
    localStorage.setItem("readerLeftPane", currentWidth.toFixed(2));
  });

  const setToc = (open) => {
    root.classList.toggle("toc-open", open);
    tocButton?.setAttribute("aria-expanded", String(open));
  };

  if (tocButton) {
    tocButton.onclick = () => setToc(!root.classList.contains("toc-open"));
  }
  if (tocClose) tocClose.onclick = () => setToc(false);
  if (tocBackdrop) tocBackdrop.onclick = () => setToc(false);

  const updateDarkLabel = () => {
    if (darkButton) darkButton.textContent = body.classList.contains("dark") ? "浅色" : "深色";
  };

  if (darkButton) {
    darkButton.onclick = () => {
      body.classList.toggle("dark");
      localStorage.setItem("readerDark", body.classList.contains("dark") ? "1" : "0");
      updateDarkLabel();
    };
  }
  updateDarkLabel();
})();
