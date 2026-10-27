// Settings content only: the app owns its modal, navigation and profile flows.
import { t } from './i18n.mjs';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function browserSettingsHtml() {
  return `<div id="browser-settings-body" class="browser-settings"><p class="bs-note" role="status">${esc(t('bset.loading'))}</p></div>`;
}

function permissionRows(profiles) {
  const rows = [];
  for (const profile of profiles || []) {
    for (const [origin, perms] of Object.entries(profile.permissions || {})) {
      for (const [permission, value] of Object.entries(perms || {})) {
        rows.push({ profileId: profile.id, origin, permission, value });
      }
    }
  }
  return rows;
}

export function browserSettingsContent(status, actions = {}) {
  const profiles = status.profiles || [];
  const profile = profiles[0] || {};
  const download = profile.downloadMode === 'auto' ? 'auto' : 'ask';
  const popup = profile.popupMode === 'oauth' ? 'oauth' : 'block';
  const sites = permissionRows(profiles);
  const blank = status.newTab === 'dark' || status.newTab === 'light' ? status.newTab : 'system';
  return `<section class="bs-section" aria-labelledby="browser-blank-heading">
    <h3 class="field-label" id="browser-blank-heading">${esc(t('bset.newTab'))}</h3>
    <label class="bs-toggle"><input type="radio" name="browser-blank" id="browser-blank-light" value="light"${blank === 'light' ? ' checked' : ''}><span>${esc(t('bset.light'))}</span></label>
    <label class="bs-toggle"><input type="radio" name="browser-blank" id="browser-blank-dark" value="dark"${blank === 'dark' ? ' checked' : ''}><span>${esc(t('bset.dark'))}</span></label>
    <label class="bs-toggle"><input type="radio" name="browser-blank" id="browser-blank-system" value="system"${blank === 'system' ? ' checked' : ''}><span>${esc(t('bset.system'))}</span></label>
    <p class="bs-note">${esc(t('bset.systemNote'))}</p>
  </section>
  <section class="bs-section" aria-labelledby="browser-download-heading">
    <h3 class="field-label" id="browser-download-heading">${esc(t('bset.downloads'))}</h3>
    <label class="bs-toggle"><input type="radio" name="browser-download" id="browser-download-ask" value="ask"${download === 'ask' ? ' checked' : ''}><span>${esc(t('bset.askSave'))}</span></label>
    <label class="bs-toggle"><input type="radio" name="browser-download" id="browser-download-auto" value="auto"${download === 'auto' ? ' checked' : ''}><span>${esc(t('bset.saveDownloads'))}</span></label>
  </section>
  <section class="bs-section" aria-labelledby="browser-popup-heading">
    <h3 class="field-label" id="browser-popup-heading">${esc(t('bset.popups'))}</h3>
    <label class="bs-toggle"><input type="radio" name="browser-popups" id="browser-popups-block" value="block"${popup === 'block' ? ' checked' : ''}><span>${esc(t('bset.blockPopups'))}</span></label>
    <label class="bs-toggle"><input type="radio" name="browser-popups" id="browser-popups-oauth" value="oauth"${popup === 'oauth' ? ' checked' : ''}><span>${esc(t('bset.oauthPopups'))}</span></label>
  </section>
  <section class="bs-section" aria-labelledby="browser-media-heading">
    <h3 class="field-label" id="browser-media-heading">${esc(t('bset.sitePerms'))}</h3>
    ${sites.length ? sites.map((row) => `<div class="bs-row"><div class="bs-row-label"><strong>${esc(row.origin)}</strong><small>${esc(row.permission)}</small></div><label class="bs-toggle"><input type="checkbox" data-browser-permission="${esc(row.origin)}" data-permission="${esc(row.permission)}" data-profile="${esc(row.profileId)}"${row.value === 'allow' ? ' checked' : ''}><span>${esc(t('bset.allow'))}</span></label></div>`).join('') : `<p class="bs-note">${esc(t('bset.noSites'))}</p>`}
  </section>
  <section class="bs-section" aria-labelledby="browser-profile-heading"><h3 class="field-label" id="browser-profile-heading">${esc(t('bset.profilesHd'))}</h3>
    ${profiles.length ? profiles.map((p) => `<div class="bs-row"><div class="bs-row-label"><strong>${esc(p.name || p.id)}</strong><small>${p.viewCount ? `${p.viewCount} ${p.viewCount === 1 ? t('bset.tab') : t('bset.tabs')}` : t('bset.profile')}</small></div></div>`).join('') : `<p class="bs-note">${status.profileLoadError ? t('bset.profilesErr') : t('bset.signInHint')}</p>`}
    <div class="bs-actions">${actions.onProfiles ? `<button class="btn btn--small" data-browser-settings="profiles">${esc(t('browser.profiles'))}</button>` : ''}${actions.onImportCookies ? `<button class="btn btn--small" data-browser-settings="cookies">${esc(t('browser.importChrome'))}</button>` : ''}${actions.onClear ? `<button class="btn btn--small" data-browser-settings="clear">${esc(t('browser.clearData'))}</button>` : ''}</div>
  </section>`;
}

export async function wireBrowserSettings(modal, options) {
  const { api, onError = () => {} } = options;
  const host = modal.querySelector('#browser-settings-body');
  if (!host) return;
  const token = {}; host._browserSettingsRequest = token;
  const current = () => host.isConnected && host._browserSettingsRequest === token;
  try {
    const [status, profileResult] = await Promise.all([api.browserStatus(), api.browserProfiles ? api.browserProfiles({ action: 'list' }).catch(() => ({ error: true })) : null]);
    if (!current()) return;
    if (status?.error) throw new Error(status.error);
    if (profileResult?.profiles) status.profiles = profileResult.profiles.map((profile) => ({ ...profile, viewCount: (status.views || []).filter((view) => view.profileId === profile.id).length }));
    if (profileResult?.error) status.profileLoadError = true;
    if (profileResult?.capabilities?.cookieImport) status.cookieImport = profileResult.capabilities.cookieImport;
    if (profileResult?.capabilities?.newTab) status.newTab = profileResult.capabilities.newTab;
    host.innerHTML = browserSettingsContent(status, options);
    const profileId = status.profiles?.[0]?.id;
    const configure = async (patch) => {
      if (!profileId || !api.browserProfiles) return;
      const result = await api.browserProfiles({ action: 'configure', profileId, ...patch });
      if (result?.error) throw new Error(result.error);
    };
    host.querySelectorAll('[name="browser-blank"]').forEach((input) => {
      input.onchange = async () => {
        try {
          const result = await api.browserProfiles({ action: 'new-tab', value: input.value });
          if (result?.error) throw new Error(result.error);
        } catch (error) { onError(error.message || 'Could not change new tab.'); }
      };
    });
    host.querySelectorAll('[name="browser-download"]').forEach((input) => { input.onchange = async () => { try { await configure({ downloadMode: input.value }); } catch (error) { onError(error.message || 'Could not change downloads.'); } }; });
    host.querySelectorAll('[name="browser-popups"]').forEach((input) => { input.onchange = async () => { try { await configure({ popupMode: input.value }); } catch (error) { onError(error.message || 'Could not change popups.'); } }; });
    host.querySelectorAll('[data-browser-permission]').forEach((input) => {
      input.onchange = async () => {
        try { await configure({ origin: input.dataset.browserPermission, permission: input.dataset.permission, value: input.checked ? 'allow' : 'deny', profileId: input.dataset.profile || profileId }); }
        catch (error) { input.checked = !input.checked; onError(error.message || 'Could not change site permission.'); }
      };
    });
    for (const [key, callback] of [['profiles', options.onProfiles], ['import', options.onImport], ['cookies', options.onImportCookies], ['clear', options.onClear]]) {
      const button = host.querySelector(`[data-browser-settings="${key}"]`);
      if (button) button.onclick = async () => { try { await callback(); } catch (error) { onError(error.message || 'Could not open browser settings.'); } };
    }
  } catch (_) {
    if (!current()) return;
    host.innerHTML = `<p class="bs-note" role="alert">${esc(t('bset.loadErr'))}</p><button class="btn btn--small">${esc(t('usage.retry'))}</button>`;
    host.querySelector('button').onclick = () => wireBrowserSettings(modal, options);
  }
}
