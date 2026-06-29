(() => {
  const root = document.documentElement;
  const openToc = document.querySelector("[data-open-toc]");
  const closeToc = document.querySelector("[data-close-toc]");
  const backdrop = document.querySelector(".toc-backdrop");
  const volumeSelect = document.querySelector("[data-volume-select]");
  const dialog = document.querySelector("#scan-dialog");
  const dialogImage = dialog?.querySelector("img");
  const footnotePopover = document.querySelector("#footnote-popover");
  const footnoteBody = footnotePopover?.querySelector("[data-footnote-body]");
  const footnoteJump = footnotePopover?.querySelector("[data-footnote-jump]");
  const textPane = document.querySelector(".text-pane");
  const mobileDetails = document.querySelector(".mobile-scan details");
  const mobileImage = document.querySelector(".mobile-scan img[data-src]");
  let zoom = 1;
  let activeFootnoteLink = null;
  let activeFootnoteTarget = null;

  const setToc = (open) => {
    root.classList.toggle("toc-open", open);
    openToc?.setAttribute("aria-expanded", String(open));
  };

  openToc?.addEventListener("click", () => setToc(true));
  closeToc?.addEventListener("click", () => setToc(false));
  backdrop?.addEventListener("click", () => setToc(false));

  volumeSelect?.addEventListener("change", () => {
    location.href = `/books/${volumeSelect.value}/`;
  });

  mobileDetails?.addEventListener("toggle", () => {
    if (mobileDetails.open && mobileImage && !mobileImage.getAttribute("src")) {
      mobileImage.src = mobileImage.dataset.src;
    }
  });

  const openDialog = () => {
    if (!dialog || !dialogImage) return;
    if (!dialogImage.getAttribute("src")) dialogImage.src = dialogImage.dataset.src;
    zoom = 1;
    dialogImage.style.setProperty("--zoom", zoom);
    dialog.showModal();
  };

  document.querySelectorAll("[data-open-scan]").forEach((button) => {
    button.addEventListener("click", openDialog);
  });

  dialog?.querySelector("[data-close-scan]")?.addEventListener("click", () => dialog.close());
  dialog?.querySelector("[data-zoom-in]")?.addEventListener("click", () => {
    zoom = Math.min(3, zoom + .25);
    dialogImage.style.setProperty("--zoom", zoom);
  });
  dialog?.querySelector("[data-zoom-out]")?.addEventListener("click", () => {
    zoom = Math.max(.5, zoom - .25);
    dialogImage.style.setProperty("--zoom", zoom);
  });
  dialog?.querySelector("[data-zoom-fit]")?.addEventListener("click", () => {
    zoom = 1;
    dialogImage.style.setProperty("--zoom", zoom);
  });

  const blockSelector = "p, li, blockquote, pre, figure, figcaption, table, thead, tbody, tfoot, tr, td, th, section, article, aside, div, h1, h2, h3, h4, h5, h6";
  const isFootnoteLink = (link) =>
    link?.matches?.('.prose a[href^="#"]') &&
    (link.parentElement?.tagName === "SUP" || [...link.children].some((child) => child.tagName === "SUP"));

  const closeFootnote = () => {
    if (!footnotePopover) return;
    footnotePopover.classList.remove("footnote-popover--visible");
    footnotePopover.setAttribute("aria-hidden", "true");
    footnoteBody?.replaceChildren();
    activeFootnoteLink = null;
    activeFootnoteTarget = null;
  };

  const positionFootnote = () => {
    if (!activeFootnoteLink || !footnotePopover) return;
    if (matchMedia("(max-width: 900px)").matches) {
      footnotePopover.style.removeProperty("left");
      footnotePopover.style.removeProperty("top");
      footnotePopover.style.removeProperty("max-height");
      return;
    }

    const rect = activeFootnoteLink.getBoundingClientRect();
    const tipWidth = 340;
    const maxHeight = Math.min(320, innerHeight * .45);
    let left = rect.right + 8;
    if (left + tipWidth > innerWidth - 12) left = Math.max(12, rect.left - tipWidth - 8);
    const top = Math.min(
      Math.max(rect.top - 10, 12),
      Math.max(12, innerHeight - maxHeight - 12)
    );
    footnotePopover.style.left = `${left}px`;
    footnotePopover.style.top = `${top}px`;
    footnotePopover.style.maxHeight = `${maxHeight}px`;
  };

  const showFootnote = (link) => {
    const href = link.getAttribute("href");
    const target = href?.startsWith("#") ? document.getElementById(decodeURIComponent(href.slice(1))) : null;
    const block = target?.closest(blockSelector);
    if (!block || !footnotePopover || !footnoteBody || !footnoteJump) return false;

    const clone = block.cloneNode(true);
    clone.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    clone.querySelectorAll('a[href^="#"]').forEach((anchor) => anchor.removeAttribute("href"));
    footnoteBody.replaceChildren(clone);
    footnoteJump.href = href;
    activeFootnoteLink = link;
    activeFootnoteTarget = target;
    positionFootnote();
    footnotePopover.classList.add("footnote-popover--visible");
    footnotePopover.setAttribute("aria-hidden", "false");
    return true;
  };

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a");
    if (isFootnoteLink(link)) {
      event.preventDefault();
      event.stopPropagation();
      showFootnote(link);
      return;
    }
    if (footnotePopover?.classList.contains("footnote-popover--visible") && !footnotePopover.contains(event.target)) {
      closeFootnote();
    }
  });

  footnoteJump?.addEventListener("click", (event) => {
    if (!activeFootnoteTarget) return;
    event.preventDefault();
    const target = activeFootnoteTarget;
    const hash = footnoteJump.getAttribute("href");
    closeFootnote();
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (hash) history.replaceState(null, "", hash);
  });

  textPane?.addEventListener("scroll", positionFootnote, { passive: true });
  window.addEventListener("scroll", positionFootnote, { passive: true });
  window.addEventListener("resize", positionFootnote, { passive: true });

  document.querySelector("[data-copy-page-citation]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const citation = button.dataset.citation;
    const originalLabel = button.textContent;
    try {
      await navigator.clipboard.writeText(citation);
      button.textContent = "已复制";
    } catch {
      window.prompt("复制本页引用", citation);
    }
    window.setTimeout(() => { button.textContent = originalLabel; }, 1400);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setToc(false);
      closeFootnote();
    }
    if (event.key === "ArrowLeft") {
      const previous = document.querySelector('a[rel="prev"]:not([aria-disabled="true"])');
      if (previous && !dialog?.open && !footnotePopover?.classList.contains("footnote-popover--visible")) location.href = previous.href;
    }
    if (event.key === "ArrowRight") {
      const next = document.querySelector('a[rel="next"]:not([aria-disabled="true"])');
      if (next && !dialog?.open && !footnotePopover?.classList.contains("footnote-popover--visible")) location.href = next.href;
    }
  });
})();