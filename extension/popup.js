/**
 * UT Schedule Builder — Chrome Extension Popup
 */

// ===== Security: HTML escaping to prevent XSS =====
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// ===== State =====
let departments = [];      // [{value: "PSY", label: "Psychology"}, ...]
let courses = [];          // [{prefix: "PSY", number: "301", label: "PSY 301"}, ...]
let allSections = [];
let settings = { bufferMinutes: 0, blockouts: [] };
let schedules = [];
let activeIndex = 0;
let debugRawHtml = [];
// Professor filters: { "PSY 301": Set(["Smith, J", "Lee, K"]) }
// Empty set or missing key = all professors allowed
let professorFilters = {};

// Currently selected department
let selectedDept = null;
let courseNumbers = [];     // Available course numbers for selected dept

const COLORS = [
  { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
  { bg: '#dcfce7', border: '#22c55e', text: '#166534' },
  { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
  { bg: '#fce7f3', border: '#ec4899', text: '#9d174d' },
  { bg: '#e0e7ff', border: '#6366f1', text: '#3730a3' },
  { bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
  { bg: '#f3e8ff', border: '#a855f7', text: '#6b21a8' },
  { bg: '#ccfbf1', border: '#14b8a6', text: '#134e4a' },
  { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
  { bg: '#ecfccb', border: '#84cc16', text: '#3f6212' },
];
const DAYS = ['M', 'T', 'W', 'Th', 'F'];
const DAY_LABELS = { M: 'Mon', T: 'Tue', W: 'Wed', Th: 'Thu', F: 'Fri' };
const CAL_START = 7, CAL_END = 22, HOUR_PX = 44;

// ===== Helpers =====
const $ = id => document.getElementById(id);
function getCourseColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}
function formatTime(m) {
  const h = Math.floor(m / 60), mn = m % 60, p = h >= 12 ? 'PM' : 'AM';
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${mn.toString().padStart(2, '0')} ${p}`;
}

// ===== Select Box (dropdown button with search) =====
function setupSelectBox(btnId, panelId, searchId, listId, labelId, getItems, onSelect) {
  const btn = $(btnId);
  const panel = $(panelId);
  const search = $(searchId);
  const list = $(listId);
  const label = $(labelId);
  let isOpen = false;

  function open() {
    isOpen = true;
    btn.classList.add('open');
    panel.classList.add('open');
    search.value = '';
    render('');
    search.focus();
  }

  function close() {
    isOpen = false;
    btn.classList.remove('open');
    panel.classList.remove('open');
  }

  function render(filter) {
    const items = getItems();
    const q = (filter || '').toLowerCase();
    const filtered = q ? items.filter(i =>
      i.value.toLowerCase().includes(q) || i.label.toLowerCase().includes(q)
    ) : items;

    list.innerHTML = filtered.map(item =>
      `<div class="select-item" data-value="${esc(item.value)}" data-label="${esc(item.label || '')}">
        <span class="code">${esc(item.value)}</span><span class="label">${esc(item.label || '')}</span>
      </div>`
    ).join('');

    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:10px;color:#999;font-size:11px;text-align:center;">No matches</div>';
    }

    list.querySelectorAll('.select-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        const val = el.dataset.value;
        const lbl = el.dataset.label;
        label.textContent = lbl ? `${val} — ${lbl}` : val;
        label.className = 'select-label selected';
        close();
        onSelect({ value: val, label: lbl });
      });
    });
  }

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    if (isOpen) close(); else open();
  });
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });

  // Close when clicking outside
  document.addEventListener('mousedown', e => {
    if (isOpen && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      close();
    }
  });

  return { close, reset: () => { label.textContent = btn === $(btnId) ? label.textContent : ''; label.className = 'select-label placeholder'; close(); } };
}

// ===== Initialize: Load departments from UT Direct =====
async function loadDepartments() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_DEPARTMENTS' });
    if (result.error === 'NOT_LOGGED_IN') {
      $('login-warning').style.display = '';
      $('loading-depts').style.display = 'none';
      return;
    }
    departments = result.departments || [];
    $('loading-depts').style.display = 'none';
    $('step-courses').style.display = '';
  } catch (err) {
    $('loading-depts').textContent = 'Error loading departments. Refresh and try again.';
    console.error(err);
  }
}

// Setup department dropdown
const deptSelect = setupSelectBox('dept-btn', 'dept-panel', 'dept-search', 'dept-list', 'dept-label',
  () => departments,
  (item) => {
    selectedDept = item.value;
    $('course-btn').disabled = false;
    $('course-label').textContent = 'Loading courses...';
    $('course-label').className = 'select-label placeholder';
    loadCourseNumbers(item.value);
  }
);

// Setup course number dropdown
const courseSelect = setupSelectBox('course-btn', 'course-panel', 'course-search', 'course-list', 'course-label',
  () => courseNumbers,
  (item) => {
    const num = item.value.replace(/[^0-9A-Za-z]/g, '');
    if (selectedDept && num) {
      addCourse(selectedDept, num);
      // Reset course dropdown for next pick
      $('course-label').textContent = 'Select Course';
      $('course-label').className = 'select-label placeholder';
    }
  }
);

async function loadCourseNumbers(deptPrefix) {
  courseNumbers = [];
  $('step-debug').style.display = 'none';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_COURSE_NUMBERS', prefix: deptPrefix });
    if (result.courseNumbers && result.courseNumbers.length > 0) {
      courseNumbers = result.courseNumbers.map(cn => ({
        value: cn.number,
        label: cn.title || '',
      }));
      $('course-label').textContent = `Select Course (${courseNumbers.length} available)`;
      $('course-label').className = 'select-label placeholder';
    } else {
      $('course-label').textContent = 'No courses found';
      $('course-label').className = 'select-label placeholder';
      $('step-debug').style.display = '';
      const debugText = `Department: ${deptPrefix}\n\n${result.debug || 'no debug info'}`;
      $('debug-html').textContent = debugText;
      $('copy-debug-btn').onclick = () => navigator.clipboard.writeText(debugText);
    }
  } catch (e) {
    $('course-label').textContent = 'Error loading';
    $('course-label').className = 'select-label placeholder';
    console.log('Could not load course numbers:', e);
  }
}

// ===== Add/Remove courses =====
function addCourse(prefix, number) {
  if (!prefix || !number) return;
  const label = `${prefix} ${number}`.toUpperCase();
  if (courses.some(c => c.prefix === prefix && c.number === number)) return;
  courses.push({ prefix, number, label });
  renderTags();
  // Don't reset dept — user might want to add another course from same dept
  // Just reset the course label
  if (courseNumbers.length > 0) {
    $('course-label').textContent = `Select Course (${courseNumbers.length} available)`;
    $('course-label').className = 'select-label placeholder';
  }
}

// add-btn removed — courses auto-add when selected from dropdown

function renderTags() {
  const container = $('course-tags');
  container.innerHTML = courses.map((c, i) =>
    `<span class="tag">${esc(c.label)}<span class="remove" data-i="${i}">×</span></span>`
  ).join('');
  container.querySelectorAll('.remove').forEach(el =>
    el.addEventListener('click', () => { courses.splice(+el.dataset.i, 1); renderTags(); })
  );
  $('fetch-btn').disabled = courses.length === 0;
  // add-btn removed
}

// ===== Fetch Sections =====
$('fetch-btn').addEventListener('click', async () => {
  if (!courses.length) return;
  $('fetch-btn').disabled = true;
  $('fetch-btn-text').textContent = 'Fetching...';
  $('fetch-spinner').style.display = '';
  $('login-warning').style.display = 'none';

  try {
    const results = await chrome.runtime.sendMessage({
      type: 'FETCH_MULTIPLE_COURSES',
      courses: courses.map(c => ({ prefix: c.prefix, number: c.number })),
    });

    if (results.some(r => r.error === 'NOT_LOGGED_IN')) {
      $('login-warning').style.display = '';
      return;
    }

    allSections = [];
    debugRawHtml = [];
    const courseResults = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      debugRawHtml.push({ course: courses[i].label, html: r.rawHtml || '', error: r.error, fetchUrl: r.fetchUrl });
      if (r.error) {
        courseResults.push({ name: courses[i].label, count: 0, error: r.error });
      } else {
        allSections.push(...r.sections);
        courseResults.push({ name: courses[i].label, count: r.sections.length });
      }
    }
    showSections(courseResults);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    $('fetch-btn').disabled = false;
    $('fetch-btn-text').textContent = 'Fetch All Sections';
    $('fetch-spinner').style.display = 'none';
  }
});

function showSections(courseResults) {
  $('step-sections').style.display = '';
  $('step-settings').style.display = '';

  const total = allSections.length;
  $('sections-summary').innerHTML = `<div class="banner banner-success" style="margin-bottom:6px;">Found <strong>${total} sections</strong> across <strong>${courseResults.filter(c=>c.count>0).length} courses</strong></div>`;

  if (total === 0) {
    $('step-debug').style.display = '';
    const txt = debugRawHtml.map(d => `===== ${d.course} =====\n${d.error||'no error'}\n${d.fetchUrl}\n\n${d.html}`).join('\n\n');
    $('debug-html').textContent = txt;
    $('copy-debug-btn').onclick = () => navigator.clipboard.writeText(txt);
  }

  const grouped = {};
  for (const s of allSections) { (grouped[s.courseName] ??= []).push(s); }

  // Reset professor filters
  professorFilters = {};

  let html = '';
  for (const [name, secs] of Object.entries(grouped)) {
    const c = getCourseColor(name);

    // Get unique professors for this course
    const profs = [...new Set(secs.map(s => s.professor || 'TBA'))].sort();

    const eName = esc(name);
    html += `<div class="section-group">`;
    html += `<div class="section-group-header" style="background:${c.bg};color:${c.text};"><span style="width:8px;height:8px;border-radius:50%;background:${c.border};display:inline-block;"></span>${eName} — ${secs.length} section${secs.length !== 1 ? 's' : ''}</div>`;

    // Professor filter chips
    if (profs.length > 1) {
      html += `<div class="prof-filter" data-course="${eName}">`;
      html += `<div class="prof-filter-label">Filter professors:</div>`;
      html += `<div class="prof-chips">`;
      for (const prof of profs) {
        html += `<label class="prof-chip active" data-prof="${esc(prof)}" data-course="${eName}">
          <input type="checkbox" checked data-prof="${esc(prof)}" data-course="${eName}" />
          <span>${esc(prof)}</span>
        </label>`;
      }
      html += `</div></div>`;
    }

    for (const s of secs) {
      const days = s.timeBlocks.map(t => t.day).join('/');
      const time = s.timeBlocks[0] ? `${formatTime(s.timeBlocks[0].start)}–${formatTime(s.timeBlocks[0].end)}` : '';
      html += `<div class="section-item" style="border-left-color:${c.border};" data-course="${eName}" data-prof="${esc(s.professor||'TBA')}"><span class="prof">${esc(s.professor||'TBA')}</span> <span class="meta">#${esc(s.sectionCode)} · ${days} ${time}${s.location?' · '+esc(s.location):''}</span></div>`;
    }
    html += '</div>';
  }
  $('sections-list').innerHTML = html;

  // Wire up professor filter checkboxes
  $('sections-list').querySelectorAll('.prof-chip input').forEach(cb => {
    cb.addEventListener('change', () => {
      const course = cb.dataset.course;
      const prof = cb.dataset.prof;
      const chip = cb.closest('.prof-chip');

      if (cb.checked) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }

      // Update professorFilters
      updateProfessorFilter(course);
    });
  });

  initBlockoutDays();
}

// ===== Settings =====
$('buffer-slider').addEventListener('input', e => {
  settings.bufferMinutes = +e.target.value;
  $('buffer-value').textContent = settings.bufferMinutes + ' min';
});

function initBlockoutDays() {
  $('blockout-days').innerHTML = DAYS.map(d => `<button class="day-btn" data-day="${d}">${DAY_LABELS[d]}</button>`).join('');
  $('blockout-days').querySelectorAll('.day-btn').forEach(b => b.addEventListener('click', () => b.classList.toggle('active')));
}

$('add-blockout-btn').addEventListener('click', () => { $('blockout-form').style.display = ''; $('add-blockout-btn').style.display = 'none'; });
$('cancel-blockout-btn').addEventListener('click', () => { $('blockout-form').style.display = 'none'; $('add-blockout-btn').style.display = ''; });
$('save-blockout-btn').addEventListener('click', () => {
  const label = $('blockout-label').value.trim();
  const days = [...$('blockout-days').querySelectorAll('.day-btn.active')].map(b => b.dataset.day);
  const [sh, sm] = $('blockout-start').value.split(':').map(Number);
  const [eh, em] = $('blockout-end').value.split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  if (!label || !days.length || end <= start) return;
  settings.blockouts.push({ id: crypto.randomUUID(), label, timeBlocks: days.map(d => ({ day: d, start, end })) });
  renderBlockouts();
  $('blockout-form').style.display = 'none'; $('add-blockout-btn').style.display = '';
  $('blockout-label').value = '';
  $('blockout-days').querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
});

function renderBlockouts() {
  $('blockout-list').innerHTML = settings.blockouts.map((b, i) => {
    const days = b.timeBlocks.map(t => t.day).join('/');
    const time = b.timeBlocks[0] ? `${formatTime(b.timeBlocks[0].start)}–${formatTime(b.timeBlocks[0].end)}` : '';
    return `<div class="blockout-item"><span><strong>${esc(b.label)}</strong> ${days} ${time}</span><span class="remove-blockout" data-i="${i}">×</span></div>`;
  }).join('');
  $('blockout-list').querySelectorAll('.remove-blockout').forEach(el =>
    el.addEventListener('click', () => { settings.blockouts.splice(+el.dataset.i, 1); renderBlockouts(); })
  );
}

// ===== Professor Filters =====
function updateProfessorFilter(course) {
  const escaped = CSS.escape(course);
  const checkboxes = $('sections-list').querySelectorAll(`.prof-chip input[data-course="${escaped}"]`);
  const checked = [...checkboxes].filter(cb => cb.checked).map(cb => cb.dataset.prof);
  const all = [...checkboxes].map(cb => cb.dataset.prof);

  // If all are checked, no filter needed (show all)
  if (checked.length === all.length) {
    delete professorFilters[course];
  } else {
    professorFilters[course] = new Set(checked);
  }

  // Visually dim excluded section items
  $('sections-list').querySelectorAll(`.section-item[data-course="${escaped}"]`).forEach(el => {
    const prof = el.dataset.prof;
    const allowed = !professorFilters[course] || professorFilters[course].has(prof);
    el.style.opacity = allowed ? '1' : '0.3';
    el.style.textDecoration = allowed ? 'none' : 'line-through';
  });
}

// ===== Generate =====
$('generate-btn').addEventListener('click', () => {
  // Group sections, applying professor filters
  const grouped = {};
  for (const s of allSections) {
    const prof = s.professor || 'TBA';
    const filter = professorFilters[s.courseName];
    // Skip if professor is filtered out
    if (filter && !filter.has(prof)) continue;
    (grouped[s.courseName] ??= []).push(s);
  }
  const groups = Object.values(grouped).filter(g => g.length).sort((a, b) => a.length - b.length);
  const blockoutBlocks = settings.blockouts.flatMap(b => b.timeBlocks);
  const buf = settings.bufferMinutes;
  schedules = [];

  function conflicts(sec, occ) {
    for (const t of sec.timeBlocks) for (const o of occ) if (t.day === o.day && t.start < o.end + buf && o.start < t.end + buf) return true;
    return false;
  }
  function bt(ci, ch, occ) {
    if (ci === groups.length) { schedules.push([...ch]); return; }
    for (const s of groups[ci]) if (!conflicts(s, occ)) { ch.push(s); bt(ci + 1, ch, occ.concat(s.timeBlocks)); ch.pop(); }
  }
  bt(0, [], blockoutBlocks);
  activeIndex = 0;
  showResults();
});

// ===== Results =====
function showResults() {
  $('step-results').style.display = '';
  if (!schedules.length) {
    $('results-summary').textContent = 'No valid schedules. Try reducing buffer or blockouts.';
    $('results-summary').className = 'banner banner-warning';
    $('schedule-nav').style.display = 'none'; $('calendar').innerHTML = ''; $('schedule-detail').innerHTML = '';
    return;
  }
  $('results-summary').textContent = `${schedules.length} valid schedule${schedules.length !== 1 ? 's' : ''} found!`;
  $('results-summary').className = 'banner banner-success';
  $('schedule-nav').style.display = '';
  renderSchedule();
}

function renderSchedule() {
  const sched = schedules[activeIndex];
  $('schedule-counter').textContent = `${activeIndex + 1} / ${schedules.length}`;

  // Detail
  $('schedule-detail').innerHTML = sched.map(s => {
    const c = getCourseColor(s.courseName);
    const days = s.timeBlocks.map(t => t.day).join('/');
    const time = s.timeBlocks[0] ? `${formatTime(s.timeBlocks[0].start)}–${formatTime(s.timeBlocks[0].end)}` : '';
    return `<div class="detail-item" style="background:${c.bg};"><span class="detail-dot" style="background:${c.border};"></span><span class="detail-name" style="color:${c.text};">${esc(s.courseName)}-${esc(s.sectionCode)}</span><span class="detail-meta">${esc(s.professor||'TBA')} · ${days} ${time}${s.location?' · '+esc(s.location):''}</span></div>`;
  }).join('');

  // Calendar
  const totalH = CAL_END - CAL_START, calH = totalH * HOUR_PX;
  let h = '<div class="cal-header"></div>';
  DAYS.forEach((d, i) => h += `<div class="cal-header" style="grid-column:${i+2};">${DAY_LABELS[d]}</div>`);
  h += `<div class="cal-time-col" style="grid-column:1;grid-row:2;height:${calH}px;position:relative;">`;
  for (let hr = CAL_START; hr < CAL_END; hr++) h += `<div class="cal-hour-label" style="top:${(hr-CAL_START)*HOUR_PX}px;">${formatTime(hr*60)}</div>`;
  h += '</div>';

  DAYS.forEach((day, di) => {
    h += `<div class="cal-day-col" style="grid-column:${di+2};grid-row:2;height:${calH}px;">`;
    for (let hr = CAL_START; hr < CAL_END; hr++) h += `<div class="cal-hour-line" style="top:${(hr-CAL_START)*HOUR_PX}px;"></div>`;
    for (const b of settings.blockouts) for (const t of b.timeBlocks) if (t.day === day) {
      const top = ((t.start - CAL_START*60)/60)*HOUR_PX, ht = ((t.end-t.start)/60)*HOUR_PX;
      h += `<div class="cal-blockout" style="top:${top}px;height:${ht}px;">${esc(b.label)}</div>`;
    }
    for (const s of sched) { const c = getCourseColor(s.courseName); for (const t of s.timeBlocks) if (t.day === day) {
      const top = ((t.start - CAL_START*60)/60)*HOUR_PX, ht = ((t.end-t.start)/60)*HOUR_PX;
      h += `<div class="cal-block" style="top:${top}px;height:${ht}px;background:${c.bg};border-left-color:${c.border};color:${c.text};"><div class="block-title">${esc(s.courseName)}</div>${ht>30?`<div class="block-meta">${esc(s.professor||'TBA')}</div>`:''}</div>`;
    }}
    h += '</div>';
  });
  $('calendar').innerHTML = h;
}

$('prev-btn').addEventListener('click', () => { if (!schedules.length) return; activeIndex = activeIndex > 0 ? activeIndex - 1 : schedules.length - 1; renderSchedule(); });
$('next-btn').addEventListener('click', () => { if (!schedules.length) return; activeIndex = activeIndex < schedules.length - 1 ? activeIndex + 1 : 0; renderSchedule(); });
document.addEventListener('keydown', e => { if (!schedules.length) return; if (e.key === 'ArrowLeft') $('prev-btn').click(); if (e.key === 'ArrowRight') $('next-btn').click(); });

// ===== Save Schedule =====
$('save-btn').addEventListener('click', () => {
  if (!schedules.length) return;
  const sched = schedules[activeIndex];
  const totalH = CAL_END - CAL_START, calH = totalH * HOUR_PX;

  // Build course detail rows
  const detailHtml = sched.map(s => {
    const c = getCourseColor(s.courseName);
    const days = s.timeBlocks.map(t => t.day).join('/');
    const time = s.timeBlocks[0] ? `${formatTime(s.timeBlocks[0].start)}–${formatTime(s.timeBlocks[0].end)}` : '';
    return `<tr>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c.border};margin-right:6px;vertical-align:middle;"></span><strong>${esc(s.courseName)}-${esc(s.sectionCode)}</strong></td>
      <td>${esc(s.professor || 'TBA')}</td>
      <td>${days} ${time}</td>
      <td>${esc(s.location || '')}</td>
    </tr>`;
  }).join('');

  // Build calendar grid
  let calHtml = '<div style="display:grid;grid-template-columns:54px repeat(5,1fr);min-width:600px;border:1px solid #d0d3d8;border-radius:8px;overflow:hidden;background:#fff;">';
  calHtml += '<div style="padding:6px;text-align:center;font-size:12px;font-weight:700;background:#f4f5f7;border-bottom:2px solid #d0d3d8;"></div>';
  DAYS.forEach((d, i) => calHtml += `<div style="padding:6px;text-align:center;font-size:12px;font-weight:700;background:#f4f5f7;border-bottom:2px solid #d0d3d8;border-left:1px solid #eee;">${DAY_LABELS[d]}</div>`);
  calHtml += `<div style="grid-column:1;grid-row:2;height:${calH}px;position:relative;border-right:1px solid #d0d3d8;background:#fafbfc;">`;
  for (let hr = CAL_START; hr < CAL_END; hr++) calHtml += `<div style="position:absolute;right:4px;top:${(hr - CAL_START) * HOUR_PX}px;font-size:10px;color:#999;transform:translateY(-50%);">${formatTime(hr * 60)}</div>`;
  calHtml += '</div>';

  DAYS.forEach((day, di) => {
    calHtml += `<div style="grid-column:${di + 2};grid-row:2;height:${calH}px;position:relative;border-left:1px solid #f0f0f0;">`;
    for (let hr = CAL_START; hr < CAL_END; hr++) calHtml += `<div style="position:absolute;left:0;right:0;top:${(hr - CAL_START) * HOUR_PX}px;border-top:1px solid #f0f0f0;"></div>`;
    for (const b of settings.blockouts) for (const t of b.timeBlocks) if (t.day === day) {
      const top = ((t.start - CAL_START * 60) / 60) * HOUR_PX, ht = ((t.end - t.start) / 60) * HOUR_PX;
      calHtml += `<div style="position:absolute;left:0;right:0;top:${top}px;height:${ht}px;background:repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(0,0,0,0.04) 3px,rgba(0,0,0,0.04) 6px);border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;font-size:10px;color:#999;">${esc(b.label)}</div>`;
    }
    for (const s of sched) {
      const c = getCourseColor(s.courseName);
      for (const t of s.timeBlocks) if (t.day === day) {
        const top = ((t.start - CAL_START * 60) / 60) * HOUR_PX, ht = ((t.end - t.start) / 60) * HOUR_PX;
        calHtml += `<div style="position:absolute;left:2px;right:2px;top:${top}px;height:${ht}px;background:${c.bg};border-left:3px solid ${c.border};border-radius:4px;padding:3px 5px;font-size:10px;color:${c.text};overflow:hidden;"><div style="font-weight:700;line-height:1.3;">${esc(s.courseName)}</div>${ht > 30 ? `<div style="opacity:0.75;line-height:1.3;">${esc(s.professor || 'TBA')}</div>` : ''}</div>`;
      }
    }
    calHtml += '</div>';
  });
  calHtml += '</div>';

  const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>My Schedule – UT Schedule Builder</title>
<style>
  body{font-family:'Segoe UI',system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#1a1a2e;background:#fff;}
  h1{font-size:22px;color:#bf5700;margin-bottom:4px;}
  .sub{font-size:13px;color:#888;margin-bottom:20px;}
  table{width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px;}
  th{text-align:left;padding:6px 10px;background:#f4f5f7;border-bottom:2px solid #d0d3d8;font-size:12px;color:#555;}
  td{padding:6px 10px;border-bottom:1px solid #eee;}
  .cal-wrap{overflow-x:auto;margin-bottom:24px;}
  .footer{text-align:center;font-size:11px;color:#aaa;margin-top:32px;}
  @media print{body{padding:0;} .no-print{display:none;}}
</style></head><body>
<h1>🤘 My UT Schedule</h1>
<p class="sub">Schedule ${activeIndex + 1} of ${schedules.length} · Generated ${new Date().toLocaleDateString()}</p>
<table><thead><tr><th>Course</th><th>Professor</th><th>Days / Time</th><th>Location</th></tr></thead><tbody>${detailHtml}</tbody></table>
<div class="cal-wrap">${calHtml}</div>
<p class="footer">Built with UT Schedule Builder</p>
<script>0</script>
</body></html>`;

  const blob = new Blob([page], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  chrome.tabs.create({ url });
});

// ===== Init =====
renderTags();
loadDepartments();
