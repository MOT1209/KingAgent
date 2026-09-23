import { mountAgentPlatform } from './agent-platform.mjs';
import { mountConversationView } from './conversation-view.mjs';

// `mountAgentPlatform()` returning null is the normal, silent case — the
// agent platform simply isn't installed in this build (see its own header
// comment). Only a *thrown* error here means something actually broke while
// mounting a platform that IS installed, and that case was going to
// console.error alone: invisible to anyone not watching devtools. This is a
// small, self-contained banner rather than app.js's toast() because this
// module boots independently of app.js's own init order — no guarantee
// toast()'s DOM root exists yet, and no reason to couple the two.
export function bannerHtml(err) {
  const message = (err && err.message) || String(err);
  return `<span class="dot"></span><span class="msg">Agent platform failed to load: ${escapeHtml(message)}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showBootError(err) {
  const el = document.createElement('div');
  el.className = 'agent-platform-boot-error';
  el.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:9999;max-width:360px;'
    + 'padding:10px 14px;border-radius:8px;background:rgba(120,20,20,.95);color:#fdeaea;'
    + 'font:12px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4);';
  el.innerHTML = bannerHtml(err);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

try {
  mountAgentPlatform();
} catch (err) {
  console.error('[agent-platform] ui unavailable:', err);
  try { showBootError(err); } catch (_) { /* document not ready — console line above still stands */ }
}

// The shared conversation (§13): one transcript for the whole organization,
// beside the tiles rather than instead of them. It returns null when the
// platform is not installed, which is the normal case for that build and not an
// error worth a banner.
try {
  mountConversationView({ api: window.kingagent && window.kingagent.agentPlatform });
} catch (err) {
  console.error('[conversation] ui unavailable:', err);
}
