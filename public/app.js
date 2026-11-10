'use strict';

(function () {
  const state = {
    demoUsers: [],
    activeToken: localStorage.getItem('baton_active_token') || 'tok_pi_lead_01',
    currentUser: null,
    projects: [],
    activeProjectId: localStorage.getItem('baton_active_project') || 'prj_solidstate_01',
    activeTab: localStorage.getItem('baton_active_tab') || 'overview',
    projectDetail: null,
    activeRole: null,
    sources: [],
    restrictedHiddenCount: 0,
    allPermittedSpans: [],
    inspectedSource: null,
    inspectedSpans: [],
    records: [],
    selectedRecordId: null,
    selectedRecordDetail: null,
    selectedRecordVersions: [],
    selectedRecordReviews: [],
    handovers: [],
    selectedHandoverId: null,
    selectedHandoverDetail: null,
    auditEvents: [],
    lastFailedUploadPayload: null
  };

  // DOM helpers
  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    } catch (_) {
      return iso;
    }
  }

  function showAlert(message, type = 'info') {
    const banner = $('global-alert');
    const textEl = $('global-alert-text');
    banner.className = `global-alert alert-${type}`;
    textEl.textContent = message;
    banner.classList.remove('hidden');
  }

  function hideAlert() {
    $('global-alert').classList.add('hidden');
  }

  function evidenceBadge(status) {
    const map = {
      SUPPORTED: 'badge-ok',
      CONFLICTING: 'badge-danger',
      UNSUPPORTED: 'badge-danger',
      STALE: 'badge-warn',
      'NEEDS REVIEW': 'badge-warn',
      NEEDS_REVIEW: 'badge-warn',
      'NOT ESTABLISHED': 'badge-neutral',
      NOT_ESTABLISHED: 'badge-neutral',
      PARTIAL: 'badge-info',
      WEAK: 'badge-warn',
      UNVERIFIED: 'badge-neutral',
      CONTRADICTED: 'badge-danger',
      BROKEN_PROVENANCE: 'badge-danger'
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}" title="Categorical Evidence Status (Separate from Approval State)">${escapeHtml(status || 'NOT ESTABLISHED')}</span>`;
  }

  function approvalBadge(status) {
    const map = {
      APPROVED: 'badge-ok',
      PENDING_REVIEW: 'badge-info',
      DRAFT: 'badge-neutral',
      NEEDS_REVISION: 'badge-warn',
      REJECTED: 'badge-danger'
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}" title="Human Governance Review State">${escapeHtml(status || 'DRAFT')}</span>`;
  }

  function handoverStatusBadge(status) {
    const map = {
      ACKNOWLEDGED: 'badge-ok',
      PUBLISHED: 'badge-info',
      DRAFT: 'badge-warn',
      NONE: 'badge-neutral'
    };
    const cls = map[status] || 'badge-neutral';
    return `<span class="badge ${cls}">${escapeHtml(status || 'NONE')}</span>`;
  }

  async function apiCall(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.activeToken) {
      headers['Authorization'] = `Bearer ${state.activeToken}`;
    }
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg =
        data && data.error && data.error.message
          ? `[${data.error.code || res.status}] ${data.error.message}`
          : `HTTP ${res.status} request failed`;
      const err = new Error(errMsg);
      err.status = res.status;
      err.code = data && data.error ? data.error.code : 'ERROR';
      throw err;
    }
    return data;
  }

  // Navigation switching
  function switchTab(tabName) {
    state.activeTab = tabName;
    localStorage.setItem('baton_active_tab', tabName);

    const tabs = ['overview', 'sources', 'continuity-map', 'records', 'review-queue', 'handover', 'audit'];
    for (const t of tabs) {
      const panel = $(`view-${t}`);
      if (panel) {
        panel.classList.toggle('hidden', t !== tabName);
      }
    }

    document.querySelectorAll('.nav-item').forEach((btn) => {
      const isMatch = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
  }

  // Load initial demo personas & session
  async function loadPersonasAndSession() {
    const demoData = await apiCall('GET', '/api/auth/demo-users');
    state.demoUsers = demoData.demo_users || [];

    const personaSelect = $('persona-select');
    personaSelect.innerHTML = '';
    const seenUsers = new Set();
    for (const u of state.demoUsers) {
      if (seenUsers.has(u.id)) continue;
      seenUsers.add(u.id);
      const opt = document.createElement('option');
      opt.value = u.api_token;
      const roleLabel = u.role_id ? `${u.role_id}` : 'NON_MEMBER';
      opt.textContent = `${u.full_name} — [${roleLabel}]`;
      if (u.api_token === state.activeToken) opt.selected = true;
      personaSelect.appendChild(opt);
    }

    const sessionData = await apiCall('GET', '/api/auth/session');
    state.currentUser = sessionData.user;
    $('sidebar-user-name').textContent = state.currentUser.full_name;
    $('sidebar-user-email').textContent = state.currentUser.email;
    $('sidebar-user-dept').textContent = state.currentUser.department;
  }

  async function loadProjectsList() {
    const projData = await apiCall('GET', '/api/projects');
    state.projects = projData.projects || [];

    const projectSelect = $('project-select');
    projectSelect.innerHTML = '';

    if (state.projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No accessible projects for this user';
      projectSelect.appendChild(opt);
      return false;
    }

    if (!state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = state.projects[0].id;
      localStorage.setItem('baton_active_project', state.activeProjectId);
    }

    for (const p of state.projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.role_id})`;
      if (p.id === state.activeProjectId) opt.selected = true;
      projectSelect.appendChild(opt);
    }
    return true;
  }

  async function loadAllPermittedSpans(sourcesList) {
    const spans = [];
    for (const src of sourcesList) {
      if (src.visibility_level === 'RESTRICTED_PI_ONLY') continue;
      try {
        const spRes = await apiCall('GET', `/api/projects/${state.activeProjectId}/sources/${src.id}/spans`);
        for (const sp of spRes.spans || []) {
          spans.push({ ...sp, source_title: src.title });
        }
      } catch (_) {
        // ignore inaccessible
      }
    }
    state.allPermittedSpans = spans;
  }

  async function refreshWorkspace() {
    const loadingEl = $('workspace-loading');
    loadingEl.classList.remove('hidden');

    try {
      await loadPersonasAndSession();
      const hasProjects = await loadProjectsList();

      if (!hasProjects) {
        state.activeRole = 'NON_MEMBER';
        $('active-role-badge').textContent = 'Role: NON_MEMBER (No Project Access)';
        showAlert(
          `User '${state.currentUser.full_name}' is not a member of any project. Backend RBAC blocks project access (403 FORBIDDEN_ROLE). Switch to a project member persona above.`,
          'error'
        );
        renderEmptyNonMemberState();
        return;
      }

      const pid = state.activeProjectId;
      const [projDetail, srcRes, recRes, hndRes] = await Promise.all([
        apiCall('GET', `/api/projects/${pid}`),
        apiCall('GET', `/api/projects/${pid}/sources`),
        apiCall('GET', `/api/projects/${pid}/records`),
        apiCall('GET', `/api/projects/${pid}/handovers`)
      ]);

      state.projectDetail = projDetail;
      state.activeRole = projDetail.caller_membership.role_id;
      state.sources = srcRes.sources || [];
      state.restrictedHiddenCount = srcRes.restricted_hidden_count || 0;
      state.records = recRes.records || [];
      state.continuityEdges = recRes.edges || [];
      state.handovers = hndRes.handovers || [];

      $('active-role-badge').textContent = `Role: ${state.activeRole}`;

      await loadAllPermittedSpans(state.sources);

      // Update navigation badges
      $('nav-badge-sources').textContent = String(state.sources.length);
      $('nav-badge-map').textContent = String(state.records.length);
      $('nav-badge-records').textContent = String(state.records.length);
      $('nav-badge-reviews').textContent = String(projDetail.dashboard.pending_reviews_count);
      $('nav-badge-handover').textContent = projDetail.dashboard.handover_status;

      // Render all screens from real API state
      renderOverviewScreen();
      renderSourcesScreen();
      renderContinuityMapScreen();
      await renderRecordsScreen();
      renderReviewQueueScreen();
      await renderHandoverScreen();
      await renderAuditScreen();
    } catch (err) {
      showAlert(err.message, 'error');
    } finally {
      loadingEl.classList.add('hidden');
    }
  }

  function renderEmptyNonMemberState() {
    $('heading-overview').textContent = 'Access Denied — Non-Member Persona';
    $('overview-description').textContent =
      'Backend RBAC enforcement prevented loading project resources because this user has no membership row.';
    $('overview-status-badge').textContent = '403 FORBIDDEN';
    $('overview-status-badge').className = 'badge badge-danger';
    $('metric-sources').textContent = '—';
    $('metric-records').textContent = '—';
    $('metric-open-loops').textContent = '—';
    $('metric-pending-reviews').textContent = '—';
    $('metric-handover-status').textContent = '—';
    $('overview-activity-list').innerHTML = '<div class="empty-state">Access restricted.</div>';
    $('overview-members-tbody').innerHTML = '<tr><td colspan="3" class="empty-state">Access restricted.</td></tr>';
  }

  // SCREEN 1: OVERVIEW
  function renderOverviewScreen() {
    const { project, dashboard, memberships, recent_activity } = state.projectDetail;
    $('heading-overview').textContent = project.name;
    $('overview-description').textContent = project.description;
    $('overview-slug').textContent = project.slug;
    $('overview-status-badge').textContent = project.status;
    $('overview-status-badge').className = 'badge badge-ok';

    // Workflow strip stats
    const verifiedCount = state.records.filter((r) => r.evidence_status === 'SUPPORTED').length;
    $('wf-connect-stat').textContent = `${dashboard.source_count} Sources`;
    $('wf-reconstruct-stat').textContent = `${dashboard.total_records_count} Records`;
    $('wf-verify-stat').textContent = `${verifiedCount} Supported`;
    $('wf-review-stat').textContent = `${dashboard.pending_reviews_count} Pending`;
    $('wf-handover-stat').textContent = dashboard.handover_status;

    // Metrics cards
    $('metric-sources').textContent = String(dashboard.source_count);
    $('metric-sources-sub').textContent =
      dashboard.restricted_hidden_count > 0
        ? `+${dashboard.restricted_hidden_count} restricted source(s) hidden for ${state.activeRole}`
        : 'All accessible project sources';
    $('metric-records').textContent = String(dashboard.total_records_count);
    $('metric-records-sub').textContent = `${dashboard.approved_records_count} approved for handover`;
    $('metric-open-loops').textContent = String(dashboard.open_loops_count);
    $('metric-pending-reviews').textContent = String(dashboard.pending_reviews_count);
    $('metric-handover-status').innerHTML = handoverStatusBadge(dashboard.handover_status);
    $('metric-handover-sub').textContent = dashboard.latest_handover
      ? `Latest: ${dashboard.latest_handover.title}`
      : 'No handover package created yet';

    // Activity list
    const actContainer = $('overview-activity-list');
    if (!recent_activity || recent_activity.length === 0) {
      actContainer.innerHTML = '<div class="empty-state">No recent activity recorded.</div>';
    } else {
      actContainer.innerHTML = recent_activity
        .map(
          (ev) => `
          <div class="activity-item">
            <div>
              <span class="badge badge-info">${escapeHtml(ev.event_type)}</span>
              <strong style="margin-left:6px;">${escapeHtml(ev.actor_name || 'System')}</strong>
              <span class="text-muted text-xs">(${escapeHtml(ev.actor_role || 'SYSTEM')})</span>
            </div>
            <div class="text-muted text-xs">${escapeHtml(formatDate(ev.created_at))}</div>
          </div>
        `
        )
        .join('');
    }

    // Memberships table
    const memTbody = $('overview-members-tbody');
    memTbody.innerHTML = (memberships || [])
      .map(
        (m) => `
        <tr>
          <td>
            <strong>${escapeHtml(m.full_name)}</strong>
            <div class="text-muted text-xs">${escapeHtml(m.email)}</div>
          </td>
          <td>${escapeHtml(m.department)}</td>
          <td><span class="badge badge-neutral">${escapeHtml(m.role_id)}</span></td>
        </tr>
      `
      )
      .join('');

    // Populate user dropdown for membership assignment
    const memUserSelect = $('member-user-select');
    memUserSelect.innerHTML = '';
    const seen = new Set();
    for (const u of state.demoUsers) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = `${u.full_name} (${u.email})`;
      memUserSelect.appendChild(opt);
    }

    const canManageMembers = state.activeRole === 'PI_LEAD';
    $('member-user-select').disabled = !canManageMembers;
    $('member-role-select').disabled = !canManageMembers;
    $('btn-submit-member').disabled = !canManageMembers;
    const memNote = $('member-form-permission-note');
    if (!canManageMembers) {
      memNote.textContent = `Action disabled: Current role '${state.activeRole}' cannot modify project memberships (requires PI_LEAD).`;
      memNote.classList.remove('hidden');
    } else {
      memNote.classList.add('hidden');
    }
  }

  // SCREEN 2: SOURCES
  function renderSourcesScreen() {
    const canUpload = ['PI_LEAD', 'RESEARCHER'].includes(state.activeRole);
    const uploadNote = $('upload-permission-note');
    if (!canUpload) {
      uploadNote.textContent = `Upload disabled: Current role '${state.activeRole}' is not permitted to upload sources. Switch to PI_LEAD or RESEARCHER.`;
      uploadNote.classList.remove('hidden');
    } else {
      uploadNote.classList.add('hidden');
    }

    ['src-title', 'src-format', 'src-file-input', 'src-filename', 'src-visibility', 'src-exclude-ai', 'src-content', 'btn-submit-source'].forEach(
      (id) => {
        if ($(id)) $(id).disabled = !canUpload;
      }
    );

    const restBanner = $('sources-restricted-banner');
    if (state.restrictedHiddenCount > 0) {
      restBanner.textContent = `${state.restrictedHiddenCount} RESTRICTED_PI_ONLY source(s) filtered out by backend RBAC for role '${state.activeRole}'.`;
      restBanner.classList.remove('hidden');
    } else {
      restBanner.classList.add('hidden');
    }

    $('sources-count-label').textContent = `${state.sources.length} accessible source(s)`;
    const tbody = $('sources-tbody');
    if (state.sources.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No sources connected yet.</td></tr>';
      return;
    }

    tbody.innerHTML = state.sources
      .map((s) => {
        const visBadge =
          s.visibility_level === 'RESTRICTED_PI_ONLY'
            ? '<span class="badge badge-danger">RESTRICTED_PI_ONLY</span>'
            : '<span class="badge badge-ok">PROJECT_SHARED</span>';
        const aiBadge = Number(s.exclude_from_ai) === 1
          ? '<span class="badge badge-warn">AI-Excluded</span>'
          : '<span class="badge badge-info">AI-Eligible</span>';
        const statusBadge =
          s.processing_status === 'READY'
            ? '<span class="badge badge-ok">READY</span>'
            : s.processing_status === 'NEEDS_OCR'
              ? '<span class="badge badge-warn">NEEDS_OCR (Scanned PDF)</span>'
              : s.processing_status === 'FAILED'
                ? '<span class="badge badge-danger">FAILED</span>'
                : `<span class="badge badge-warn">${escapeHtml(s.processing_status)}</span>`;

        const countMetric =
          s.page_count !== null && s.page_count !== undefined
            ? `${s.page_count} page(s) · ${s.span_count} span(s)`
            : s.row_count !== null && s.row_count !== undefined
              ? `${s.row_count} row/line(s) · ${s.span_count} span(s)`
              : `${s.span_count} span(s)`;

        const injectionBadge =
          Number(s.has_prompt_injection_pattern) === 1
            ? ' <span class="badge badge-warn" title="Adversarial instruction text treated strictly as inert document data">Untrusted Prompt Sandboxed</span>'
            : '';

        const errNotice = s.processing_error
          ? `<div class="text-xs" style="color:var(--status-danger-text); margin-top:3px;">Error: ${escapeHtml(s.processing_error)}</div>`
          : '';

        return `
          <tr>
            <td>
              <strong>${escapeHtml(s.title)}</strong>
              <div class="text-muted text-xs">${escapeHtml(s.file_name)} (${escapeHtml(s.mime_type || 'text/plain')}) · ${escapeHtml(String(s.byte_size))} B</div>
              ${errNotice}
            </td>
            <td><span class="mono-tag">${escapeHtml(s.source_type)}</span></td>
            <td>${visBadge} ${aiBadge}${injectionBadge}</td>
            <td>${statusBadge}</td>
            <td><span class="mono-tag">${escapeHtml(countMetric)}</span></td>
            <td>
              ${escapeHtml(s.uploaded_by_name)}
              <div class="text-muted text-xs">${escapeHtml(formatDate(s.created_at))}</div>
            </td>
            <td>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" class="btn btn-outline btn-xs btn-inspect-spans" data-source-id="${escapeHtml(s.id)}">
                  Preview &amp; Spans
                </button>
                <button type="button" class="btn btn-outline btn-xs btn-retry-source" data-source-id="${escapeHtml(s.id)}" ${!canUpload ? 'disabled title="Requires PI_LEAD or RESEARCHER"' : ''}>
                  Re-index
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('.btn-inspect-spans').forEach((btn) => {
      btn.addEventListener('click', () => inspectSourceSpans(btn.getAttribute('data-source-id')));
    });

    tbody.querySelectorAll('.btn-retry-source').forEach((btn) => {
      btn.addEventListener('click', () => retrySourceProcessing(btn.getAttribute('data-source-id')));
    });
  }

  async function inspectSourceSpans(sourceId) {
    try {
      const data = await apiCall('GET', `/api/projects/${state.activeProjectId}/sources/${sourceId}/spans`);
      state.inspectedSource = data.source;
      state.inspectedSpans = data.spans || [];
      $('inspector-source-badge').textContent = `${data.source.file_name} (${state.inspectedSpans.length} spans)`;

      const body = $('span-inspector-body');
      const previewHeader = `
        <div class="status-box" style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <strong>Source Preview: ${escapeHtml(data.source.title)}</strong>
            <span class="mono-tag">Status: ${escapeHtml(data.source.processing_status)}</span>
          </div>
          <div class="text-muted text-xs" style="margin-bottom:6px;">
            File: ${escapeHtml(data.source.file_name)} (${escapeHtml(data.source.mime_type)}) ·
            ${data.source.page_count !== null ? `Pages: ${data.source.page_count} · ` : ''}
            ${data.source.row_count !== null ? `Rows/Lines: ${data.source.row_count} · ` : ''}
            SHA-256: <code>${escapeHtml((data.source.content_hash || '').slice(0, 16))}...</code>
          </div>
          ${
            data.source.processing_error
              ? `<div class="permission-note" style="margin:4px 0;">${escapeHtml(data.source.processing_error)}</div>`
              : ''
          }
          <details>
            <summary class="text-xs" style="cursor:pointer; font-weight:600;">View Extracted Source Text Preview (Untrusted Document Data)</summary>
            <pre class="span-text" style="margin-top:6px; padding:8px; background:#fff; border:1px solid var(--border-color); max-height:140px; overflow-y:auto;">${escapeHtml(data.source.raw_content_preview || '')}</pre>
          </details>
        </div>
      `;

      if (state.inspectedSpans.length === 0) {
        body.innerHTML = previewHeader + '<div class="empty-state">Zero extractable provenance spans (e.g., NEEDS_OCR or failed extraction).</div>';
        return;
      }

      body.innerHTML =
        previewHeader +
        state.inspectedSpans
          .map((sp) => {
            const fieldsInfo = sp.column_names_json
              ? `<div class="text-muted text-xs">Field Context: <code>${escapeHtml(sp.column_names_json)}</code> · Record Key: <code>${escapeHtml(sp.record_key || '')}</code></div>`
              : sp.page_number
                ? `<div class="text-muted text-xs">PDF Page Number: <code>${sp.page_number}</code></div>`
                : sp.section_heading
                  ? `<div class="text-muted text-xs">Section: <code>${escapeHtml(sp.section_heading)}</code> · Lines: <code>${sp.line_start}–${sp.line_end}</code></div>`
                  : '';

            return `
            <div class="span-card">
              <div class="span-locator">
                [${escapeHtml(sp.id)}] ${escapeHtml(sp.locator_type)} · ${escapeHtml(sp.locator_label)}
                <span class="text-muted text-xs" style="float:right;">chars ${sp.char_start}–${sp.char_end}</span>
              </div>
              ${fieldsInfo}
              <div class="span-text" style="margin-top:4px;">${escapeHtml(sp.content_text)}</div>
            </div>
          `;
          })
          .join('');
    } catch (err) {
      showAlert(err.message, 'error');
    }
  }

  async function retrySourceProcessing(sourceId) {
    try {
      const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/sources/${sourceId}/retry`);
      showAlert(`Source '${res.source.title}' re-indexed (${res.spans.length} provenance spans ready).`, 'success');
      await refreshWorkspace();
      await inspectSourceSpans(sourceId);
    } catch (err) {
      showAlert(err.message, 'error');
    }
  }

  // SCREEN 3: CONTINUITY MAP
  function renderContinuityMapScreen() {
    const canReconstruct = ['PI_LEAD', 'RESEARCHER'].includes(state.activeRole);
    const recNote = $('reconstruct-permission-note');
    if (!canReconstruct) {
      recNote.textContent = `Reconstruction disabled: Current role '${state.activeRole}' cannot run extraction (requires PI_LEAD or RESEARCHER).`;
      recNote.classList.remove('hidden');
    } else {
      recNote.classList.add('hidden');
    }
    $('reconstruct-focus').disabled = !canReconstruct;
    $('btn-run-reconstruct').disabled = !canReconstruct;

    const cbContainer = $('reconstruct-source-checkboxes');
    cbContainer.innerHTML = state.sources
      .map((s) => {
        const isRest = s.visibility_level === 'RESTRICTED_PI_ONLY' || Number(s.exclude_from_ai) === 1;
        return `
          <label class="checkbox-card">
            <input type="checkbox" name="recon-source" value="${escapeHtml(s.id)}" checked ${!canReconstruct ? 'disabled' : ''} />
            <div>
              <strong>${escapeHtml(s.title)}</strong>
              <div class="text-muted text-xs">
                ${escapeHtml(s.source_type)} · ${isRest ? 'Will be filtered out by Pre-AI Gate' : `${s.span_count} permitted spans`}
              </div>
            </div>
          </label>
        `;
      })
      .join('');

    // Populate Continuity Map Owner & Source filter dropdowns
    const ownerSelect = $('map-filter-owner');
    const prevOwnerVal = ownerSelect.value || 'ALL';
    const distinctOwners = Array.from(
      new Set(state.records.map((r) => r.stated_owner).filter(Boolean))
    );
    ownerSelect.innerHTML =
      '<option value="ALL">All Owners</option>' +
      '<option value="UNKNOWN">UNKNOWN (Not stated in source)</option>' +
      distinctOwners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    if ([...ownerSelect.options].some((o) => o.value === prevOwnerVal)) {
      ownerSelect.value = prevOwnerVal;
    }

    const srcFilterSelect = $('map-filter-source');
    const prevSrcVal = srcFilterSelect.value || 'ALL';
    srcFilterSelect.innerHTML =
      '<option value="ALL">All Sources</option>' +
      state.sources
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`)
        .join('');
    if ([...srcFilterSelect.options].some((o) => o.value === prevSrcVal)) {
      srcFilterSelect.value = prevSrcVal;
    }

    const fType = $('map-filter-type').value;
    const fStatus = $('map-filter-status').value;
    const fOwner = $('map-filter-owner').value;
    const fSource = $('map-filter-source').value;

    const filteredMapRecords = state.records.filter((r) => {
      if (fType !== 'ALL' && r.record_type !== fType) return false;
      if (fStatus !== 'ALL') {
        if (fStatus === 'INCOMPLETE') {
          if (!r.is_incomplete && (!r.missing_fields || r.missing_fields.length === 0)) return false;
        } else if (fStatus === 'CONTRADICTED') {
          if (r.evidence_status !== 'CONTRADICTED' && !r.has_conflict) return false;
        } else if (['APPROVED', 'PENDING_REVIEW'].includes(fStatus)) {
          if (r.approval_status !== fStatus) return false;
        } else if (r.evidence_status !== fStatus) {
          return false;
        }
      }
      if (fOwner !== 'ALL') {
        if (fOwner === 'UNKNOWN' && r.stated_owner) return false;
        if (fOwner !== 'UNKNOWN' && r.stated_owner !== fOwner) return false;
      }
      if (fSource !== 'ALL') {
        const hasSource = (r.evidence_links || []).some((l) => l.source_id === fSource);
        if (!hasSource) return false;
      }
      return true;
    });

    const colObj = [];
    const colExp = [];
    const colRisk = [];
    const colDep = [];

    for (const r of filteredMapRecords) {
      if (['OBJECTIVE', 'DECISION', 'CLAIM'].includes(r.record_type)) {
        colObj.push(r);
      } else if (['EXPERIMENT', 'RESULT', 'PROTOCOL', 'METHOD', 'DATASET_FINDING'].includes(r.record_type)) {
        colExp.push(r);
      } else if (['DEPENDENCY', 'CONTACT'].includes(r.record_type)) {
        colDep.push(r);
      } else {
        colRisk.push(r);
      }
    }

    $('map-count-obj').textContent = String(colObj.length);
    $('map-count-exp').textContent = String(colExp.length);
    $('map-count-risk').textContent = String(colRisk.length);
    $('map-count-dep').textContent = String(colDep.length);

    function renderFlagsBadges(r) {
      const badges = [];
      if (r.has_conflict || r.evidence_status === 'CONTRADICTED' || r.evidence_status === 'CONFLICTING') {
        badges.push('<span class="badge badge-danger" title="Conflicting evidence or contradictory dates">CONFLICT</span>');
      }
      if (r.is_stale || r.evidence_status === 'STALE') {
        badges.push(`<span class="badge badge-warn" title="${escapeHtml(r.stale_reason || 'Stale evidence')}">STALE</span>`);
      }
      if (r.is_incomplete || (r.missing_fields && r.missing_fields.length > 0)) {
        badges.push(
          `<span class="badge badge-warn" title="Missing in source: ${escapeHtml((r.missing_fields || []).join(', '))}">INCOMPLETE</span>`
        );
      }
      if (!r.evidence_links || r.evidence_links.length === 0) {
        badges.push('<span class="badge badge-danger">UNLINKED</span>');
      }
      return badges.join(' ');
    }

    function renderMapCards(list, targetId) {
      const container = $(targetId);
      if (list.length === 0) {
        container.innerHTML = '<div class="empty-state">No records match in this category.</div>';
        return;
      }
      container.innerHTML = list
        .map((r) => {
          const ownerLabel = r.stated_owner ? escapeHtml(r.stated_owner) : 'UNKNOWN (Not in source)';
          const locators = (r.evidence_links || []).map((l) => l.locator_label).join(', ');
          return `
          <button type="button" class="map-item-card" data-record-id="${escapeHtml(r.id)}">
            <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
              <span class="mono-tag">${escapeHtml(r.record_type)}</span>
              ${evidenceBadge(r.evidence_status)}
              ${approvalBadge(r.approval_status)}
              ${renderFlagsBadges(r)}
            </div>
            <div class="map-item-title">${escapeHtml(r.title)}</div>
            <div class="text-xs" style="color:var(--text-secondary); margin-bottom:4px;">
              ${escapeHtml((r.direct_source_statement || r.statement || '').slice(0, 95))}...
            </div>
            <div class="map-item-meta">
              <span>Stated Owner: <strong>${ownerLabel}</strong></span>
              <span>· Date: ${escapeHtml(r.recorded_date || 'UNKNOWN')}</span>
              <span>· ${r.evidence_links.length} span(s) (${escapeHtml(locators)})</span>
            </div>
          </button>
        `;
        })
        .join('');

      container.querySelectorAll('.map-item-card').forEach((card) => {
        card.addEventListener('click', () => {
          state.selectedRecordId = card.getAttribute('data-record-id');
          switchTab('records');
          renderRecordsScreen();
        });
      });
    }

    renderMapCards(colObj, 'map-col-objectives');
    renderMapCards(colExp, 'map-col-experiments');
    renderMapCards(colRisk, 'map-col-risks');
    renderMapCards(colDep, 'map-col-dependencies');

    // Render Accessible Table Alternative
    $('map-table-count').textContent = `${filteredMapRecords.length} node(s)`;
    const mapTbody = $('continuity-map-tbody');
    if (filteredMapRecords.length === 0) {
      mapTbody.innerHTML = '<tr><td colspan="7" class="empty-state">No continuity nodes match active filters.</td></tr>';
    } else {
      mapTbody.innerHTML = filteredMapRecords
        .map((r) => {
          const locators = (r.evidence_links || []).map((l) => `${l.source_id} (${l.locator_label})`).join('; ');
          return `
            <tr data-record-id="${escapeHtml(r.id)}" style="cursor:pointer;">
              <td><span class="mono-tag">${escapeHtml(r.record_type)}</span></td>
              <td>
                <strong>${escapeHtml(r.title)}</strong>
                <div class="text-xs">${escapeHtml(r.direct_source_statement || r.statement)}</div>
              </td>
              <td>
                <div>Owner: <strong>${escapeHtml(r.stated_owner || 'UNKNOWN')}</strong></div>
                <div class="text-muted text-xs">Date: ${escapeHtml(r.recorded_date || 'UNKNOWN')}</div>
              </td>
              <td>${evidenceBadge(r.evidence_status)}</td>
              <td>${approvalBadge(r.approval_status)}</td>
              <td>${renderFlagsBadges(r) || '<span class="badge badge-ok">COMPLETE</span>'}</td>
              <td class="text-xs">${escapeHtml(locators || 'UNLINKED')}</td>
            </tr>
          `;
        })
        .join('');

      mapTbody.querySelectorAll('tr[data-record-id]').forEach((row) => {
        row.addEventListener('click', () => {
          state.selectedRecordId = row.getAttribute('data-record-id');
          switchTab('records');
          renderRecordsScreen();
        });
      });
    }

    // Render Evidence-Supported Continuity Edges
    const edges = state.continuityEdges || [];
    $('continuity-edges-count').textContent = `${edges.length} evidence-backed edge(s)`;
    const edgesTbody = $('continuity-edges-tbody');
    const recById = new Map(state.records.map((r) => [r.id, r]));

    if (edges.length === 0) {
      edgesTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No evidence-backed edges recorded yet.</td></tr>';
    } else {
      edgesTbody.innerHTML = edges
        .map((e) => {
          const fromRec = recById.get(e.from_record_id);
          const toRec = recById.get(e.to_record_id);
          const edgeCls = e.relationship_type === 'CONFLICTS_WITH' ? 'badge-danger' : 'badge-info';
          return `
            <tr>
              <td><span class="badge ${edgeCls}">${escapeHtml(e.relationship_type)}</span></td>
              <td><strong>${escapeHtml(fromRec ? fromRec.title : e.from_record_id)}</strong></td>
              <td><strong>${escapeHtml(toRec ? toRec.title : e.to_record_id)}</strong></td>
              <td class="text-xs">${escapeHtml(e.evidence_rationale)}</td>
              <td><span class="mono-tag">${escapeHtml((e.supporting_span_ids || []).join(', '))}</span></td>
            </tr>
          `;
        })
        .join('');
    }
  }

  // SCREEN 4: RECORDS & EVIDENCE
  async function renderRecordsScreen() {
    const canCreateEdit = ['PI_LEAD', 'RESEARCHER'].includes(state.activeRole);
    const createNote = $('create-record-permission-note');
    if (!canCreateEdit) {
      createNote.textContent = `Record creation disabled: Role '${state.activeRole}' cannot create records (requires PI_LEAD or RESEARCHER).`;
      createNote.classList.remove('hidden');
    } else {
      createNote.classList.add('hidden');
    }
    ['new-rec-type', 'new-rec-evidence-status', 'new-rec-title', 'new-rec-statement', 'new-rec-rationale', 'new-rec-span', 'new-rec-quote', 'btn-submit-new-record'].forEach(
      (id) => {
        if ($(id)) $(id).disabled = !canCreateEdit;
      }
    );

    // Populate span selector for manual record creation
    const spanSelect = $('new-rec-span');
    spanSelect.innerHTML = '';
    for (const sp of state.allPermittedSpans) {
      const opt = document.createElement('option');
      opt.value = sp.id;
      opt.textContent = `[${sp.id}] ${sp.source_title} — ${sp.locator_label}`;
      opt.dataset.sampleQuote = sp.content_text.slice(0, 90);
      spanSelect.appendChild(opt);
    }
    if (state.allPermittedSpans.length > 0 && !$('new-rec-quote').value) {
      $('new-rec-quote').value = state.allPermittedSpans[0].content_text.slice(0, 90);
    }

    // Apply filters
    const typeFilter = $('filter-rec-type').value;
    const evFilter = $('filter-evidence-status').value;
    const appFilter = $('filter-approval-status').value;
    const query = ($('filter-search').value || '').toLowerCase().trim();

    const filtered = state.records.filter((r) => {
      if (typeFilter !== 'ALL' && r.record_type !== typeFilter) return false;
      if (evFilter !== 'ALL' && r.evidence_status !== evFilter) return false;
      if (appFilter !== 'ALL' && r.approval_status !== appFilter) return false;
      if (query) {
        const hay = `${r.title} ${r.statement} ${r.created_by_name} ${r.record_type}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    $('records-table-count').textContent = `${filtered.length} of ${state.records.length} record(s)`;
    const tbody = $('records-tbody');

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No continuity records match the active filters.</td></tr>';
    } else {
      if (!state.selectedRecordId || !state.records.some((r) => r.id === state.selectedRecordId)) {
        state.selectedRecordId = filtered[0].id;
      }

      tbody.innerHTML = filtered
        .map((r) => {
          const isSelected = r.id === state.selectedRecordId;
          const locators = (r.evidence_links || []).map((l) => l.locator_label).join('; ') || 'None';
          return `
            <tr class="${isSelected ? 'selected-row' : ''}" data-record-id="${escapeHtml(r.id)}" style="cursor:pointer;">
              <td><span class="mono-tag">${escapeHtml(r.record_type)}</span></td>
              <td>
                <strong>${escapeHtml(r.title)}</strong>
                <div class="text-muted text-xs">${escapeHtml(r.statement.slice(0, 110))}${r.statement.length > 110 ? '...' : ''}</div>
              </td>
              <td>
                ${escapeHtml(r.created_by_name)}
                <div class="text-muted text-xs">${escapeHtml(formatDate(r.updated_at).slice(0, 10))}</div>
              </td>
              <td>
                <span class="mono-tag">${r.evidence_links.length} ref(s)</span>
                <div class="text-muted text-xs">${escapeHtml(locators)}</div>
              </td>
              <td>${evidenceBadge(r.evidence_status)}</td>
              <td>${approvalBadge(r.approval_status)}</td>
            </tr>
          `;
        })
        .join('');

      tbody.querySelectorAll('tr[data-record-id]').forEach((row) => {
        row.addEventListener('click', () => {
          state.selectedRecordId = row.getAttribute('data-record-id');
          renderRecordsScreen();
        });
      });
    }

    await renderSelectedRecordDetail();
  }

  async function renderSelectedRecordDetail() {
    const detailBody = $('record-detail-body');
    if (!state.selectedRecordId) {
      $('detail-record-version').textContent = '—';
      detailBody.innerHTML = '<div class="empty-state">Select a continuity record to inspect evidence and versions.</div>';
      return;
    }

    try {
      const [recRes, verRes] = await Promise.all([
        apiCall('GET', `/api/projects/${state.activeProjectId}/records/${state.selectedRecordId}`),
        apiCall('GET', `/api/projects/${state.activeProjectId}/records/${state.selectedRecordId}/versions`)
      ]);

      const rec = recRes.record;
      const versions = verRes.versions || [];
      $('detail-record-version').textContent = `v${rec.current_version} · ${rec.id}`;

      const canVerify = ['PI_LEAD', 'RESEARCHER', 'REVIEWER'].includes(state.activeRole);
      const canEdit = ['PI_LEAD', 'RESEARCHER'].includes(state.activeRole);

      const linksHtml =
        rec.evidence_links.length === 0
          ? '<div class="empty-state">No evidence spans linked yet (UNSUPPORTED / NOT ESTABLISHED).</div>'
          : rec.evidence_links
              .map((l) => {
                const citStatus = l.citation_status || (l.quote_verified ? 'RESOLVED' : 'INVALID_UNRESOLVED');
                const isValid = Boolean(l.is_valid_support && citStatus === 'RESOLVED');
                const statusBadgeCls = isValid ? 'badge-ok' : 'badge-danger';
                return `
              <div class="quote-card" data-citation-id="${escapeHtml(l.id)}">
                <div class="span-locator">
                  <strong>${escapeHtml(l.source_title)}</strong>
                  ${l.source_file_name ? `<code>(${escapeHtml(l.source_file_name)})</code>` : ''}
                  · <span>${escapeHtml(l.locator_label)}</span>
                  · <span>Date: <code>${escapeHtml(l.excerpt_date || 'UNKNOWN')}</code></span>
                  <span class="badge ${statusBadgeCls}" style="float:right;">
                    ${escapeHtml(citStatus)} ${isValid ? '(Valid Support)' : '(Invalid / Excluded)'}
                  </span>
                </div>
                <div class="span-text"><strong>Exact Excerpt:</strong> "${escapeHtml(l.verbatim_quote)}"</div>
                ${
                  l.span_content_text
                    ? `<div class="text-xs text-muted" style="margin-top:4px; padding-top:4px; border-top:1px dashed var(--border-subtle);">
                         <strong>Full Stored Source Span Passage (${escapeHtml(l.span_id || '')}):</strong> ${escapeHtml(l.span_content_text)}
                       </div>`
                    : ''
                }
                ${
                  l.resolution_error
                    ? `<div class="text-xs" style="color:var(--status-danger-text); margin-top:4px;">
                         <strong>Citation Issue:</strong> ${escapeHtml(l.resolution_error)}
                       </div>`
                    : ''
                }
                ${
                  canVerify
                    ? `<div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
                         <button type="button" class="btn btn-outline btn-xs btn-flag-citation" data-link-id="${escapeHtml(l.id)}" data-flag-reason="INCORRECT_EXCERPT">
                           Flag Incorrect Citation
                         </button>
                         <button type="button" class="btn btn-outline btn-xs btn-flag-citation" data-link-id="${escapeHtml(l.id)}" data-flag-reason="IRRELEVANT_PASSAGE">
                           Flag Irrelevant Citation
                         </button>
                       </div>`
                    : ''
                }
              </div>
            `;
              })
              .join('');

      const versionsHtml = versions
        .map(
          (v) => `
          <tr>
            <td><span class="mono-tag">v${v.version_number}</span></td>
            <td>
              <span class="badge badge-neutral">${escapeHtml(v.change_reason)}</span>
              ${
                Array.isArray(v.changed_fields) && v.changed_fields.length > 0
                  ? `<div class="text-muted text-xs" style="margin-top:2px;">Changed: <code>${escapeHtml(v.changed_fields.join(', '))}</code></div>`
                  : ''
              }
            </td>
            <td>${escapeHtml(v.changed_by_name)}</td>
            <td class="text-xs">${escapeHtml(formatDate(v.created_at))}</td>
          </tr>
        `
        )
        .join('');

      const disc = rec.disclosure || {};
      const conflictingPassages = Array.isArray(rec.conflicting_passages) ? rec.conflicting_passages : [];
      const conflictingPassagesHtml =
        conflictingPassages.length > 0
          ? `<div style="margin-top:6px;">
               <div class="text-xs" style="font-weight:700;">Disagreeing Source Passages (Both Shown — No Automatic Winner):</div>
               ${conflictingPassages
                 .map(
                   (cp) => `
                   <div class="quote-card" style="margin-top:4px;">
                     <div class="span-locator">
                       <strong>${escapeHtml(cp.passage_label || 'Passage')}</strong> ·
                       ${escapeHtml(cp.source_title || '')} · ${escapeHtml(cp.locator_label || cp.span_id || '')} ·
                       Date: <code>${escapeHtml(cp.recorded_date || 'UNKNOWN')}</code>
                     </div>
                     <div class="span-text">"${escapeHtml(cp.verbatim_quote || '')}"</div>
                   </div>`
                 )
                 .join('')}
             </div>`
          : '';

      const conflictBanner =
        rec.has_conflict || rec.evidence_status === 'CONTRADICTED' || rec.evidence_status === 'CONFLICTING'
          ? `<div class="permission-note" style="margin:6px 0; background:var(--status-danger-bg); color:var(--status-danger-text); border-color:var(--status-danger-border);">
               <strong>CONFLICTING Evidence Flagged:</strong> ${escapeHtml(rec.conflict_summary || 'Credible linked sources disagree on a material point. Both are shown below without choosing a winner automatically.')}
               ${conflictingPassagesHtml}
             </div>`
          : '';

      const staleBanner =
        rec.is_stale || rec.evidence_status === 'STALE'
          ? `<div class="permission-note" style="margin:6px 0; background:var(--status-warn-bg); color:var(--status-warn-text); border-color:var(--status-warn-border);">
               <strong>STALE Evidence Flagged:</strong> ${escapeHtml(rec.stale_reason || 'Evidence may be outdated relative to a newer dated source or explicit validity rule.')}
             </div>`
          : '';

      const missingFieldsBanner =
        Array.isArray(rec.missing_fields) && rec.missing_fields.length > 0
          ? `<div class="permission-note" style="margin:6px 0;">
               <strong>Missing / Unestablished Fields in Source:</strong> <code>${escapeHtml(rec.missing_fields.join(', '))}</code>
             </div>`
          : '';

      detailBody.innerHTML = `
        <div style="margin-bottom: 12px;">
          <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:6px;">
            <span class="mono-tag">${escapeHtml(rec.record_type)}</span>
            <div>
              <span class="text-xs text-muted">Evidence:</span> ${evidenceBadge(rec.evidence_status)}
              <span class="text-xs text-muted" style="margin-left:4px;">Approval:</span> ${approvalBadge(rec.approval_status)}
            </div>
          </div>
          <div class="text-xs text-muted" style="margin-bottom:6px;">
            <strong>Evidence State Meaning (${escapeHtml(rec.canonical_evidence_state || rec.evidence_status)}):</strong>
            ${escapeHtml(rec.evidence_state_definition || '')}
          </div>
          <div class="status-box" style="margin-bottom:6px; font-size:11px;">
            <strong>Epistemic Notice:</strong> ${escapeHtml(rec.epistemic_notice || 'A citation shows where a claim came from; it does not prove the source itself is correct.')}
          </div>
          <h3 style="margin:4px 0 6px; font-size:15px;">${escapeHtml(rec.title)}</h3>
          ${conflictBanner}
          ${staleBanner}
          ${missingFieldsBanner}
          <div class="status-box" style="margin-bottom:6px;">
            <div class="text-xs" style="font-weight:700; color:var(--accent-primary);">Direct Source Statement (Factual From Span):</div>
            <div>${escapeHtml(rec.direct_source_statement || rec.statement)}</div>
          </div>
          <div class="status-box" style="margin-bottom:8px; background:#fff;">
            <div class="text-xs" style="font-weight:700; color:var(--text-secondary);">AI Summary / Continuity Inference (Kept Separate):</div>
            <div class="text-xs">${escapeHtml(rec.ai_summary_or_inference || 'None (Manual direct record)')}</div>
          </div>
          <div class="text-muted text-xs" style="margin-bottom:4px;">
            <strong>Stated Owner in Source:</strong> <code>${escapeHtml(rec.stated_owner || 'UNKNOWN (Not stated in source)')}</code> |
            <strong>Recorded Date:</strong> <code>${escapeHtml(rec.recorded_date || 'UNKNOWN')}</code> |
            <strong>Due Date:</strong> <code>${escapeHtml(rec.due_date || 'UNKNOWN')}</code>
          </div>
          <div class="text-muted text-xs" style="margin-bottom:4px;">
            <strong>Rationale:</strong> ${escapeHtml(rec.rationale || 'UNKNOWN (Not stated in source)')} |
            <strong>Record Creator:</strong> ${escapeHtml(rec.created_by_name)} |
            <strong>Verified By:</strong> ${escapeHtml(rec.verified_by_name || 'Not yet verified')}
          </div>
          <div class="text-muted text-xs">
            <strong>Model / Extractor Disclosure:</strong>
            <code>${escapeHtml(disc.provider || '—')} / ${escapeHtml(disc.model || '—')} v${escapeHtml(disc.version || '—')}</code>
            (${escapeHtml(formatDate(disc.extracted_at))})
          </div>
        </div>

        <div class="border-top" style="padding-top:10px; margin-bottom:12px;">
          <div class="form-title">Exact Source Provenance Spans (${rec.evidence_links.length})</div>
          ${linksHtml}
        </div>

        <!-- Stage 06 Verification Form -->
        <form id="form-verify-record" class="border-top" style="padding-top:10px; margin-bottom:12px;">
          <div class="form-title">Stage 3 · Verify Evidence &amp; Gap States (Separate From Approval State)</div>
          ${
            !canVerify
              ? `<div class="permission-note" style="margin:6px 0;">Verification disabled for role '${escapeHtml(state.activeRole)}' (requires PI_LEAD, RESEARCHER, or REVIEWER).</div>`
              : ''
          }
          <div class="form-row">
            <div class="form-field">
              <label for="verify-status-select">Categorical Evidence State</label>
              <select id="verify-status-select" ${!canVerify ? 'disabled' : ''}>
                ${[
                  'SUPPORTED',
                  'CONFLICTING',
                  'UNSUPPORTED',
                  'STALE',
                  'NEEDS REVIEW',
                  'NOT ESTABLISHED',
                  'UNVERIFIED',
                  'WEAK',
                  'PARTIAL',
                  'CONTRADICTED',
                  'BROKEN_PROVENANCE'
                ]
                  .map(
                    (st) =>
                      `<option value="${st}" ${rec.evidence_status === st ? 'selected' : ''}>${st}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div class="form-field" style="flex:2;">
              <label for="verify-notes-input">Verification / Stale / Conflict Explanation</label>
              <input id="verify-notes-input" type="text" value="${escapeHtml(rec.stale_reason || rec.verification_notes || '')}" ${!canVerify ? 'disabled' : ''} />
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-xs" ${!canVerify ? 'disabled' : ''}>
            Save Evidence State (Does Not Change Approval)
          </button>
        </form>

        <!-- Edit / Submit for Review Form -->
        <form id="form-edit-record" class="border-top" style="padding-top:10px; margin-bottom:12px;">
          <div class="form-title">Edit Record / Add Context / Reject or Submit to Review Queue</div>
          ${
            rec.approved_version
              ? `<div class="status-box" style="margin:6px 0; font-size:11.5px;">
                   <strong>Version-Bound Approval Active:</strong> Approved at <code>v${escapeHtml(String(rec.approved_version))}</code>.
                   Editing this record creates <code>v${rec.current_version + 1}</code>, invalidates the old approval, and returns it to <code>PENDING_REVIEW</code>.
                 </div>`
              : ''
          }
          ${
            !canEdit
              ? `<div class="permission-note" style="margin:6px 0;">Editing disabled for role '${escapeHtml(state.activeRole)}' (requires PI_LEAD or RESEARCHER).</div>`
              : ''
          }
          <div class="form-row">
            <div class="form-field">
              <label for="edit-rec-title">Title</label>
              <input id="edit-rec-title" type="text" value="${escapeHtml(rec.title)}" ${!canEdit ? 'disabled' : ''} required />
            </div>
            <div class="form-field">
              <label for="edit-rec-approval">Workflow State</label>
              <select id="edit-rec-approval" ${!canEdit ? 'disabled' : ''}>
                <option value="DRAFT" ${rec.approval_status === 'DRAFT' ? 'selected' : ''}>DRAFT</option>
                <option value="PENDING_REVIEW" ${rec.approval_status === 'PENDING_REVIEW' || rec.approval_status === 'APPROVED' ? 'selected' : ''}>PENDING_REVIEW (Send to Review Queue)</option>
                <option value="REJECTED" ${rec.approval_status === 'REJECTED' ? 'selected' : ''}>REJECTED (Reject Extraction)</option>
              </select>
            </div>
          </div>
          <div class="form-field">
            <label for="edit-rec-statement">Statement</label>
            <textarea id="edit-rec-statement" rows="2" ${!canEdit ? 'disabled' : ''} required>${escapeHtml(rec.statement)}</textarea>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label for="edit-rec-context">Outgoing Context Notes</label>
              <input id="edit-rec-context" type="text" value="${escapeHtml(rec.context_notes || '')}" placeholder="Add outgoing laboratory or operational context..." ${!canEdit ? 'disabled' : ''} />
            </div>
            <div class="form-field">
              <label for="edit-rec-reason">Edit / Correction Reason</label>
              <input id="edit-rec-reason" type="text" value="" placeholder="Why is this record being corrected or rejected?" ${!canEdit ? 'disabled' : ''} />
            </div>
          </div>
          <button type="submit" class="btn btn-secondary btn-xs" ${!canEdit ? 'disabled' : ''}>
            Save Record Revision (Creates v${rec.current_version + 1})
          </button>
        </form>

        <!-- Version History Table -->
        <div class="border-top" style="padding-top:10px;">
          <div class="form-title">Immutable Record Version History (${versions.length})</div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Ver</th>
                <th>Reason</th>
                <th>Actor</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>${versionsHtml}</tbody>
          </table>
        </div>
      `;

      detailBody.querySelectorAll('.btn-flag-citation').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const linkId = btn.getAttribute('data-link-id');
            const reason = btn.getAttribute('data-flag-reason') || 'INCORRECT_EXCERPT';
            await apiCall(
              'POST',
              `/api/projects/${state.activeProjectId}/records/${rec.id}/citations/${linkId}/flag`,
              {
                flag_reason: reason,
                notes: `Flagged by ${state.activeRole} as ${reason} in Evidence Inspector.`
              }
            );
            showAlert(`Citation '${linkId}' flagged as ${reason}.`, 'info');
            await refreshWorkspace();
          } catch (err) {
            showAlert(err.message, 'error');
          }
        });
      });

      const verifyForm = $('form-verify-record');
      if (verifyForm) {
        verifyForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            const newStatus = $('verify-status-select').value;
            const notes = $('verify-notes-input').value;
            await apiCall('POST', `/api/projects/${state.activeProjectId}/records/${rec.id}/verify`, {
              evidence_status: newStatus,
              verification_notes: notes,
              stale_reason: newStatus === 'STALE' ? notes : undefined
            });
            showAlert(`Record '${rec.title}' verified with evidence_status='${newStatus}'.`, 'success');
            await refreshWorkspace();
          } catch (err) {
            showAlert(err.message, 'error');
          }
        });
      }

      const editForm = $('form-edit-record');
      if (editForm) {
        editForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            const updatedTitle = $('edit-rec-title').value;
            const updatedStatement = $('edit-rec-statement').value;
            const updatedApproval = $('edit-rec-approval').value;
            const updatedContext = $('edit-rec-context') ? $('edit-rec-context').value : undefined;
            const editReason = $('edit-rec-reason') ? $('edit-rec-reason').value : undefined;
            await apiCall('PATCH', `/api/projects/${state.activeProjectId}/records/${rec.id}`, {
              title: updatedTitle,
              statement: updatedStatement,
              approval_status: updatedApproval,
              context_notes: updatedContext,
              reason: editReason || undefined
            });
            showAlert(`Saved revision for '${updatedTitle}'.`, 'success');
            await refreshWorkspace();
          } catch (err) {
            showAlert(err.message, 'error');
          }
        });
      }
    } catch (err) {
      detailBody.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    }
  }

  // SCREEN 5: REVIEW QUEUE
  function renderReviewQueueScreen() {
    const canReview = ['PI_LEAD', 'REVIEWER'].includes(state.activeRole);
    const banner = $('review-role-banner');
    if (canReview) {
      banner.textContent = `Active role '${state.activeRole}' is authorized to review records. Submitting a review updates approval_status only and never alters evidence_status.`;
    } else {
      banner.textContent = `Review actions disabled: Current role '${state.activeRole}' cannot approve or reject records (requires PI_LEAD or REVIEWER).`;
    }

    const listEl = $('review-queue-list');
    if (state.records.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No records available for review.</div>';
      return;
    }

    // Sort pending reviews first
    const sorted = [...state.records].sort((a, b) => {
      const aPending = ['PENDING_REVIEW', 'DRAFT', 'NEEDS_REVISION'].includes(a.approval_status) ? 0 : 1;
      const bPending = ['PENDING_REVIEW', 'DRAFT', 'NEEDS_REVISION'].includes(b.approval_status) ? 0 : 1;
      return aPending - bPending;
    });

    listEl.innerHTML = sorted
      .map((r) => {
        const citations = (r.evidence_links || [])
          .map((l) => `<li><strong>${escapeHtml(l.source_title)} (${escapeHtml(l.locator_label)}):</strong> "${escapeHtml(l.verbatim_quote)}"</li>`)
          .join('');

        return `
          <div class="review-card">
            <div class="review-card-header">
              <div>
                <span class="mono-tag">${escapeHtml(r.record_type)}</span>
                <strong style="font-size:15px; margin-left:6px;">${escapeHtml(r.title)}</strong>
                <div class="text-muted text-xs" style="margin-top:2px;">
                  Owner: ${escapeHtml(r.created_by_name)} · Version v${r.current_version} · Updated ${escapeHtml(formatDate(r.updated_at))}
                </div>
              </div>
              <div style="display:flex; gap:6px; align-items:center;">
                <span>Evidence: ${evidenceBadge(r.evidence_status)}</span>
                <span>Review State: ${approvalBadge(r.approval_status)}</span>
              </div>
            </div>

            <p style="margin:6px 0;">${escapeHtml(r.statement)}</p>
            <ul style="margin:6px 0 10px; padding-left:18px; font-size:12.5px; color:var(--text-secondary);">
              ${citations || '<li>No evidence spans linked.</li>'}
            </ul>

            <form class="form-submit-review border-top" data-record-id="${escapeHtml(r.id)}" style="padding-top:10px;">
              <div class="form-row" style="margin-bottom:0;">
                <div class="form-field" style="max-width:220px; margin-bottom:0;">
                  <label>Review Decision</label>
                  <select name="decision" ${!canReview ? 'disabled' : ''} required>
                    <option value="APPROVE">APPROVE (Ready for Handover)</option>
                    <option value="REQUEST_CHANGES">REQUEST_CHANGES</option>
                    <option value="FLAG_GAP">FLAG_GAP</option>
                    <option value="REJECT">REJECT</option>
                  </select>
                </div>
                <div class="form-field" style="flex:2; margin-bottom:0;">
                  <label>Reviewer Comments &amp; Governance Note *</label>
                  <input type="text" name="comments" placeholder="Enter review rationale (e.g., verified against PDF Page 2 & CSV Row 4)..." ${!canReview ? 'disabled' : ''} required />
                </div>
                <div class="form-field form-field-btn" style="margin-bottom:0;">
                  <button type="submit" class="btn btn-primary btn-sm" ${!canReview ? 'disabled title="Requires PI_LEAD or REVIEWER"' : ''}>
                    Submit Review Decision
                  </button>
                </div>
              </div>
            </form>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.form-submit-review').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const recordId = form.getAttribute('data-record-id');
        const decision = form.querySelector('select[name="decision"]').value;
        const comments = form.querySelector('input[name="comments"]').value;
        try {
          const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/records/${recordId}/reviews`, {
            decision,
            comments
          });
          showAlert(
            `Review submitted: decision='${decision}' -> approval_status='${res.record.approval_status}' (evidence_status remains '${res.record.evidence_status}').`,
            'success'
          );
          await refreshWorkspace();
        } catch (err) {
          showAlert(err.message, 'error');
        }
      });
    });
  }

  // SCREEN 6: HANDOVER VIEW
  async function renderHandoverScreen() {
    const canCreateHandover = ['PI_LEAD', 'RESEARCHER'].includes(state.activeRole);
    const createNote = $('handover-create-permission-note');
    if (!canCreateHandover) {
      createNote.textContent = `Handover creation disabled: Current role '${state.activeRole}' cannot draft handover packages (requires PI_LEAD or RESEARCHER).`;
      createNote.classList.remove('hidden');
    } else {
      createNote.classList.add('hidden');
    }
    $('hnd-title').disabled = !canCreateHandover;
    $('hnd-recipient').disabled = !canCreateHandover;
    $('btn-create-handover').disabled = !canCreateHandover;

    // Recipient selector (INCOMING_MEMBER users)
    const recSelect = $('hnd-recipient');
    recSelect.innerHTML = '';
    const members = (state.projectDetail && state.projectDetail.memberships) || [];
    const incomingMembers = members.filter((m) => m.role_id === 'INCOMING_MEMBER');
    const candidateRecipients = incomingMembers.length > 0 ? incomingMembers : members;
    for (const m of candidateRecipients) {
      const opt = document.createElement('option');
      opt.value = m.user_id;
      opt.textContent = `${m.full_name} (${m.role_id})`;
      recSelect.appendChild(opt);
    }

    // Approved records checkboxes
    const approvedRecords = state.records.filter((r) => r.approval_status === 'APPROVED');
    const appContainer = $('hnd-approved-records-list');
    if (approvedRecords.length === 0) {
      appContainer.innerHTML = '<div class="empty-state">No APPROVED records available yet. Approve records in Stage 4 Review Queue first.</div>';
      $('btn-create-handover').disabled = true;
    } else {
      appContainer.innerHTML = approvedRecords
        .map(
          (r) => `
          <label class="checkbox-card">
            <input type="checkbox" name="hnd-record" value="${escapeHtml(r.id)}" checked ${!canCreateHandover ? 'disabled' : ''} />
            <div>
              <strong>[${escapeHtml(r.record_type)}] ${escapeHtml(r.title)}</strong>
              <div class="text-muted text-xs">Evidence: ${escapeHtml(r.evidence_status)} · Owner: ${escapeHtml(r.created_by_name)}</div>
            </div>
          </label>
        `
        )
        .join('');
    }

    // Package selector
    const pkgSelect = $('handover-package-select');
    pkgSelect.innerHTML = '';
    if (state.handovers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No handover packages created yet';
      pkgSelect.appendChild(opt);
      $('handover-lifecycle-box').innerHTML =
        '<div class="empty-state">Create a draft handover package on the left to inspect structured handover sections and sign-off controls.</div>';
      $('handover-structured-view').classList.add('hidden');
      return;
    }

    if (!state.selectedHandoverId || !state.handovers.some((h) => h.id === state.selectedHandoverId)) {
      state.selectedHandoverId = state.handovers[0].id;
    }

    for (const h of state.handovers) {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = `${h.title} [${h.status}]`;
      if (h.id === state.selectedHandoverId) opt.selected = true;
      pkgSelect.appendChild(opt);
    }

    const hndDetail = await apiCall('GET', `/api/projects/${state.activeProjectId}/handovers/${state.selectedHandoverId}`);
    state.selectedHandoverDetail = hndDetail;
    renderSelectedHandoverDetail(hndDetail);
  }

  function renderSelectedHandoverDetail({ handover, items, acknowledgements, versions }) {
    $('handover-structured-view').classList.remove('hidden');

    const canPublish = state.activeRole === 'PI_LEAD' && handover.status === 'DRAFT';
    const allItemsChecked = items.length > 0 && items.every((i) => Number(i.recipient_checked) === 1);
    const canAcknowledge =
      state.activeRole === 'INCOMING_MEMBER' && handover.status === 'PUBLISHED' && allItemsChecked;
    const canCheckItems = ['INCOMING_MEMBER', 'PI_LEAD'].includes(state.activeRole);

    let publishExplain = '';
    if (handover.status === 'DRAFT' && state.activeRole !== 'PI_LEAD') {
      publishExplain = `Publish disabled: Only PI_LEAD can publish a DRAFT handover package (current role: ${state.activeRole}).`;
    }

    let ackExplain = '';
    if (handover.status === 'DRAFT') {
      ackExplain = 'Acknowledgement disabled: Package must be PUBLISHED by PI_LEAD before recipient sign-off.';
    } else if (handover.status === 'PUBLISHED' && state.activeRole !== 'INCOMING_MEMBER') {
      ackExplain = `Acknowledgement disabled: Only INCOMING_MEMBER can formally acknowledge receipt (current role: ${state.activeRole}).`;
    } else if (handover.status === 'PUBLISHED' && !allItemsChecked) {
      ackExplain = 'Acknowledgement disabled: Check off all provenance verification items in Section 5 below before signing off.';
    }

    const ackHistoryHtml =
      acknowledgements && acknowledgements.length > 0
        ? acknowledgements
            .map(
              (a) => `
              <div class="status-box" style="margin-top:8px; background:var(--status-ok-bg); border-color:var(--status-ok-border);">
                <strong>Acknowledged by ${escapeHtml(a.recipient_name)} (Handover v${escapeHtml(String(a.handover_version || handover.version_number || 1))})</strong> on ${escapeHtml(formatDate(a.created_at))}
                <div class="text-xs" style="margin-top:4px;">Notes: "${escapeHtml(a.notes)}" (${a.checked_item_count} items verified)</div>
                <div class="text-muted text-xs" style="margin-top:2px;">
                  <strong>Receipt Semantic:</strong> ${escapeHtml(a.acknowledgement_disclaimer || 'Acknowledgement means receipt, not agreement or proof of understanding.')}
                </div>
              </div>
            `
            )
            .join('')
        : '';

    const versionHistoryHtml =
      Array.isArray(versions) && versions.length > 0
        ? `<div class="border-top" style="margin-top:10px; padding-top:8px;">
             <div class="text-xs" style="font-weight:700; margin-bottom:4px;">Preserved Handover Versions (${versions.length}):</div>
             <div class="text-xs text-muted">
               ${versions
                 .map(
                   (v) =>
                     `<span class="mono-tag" style="margin-right:6px;">v${escapeHtml(String(v.version_number))}: ${escapeHtml(v.lifecycle_event)} (${escapeHtml(v.actor_name || v.actor_user_id || 'System')})</span>`
                 )
                 .join(' ')}
             </div>
           </div>`
        : '';

    $('handover-lifecycle-box').innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <div>
          <strong>${escapeHtml(handover.title)}</strong>
          <span class="mono-tag" style="margin-left:6px;">v${escapeHtml(String(handover.version_number || 1))}</span>
        </div>
        ${handoverStatusBadge(handover.status)}
      </div>
      <div class="text-muted text-xs" style="margin-bottom:8px;">
        Created by: ${escapeHtml(handover.created_by_name || handover.created_by_user_id)} ·
        Designated Recipient: ${escapeHtml(handover.recipient_name || handover.recipient_user_id || 'Any INCOMING_MEMBER')} ·
        Published by: ${escapeHtml(handover.published_by_name || handover.published_by_user_id || 'Not yet published')} ·
        Restricted Sources Excluded: <strong>${handover.restricted_sources_excluded_count}</strong>
      </div>
      <div class="status-box" style="margin-bottom:10px; white-space:pre-wrap;">${escapeHtml(handover.executive_summary)}</div>

      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
        <button id="btn-publish-handover" type="button" class="btn btn-primary btn-sm" ${!canPublish ? 'disabled' : ''}>
          Publish Handover Package v${escapeHtml(String(handover.version_number || 1))} (PI_LEAD)
        </button>
        ${publishExplain ? `<span class="text-muted text-xs">${escapeHtml(publishExplain)}</span>` : ''}
      </div>

      ${
        handover.status !== 'ACKNOWLEDGED'
          ? `
        <form id="form-acknowledge-handover" class="border-top" style="padding-top:10px;">
          <div class="form-title">Recipient Onboarding Sign-Off (INCOMING_MEMBER)</div>
          <div class="text-muted text-xs" style="margin-bottom:6px;">
            <strong>Important:</strong> Acknowledgement means receipt of Handover v${escapeHtml(String(handover.version_number || 1))}, not agreement or proof of understanding.
          </div>
          ${ackExplain ? `<div class="permission-note" style="margin:6px 0;">${escapeHtml(ackExplain)}</div>` : ''}
          <div class="form-row" style="margin-bottom:0;">
            <div class="form-field" style="margin-bottom:0;">
              <input id="ack-notes-input" type="text" placeholder="Enter receipt acknowledgement notes..." ${!canAcknowledge ? 'disabled' : ''} required />
            </div>
            <div class="form-field form-field-btn" style="margin-bottom:0;">
              <button type="submit" class="btn btn-primary btn-sm" ${!canAcknowledge ? 'disabled' : ''}>
                Acknowledge Handover Receipt (v${escapeHtml(String(handover.version_number || 1))})
              </button>
            </div>
          </div>
        </form>
      `
          : ''
      }
      ${ackHistoryHtml}
      ${versionHistoryHtml}
    `;

    const pubBtn = $('btn-publish-handover');
    if (pubBtn) {
      pubBtn.addEventListener('click', async () => {
        try {
          await apiCall('POST', `/api/projects/${state.activeProjectId}/handovers/${handover.id}/publish`, {});
          showAlert(`Handover package '${handover.title}' published by PI_LEAD.`, 'success');
          await refreshWorkspace();
        } catch (err) {
          showAlert(err.message, 'error');
        }
      });
    }

    const ackForm = $('form-acknowledge-handover');
    if (ackForm) {
      ackForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const notes = $('ack-notes-input').value;
          await apiCall('POST', `/api/projects/${state.activeProjectId}/handovers/${handover.id}/acknowledge`, {
            acknowledgement_notes: notes
          });
          showAlert(`Handover package '${handover.title}' formally ACKNOWLEDGED by incoming researcher.`, 'success');
          await refreshWorkspace();
        } catch (err) {
          showAlert(err.message, 'error');
        }
      });
    }

    // Group items into the 4 structured handover categories
    const secStatus = [];
    const secDecisions = [];
    const secOpen = [];
    const secBlockers = [];

    for (const item of items) {
      const r = item.record || {};
      const rType = r.record_type || 'RESULT';
      if (['OBJECTIVE', 'RESULT', 'CLAIM', 'DATASET_FINDING'].includes(rType)) {
        secStatus.push(item);
      } else if (['DECISION', 'EXPERIMENT', 'PROTOCOL', 'METHOD', 'CONTACT'].includes(rType)) {
        secDecisions.push(item);
      } else if (['TASK', 'QUESTION', 'OPEN_QUESTION'].includes(rType)) {
        secOpen.push(item);
      } else {
        secBlockers.push(item);
      }
    }

    $('hnd-count-status').textContent = String(secStatus.length);
    $('hnd-count-decisions').textContent = String(secDecisions.length);
    $('hnd-count-open').textContent = String(secOpen.length);
    $('hnd-count-blockers').textContent = String(secBlockers.length);

    function renderHandoverSectionList(arr, containerId) {
      const el = $(containerId);
      if (arr.length === 0) {
        el.innerHTML = '<div class="empty-state">No approved items in this section.</div>';
        return;
      }
      el.innerHTML = arr
        .map((it) => {
          const r = it.record || {};
          const cites = (r.evidence_links || []).map((l) => `${l.source_title} (${l.locator_label})`).join('; ');
          const ownerLabel = r.stated_owner || 'UNKNOWN (Not stated in source)';
          const deadlineLabel = r.due_date || 'UNKNOWN (No deadline stated in source)';
          const rationaleLabel = r.rationale || 'UNKNOWN (No explicit rationale stated in source)';
          return `
            <div class="handover-card">
              <div style="display:flex; justify-content:space-between; gap:8px; margin-bottom:4px;">
                <span class="mono-tag">${escapeHtml(r.record_type)} (v${escapeHtml(String(it.record_version || r.current_version || 1))})</span>
                <div>
                  ${evidenceBadge(it.evidence_status_snapshot)}
                  ${approvalBadge(it.approval_status_snapshot)}
                </div>
              </div>
              <strong>${escapeHtml(r.title)}</strong>
              <p style="margin:4px 0; font-size:12.5px;">${escapeHtml(r.statement)}</p>
              <div class="text-muted text-xs">
                <strong>Stated Owner:</strong> <code>${escapeHtml(ownerLabel)}</code> ·
                <strong>Deadline:</strong> <code>${escapeHtml(deadlineLabel)}</code> ·
                <strong>Rationale:</strong> ${escapeHtml(rationaleLabel)} ·
                <strong>Evidence:</strong> ${escapeHtml(cites || 'None')}
              </div>
            </div>
          `;
        })
        .join('');
    }

    renderHandoverSectionList(secStatus, 'hnd-sec-status');
    renderHandoverSectionList(secDecisions, 'hnd-sec-decisions');
    renderHandoverSectionList(secOpen, 'hnd-sec-open');
    renderHandoverSectionList(secBlockers, 'hnd-sec-blockers');

    // Checklist table
    const checkedCount = items.filter((i) => Number(i.recipient_checked) === 1).length;
    $('hnd-checklist-progress').textContent = `${checkedCount} / ${items.length} checked`;

    const chkTbody = $('hnd-checklist-tbody');
    chkTbody.innerHTML = items
      .map((it) => {
        const r = it.record || {};
        const spansList = (r.evidence_links || [])
          .map((l) => `<div><span class="mono-tag">${escapeHtml(l.locator_label)}</span> "${escapeHtml(l.verbatim_quote)}"</div>`)
          .join('');
        return `
          <tr>
            <td>
              <input
                type="checkbox"
                class="hnd-item-checkbox"
                data-item-id="${escapeHtml(it.id)}"
                ${Number(it.recipient_checked) === 1 ? 'checked' : ''}
                ${!canCheckItems ? 'disabled title="Requires INCOMING_MEMBER or PI_LEAD"' : ''}
              />
            </td>
            <td>
              <span class="mono-tag">${escapeHtml(r.record_type)}</span>
              <strong>${escapeHtml(r.title)}</strong>
              <div class="text-muted text-xs">Pinned v${it.record_version}</div>
            </td>
            <td>${escapeHtml(r.created_by_name)}</td>
            <td>${evidenceBadge(it.evidence_status_snapshot)}</td>
            <td>${approvalBadge(it.approval_status_snapshot)}</td>
            <td class="text-xs">${spansList || '—'}</td>
          </tr>
        `;
      })
      .join('');

    chkTbody.querySelectorAll('.hnd-item-checkbox').forEach((cb) => {
      cb.addEventListener('change', async () => {
        try {
          const itemId = cb.getAttribute('data-item-id');
          await apiCall(
            'POST',
            `/api/projects/${state.activeProjectId}/handovers/${handover.id}/items/${itemId}/check`,
            { recipient_checked: cb.checked }
          );
          await renderHandoverScreen();
        } catch (err) {
          cb.checked = !cb.checked;
          showAlert(err.message, 'error');
        }
      });
    });
  }

  // SCREEN 7: ACTIVITY / AUDIT
  async function renderAuditScreen() {
    const canViewFullAudit = ['PI_LEAD', 'AUDITOR'].includes(state.activeRole);
    const banner = $('audit-permission-banner');
    const tbody = $('audit-tbody');

    if (canViewFullAudit) {
      banner.classList.add('hidden');
      const data = await apiCall('GET', `/api/projects/${state.activeProjectId}/audit-events`);
      state.auditEvents = data.audit_events || [];
      $('audit-events-count').textContent = `${state.auditEvents.length} full security & workflow events`;

      tbody.innerHTML = state.auditEvents
        .map(
          (ev) => `
          <tr>
            <td class="text-xs">${escapeHtml(formatDate(ev.created_at))}</td>
            <td>
              <span class="badge ${ev.event_type === 'ACCESS_DENIED' ? 'badge-danger' : 'badge-info'}">
                ${escapeHtml(ev.event_type)}
              </span>
            </td>
            <td>${escapeHtml(ev.actor_name || ev.actor_user_id || 'Unauthenticated')}</td>
            <td><span class="mono-tag">${escapeHtml(ev.actor_role || 'NONE')}</span></td>
            <td>${escapeHtml(ev.target_entity_type)} (${escapeHtml(ev.target_entity_id || '—')})</td>
            <td class="text-xs"><code style="word-break:break-all;">${escapeHtml(JSON.stringify(ev.metadata || {}))}</code></td>
          </tr>
        `
        )
        .join('');
    } else {
      banner.textContent = `Full security & access-denial audit log is restricted to PI_LEAD and AUDITOR (current role: '${state.activeRole}'). Showing general project workflow activity below.`;
      banner.classList.remove('hidden');

      const recent = (state.projectDetail && state.projectDetail.recent_activity) || [];
      $('audit-events-count').textContent = `${recent.length} workflow activity events`;
      tbody.innerHTML = recent
        .map(
          (ev) => `
          <tr>
            <td class="text-xs">${escapeHtml(formatDate(ev.created_at))}</td>
            <td><span class="badge badge-info">${escapeHtml(ev.event_type)}</span></td>
            <td>${escapeHtml(ev.actor_name || 'System')}</td>
            <td><span class="mono-tag">${escapeHtml(ev.actor_role || '—')}</span></td>
            <td>${escapeHtml(ev.target_entity_type)} (${escapeHtml(ev.target_entity_id || '—')})</td>
            <td class="text-muted text-xs">Detailed security metadata requires PI_LEAD or AUDITOR</td>
          </tr>
        `
        )
        .join('');
    }
  }

  // Wire up interactive DOM event listeners
  function bindEvents() {
    $('global-alert-close').addEventListener('click', hideAlert);

    // Navigation rail buttons
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    // Workflow strip shortcut buttons
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-goto'));
      });
    });

    // Persona switcher
    $('persona-select').addEventListener('change', async (e) => {
      state.activeToken = e.target.value;
      localStorage.setItem('baton_active_token', state.activeToken);
      hideAlert();
      await refreshWorkspace();
    });

    // Project switcher
    $('project-select').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      state.activeProjectId = e.target.value;
      localStorage.setItem('baton_active_project', state.activeProjectId);
      hideAlert();
      await refreshWorkspace();
    });

    // Refresh button
    $('btn-refresh-workspace').addEventListener('click', async () => {
      hideAlert();
      await refreshWorkspace();
      showAlert('Workspace refreshed from backend API.', 'info');
    });

    // Explicit Demo Seed Reset button
    $('btn-seed-demo').addEventListener('click', async () => {
      try {
        await apiCall('POST', '/api/demo/reset', {});
        state.activeProjectId = 'prj_solidstate_01';
        localStorage.setItem('baton_active_project', state.activeProjectId);
        await refreshWorkspace();
        showAlert('Synthetic demo seed reset completed.', 'success');
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });

    // Assign member role form
    $('form-add-member').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const userId = $('member-user-select').value;
        const roleId = $('member-role-select').value;
        await apiCall('POST', `/api/projects/${state.activeProjectId}/memberships`, {
          user_id: userId,
          role_id: roleId
        });
        showAlert(`Assigned role '${roleId}' to user '${userId}'.`, 'success');
        await refreshWorkspace();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });

    // Create new project form
    $('form-create-project').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const name = $('new-project-name').value;
        const description = $('new-project-desc').value;
        const res = await apiCall('POST', '/api/projects', { name, description });
        $('new-project-name').value = '';
        $('new-project-desc').value = '';
        state.activeProjectId = res.project.id;
        localStorage.setItem('baton_active_project', state.activeProjectId);
        showAlert(`Project '${res.project.name}' created and persisted.`, 'success');
        await refreshWorkspace();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });

    // Sample upload templates
    $('btn-fill-sample-note').addEventListener('click', () => {
      $('src-title').value = 'Lab Note: Critical Current Density & Stack Pressure Log';
      $('src-format').value = 'LAB_NOTE';
      $('src-filename').value = 'stack_pressure_calibration_nov.md';
      $('src-visibility').value = 'PROJECT_SHARED';
      $('src-exclude-ai').checked = false;
      $('src-content').value =
        '# Fixture Torque-to-Pressure Calibration\nVerified 5.0 MPa stack pressure at 1.4 N-m torque using inline piezo load cell.\n# Symmetric Cell Cycling Result\nCritical current density reached 1.15 mA/cm2 at 25C without voltage short-circuit.';
    });

    $('btn-fill-sample-csv').addEventListener('click', () => {
      $('src-title').value = 'Critical Current Density CSV Log (Cells C1-C3)';
      $('src-format').value = 'CSV_DATASET';
      $('src-filename').value = 'ccd_cycling_nov.csv';
      $('src-visibility').value = 'PROJECT_SHARED';
      $('src-exclude-ai').checked = false;
      $('src-content').value =
        'cell_id,stack_pressure_MPa,ccd_mA_cm2,cycles_completed\nCELL-01,2.5,0.62,25\nCELL-02,5.0,1.15,80\nCELL-03,5.0,1.12,78';
    });

    // File input reader helper
    $('src-file-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      $('src-filename').value = file.name;
      if (!$('src-title').value) {
        $('src-title').value = file.name.replace(/\.[^.]+$/, '');
      }
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'csv') $('src-format').value = 'CSV_DATASET';
      else if (ext === 'json') $('src-format').value = 'JSON_RECORDS';
      else if (ext === 'md' || ext === 'txt') $('src-format').value = 'LAB_NOTE';
      else if (ext === 'pdf') $('src-format').value = 'PDF_DOCUMENT';

      const reader = new FileReader();
      reader.onload = () => {
        $('src-content').value = String(reader.result || '');
      };
      reader.readAsText(file);
    });

    // Source upload submission & retry handler
    async function submitSourceUpload(payload) {
      const statusBox = $('upload-status-box');
      const statusLabel = $('upload-status-label');
      const statusDetail = $('upload-status-detail');
      const progressBar = $('upload-progress-bar');
      const retryWrap = $('upload-retry-wrap');

      statusBox.classList.remove('hidden');
      retryWrap.classList.add('hidden');
      statusLabel.textContent = 'Uploading & Indexing Spans...';
      statusDetail.textContent = 'Validating format & provenance locators';
      progressBar.style.width = '55%';

      try {
        const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/sources`, payload);
        progressBar.style.width = '100%';
        statusLabel.textContent = `Processing State: ${res.source.processing_status}`;
        statusDetail.textContent = `Indexed ${res.spans.length} provenance span(s)`;
        state.lastFailedUploadPayload = null;

        $('src-title').value = '';
        $('src-filename').value = '';
        $('src-content').value = '';

        showAlert(`Uploaded '${res.source.title}' and indexed ${res.spans.length} provenance spans.`, 'success');
        await refreshWorkspace();
        await inspectSourceSpans(res.source.id);
      } catch (err) {
        progressBar.style.width = '100%';
        statusLabel.textContent = 'Processing State: FAILED';
        statusDetail.textContent = err.message;
        state.lastFailedUploadPayload = payload;
        retryWrap.classList.remove('hidden');
        showAlert(err.message, 'error');
      }
    }

    $('form-upload-source').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        title: $('src-title').value,
        file_name: $('src-filename').value,
        source_type: $('src-format').value,
        visibility_level: $('src-visibility').value,
        exclude_from_ai: $('src-exclude-ai').checked,
        raw_content: $('src-content').value
      };
      await submitSourceUpload(payload);
    });

    $('btn-retry-upload').addEventListener('click', async () => {
      if (!state.lastFailedUploadPayload) return;
      await submitSourceUpload(state.lastFailedUploadPayload);
    });

    // Stage 2 Reconstruction form
    $('form-reconstruct').addEventListener('submit', async (e) => {
      e.preventDefault();
      const checkedIds = Array.from(document.querySelectorAll('input[name="recon-source"]:checked')).map(
        (cb) => cb.value
      );
      const focus = $('reconstruct-focus').value;
      try {
        const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/reconstruct`, {
          source_ids: checkedIds,
          extraction_focus: focus
        });
        const f = res.filter_summary;
        const box = $('reconstruct-filter-result');
        box.classList.remove('hidden');
        box.innerHTML = `
          <strong>Pre-AI Filter &amp; Reconstruction Summary:</strong>
          Requested Sources: <code>${f.requested_sources_count}</code> ·
          Permitted Shared Sources: <code>${f.permitted_sources_count}</code> ·
          Restricted/AI-Excluded Sources Filtered Out: <code>${f.restricted_or_excluded_sources_filtered}</code> ·
          Permitted Spans Processed: <code>${f.permitted_spans_sent_to_ai}</code> ·
          New Candidate Records Created: <code>${res.created_records.length}</code>
        `;
        showAlert(
          `Reconstruction complete: ${res.created_records.length} candidate record(s) created (${f.restricted_or_excluded_sources_filtered} restricted source(s) filtered out before extraction).`,
          'success'
        );
        await refreshWorkspace();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });

    // Toggle new manual record card
    $('btn-toggle-new-record').addEventListener('click', () => {
      $('card-create-record').classList.toggle('hidden');
    });
    $('btn-close-new-record').addEventListener('click', () => {
      $('card-create-record').classList.add('hidden');
    });

    $('new-rec-span').addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt && opt.dataset.sampleQuote) {
        $('new-rec-quote').value = opt.dataset.sampleQuote;
      }
    });

    $('form-create-record').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const payload = {
          record_type: $('new-rec-type').value,
          evidence_status: $('new-rec-evidence-status').value,
          title: $('new-rec-title').value,
          statement: $('new-rec-statement').value,
          rationale: $('new-rec-rationale').value,
          evidence_links: [
            {
              span_id: $('new-rec-span').value,
              relationship_type: 'SUPPORTS',
              verbatim_quote: $('new-rec-quote').value
            }
          ]
        };
        const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/records`, payload);
        $('new-rec-title').value = '';
        $('new-rec-statement').value = '';
        $('new-rec-rationale').value = '';
        $('card-create-record').classList.add('hidden');
        state.selectedRecordId = res.record.id;
        showAlert(`Created continuity record '${res.record.title}' with verified provenance span.`, 'success');
        await refreshWorkspace();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });

    // Continuity Map filters & accessible view switcher
    ['map-filter-type', 'map-filter-status', 'map-filter-owner', 'map-filter-source'].forEach((id) => {
      $(id).addEventListener('change', () => {
        renderContinuityMapScreen();
      });
    });

    $('btn-map-view-nodes').addEventListener('click', () => {
      $('continuity-map-nodes-wrap').classList.remove('hidden');
      $('continuity-map-table-card').classList.add('hidden');
      $('btn-map-view-nodes').className = 'btn btn-primary btn-xs';
      $('btn-map-view-table').className = 'btn btn-outline btn-xs';
    });

    $('btn-map-view-table').addEventListener('click', () => {
      $('continuity-map-nodes-wrap').classList.add('hidden');
      $('continuity-map-table-card').classList.remove('hidden');
      $('btn-map-view-table').className = 'btn btn-primary btn-xs';
      $('btn-map-view-nodes').className = 'btn btn-outline btn-xs';
    });

    // Records filters
    ['filter-rec-type', 'filter-evidence-status', 'filter-approval-status', 'filter-search'].forEach((id) => {
      $(id).addEventListener('input', () => {
        renderRecordsScreen();
      });
      $(id).addEventListener('change', () => {
        renderRecordsScreen();
      });
    });

    // Handover creation & package selection
    $('form-create-handover').addEventListener('submit', async (e) => {
      e.preventDefault();
      const recordIds = Array.from(document.querySelectorAll('input[name="hnd-record"]:checked')).map(
        (cb) => cb.value
      );
      try {
        const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/handovers`, {
          title: $('hnd-title').value,
          recipient_user_id: $('hnd-recipient').value,
          record_ids: recordIds
        });
        $('hnd-title').value = '';
        state.selectedHandoverId = res.handover.id;
        showAlert(`Draft handover package '${res.handover.title}' created with ${res.items.length} approved items.`, 'success');
        await refreshWorkspace();
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });

    $('handover-package-select').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      state.selectedHandoverId = e.target.value;
      await renderHandoverScreen();
    });

    // Stage 09: Optional Camera-Assisted / Non-Camera Step-Up Verification
    let activeStepUpMediaStream = null;
    function stopLocalStepUpCameraStream() {
      if (activeStepUpMediaStream && typeof activeStepUpMediaStream.getTracks === 'function') {
        activeStepUpMediaStream.getTracks().forEach((t) => {
          if (typeof t.stop === 'function') t.stop();
        });
      }
      activeStepUpMediaStream = null;
    }

    $('btn-step-up-verify').addEventListener('click', async () => {
      const requestedAction = $('step-up-action-select').value;
      const selectedRoute = $('step-up-route-select').value;
      const mfaCode = $('step-up-mfa-input').value;
      const resultBox = $('step-up-result-box');
      const badge = $('step-up-status-badge');

      let cameraStreamStatus = 'NOT_REQUESTED';

      if (selectedRoute === 'CAMERA_ASSISTED_MFA') {
        if (
          typeof navigator === 'undefined' ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== 'function'
        ) {
          cameraStreamStatus = 'UNSUPPORTED_BROWSER';
        } else {
          try {
            activeStepUpMediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            cameraStreamStatus = 'STREAM_AVAILABLE';
            // Immediately stop stream after checking local availability — never record or upload media
            stopLocalStepUpCameraStream();
          } catch (camErr) {
            const errName = camErr && camErr.name ? camErr.name : '';
            if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
              cameraStreamStatus = 'PERMISSION_DENIED';
            } else if (errName === 'NotFoundError' || errName === 'DevicesNotFoundError') {
              cameraStreamStatus = 'NO_DEVICE';
            } else {
              cameraStreamStatus = 'DEVICE_ERROR';
            }
          }
        }
      }

      try {
        const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/step-up/verify`, {
          requested_action: requestedAction,
          verification_route: selectedRoute,
          camera_stream_status: cameraStreamStatus,
          mfa_code: mfaCode,
          allow_non_camera_fallback: true
        });

        state.activeStepUpToken = res.step_up_token || null;
        resultBox.classList.remove('hidden');
        resultBox.innerHTML = `
          <strong>Step-Up Outcome:</strong> <code>${escapeHtml(res.outcome)}</code> ·
          Route: <code>${escapeHtml(res.verification_route)}</code> ·
          Camera Status: <code>${escapeHtml(res.camera_stream_status)}</code> ·
          Media Stored: <code>${res.media_stored}</code> (Zero images/video stored)<br/>
          <span class="text-xs">${escapeHtml(res.epistemic_disclosure)}</span>
        `;
        badge.className = res.verified ? 'badge badge-ok' : 'badge badge-warn';
        badge.textContent = res.verified ? `Step-Up Verified (${res.verification_route})` : res.outcome;
        showAlert(`Step-up verification result: ${res.outcome} (${res.verification_route})`, 'success');
      } catch (err) {
        stopLocalStepUpCameraStream();
        resultBox.classList.remove('hidden');
        resultBox.innerHTML = `<strong>Step-Up Failed:</strong> ${escapeHtml(err.message)}`;
        badge.className = 'badge badge-danger';
        badge.textContent = 'Step-Up Failed';
        showAlert(err.message, 'error');
      }
    });

    $('btn-step-up-cancel').addEventListener('click', async () => {
      stopLocalStepUpCameraStream();
      const requestedAction = $('step-up-action-select').value;
      const selectedRoute = $('step-up-route-select').value;
      const resultBox = $('step-up-result-box');
      const badge = $('step-up-status-badge');

      try {
        const res = await apiCall('POST', `/api/projects/${state.activeProjectId}/step-up/verify`, {
          requested_action: requestedAction,
          verification_route: selectedRoute,
          camera_stream_status: 'CANCELLED',
          cancelled: true
        });
        state.activeStepUpToken = null;
        resultBox.classList.remove('hidden');
        resultBox.innerHTML = `
          <strong>Cancelled:</strong> ${escapeHtml(res.message)}
          Alternative Route: <code>${escapeHtml(res.alternative_route)}</code>
        `;
        badge.className = 'badge badge-neutral';
        badge.textContent = 'Cancelled · Non-Camera Available';
      } catch (err) {
        showAlert(err.message, 'error');
      }
    });
  }

  // Initialize workspace on DOM ready
  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    switchTab(state.activeTab);
    await refreshWorkspace();
  });
})();
