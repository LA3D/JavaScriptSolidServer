// src/lws/governance-backfill.js
// Boot-time self-heal (governance round 2026-07-22). Pods provisioned before
// the lws:Storage marker (a8e0c47) / .lwsowner records existed silently lose
// storage discovery on upgrade. Re-derive both from the provisioning roster —
// IDP account index, single-user config, root profile card. ROSTER-ONLY, no
// structural heuristics: a false positive would carve a fake tenant boundary
// that shadows the root storage (storageRootFor checks named candidates
// first). LOUD, NEVER FATAL, idempotent (Phase D discipline). The
// storage-resolver's positive-only cache needs no invalidation (marker
// status is monotonic). Design: lws-pod docs/superpowers/specs/2026-07-22-*.
import { readDeclaredTypes, readOwners, writeOwners, ensureDeclaredType, LWS_STORAGE } from './type-metadata.js';

// The same card-variant rule the single-user boot gate uses: a legacy pod
// keeps its extensionless /profile/card WebID.
async function profileWebId(storage, podPath, podUri) {
  if (await storage.exists(`${podPath}profile/card.jsonld`)) return `${podUri}profile/card.jsonld#me`;
  if (await storage.exists(`${podPath}profile/card`)) return `${podUri}profile/card#me`;
  return null;                       // no profile -> not a provisioned pod shape
}

async function assembleRoster(storage, { idpEnabled, singleUser, singleUserName, baseUrl }) {
  const roster = [];
  if (idpEnabled) {
    const accounts = await import('../idp/accounts.js');
    for (const username of await accounts.listUsernames()) {
      const account = await accounts.findByUsername(username);
      if (account) roster.push({ root: `/${username}/`, webId: account.webId ?? null });
    }
  }
  if (singleUser && singleUserName) {
    const podPath = `/${singleUserName}/`;
    roster.push({ root: podPath, webId: await profileWebId(storage, podPath, `${baseUrl}${podPath}`) });
  }
  // Root pod: only a root-pod deployment has /profile/card at the root, so
  // this stays null (and '/' unstamped) for named-pod deployments.
  const rootWebId = await profileWebId(storage, '/', `${baseUrl}/`);
  if (rootWebId) roster.push({ root: '/', webId: rootWebId });
  return roster;
}

export async function backfillGovernance(storage, opts, log) {
  const summary = { checked: 0, markers: 0, owners: 0 };
  let roster;
  try { roster = await assembleRoster(storage, opts); }
  catch (err) { log.warn({ err }, '[lws-pod] governance backfill: roster assembly failed — skipped'); return summary; }
  const seen = new Set();
  for (const { root, webId } of roster) {
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      if (!(await storage.exists(root))) continue;
      summary.checked++;
      if (await ensureDeclaredType(storage, root, LWS_STORAGE)) {
        summary.markers++;
        log.warn(`[lws-pod] governance backfill: stamped lws:Storage marker on ${root}`);
      }
      if (webId && !(await readOwners(storage, root)).length) {   // never overwrite an operator edit
        await writeOwners(storage, root, [webId]);
        summary.owners++;
        log.warn(`[lws-pod] governance backfill: recorded owner ${webId} for ${root}`);
      }
    } catch (err) {
      log.warn({ err }, `[lws-pod] governance backfill: ${root} failed — continuing`);   // never fatal
    }
  }
  const stamped = summary.markers + summary.owners;
  log.info(`[lws-pod] governance backfill: ${summary.checked} storage(s) checked, ${summary.markers} marker(s) + ${summary.owners} owner record(s) stamped${stamped === 0 ? ' (clean)' : ''}`);
  return summary;
}
