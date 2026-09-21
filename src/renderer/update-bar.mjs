// Extracted from app.js verbatim, as part of splitting that file into
// smaller feature modules. Two related, self-contained UI slots that share
// one DOM node (els.updateRoot): the update card, and the one-time star ask
// that only shows when no update is occupying the slot.
//
// A card in the corner, never a modal. Someone mid-sentence with an agent does
// not want the app in front of them, and an update is the least urgent thing
// KingAgent has to say — so it waits, and "Not now" means not this version, ever.
export function createUpdateBar({ api, els, q, esc, state, onStarClick }) {
  const SKIPPED_UPDATE = 'kingagent-skipped-update';

  // What the bar is currently saying. `offered` is what update-check found, and
  // survives every repaint — the failure state needs its url to fall back to a
  // browser, and the progress events do not carry one.
  let offered = null;
  // The Smart Update Center's analysis of `offered` — { metadata, analysis,
  // importance, currentVersion } from update:getReleaseInfo, or null before it
  // has arrived (a plain, unlabeled card is still a complete, honest card; the
  // details toggle just has nothing to show yet). Whether the "details" flap
  // under the card is open is separate from whether the data exists, so
  // opening it before the analysis lands does not have to be re-triggered.
  let releaseInfo = null;
  let updateDetailsOpen = false;

  async function refreshReleaseInfo() {
    if (!offered || !api.updater || !api.updater.getReleaseInfo) return;
    try { releaseInfo = await api.updater.getReleaseInfo(); } catch (_) { releaseInfo = null; }
    if (offered) paintUpdate(lastUpdateState, lastUpdateEvent);
  }

  function offerUpdate(info, initial) {
    if (!info || !info.version || !els.updateRoot) return;
    // Dismissing is per version, and it sticks. Re-asking every six hours for
    // something already refused is how an update prompt becomes wallpaper —
    // unless main is the one asking again, on purpose, through a reminder it
    // scheduled itself (see the onReminder wiring above, which clears this
    // mark first: a scheduled "ask me later" is not the same refusal as "not
    // now" was, and must not stay silenced by it).
    if (localStorage.getItem(SKIPPED_UPDATE) === info.version) return;
    offered = info;
    updateDetailsOpen = false;
    // A window opened while a download was already running joins it in progress
    // rather than offering to start a second one.
    //
    // `staged` is the case that used to be lost entirely: a download finished in
    // some earlier run and was never installed, and nothing in the app knew it
    // was there — so the bar offered to fetch 166 MB that was already on disk,
    // and quitting did nothing, forever. A file waiting is a ready update.
    // `state` is always set, so staged has to be asked about on its own — as a
    // fallback for the idle case, never as an override of a live download.
    let at = (initial && initial.state) || 'idle';
    if (at === 'idle' && initial && initial.staged) at = 'ready';
    if (initial && initial.releaseInfo) releaseInfo = initial.releaseInfo;
    paintUpdate(at === 'downloading' ? 'downloading' : at === 'ready' ? 'ready' : 'idle', {});
    refreshReleaseInfo();
  }

  // Why update / highlights / stats / importance — the same explanation the
  // spec's dialog mockup wants, folded into the corner card's own voice rather
  // than a second visual system. Every string here came out of releaseInfo,
  // which came out of the release itself (see update-analyzer.js) — nothing is
  // written fresh here.
  function updateDetailsHtml() {
    if (!releaseInfo || !releaseInfo.analysis) return '';
    const a = releaseInfo.analysis;
    const importance = releaseInfo.importance || 'NORMAL';
    const stats = a.stats || { features: 0, bugFixes: 0, securityFixes: 0 };
    return `<div class="un-details">
    ${a.summary ? `<p class="un-why">${esc(a.summary)}</p>` : ''}
    ${a.highlights && a.highlights.length ? `<ul class="un-highlights">${a.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    <div class="un-stats">
      <span>Features <b>${stats.features}</b></span>
      <span>Bug fixes <b>${stats.bugFixes}</b></span>
      <span>Security fixes <b>${stats.securityFixes}</b></span>
      <span class="un-importance un-importance--${importance.toLowerCase()}">${importance}</span>
    </div>
  </div>`;
  }
  function detailsToggleHtml() {
    if (!releaseInfo || !releaseInfo.analysis) return '';
    return `<span class="un-sep">·</span><button class="un-act un-quiet" id="uc-details">${updateDetailsOpen ? 'hide details' : 'why update?'}</button>`;
  }

  // One function, five states now, because they are the same card saying
  // different things — and because a repaint from an event that arrives after
  // the user dismissed the bar must not bring it back. `offered` being null
  // means the bar is closed, and every state respects that.
  let lastUpdateState = 'idle';
  let lastUpdateEvent = {};
  function paintUpdate(state, ev) {
    lastUpdateState = state; lastUpdateEvent = ev || {};
    if (!offered || !els.updateRoot) return;
    const version = esc((ev && ev.version) || offered.version);
    const close = () => { els.updateRoot.innerHTML = ''; offered = null; releaseInfo = null; };
    // Section 9: a critical release keeps the same one-line voice as every
    // other update, but the accent turns from amber to the same red the rest
    // of the app already uses for something that needs attention now.
    const critical = releaseInfo && releaseInfo.importance === 'CRITICAL';
    const criticalCls = critical ? ' update-note--critical' : '';
    const criticalLine = critical ? '<div class="un-critical">Critical update — contains important security or stability fixes.</div>' : '';

    if (state === 'downloading') {
      const pct = Math.max(0, Math.min(100, Number((ev && ev.percent) || 0)));
      els.updateRoot.innerHTML = `<div class="update-note${criticalCls}">
      <span class="un-dot"></span>
      <span class="un-msg">getting KingAgent ${version}…</span>
      <span class="un-bar"><span class="un-fill" style="width:${pct}%"></span></span>
      <span class="un-pct">${pct}%</span>
    </div>`;
      return;
    }

    if (state === 'ready') {
      // There is a button now, and there did not used to be. Waiting for a quit
      // was the whole design — an update should never end a session somebody is
      // in the middle of — but on a real machine it lost every time: the app
      // takes its time closing, Squirrel waits for it, and reopening KingAgent inside
      // that window cancels the install with nothing said. So the wait stays as
      // the quiet default and this is the way to make it happen on purpose.
      els.updateRoot.innerHTML = `<div class="update-note${criticalCls}">${criticalLine}
      <span class="un-dot un-done"></span>
      <span class="un-msg">KingAgent ${version} is ready</span>
      <button class="un-act" id="uc-now">install now</button>
      <span class="un-sep">·</span>
      <button class="un-act un-quiet" id="uc-ok">on quit</button>
      ${detailsToggleHtml()}
      ${updateDetailsOpen ? updateDetailsHtml() : ''}
    </div>`;
      q('#uc-ok', els.updateRoot).onclick = close;
      // The active-task check now lives in main (update-manager.js's install()),
      // which knows about every window's sessions, not just this one — the
      // confirm step only shows up when it actually says no.
      q('#uc-now', els.updateRoot).onclick = async () => {
        const res = await api.installUpdate();
        if (res && res.blocked) return paintUpdate('confirm', { version: (ev && ev.version) || offered.version, live: res.activeWork });
      };
      wireDetailsToggle();
      return;
    }

    // The one warning this feature owes anybody. Installing restarts KingAgent, and
    // restarting ends every session — so when there is work in flight, say what
    // will be lost and make them say yes to it.
    if (state === 'confirm') {
      const live = Number((ev && ev.live) || 0);
      els.updateRoot.innerHTML = `<div class="update-note">
      <span class="un-dot"></span>
      <span class="un-msg">${live} session${live === 1 ? '' : 's'} running — installing stops ${live === 1 ? 'it' : 'them'}</span>
      <button class="un-act" id="uc-yes">install anyway</button>
      <span class="un-sep">·</span>
      <button class="un-act un-quiet" id="uc-no">not now</button>
    </div>`;
      q('#uc-yes', els.updateRoot).onclick = async () => { await api.installUpdate({ force: true }); };
      q('#uc-no', els.updateRoot).onclick = () => paintUpdate('ready', ev);
      return;
    }

    // idle, and failed. They differ only in what the button does: before anything
    // has gone wrong it downloads in place, and afterwards it hands the dmg to a
    // browser, which is exactly what 0.1.3 did.
    const broke = state === 'failed';
    els.updateRoot.innerHTML = `<div class="update-note${criticalCls}">${criticalLine}
    <span class="un-dot"></span>
    <span class="un-msg">${broke ? `KingAgent ${version} has to be installed by hand` : `KingAgent ${version} is out`}</span>
    <button class="un-act" id="uc-get">download</button>
    <span class="un-sep">·</span>
    <button class="un-act un-quiet" id="uc-later">not now</button>
    ${detailsToggleHtml()}
    ${updateDetailsOpen ? updateDetailsHtml() : ''}
  </div>`;

    q('#uc-get', els.updateRoot).onclick = async () => {
      if (broke) { await api.openUpdate(offered.url); close(); return; }
      // Everything after this arrives as an event: progress, then ready, or
      // failed — at which point this same bar comes back offering the browser.
      await api.downloadUpdate();
    };
    q('#uc-later', els.updateRoot).onclick = () => {
      localStorage.setItem(SKIPPED_UPDATE, offered.version);
      // Section 7: preserve the downloaded bytes, persist the postponed state,
      // and remind in 24h by default (Settings → Updates can change the
      // interval). A failure here is silent, same as every other update
      // network call — the local skip above still closes the bar either way.
      if (api.updater && api.updater.postpone) api.updater.postpone().catch(() => {});
      close();
    };
    wireDetailsToggle();
  }

  function wireDetailsToggle() {
    const btn = q('#uc-details', els.updateRoot);
    if (!btn) return;
    btn.onclick = () => { updateDetailsOpen = !updateDetailsOpen; paintUpdate(lastUpdateState, lastUpdateEvent); };
  }

  // ---------------------------------------------------------------------------
  //  The one time KingAgent asks for anything
  // ---------------------------------------------------------------------------
  // KingAgent is free, and the only thing that helps anyone find it is a star. But the
  // app has no account, no telemetry and no way to reach the person using it —
  // which is the point — so the ask has to happen here, and it gets exactly one
  // chance. Once. Dismissed is forever, same as a skipped update.
  //
  // Counted in launches rather than sessions on purpose. Five sessions can all
  // happen in one sitting on the first afternoon, when nobody owes you anything
  // yet; five separate launches means somebody came back, which is the only
  // evidence available that KingAgent earned its place. Nothing is sent anywhere to
  // learn this — it is a number in localStorage on one machine.

  const STAR_ASKED = 'kingagent-star-asked';
  const LAUNCH_TALLY = 'kingagent-launches';
  const ASK_AFTER_LAUNCHES = 5;
  // Long enough that the bar is never part of the app opening. Someone who just
  // launched KingAgent is going somewhere; this waits until they have arrived.
  const ASK_AFTER_MS = 90_000;

  function tallyLaunch() {
    const n = Number(localStorage.getItem(LAUNCH_TALLY) || 0) + 1;
    // Stop counting once it is moot, so the number cannot grow without bound.
    if (n <= ASK_AFTER_LAUNCHES) localStorage.setItem(LAUNCH_TALLY, String(n));
    return n;
  }

  // Pure, so the rules are testable without a DOM: asked already, or not enough
  // launches, means never.
  function starAskDue({ asked, launches }) {
    if (asked) return false;
    return Number(launches) >= ASK_AFTER_LAUNCHES;
  }

  function closeStarAsk() {
    // Clicked or waved away, it makes no difference: both are an answer, and
    // asking a second time is how a request becomes a nag.
    localStorage.setItem(STAR_ASKED, '1');
    if (els.updateRoot) els.updateRoot.innerHTML = '';
  }

  function paintStarAsk() {
    // An update is always the more important thing in this slot, and it must
    // never be displaced by a favour. If one is showing, the moment has passed.
    if (!els.updateRoot || offered || localStorage.getItem(STAR_ASKED)) return;
    // Green, not amber: amber in KingAgent means *needs you*, and this does not.
    els.updateRoot.innerHTML = `<div class="update-note">
    <span class="un-dot un-done"></span>
    <span class="un-msg un-ask">Enjoying KingAgent? A star helps other people find it.</span>
    <button class="un-act" id="star-go">★ Star it</button>
    <span class="un-sep">·</span>
    <button class="un-act un-quiet" id="star-no">no thanks</button>
  </div>`;
    q('#star-go', els.updateRoot).onclick = () => { onStarClick(); closeStarAsk(); };
    q('#star-no', els.updateRoot).onclick = closeStarAsk;
  }

  // Called once at boot. A demo or screenshot run counts nothing — those launches
  // are not a person coming back to the app.
  function armStarAsk() {
    if (state.demo) return;
    const launches = tallyLaunch();
    if (!starAskDue({ asked: localStorage.getItem(STAR_ASKED), launches })) return;
    setTimeout(paintStarAsk, ASK_AFTER_MS);
  }

  return {
    SKIPPED_UPDATE, STAR_ASKED,
    offerUpdate, paintUpdate, refreshReleaseInfo,
    armStarAsk, paintStarAsk,
    setReleaseInfo: (v) => { releaseInfo = v; },
    setOffered: (v) => { offered = v; },
  };
}
