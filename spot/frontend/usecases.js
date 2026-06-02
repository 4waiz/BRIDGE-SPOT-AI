/*
 * BRIDGE SPOT — Industry 5.0 use-case launcher cards + demo detail modal.
 *
 * DEMO ONLY: this renders the five Industry 5.0 use-case cards from
 * usecases.data.js and opens a client-side detail modal. There are no backend
 * calls — every action is mocked. Existing launcher entries (Autonomous
 * Inspection, Smart Assistant, Guided Tour, Spot Admin link) are untouched.
 *
 * FUTURE REAL API INTEGRATION: see handleMockAction() near the bottom — each
 * action id is where a real Spot SDK / BRIDGE backend call should be wired.
 */
(function initUseCases() {
  const data = window.BRIDGE_SPOT_DEMO;
  if (!data) {
    console.warn("[bridge-spot] use-case demo data not found");
    return;
  }
  const { USE_CASES, ADMIN_INFO } = data;

  const grid = document.getElementById("usecase-grid");
  const modal = document.getElementById("usecase-modal");
  if (!grid || !modal) {
    return;
  }

  const modalBody = modal.querySelector("[data-role='modal-body']");
  const modalClose = modal.querySelector("[data-role='modal-close']");
  let lastFocused = null;

  // ---- Inline SVG icon set (crisp + consistent; no emoji font dependency) --
  // Stroke uses currentColor so icons pick up the orange accent via CSS.
  const ICONS = {
    inspection:
      '<path d="M3 5h7l2 2h9v12H3z"/><circle cx="12" cy="13" r="3.2"/><path d="M12 11v4M10 13h4"/>',
    maintenance:
      '<path d="M4 19V5"/><path d="M4 17l5-5 4 3 7-8"/><path d="M16 7h4v4"/>',
    safety:
      '<path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="M12 8v4M12 15.5v.5"/>',
    readiness:
      '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"/>',
    digitaltwin:
      '<path d="M9 4 3 6v12l6 2 6-2 6 2V8l-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
    admin:
      '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.4 2H9.6l-.3 2.4a7.6 7.6 0 0 0-2.6 1.5l-2-.8L2.9 8.2 4.6 9.5a7.6 7.6 0 0 0 0 3L2.9 13.8l1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.3 2.4h4.8l.3-2.4a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1z"/>',
  };

  function iconSvg(key, extraClass) {
    const cls = "uc-icon" + (extraClass ? " " + extraClass : "");
    const inner = ICONS[key] || ICONS.admin;
    return (
      '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      inner +
      "</svg>"
    );
  }

  // ---- Small DOM helpers (no framework) --------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function list(items) {
    const ul = el("ul", "uc-list");
    items.forEach((item) => ul.appendChild(el("li", null, item)));
    return ul;
  }

  // ---- Launcher cards ---------------------------------------------------
  function buildCard(uc) {
    const card = el("button", "usecase-card");
    card.type = "button";
    card.setAttribute("data-id", uc.id);
    card.setAttribute("aria-haspopup", "dialog");

    const top = el("div", "usecase-card__top");
    const iconWrap = el("span", "usecase-card__icon");
    iconWrap.innerHTML = iconSvg(uc.icon);
    top.appendChild(iconWrap);
    top.appendChild(el("span", "usecase-badge", "Demo"));
    card.appendChild(top);

    card.appendChild(el("h3", "usecase-card__title", uc.title));
    card.appendChild(el("p", "usecase-card__desc", uc.tagline));

    const cta = el("span", "usecase-card__cta", "Open demo");
    cta.setAttribute("aria-hidden", "true");
    card.appendChild(cta);

    card.addEventListener("click", () => openModal(uc));
    return card;
  }

  USE_CASES.forEach((uc) => grid.appendChild(buildCard(uc)));

  // ---- Detail modal content --------------------------------------------
  function statusGrid(statusItems) {
    const wrap = el("div", "uc-status-grid");
    statusItems.forEach((s) => {
      const cardEl = el("div", `uc-status-card tone-${s.tone || "info"}`);
      cardEl.appendChild(el("span", "uc-status-card__label", s.label));
      cardEl.appendChild(el("span", "uc-status-card__value", s.value));
      wrap.appendChild(cardEl);
    });
    return wrap;
  }

  function section(title, node) {
    const sec = el("section", "uc-section");
    sec.appendChild(el("h4", "uc-section__title", title));
    sec.appendChild(node);
    return sec;
  }

  function actionBar(actions, context) {
    const bar = el("div", "uc-actions");
    actions.forEach((action) => {
      let btn;
      if (action.external && context.externalUrl) {
        // Spot Admin keeps a real link to the existing admin console.
        btn = el("a", "uc-action-btn");
        btn.href = context.externalUrl;
        btn.target = "_blank";
        btn.rel = "noopener";
        btn.textContent = action.label;
      } else {
        btn = el("button", "uc-action-btn");
        btn.type = "button";
        btn.textContent = action.label;
        btn.addEventListener("click", () =>
          handleMockAction(action, context, btn)
        );
      }
      if (action.primary) btn.classList.add("is-primary");
      bar.appendChild(btn);
    });
    return bar;
  }

  function buildUseCaseBody(uc) {
    const frag = document.createDocumentFragment();

    const header = el("div", "uc-modal__header");
    const iconWrap = el("span", "uc-modal__icon");
    iconWrap.innerHTML = iconSvg(uc.icon);
    header.appendChild(iconWrap);
    const titles = el("div", "uc-modal__titles");
    const titleRow = el("div", "uc-modal__title-row");
    titleRow.appendChild(el("h2", "uc-modal__title", uc.title));
    titleRow.appendChild(el("span", "usecase-badge usecase-badge--lg", "Demo Mode"));
    titles.appendChild(titleRow);
    titles.appendChild(el("p", "uc-modal__tagline", uc.tagline));
    header.appendChild(titles);
    frag.appendChild(header);

    frag.appendChild(section("Overview", el("p", "uc-text", uc.overview)));

    // Live status / data cards (mocked).
    frag.appendChild(section("Live status (demo data)", statusGrid(uc.mockStatus)));

    // Optional natural-language prompt sample (Digital Twin use case).
    if (uc.samplePrompt) {
      const promptBox = el("div", "uc-prompt");
      promptBox.appendChild(el("span", "uc-prompt__label", "Example instruction"));
      promptBox.appendChild(el("p", "uc-prompt__text", `“${uc.samplePrompt}”`));
      frag.appendChild(section("Natural-language mission", promptBox));
    }

    // Two-column: What Spot does / What the app does.
    const cols = el("div", "uc-cols");
    cols.appendChild(section("What Spot does", list(uc.spotDoes)));
    cols.appendChild(section("What the external app does", list(uc.appDoes)));
    frag.appendChild(cols);

    frag.appendChild(section("Key benefits", list(uc.benefits)));

    frag.appendChild(actionBar(uc.actions, uc));

    // Inline log surface where mock actions report what they "did".
    const log = el("div", "uc-log");
    log.setAttribute("data-role", "uc-log");
    log.setAttribute("aria-live", "polite");
    log.hidden = true;
    frag.appendChild(log);

    return frag;
  }

  function buildAdminBody(admin) {
    const frag = document.createDocumentFragment();

    const header = el("div", "uc-modal__header");
    const iconWrap = el("span", "uc-modal__icon");
    iconWrap.innerHTML = iconSvg(admin.icon);
    header.appendChild(iconWrap);
    const titles = el("div", "uc-modal__titles");
    const titleRow = el("div", "uc-modal__title-row");
    titleRow.appendChild(el("h2", "uc-modal__title", admin.title));
    titleRow.appendChild(el("span", "usecase-badge usecase-badge--lg", "Demo Mode"));
    titles.appendChild(titleRow);
    titles.appendChild(el("p", "uc-modal__tagline", admin.tagline));
    header.appendChild(titles);
    frag.appendChild(header);

    frag.appendChild(section("System status (demo)", statusGrid(admin.status)));
    frag.appendChild(actionBar(admin.actions, admin));

    const log = el("div", "uc-log");
    log.setAttribute("data-role", "uc-log");
    log.setAttribute("aria-live", "polite");
    log.hidden = true;
    frag.appendChild(log);

    return frag;
  }

  // ---- Open / close -----------------------------------------------------
  function openModal(context) {
    lastFocused = document.activeElement;
    modalBody.innerHTML = "";
    const isAdmin = context.id === ADMIN_INFO.id;
    modalBody.appendChild(isAdmin ? buildAdminBody(context) : buildUseCaseBody(context));

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    // Move focus into the dialog for accessibility.
    (modalClose || modal).focus();
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    modalBody.innerHTML = "";
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  // "Back to Home" + the × button both close the modal.
  if (modalClose) modalClose.addEventListener("click", closeModal);
  modal.querySelectorAll("[data-role='modal-dismiss']").forEach((btn) =>
    btn.addEventListener("click", closeModal)
  );
  // Click on the dim backdrop closes.
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) {
      closeModal();
    }
  });

  // Wire the existing "Spot Admin" launcher entry to the demo modal while
  // keeping the original external link intact (Ctrl/Cmd/middle-click still
  // opens the real console; a plain click opens the demo preview).
  const adminLink = document.querySelector("[data-role='spot-admin']");
  if (adminLink) {
    adminLink.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.button === 1) {
        return; // let the browser open the real admin console
      }
      event.preventDefault();
      openModal(ADMIN_INFO);
    });
  }

  // Optional deep link: index.html#demo=<id> opens that demo directly.
  // Handy for presenting a single use case straight from a bookmark/link.
  function openFromHash() {
    const match = /(?:^|#|&)demo=([\w-]+)/.exec(window.location.hash);
    if (!match) return;
    const id = match[1];
    const target =
      id === ADMIN_INFO.id ? ADMIN_INFO : USE_CASES.find((u) => u.id === id);
    if (target) openModal(target);
  }
  openFromHash();
  window.addEventListener("hashchange", openFromHash);

  // ---- Mock action handling --------------------------------------------
  function logLine(btn, message) {
    const modalRoot = btn.closest("[data-role='modal-body']") || modalBody;
    const log = modalRoot.querySelector("[data-role='uc-log']");
    if (!log) return;
    log.hidden = false;
    const line = el("div", "uc-log__line");
    line.appendChild(el("span", "uc-log__dot", ""));
    line.appendChild(el("span", null, message));
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /*
   * handleMockAction — DEMO stub for every action button.
   *
   * FUTURE REAL API INTEGRATION:
   *   switch (action.id) {
   *     case "start-patrol":   return spotApi.startMission(context.id, ...);
   *     case "generate-report":return reportApi.generate(context.id, ...);
   *     case "run-asset-scan": return spotApi.runAssetScan(...);
   *     case "test-connection":return spotApi.ping();
   *     ...
   *   }
   * For now we just give the manager visible, believable feedback.
   */
  function handleMockAction(action, context, btn) {
    const label = action.label;
    btn.classList.add("is-busy");
    btn.disabled = true;
    logLine(btn, `▶ ${label} — running (demo)…`);

    // Simulated async work so the demo feels live. No real call is made.
    window.setTimeout(() => {
      btn.classList.remove("is-busy");
      btn.disabled = false;
      logLine(btn, `✓ ${label} — completed (mock data, no robot connected).`);
    }, 900);
  }
})();
