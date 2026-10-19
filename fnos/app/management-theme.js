// Console styling aligned with the DSH design language (colors, nav pills,
// radii). Layout structure is unchanged; DSH token names are not used since
// this page renders outside the DSH document.
const css = `
:root{color-scheme:light dark;
--mg-bg:#ffffff;--mg-panel:#ffffff;--mg-soft:#f7f8fa;--mg-softer:#fbfcfd;
--mg-text:#0f1115;--mg-muted:#61666b;--mg-tertiary:#81858c;
--mg-border:rgba(15,17,21,.08);--mg-border-strong:rgba(15,17,21,.16);
--mg-accent:#4176e6;--mg-accent-soft:rgba(65,118,230,.1);
--mg-active:#f2f3f5;
--mg-radius-panel:20px;--mg-radius-item:10px;--mg-radius-input:10px;
--mg-shadow:0 1px 2px rgba(15,17,21,.04);
--mg-danger:#d92d20;
--mg-warn-bg:#fffaeb;--mg-warn-border:rgba(153,104,0,.25);--mg-warn-title:#7a4b01;
--mg-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
body{background:var(--mg-bg);color:var(--mg-text);font-family:var(--mg-font)}
.shell.settings-shell{max-width:1280px;margin:0 auto;padding:28px 32px 64px;min-width:0}
.settings-shell>header{margin:0 0 24px;padding:0;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.settings-shell h1{font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--mg-text)}
.settings-layout{display:grid;grid-template-columns:232px minmax(0,1fr);gap:36px;align-items:start;min-width:0}
.settings-sidebar{position:sticky;top:20px;min-width:0;background:transparent;border:0;border-radius:0;padding:0;box-shadow:none}
.settings-sidebar .primary{display:block;margin:0;padding:0;border:0;overflow:visible;background:none}
.settings-nav-group{margin:0 0 18px}
.settings-nav-group:last-child{margin-bottom:0}
.settings-nav-group h2{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--mg-tertiary);margin:0 12px 6px;text-transform:uppercase}
.settings-sidebar .primary a{display:flex;align-items:center;gap:12px;min-height:40px;padding:9px 12px;margin:2px 0;border:1px solid transparent;border-radius:var(--mg-radius-item);white-space:nowrap;color:var(--mg-muted);font-size:14px;line-height:1.4;font-weight:500;text-decoration:none;background:transparent;position:relative;transition:background .15s,color .15s}
.settings-sidebar .primary a:hover{background:var(--mg-soft);color:var(--mg-text)}
.settings-sidebar .primary a[aria-current="page"]{background:var(--mg-active);color:var(--mg-text);font-weight:600}
.settings-sidebar .primary a[aria-current="page"]::before{content:none}
.nav-icon{width:18px;height:18px;flex:0 0 18px;opacity:.9}
.nav-label{min-width:0}
.settings-content{min-width:0}.settings-content .group-description{margin:0 0 16px;color:var(--mg-muted)}
.settings-content .secondary{display:flex;gap:4px;flex-wrap:nowrap;min-width:0;background:none;border:0;padding:0;margin:0 0 18px;overflow-x:auto;scrollbar-width:none;overscroll-behavior-x:contain}
.settings-content .secondary::-webkit-scrollbar{display:none}
.settings-content .secondary a{flex:0 0 auto}
.settings-secondary-navigation{display:grid;grid-template-columns:28px minmax(0,1fr) 28px;align-items:center;gap:2px;margin:0 0 18px;min-width:0}
.settings-secondary-navigation .secondary{margin:0}
.settings-content .settings-nav-arrow{width:28px;min-height:38px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--mg-muted);font-size:22px;visibility:hidden;touch-action:manipulation}
.settings-nav-arrow[data-visible="true"]{visibility:visible}
.secondary[data-can-prev="true"]{mask-image:linear-gradient(to right,transparent,#000 16px);-webkit-mask-image:linear-gradient(to right,transparent,#000 16px)}
.secondary[data-can-next="true"]{mask-image:linear-gradient(to left,transparent,#000 16px);-webkit-mask-image:linear-gradient(to left,transparent,#000 16px)}
.secondary[data-can-prev="true"][data-can-next="true"]{mask-image:linear-gradient(to right,transparent,#000 16px,#000 calc(100% - 16px),transparent);-webkit-mask-image:linear-gradient(to right,transparent,#000 16px,#000 calc(100% - 16px),transparent)}
.settings-content .secondary a{flex:0 0 auto;min-width:0;white-space:nowrap;border:0;border-radius:999px;color:var(--mg-muted);padding:7px clamp(9px,2vw,14px);background:transparent;text-decoration:none;font-size:clamp(12.5px,2.2vw,13.5px);transition:background .15s,color .15s;touch-action:manipulation}
.settings-content .secondary a:hover{background:var(--mg-soft);color:var(--mg-text)}
.settings-content .secondary a[aria-current="page"]{border:0;background:var(--mg-active);color:var(--mg-text);font-weight:600}
.settings-content>.card{background:var(--mg-panel);border:1px solid var(--mg-border);box-shadow:var(--mg-shadow);border-radius:var(--mg-radius-panel);padding:26px;color:var(--mg-text);min-width:0}
.settings-content h2{margin-top:0;font-size:19px;font-weight:700;letter-spacing:-.01em}
.settings-content h3{color:var(--mg-text);font-weight:600}
.settings-content .hint,.settings-content small{color:var(--mg-muted)}
.settings-content a{color:var(--mg-accent)}
.settings-content a.primary-link{color:#fff;background:var(--mg-accent,#4176e6);font-weight:600;touch-action:manipulation}
.settings-content a.primary-link:hover{background:#3367d6}
.settings-content .summary{grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.settings-content .summary>div{border:1px solid var(--mg-border);background:var(--mg-softer);border-radius:var(--mg-radius-item);padding:16px;min-width:0}
.settings-content .summary span{color:var(--mg-muted)}.settings-content .summary strong{color:var(--mg-text);overflow-wrap:anywhere}
.settings-content .plugin-card,.settings-content .debug-info,.settings-content .patch-readonly,.settings-content .patch-editor{background:var(--mg-softer);color:var(--mg-text);border-color:var(--mg-border)}
.settings-content input,.settings-content textarea,.settings-content select{background:var(--mg-panel);color:var(--mg-text);border-color:var(--mg-border-strong);border-radius:var(--mg-radius-input)}
.settings-content button{font:inherit;font-weight:550;color:var(--mg-text);background:var(--mg-panel);border:1px solid var(--mg-border-strong);border-radius:var(--mg-radius-input);padding:8px 15px;cursor:pointer;transition:background .15s,border-color .15s;touch-action:manipulation}
.settings-content button:hover{background:var(--mg-soft)}
.settings-content button.tone-danger{color:var(--mg-danger);border-color:rgba(217,45,32,.4)}
.settings-content button.tone-danger:hover{background:rgba(217,45,32,.06)}
.settings-content table th,.settings-content table td{border-color:var(--mg-border);color:var(--mg-text)}
.settings-content table th{background:var(--mg-softer);color:var(--mg-muted);font-weight:600}
.settings-content .reliability-status{display:grid;gap:10px;margin:18px 0;padding:16px 18px;border:1px solid var(--mg-border);background:var(--mg-softer);border-radius:var(--mg-radius-item)}
.settings-content .reliability-status dl{display:grid;grid-template-columns:minmax(120px,.4fr) minmax(0,1fr);gap:9px;margin:0}
.settings-content .reliability-status dt{color:var(--mg-muted)}.settings-content .reliability-status dd{margin:0;overflow-wrap:anywhere}
.settings-content .card.remediation{background:var(--mg-warn-bg);border-color:var(--mg-warn-border)}
.settings-content .card.remediation h3{color:var(--mg-warn-title)}
.settings-content .notice,.settings-content .startup-diagnosis{background:var(--mg-softer);color:var(--mg-text);border-color:var(--mg-border)}
.settings-content .error{color:var(--mg-danger)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--mg-accent);outline-offset:2px}
@media(prefers-color-scheme:dark){:root{
--mg-bg:#151517;--mg-panel:#232324;--mg-soft:#2c2c2e;--mg-softer:#202021;
--mg-text:#f9fafb;--mg-muted:#cfd3d6;--mg-tertiary:#adb2b8;
--mg-border:rgba(255,255,255,.09);--mg-border-strong:rgba(255,255,255,.17);
--mg-accent:#5686fe;--mg-accent-soft:rgba(86,134,254,.16);
--mg-active:#353638;
--mg-shadow:none;
--mg-warn-bg:#2b2416;--mg-warn-border:rgba(255,205,90,.28);--mg-warn-title:#ffd79a
--mg-ok-bg:#12271b;--mg-ok-border:#1f5c3a;--mg-ok-text:#7fe0a8;
--mg-err-bg:#2e1a18;--mg-err-border:#7a3b34;--mg-err-text:#ffb4a6;
--mg-busy-bg:#2b2416;--mg-busy-border:#6c591e;--mg-busy-text:#ffd79a;
--mg-dialog-bg:#232324;--mg-dialog-border:rgba(255,255,255,.14);
--mg-guide-ok-bg:#12241c;--mg-guide-warn-bg:#262115;--mg-guide-danger-bg:#2b1a17;
--mg-restart-hover:#20304d;--mg-restart-border:#3d5f9e;
--mg-error-text:#ff8f7d}
.notice{background:var(--mg-ok-bg,#e6f5eb);border-color:var(--mg-ok-border,#b8ddc4);color:var(--mg-ok-text,#14522e)}
.notice-error{background:var(--mg-err-bg,#fff0ee);border-color:var(--mg-err-border,#edc0ba);color:var(--mg-err-text,#9b2424)}
.notice-busy{background:var(--mg-busy-bg,#fffaeb);border-color:var(--mg-busy-border,#fedf89);color:var(--mg-busy-text,#7a2e0e)}
.error{color:var(--mg-error-text,#a52222)}
.restart-dialog{background:var(--mg-dialog-bg,#fff);border-color:var(--mg-dialog-border,rgba(15,17,21,.1))}
button.restart-icon{background:var(--mg-panel);border-color:var(--mg-border-strong)}
button.restart-icon:hover,button.restart-icon:focus-visible{background:var(--mg-restart-hover,#e8f0ff);border-color:var(--mg-restart-border,#82a9ed)}
button.restart-option:hover,button.restart-option:focus-visible{background:var(--mg-soft)}
.guide .guide-row.tone-ok{background:var(--mg-guide-ok-bg,#f3faf5)}
.guide .guide-row.tone-warn{background:var(--mg-guide-warn-bg,#fdf9ef)}
.guide .guide-row.tone-danger{background:var(--mg-guide-danger-bg,#fdf4f2)}}
@media(max-width:700px){.shell.settings-shell{padding:16px 14px 44px}.settings-layout{grid-template-columns:minmax(0,1fr);gap:18px}.settings-sidebar{position:static}.settings-sidebar .primary{display:flex;flex-wrap:nowrap;gap:2px;width:100%;--primary-fit:1;scrollbar-width:none}.settings-sidebar .primary a{flex:1 0 auto;min-width:0;justify-content:center;white-space:nowrap;gap:calc(7px * var(--primary-fit));min-height:44px;padding:8px calc(8px * var(--primary-fit));margin:0;font-size:calc(14px * var(--primary-fit))}.settings-sidebar .primary .nav-icon{width:calc(18px * var(--primary-fit));height:calc(18px * var(--primary-fit));flex-basis:calc(18px * var(--primary-fit))}.settings-nav-group{margin:0}.settings-nav-group h2{display:none}.settings-content .secondary{flex-wrap:nowrap}.settings-content .secondary a{flex:0 0 auto;min-width:0}.settings-content>.card{padding:18px;border-radius:16px}.settings-content .summary{grid-template-columns:repeat(2,minmax(0,1fr))}.settings-shell>header{margin-bottom:14px}.settings-content .reliability-status dl{grid-template-columns:minmax(0,1fr)}.settings-content .reliability-status dd{margin-bottom:6px}}
@media(max-width:380px){.settings-content .summary{grid-template-columns:minmax(0,1fr)}}
`;

// Standalone initializer: serialized into the nonce-protected management page.
function installNavigation() {
  const primary = document.querySelector('.settings-sidebar .primary');
  const secondary = document.querySelector('.settings-content .secondary');
  if (!primary || !secondary) return () => {};
  const wrapper = document.createElement('div');
  wrapper.className = 'settings-secondary-navigation';
  secondary.before(wrapper);
  const arrow = (label, text) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'settings-nav-arrow';
    button.setAttribute('aria-label', label); button.textContent = text;
    return button;
  };
  const prev = arrow('向左滚动二级导航', '‹');
  const next = arrow('向右滚动二级导航', '›');
  wrapper.append(prev, secondary, next);
  let controller = null, observer = null, frame = 0;
  const update = () => {
    frame = 0;
    primary.style.removeProperty('--primary-fit');
    if (matchMedia('(max-width:700px)').matches) {
      const items = [...primary.children];
      const gaps = Math.max(0, items.length - 1) * 2;
      let scale = 1;
      for (let i = 0; i < 4; i++) {
        const used = items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0);
        const available = primary.clientWidth - gaps;
        if (used <= available + 0.25 || available <= 0) break;
        scale *= Math.max(0.1, (available - 1) / used);
        primary.style.setProperty('--primary-fit', String(scale));
      }
    }
    const max = Math.max(0, secondary.scrollWidth - secondary.clientWidth);
    const canPrev = max > 1 && secondary.scrollLeft > 1;
    const canNext = max > 1 && secondary.scrollLeft < max - 1;
    secondary.dataset.canPrev = String(canPrev);
    secondary.dataset.canNext = String(canNext);
    for (const [button, visible] of [[prev, canPrev], [next, canNext]]) {
      button.dataset.visible = String(visible); button.disabled = !visible;
      button.setAttribute('aria-hidden', String(!visible));
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const stop = () => {
    controller?.abort(); controller = null; observer?.disconnect(); observer = null;
    cancelAnimationFrame(frame); frame = 0;
  };
  const start = () => {
    if (controller) return;
    controller = new AbortController();
    const signal = controller.signal;
    secondary.addEventListener('scroll', schedule, { passive: true, signal });
    window.addEventListener('resize', schedule, { signal });
    const scroll = (direction) => secondary.scrollBy({ left: direction * secondary.clientWidth * 0.7,
      behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'instant' : 'smooth' });
    prev.addEventListener('click', () => scroll(-1), { signal });
    next.addEventListener('click', () => scroll(1), { signal });
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule); observer.observe(primary); observer.observe(secondary);
      for (const link of secondary.children) observer.observe(link);
    }
    document.fonts?.ready.then(() => { if (!signal.aborted) schedule(); });
    schedule();
  };
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', start);
  start();
  return () => {
    stop(); window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', start);
    wrapper.replaceWith(secondary); primary.style.removeProperty('--primary-fit');
    delete secondary.dataset.canPrev; delete secondary.dataset.canNext;
  };
}
module.exports={css,installNavigation};
