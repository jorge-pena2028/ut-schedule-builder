/**
 * Background service worker for UT Schedule Builder.
 *
 * UT Direct has multiple search forms. The one we need is "crs_nbrSearch":
 *   action: /apps/registrar/course_schedule/20269/results/
 *   params: ccyys=20269, search_type_main=COURSE, fos_cn=PSY, course_number=301
 *
 * Fallback: keyword search at /kws_results/
 *   params: ccyys=20269, search_type=ALL, keywords=PSY+301
 */

const RESULTS_URL = 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20269/results/';
const KWS_RESULTS_URL = 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20269/kws_results/';

async function fetchCourse(coursePrefix, courseNumber) {
  if (!coursePrefix || !courseNumber) return { error: 'Missing prefix or number', sections: [], rawHtml: '', fetchUrl: '' };
  const courseName = `${coursePrefix} ${courseNumber}`.toUpperCase().replace(/\s+/g, ' ').trim();

  // Strategy 1: Course number search (crs_nbrSearch form)
  const params = new URLSearchParams();
  params.set('ccyys', '20269');
  params.set('search_type_main', 'COURSE');
  params.set('fos_cn', coursePrefix.toUpperCase());
  params.set('course_number', courseNumber.toUpperCase());

  const url = `${RESULTS_URL}?${params.toString()}`;

  try {
    let response = await fetch(url, { credentials: 'include', redirect: 'follow' });

    if (response.url.includes('login.utexas.edu') || response.url.includes('enterprise.login')) {
      return { error: 'NOT_LOGGED_IN', sections: [], rawHtml: '', fetchUrl: url };
    }

    let html = await response.text();
    let usedUrl = url;

    // Check for error messages — if so, try keyword search as fallback
    if (html.includes('class="error"') || html.includes('No ')) {
      const kwsParams = new URLSearchParams();
      kwsParams.set('ccyys', '20269');
      kwsParams.set('search_type', 'ALL');
      kwsParams.set('keywords', `${coursePrefix} ${courseNumber}`.toUpperCase());

      const kwsUrl = `${KWS_RESULTS_URL}?${kwsParams.toString()}`;
      response = await fetch(kwsUrl, { credentials: 'include', redirect: 'follow' });

      if (response.url.includes('login.utexas.edu')) {
        return { error: 'NOT_LOGGED_IN', sections: [], rawHtml: '', fetchUrl: kwsUrl };
      }

      html = await response.text();
      usedUrl = kwsUrl;
    }

    const sections = parseScheduleHTML(html, coursePrefix, courseNumber);

    return {
      error: null,
      sections,
      fetchUrl: usedUrl,
    };
  } catch (err) {
    return { error: err.message, sections: [], fetchUrl: url };
  }
}

/**
 * Parse the HTML response from UT Direct course schedule.
 */
function parseScheduleHTML(html, coursePrefix, courseNumber) {
  const sections = [];
  const courseName = `${coursePrefix} ${courseNumber}`.toUpperCase().replace(/\s+/g, ' ').trim();

  // Convert HTML to text preserving table structure
  const textVersion = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<select[\s\S]*?<\/select>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n---ROW---\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<\/th>/gi, '\t')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h\d>/gi, '\n')
    .replace(/<\/a>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#58;/g, ':')
    .replace(/&#x25B6;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ ]+/g, ' ');

  // Split by row markers
  const rows = textVersion.split('---ROW---');

  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed) continue;

    // Must have a unique number (5 digits)
    const uniqueMatch = trimmed.match(/\b(\d{5})\b/);
    if (!uniqueMatch) continue;
    const uniqueNum = uniqueMatch[1];

    // Must have a time pattern
    const timeMatch = trimmed.match(/(\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.))\s*[-–—]\s*(\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.))/i)
      || trimmed.match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})\s*(am|pm)/i);

    if (!timeMatch) continue;

    let startStr = timeMatch[1];
    let endStr = timeMatch[2];

    if (timeMatch[3] && !startStr.match(/[ap]m/i)) {
      endStr = endStr.trim() + ' ' + timeMatch[3];
      const startHour = parseInt(startStr.split(':')[0]);
      if (timeMatch[3].toLowerCase().includes('p') && startHour < 12) {
        const endHour = parseInt(endStr.split(':')[0]);
        startStr = startStr.trim() + (startHour <= endHour ? ' pm' : ' am');
      } else {
        startStr = startStr.trim() + ' ' + timeMatch[3];
      }
    }

    const startMin = parseTime(startStr);
    const endMin = parseTime(endStr);
    if (startMin < 0 || endMin <= startMin) continue;

    // Days
    const dayMatch = trimmed.match(/\b((?:M|T(?!H)|TH|W|F)+)\b/i);
    if (!dayMatch) continue;
    const days = parseDays(dayMatch[1]);
    if (days.length === 0) continue;

    // Room
    const roomMatch = trimmed.match(/\b([A-Z]{2,5})\s+(\d+\.?\d*[A-Za-z]?)\b/);
    const location = roomMatch ? `${roomMatch[1]} ${roomMatch[2]}` : '';

    // Instructor from tab-delimited fields
    const fields = trimmed.split('\t').map(f => f.trim()).filter(f => f);
    let instructor = '';
    for (const field of fields) {
      if (field.match(/^[A-Za-z'-]+,\s*[A-Za-z'-]/) && field.length < 40) {
        instructor = field.trim();
        break;
      }
    }
    if (!instructor) {
      for (const field of fields) {
        if (field.length > 3 && field.length < 35 &&
            /^[A-Za-z]/.test(field) &&
            !/^\d/.test(field) &&
            !/^(open|closed|waitlisted|canceled|reserved)/i.test(field) &&
            !/^(M|T|W|Th|F|MW|MWF|TTH)/i.test(field) &&
            !/^\d{1,2}:\d{2}/.test(field) &&
            !/^[A-Z]{2,5}\s+\d/.test(field) &&
            !/Internet|Web-Based|Face-to-Face|Hybrid/i.test(field) &&
            !field.includes('Search') && !field.includes('Register') &&
            !field.includes('add') && !field.includes('Quick')) {
          instructor = field.trim();
          break;
        }
      }
    }

    const timeBlocks = days.map(day => ({ day, start: startMin, end: endMin }));

    sections.push({
      id: crypto.randomUUID(),
      courseName,
      sectionCode: uniqueNum,
      professor: instructor,
      location,
      timeBlocks,
    });
  }

  return sections;
}

function parseTime(str) {
  const cleaned = str.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  const match = cleaned.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (!match) return -1;
  let hours = parseInt(match[1]);
  const mins = parseInt(match[2]);
  const period = match[3];
  if (period === 'pm' && hours !== 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  return hours * 60 + mins;
}

function parseDays(dayStr) {
  const days = [];
  const upper = dayStr.toUpperCase();
  let i = 0;
  while (i < upper.length) {
    if (i + 1 < upper.length && upper[i] === 'T' && upper[i + 1] === 'H') {
      days.push('Th');
      i += 2;
    } else {
      const ch = upper[i];
      if (ch === 'M') days.push('M');
      else if (ch === 'T') days.push('T');
      else if (ch === 'W') days.push('W');
      else if (ch === 'F') days.push('F');
      i++;
    }
  }
  return days;
}

const SEARCH_PAGE = 'https://utdirect.utexas.edu/apps/registrar/course_schedule/20269/';

/**
 * Fetch the list of departments (fields of study) from the main search page.
 */
async function getDepartments() {
  try {
    const response = await fetch(SEARCH_PAGE, { credentials: 'include', redirect: 'follow' });
    if (response.url.includes('login.utexas.edu')) {
      return { error: 'NOT_LOGGED_IN', departments: [] };
    }
    const html = await response.text();
    if (html.includes('UT EID') && html.includes('Password') && !html.includes('fos_cn')) {
      return { error: 'NOT_LOGGED_IN', departments: [] };
    }

    // Extract departments from the fos_cn select (course number search form)
    const departments = [];
    const selectMatch = html.match(/<select[^>]*name="fos_cn"[^>]*>([\s\S]*?)<\/select>/i);
    if (selectMatch) {
      const optPattern = /<option\s+value="([^"]*)"[^>]*>([^<]*)/g;
      let m;
      while ((m = optPattern.exec(selectMatch[1])) !== null) {
        if (m[1]) {
          const label = m[2].trim().replace(/^[A-Z\s]+-\s*/, ''); // Remove "PSY - " prefix
          departments.push({ value: m[1], label });
        }
      }
    }

    return { error: null, departments };
  } catch (err) {
    return { error: err.message, departments: [] };
  }
}

/**
 * Fetch available course numbers for a given department.
 * Uses the COURSE search with just the department prefix to get a listing.
 */
/**
 * Fetch ALL course numbers for a department from the UT course catalog.
 *
 * Strategy 1: CourseLeaf FOSE API (POST request to ribbit endpoint)
 * Strategy 2: Catalog HTML page scraping
 * Strategy 3: UT Direct course schedule keyword search
 */
async function getCourseNumbers(prefix) {
  if (!prefix) return { courseNumbers: [], debug: 'No prefix provided' };

  const courseNumbers = [];
  const seen = new Set();
  const prefixUpper = String(prefix).toUpperCase().trim();
  const prefixLower = String(prefix).toLowerCase().replace(/\s+/g, '-');
  let debugInfo = '';

  // Build prefix regex that handles spaces and &nbsp;
  const prefixEsc = prefixUpper.split('').map(c =>
    c === ' ' ? '(?:\\s|&nbsp;|&#160;)+' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('');

  try {
    // === Strategy 1: CourseLeaf FOSE API (POST) ===
    // CourseLeaf uses POST requests to its ribbit endpoint for searches
    const foseUrl = 'https://catalog.utexas.edu/ribbit/index.cgi?page=fose&route=search';
    try {
      const foseResp = await fetch(foseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `other=%7B%22srcdb%22%3A%22999%22%7D&subject=${encodeURIComponent(prefixUpper)}`,
      });
      const foseText = await foseResp.text();
      debugInfo += `FOSE API: status=${foseResp.status} len=${foseText.length}\n`;

      if (foseText.length > 100) {
        // Parse FOSE response — it returns HTML fragments with course data
        extractCoursesFromHtml(foseText, prefixUpper, prefixEsc, courseNumbers, seen);
        debugInfo += `FOSE found: ${courseNumbers.length}\n`;
      }
    } catch (foseErr) {
      debugInfo += `FOSE error: ${foseErr.message}\n`;
    }

    // === Strategy 2: Catalog HTML page ===
    if (courseNumbers.length === 0) {
      const catalogUrl = `https://catalog.utexas.edu/general-information/coursesatoz/${prefixLower}/`;
      try {
        const catResp = await fetch(catalogUrl);
        const catHtml = await catResp.text();
        debugInfo += `Catalog page: status=${catResp.status} len=${catHtml.length}\n`;

        extractCoursesFromHtml(catHtml, prefixUpper, prefixEsc, courseNumbers, seen);
        debugInfo += `Catalog found: ${courseNumbers.length}\n`;
      } catch (catErr) {
        debugInfo += `Catalog error: ${catErr.message}\n`;
      }
    }

    // === Strategy 3: UT Direct keyword search ===
    if (courseNumbers.length === 0) {
      const kwsParams = new URLSearchParams();
      kwsParams.set('ccyys', '20269');
      kwsParams.set('search_type', 'ALL');
      kwsParams.set('keywords', prefixUpper);
      const kwsUrl = `${KWS_RESULTS_URL}?${kwsParams.toString()}`;

      try {
        const kwsResp = await fetch(kwsUrl, { credentials: 'include', redirect: 'follow' });
        if (!kwsResp.url.includes('login.utexas.edu')) {
          const kwsHtml = await kwsResp.text();
          debugInfo += `KWS search: len=${kwsHtml.length}\n`;
          extractCoursesFromHtml(kwsHtml, prefixUpper, prefixEsc, courseNumbers, seen);
          debugInfo += `KWS found: ${courseNumbers.length}\n`;
        }
      } catch (kwsErr) {
        debugInfo += `KWS error: ${kwsErr.message}\n`;
      }
    }

    courseNumbers.sort((a, b) => a.number.localeCompare(b.number));
    return { courseNumbers, debug: debugInfo };
  } catch (err) {
    return { courseNumbers: [], debug: debugInfo + '\nERROR: ' + err.message };
  }
}

/**
 * Extract course numbers and titles from HTML content.
 * Handles multiple formats: courseblock divs, plain text, table rows.
 */
function extractCoursesFromHtml(html, prefixUpper, prefixEsc, courseNumbers, seen) {
  // Pattern 1: courseblocktitle format
  // <strong>PSY&nbsp;301.  Introduction to Psychology.  3 Hours.</strong>
  const p1 = new RegExp(
    prefixEsc + '(?:\\s|&nbsp;|&#160;)+(\\d{3}[A-Za-z]?)\\.\\s*([^.<]{3,80}?)\\.',
    'g'
  );
  let m;
  while ((m = p1.exec(html)) !== null) {
    addCourse(m[1], m[2], courseNumbers, seen);
  }

  // Pattern 2: stripped text — "PSY 301 Title" or "PSY 301. Title."
  const stripped = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ').replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ');

  const prefixEsc2 = prefixUpper.split('').map(c =>
    c === ' ' ? '\\s+' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('');

  const p2 = new RegExp(prefixEsc2 + '\\s+(\\d{3}[A-Za-z]?)\\.?\\s+([A-Z][^.\\d]{2,70}?)(?:\\.|\\s+\\d)', 'g');
  while ((m = p2.exec(stripped)) !== null) {
    addCourse(m[1], m[2], courseNumbers, seen);
  }

  // Pattern 3: Just course numbers (no title) as last resort
  const p3 = new RegExp('\\b' + prefixEsc2 + '\\s+(\\d{3}[A-Za-z]?)\\b', 'g');
  while ((m = p3.exec(stripped)) !== null) {
    const num = m[1].toUpperCase();
    if (!seen.has(num)) {
      seen.add(num);
      courseNumbers.push({ number: num, title: '' });
    }
  }
}

function addCourse(numRaw, titleRaw, courseNumbers, seen) {
  const num = numRaw.toUpperCase();
  if (seen.has(num)) return;
  let title = (titleRaw || '').replace(/<[^>]*>/g, '').replace(/&\w+;/g, ' ').trim();
  if (/^\d{5}$/.test(title) || title.length < 2) title = '';
  seen.add(num);
  courseNumbers.push({ number: num, title: title.substring(0, 60) });
}

// Listen for messages from the popup (with sender validation)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only accept messages from our own extension
  if (sender.id !== chrome.runtime.id) return;

  if (request.type === 'GET_DEPARTMENTS') {
    getDepartments().then(sendResponse);
    return true;
  }

  if (request.type === 'GET_COURSE_NUMBERS') {
    getCourseNumbers(request.prefix).then(sendResponse);
    return true;
  }

  if (request.type === 'FETCH_COURSE') {
    fetchCourse(request.prefix, request.number).then(sendResponse);
    return true;
  }

  if (request.type === 'FETCH_MULTIPLE_COURSES') {
    (async () => {
      const results = [];
      for (const c of request.courses) {
        const result = await fetchCourse(c.prefix, c.number);
        results.push(result);
      }
      sendResponse(results);
    })();
    return true;
  }
});
