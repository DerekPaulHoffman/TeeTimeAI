/** Brand-faithful, inert email concepts. No customer data or delivery dependencies. */
export const designs = [
  ['Original, sharpened', 'Keep the photo header and familiar time pills; separate new from already shared.', 'Closest to your current email'],
  ['New openings spotlight', 'Lead with the new-match count, then the original photo card.', 'New first'],
  ['Dashboard cards', 'Photo, venue and status arranged like My Alerts, with the same green and orange.', 'Dashboard continuity'],
  ['Search result headers', 'A compact photo thumbnail and venue details, inspired by search results.', 'Search-page continuity'],
  ['Photo-led alert', 'A taller photo header and a strong orange action underneath the times.', 'More visual impact'],
  ['Two clear groups', 'New openings in a dark-green panel; existing times on a pale-green surface.', 'Recommended'],
  ['Orange announcement', 'An orange change banner connects the email heading to the new time pills.', 'High visibility'],
  ['New, then existing', 'Two labeled time groups with their own counts and a shared photo header.', 'Explicit distinction'],
  ['Wide photo story', 'A panoramic venue header with large type and an inset availability panel.', 'Photo emphasis'],
  ['Compact familiar', 'A shorter photo band and tighter spacing, preserving all the status cues.', 'Compact option'],
  ['Availability rows', 'Full-width time rows give sessions and their NEW labels more space.', 'Session readability'],
  ['Existing-time ledger', 'Put the existing times into readable rows beneath the new openings.', 'Dense availability'],
  ['First new opening', 'Feature the first newly found time; keep every other sample time below.', 'Single-match emphasis'],
  ['Venue digest', 'Photo headers and clear state labels carry through a five-venue update.', 'Multiple venues'],
  ['Status beside the photo', 'A state rail links the photo identity, current result and next step.', 'State emphasis'],
  ['Photo with caption', 'A photo above a solid dark caption keeps venue names readable.', 'Images-off fallback'],
  ['Fairway frame', 'A dark-green email frame surrounds the familiar white course cards.', 'Stronger brand presence'],
  ['What changed', 'A compact orange/green change summary sits above the course list.', 'Change summary'],
  ['New ribbon', 'An orange ribbon on the image flags new matches before you read the times.', 'Fast recognition'],
  ['Familiar, with clarity', 'The selected photo-card style, with orange NEW pills and calm existing-time windows.', 'Selected state-card style']
].map(([name, description, bestFor], index) => ({ id: index + 1, name, description, bestFor }));

export const scenarios = [
  ['mixed', 'Mixed venue states'], ['new', 'New openings only'], ['existing', 'Existing openings only'],
  ['none', 'We’re watching · no matches yet'], ['checking', 'Getting started'],
  ['window', 'Waiting for booking to open'], ['retry', 'We’re checking on it'],
  ['support', 'We’re working on this venue'], ['review', 'This venue needs a closer look'],
  ['direct', 'Check the official site'], ['phone', 'Call for openings'],
  ['account', 'Sign in on the venue’s site'], ['captcha', 'Check directly · verification needed'],
  ['invalid', 'Choose another venue'], ['recovered', 'Back on track'],
  ['stale', 'A fresh check is needed'],
  ['gone', 'Those openings are gone · we’re still looking'],
  ['outside', 'We’re watching · other times available']
].map(([id, label]) => ({ id, label }));

// Keep self-contained: this same function runs inside the offline comparison gallery.
export function renderEmail(design, state = {}, assets = {}) {
  if (typeof assets === 'string') assets = { course: assets, sim: assets.replace('course.png', 'simulator.webp') };
  const { mode = 'course', kind = 'instant', stress = false, scenario = 'mixed' } = state;
  const sim = mode === 'sim';
  const id = design.id;
  const image = sim ? assets.sim || 'assets/simulator.webp' : assets.course || 'assets/course.png';
  const c = { ink: '#14231d', green: '#1f7a4d', dark: '#14231d', orange: '#e28a2f', paper: '#f4efe5', pale: '#eaf3ee', muted: '#5c6c64', line: '#d9e3dc' };
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const table = (html, style = '') => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border-collapse:separate;border-spacing:0;${style}">${html}</table>`;
  const row = (html, style = '') => `<tr><td style="${style}">${html}</td></tr>`;
  const p = (html, style = '') => `<p style="margin:0 0 8px;${style}">${html}</p>`;
  const tag = (html, bg = c.pale, color = c.green) => `<span style="display:inline-block;padding:5px 9px;border-radius:5px;background:${bg};color:${color};font-size:11px;line-height:16px;font-weight:800;letter-spacing:.3px">${html}</span>`;
  const button = (label, secondary = false) => `<a href="#preview-action" class="action" style="display:block;padding:13px 12px;min-height:20px;font-size:14px;line-height:20px;font-weight:800;text-align:center;border-radius:10px;background:${secondary ? '#edf4ef' : c.orange};color:${secondary ? c.green : '#251807'};text-decoration:none">${label}</a>`;
  const units = sim ? 'sessions' : 'tee times';
  const venueWord = sim ? 'venue' : 'course';
  const names = sim ? ['The Birdie Barn', 'X-Golf Lincoln', 'The Loft Golf Studio', 'Green Room Golf', 'Fairway Indoor Golf'] : ['Swansea Country Club', 'Pinebrook Golf Club', 'Lakeview Golf Course', 'Cedar Valley Golf Course', 'Meadow Hills Golf Club'];
  const shortDetail = sim ? 'Indoor simulator' : 'Outdoor golf course';
  const statuses = {
    new: ['NEW OPENINGS', sim ? 'New sessions for your next visit' : 'New tee times for your next round', 'These openings match your alert and are new since your last email.', 'new', 'View openings on the official site ↗'],
    mixed: ['OPENINGS FOR YOU', 'New openings, plus your earlier options', 'New openings are listed first. Earlier options are included only when they were still available at this check.', 'new', 'View openings on the official site ↗'],
    existing: ['STILL AVAILABLE', 'Your earlier options are still available', 'We checked again, and these openings from your last email were still available. There are no new matches this time.', 'green', 'View openings on the official site ↗'],
    none: ['WE’RE WATCHING', `We’re watching for your ${sim ? 'session' : 'tee time'}`, `We checked this ${venueWord} and found no ${units} matching your saved request yet.`, 'green', 'View the official booking page ↗'],
    checking: ['GETTING STARTED', `We’re checking this ${venueWord} for you`, 'Your alert is saved. We haven’t confirmed any openings here yet.', 'blue', 'Visit the official site ↗'],
    window: ['WAITING FOR BOOKING TO OPEN', 'Your requested date hasn’t opened yet', `This ${venueWord} hasn’t released ${units} for your date. In this example, booking opens Wed, Oct 28 at 7:00 AM EDT.`, 'blue', 'View the official booking page ↗'],
    retry: ['WE’RE CHECKING ON IT', 'Your alert is still active', 'We couldn’t confirm openings on our last check.', 'amber', 'Check openings on the official site ↗'],
    support: ['WE’RE WORKING ON IT', `We’re checking whether we can watch this ${venueWord}`, 'Your alert is saved. We’re looking into how this booking site works, and we can’t confirm openings here yet.', 'amber', 'Check the official site for now ↗'],
    review: ['CHECK DIRECTLY FOR NOW', 'This venue needs a closer look', `Automatic alerts aren’t ready for this ${venueWord}. We haven’t confirmed current openings here.`, 'amber', 'Check the official site ↗'],
    direct: ['CHECK DIRECTLY', `Use this ${venueWord}’s booking site`, `Tee Time Spot can’t check ${units} here automatically.`, 'amber', 'Check the official booking site ↗'],
    phone: ['CALL FOR OPENINGS', `Call the ${venueWord} for current openings`, `This ${venueWord} confirms availability by phone, so we can’t watch for openings here.`, 'amber', 'Find the official contact details ↗'],
    account: ['SIGN IN TO CHECK', `This ${venueWord} requires its own sign-in`, 'Current openings are only visible after you sign in on its website. Tee Time Spot can’t check pages that require your account.', 'amber', 'Sign in on the official site ↗'],
    captcha: ['CHECK DIRECTLY', 'The booking site needs you to take a step', 'Its verification step or waiting room prevents us from checking current openings.', 'amber', 'Open the official booking page ↗'],
    invalid: ['CHOOSE ANOTHER VENUE', sim ? 'Public sessions aren’t offered here' : 'This course is private', sim ? 'This example venue does not offer public simulator rentals, so we can’t watch for sessions here.' : 'This example course is private, so it can’t be included in public tee-time alerts.', 'red', 'Choose another venue ↗'],
    recovered: ['BACK ON TRACK', `We’re checking this ${venueWord} again`, 'The latest check worked. The openings below were available when we checked.', 'green', 'View openings on the official site ↗'],
    stale: ['A FRESH CHECK IS NEEDED', 'We need to confirm the latest openings', 'The times we found earlier may have changed. We’re keeping them out of your current results until we can confirm them again.', 'amber', 'Check the official site for now ↗'],
    gone: ['WE’RE STILL LOOKING', 'Those earlier openings are no longer available', 'The times from your previous email were no longer listed at the latest check.', 'green', 'View the official booking page ↗'],
    outside: ['WE’RE WATCHING', 'There are openings outside your window', `We found ${units} outside your saved window, but none matching your request. These other times won’t trigger an opening alert.`, 'green', 'View other times on the official site ↗']
  };
  if (!statuses[scenario]) throw new Error(`Unknown scenario: ${scenario}`);
  const effectiveKind = kind === 'instant' && !['mixed', 'new'].includes(scenario) ? 'morning' : kind;
  const hasNew = ['mixed', 'new'].includes(scenario);
  const hasExisting = ['mixed', 'existing', 'recovered'].includes(scenario);
  const heading = effectiveKind === 'setup' ? 'Your alert is saved. Here’s the latest.' : effectiveKind === 'morning' ? `Your ${sim ? 'simulator' : 'tee-time'} update` : `2 new ${units} match your alert`;
  const intro = hasNew ? 'New openings are listed first. Earlier options are included when they were still available at this check.' : 'Here’s where your alert stands. Each venue below has its own latest update.';
  const clock = h => `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;
  const allTimes = sim ? Array.from({ length: stress ? 10 : 6 }, (_, i) => ({ start: clock(10 + i), end: clock(11 + i), isNew: i < 2 })) : ['9:20 AM', '9:40 AM', '10:10 AM', '10:30 AM', '11:00 AM', '11:20 AM'].map((start, i) => ({ start, isNew: i < 2 }));
  const newTimes = hasNew ? allTimes.filter(t => t.isNew) : [];
  const existingTimes = hasExisting ? allTimes.filter(t => !t.isNew) : [];
  const newCount = newTimes.length;
  const oldCount = existingTimes.length;
  const groupTitle = (fresh, count) => `<h3 style="color:${fresh ? c.ink : c.green};font-size:14px;line-height:21px;margin:0 0 9px">${fresh ? tag('NEW', c.orange, '#251807') + ' &nbsp; New since your last email' : 'Still available · previously shared'} <span style="font-weight:500;color:${c.muted}">(${count})</span></h3>`;
  function slots(times, fresh, layout = 'pills') {
    if (!times.length) return '';
    const large = layout === 'feature';
    const list = layout === 'rows';
    const columns = list || large ? 1 : Math.min(times.length, sim ? 2 : 4);
    const cells = times.map(t => {
      const time = sim ? `${esc(t.start)}<span style="display:block;font-size:12px;font-weight:600;margin-top:2px">to ${esc(t.end)}</span>` : esc(t.start);
      return `<td class="${columns === 4 ? 'four-slot' : 'slot-cell'}" width="${100 / columns}%" style="padding:4px;vertical-align:top"><div data-time="${fresh ? 'new' : 'existing'}" style="padding:${large ? '17px 12px' : '12px 6px'};text-align:${list ? 'left' : 'center'};background:${fresh ? c.dark : '#eaf3ee'};color:${fresh ? '#ffffff' : '#1c593d'};border:1px solid ${fresh ? '#256644' : '#c8e1d2'};border-radius:10px;font-size:${large ? 27 : 14}px;line-height:20px;font-weight:800">${time}<span style="display:${list ? 'inline-block' : 'block'};${list ? 'margin-left:16px;' : 'margin-top:6px;'}font-size:10px;line-height:16px;letter-spacing:.4px;color:${fresh ? '#f4a74f' : '#38654f'}">${fresh ? '✦ NEW' + (sim ? ' · 60 MIN' : '') : id === 20 ? sim ? '60 MIN' : 'AVAILABLE' : 'PREVIOUSLY SHARED' + (sim ? ' · 60 MIN' : '')}</span></div></td>`;
    });
    return table(cells.map((cell, i) => (i % columns === 0 ? '<tr>' : '') + cell + ((i + 1) % columns === 0 ? '</tr>' : '')).join('') + (cells.length % columns ? `${'<td></td>'.repeat(columns - cells.length % columns)}</tr>` : ''));
  }
  function availability() {
    let fresh = newTimes.length ? groupTitle(true, newCount) + (id === 13 ? slots(newTimes.slice(0, 1), true, 'feature') + slots(newTimes.slice(1), true) : slots(newTimes, true, id === 11 ? 'rows' : 'pills')) : '';
    let old = existingTimes.length ? groupTitle(false, oldCount) + slots(existingTimes, false, id === 11 ? 'rows' : 'pills') : '';
    if (id === 12 && existingTimes.length) old = groupTitle(false, oldCount) + table(existingTimes.map(t => row(`${esc(t.start)}${sim ? ' – ' + esc(t.end) : ''}<span style="display:block;font-size:11px;color:${c.muted}">Previously shared</span>`, `padding:12px 8px;border-bottom:1px solid ${c.line};font-weight:700;background:#eaf3ee`).replace('<td style=', '<td data-time="existing" style=')).join(''));
    if ([6, 20].includes(id) && fresh) fresh = table(row(fresh, `padding:14px 12px;background:#fff3df;border:1px solid #efd1a4;border-radius:12px`));
    if (id === 8 && fresh) fresh = table(row(`${newCount} newly found ${units}`, `padding:10px 12px;background:${c.orange};color:#251807;font-weight:800;border-radius:8px`)) + slots(newTimes, true);
    return fresh + (fresh && old ? '<div style="height:18px"></div>' : '') + old;
  }
  function card(statusId, venueIndex) {
    const status = statuses[statusId];
    const available = ['new', 'mixed', 'existing', 'recovered'].includes(statusId);
    const tone = ({ new: ['#fff3df', '#efd1a4'], green: ['#eaf3ee', '#c8e1d2'], blue: ['#fff3df', '#efd1a4'], amber: ['#fff3df', '#efd1a4'], red: ['#f4efe5', '#d9d2c7'] })[status[3]];
    const name = stress ? names[venueIndex - 1] + (sim ? ' Indoor Golf & Simulator Studio — Bellingham Location' : ' — Championship Course & Practice Facility') : names[venueIndex - 1];
    const modeLabel = sim ? '▣ SIMULATOR' : '⚑ GOLF COURSE';
    const badge = tag(modeLabel, '#153c2d', '#d7f1df');
    const title = `<h2 style="font-size:${id === 9 ? 28 : 23}px;line-height:1.2;letter-spacing:-.5px;margin:14px 0 5px;font-weight:800;color:#ffffff;overflow-wrap:anywhere">${esc(name)}</h2>`;
    const place = p(venueIndex === 1 ? sim ? 'Bellingham, MA' : 'Swansea, MA' : 'Sample location · New England', 'font-size:12px;color:#e2ece5;margin:0');
    const pictureStyle = `background-color:${c.dark};background-image:linear-gradient(0deg,rgba(10,29,20,.9),rgba(10,29,20,.15)),url('${esc(image)}');background-position:center;background-size:cover;`;
    let header = row(`${badge}${id === 19 && statusId === 'mixed' ? '&nbsp;' + tag('✦ 2 NEW', c.orange, '#251807') : ''}${title}${place}`, `${pictureStyle}padding:22px 20px;height:${id === 10 ? 100 : [5, 9].includes(id) ? 176 : 132}px;vertical-align:bottom;border-radius:14px 14px 0 0;`);
    if ([3, 4].includes(id)) header = row(table(`<tr><td width="${id === 3 ? '22%' : '36%'}" style="width:${id === 3 ? '22%' : '36%'};${pictureStyle}height:142px;border-radius:12px 0 0 0"></td><td style="padding:18px 16px;background:${c.dark};border-radius:0 12px 0 0">${badge}${title}${place}</td></tr>`));
    if (id === 16) header = row('', `${pictureStyle}height:132px;border-radius:14px 14px 0 0;`) + row(`${badge}${title}${place}`, `padding:17px 20px;background:${c.dark}`);
    const info = row(`${shortDetail} &nbsp;·&nbsp; ${sim ? 'Requested: 1 bay · 60 minutes' : 'Request for 2 golfers'}${available ? '&nbsp; · &nbsp; Thu, Oct 29' : ''}`, `padding:10px 18px;background:#f5f8f5;color:${c.muted};font-size:12px;line-height:19px;border-bottom:1px solid ${c.line}`);
    const stateIcon = ({ existing: '✓', none: '✓', checking: '◷', window: '▦', retry: '↻', support: '+', review: '⌕', direct: '↗', phone: '☎', account: '▣', captcha: '!', invalid: '—', recovered: '✓', stale: '◷', gone: '—', outside: '◷' })[statusId] || '•';
    const nextSteps = {
      existing: 'No action needed to keep your alert running. We’ll email you when we find a new match.',
      none: 'No action needed. We’ll keep looking and email you when we find a match.',
      checking: 'No action needed. We’ll email you when we confirm a matching opening.',
      window: 'No action needed. We’ll check when booking opens for your date.',
      retry: 'We’ll check again automatically. You don’t need to do anything.',
      support: 'We’ll update you when we know whether alerts can run here. You can check the official site in the meantime.',
      review: 'Check the official site for current openings. Your other selected venues are checked separately.',
      direct: 'Open the official site to see current options. Your other selected venues are checked separately.',
      phone: 'Use the venue’s official contact details to ask about current openings.',
      account: 'Sign in yourself on the venue’s official site to see current openings.',
      captcha: 'Open the official site and complete its verification or waiting-room step yourself.',
      invalid: 'Choose another venue from your dashboard to keep looking for somewhere to play.',
      recovered: 'No action needed. Your alert is watching for new matching openings again.',
      stale: 'We’ll try again automatically. Check the official site if you want to look right now.',
      gone: 'No action needed. Your alert is still running, and we’ll email you when we find a new match.',
      outside: 'No action needed. We’ll keep looking inside your saved window. You can also view the other times on the official site.'
    };
    const userActionNeeded = ['review', 'direct', 'phone', 'account', 'captcha', 'invalid'].includes(statusId);
    const statePanel = `<div data-status="${statusId}" data-follow-up="${userActionNeeded ? 'user' : 'automatic'}" data-state-style="selected-photo-card" style="border-radius:12px;background:${tone[0]};border:1px solid ${tone[1]};padding:14px 12px;color:${c.ink}">${tag(status[0], status[3] === 'green' ? '#d8e9dd' : c.orange, status[3] === 'green' ? '#1c593d' : '#251807')}<div style="height:12px"></div>${table(`<tr><td style="width:44px;vertical-align:top"><div aria-hidden="true" style="width:34px;height:34px;background:${c.dark};color:#f4a74f;border-radius:10px;text-align:center;font-size:22px;line-height:34px;font-weight:800">${stateIcon}</div></td><td style="vertical-align:top"><h3 style="font-size:18px;line-height:24px;margin:0 0 7px;color:${c.ink}">${status[1]}</h3>${p(status[2], `font-size:13px;line-height:21px;color:${c.muted};margin-bottom:0`)}</td></tr>`)}<div style="margin-top:14px;padding-top:12px;border-top:1px solid ${tone[1]};font-size:12px;line-height:20px;color:${c.muted}"><strong style="color:${c.ink}">${userActionNeeded ? 'Your next step' : 'What we’ll do next'}</strong><br>${nextSteps[statusId]}</div></div>`;
    const gone = statusId === 'gone' ? `<div data-time="gone" style="margin-top:14px;padding:12px;background:#eef0ed;color:#69776e;border:1px solid #d9e3dc;border-radius:8px"><s>${sim ? '10:00 AM – 11:00 AM' : '9:20 AM'}</s><strong style="display:block;margin-top:4px;font-size:11px">NO LONGER AVAILABLE · NOT A CURRENT MATCH</strong></div>` : '';
    const outside = statusId === 'outside' ? `<div style="margin-top:14px;padding:12px;background:#eaf3ee;color:#1c593d;border:1px solid #c8e1d2;border-radius:10px"><strong>${sim ? '9:00 AM – 10:00 AM' : '7:30 AM'}</strong><span style="display:block;font-size:12px">Before your requested ${sim ? '10:00 AM' : '8:00 AM'} start · ${venueWord} local time</span></div>` : '';
    const content = available ? (statusId === 'existing' || statusId === 'recovered' ? statePanel + '<div style="height:16px"></div>' : '') + availability() : statePanel + gone + outside;
    return table(header + info + row(`${content}${available ? p(`All times are ${venueWord} local · EDT`, `font-size:12px;color:${c.muted};margin-top:14px`) : ''}<div style="height:16px"></div>${button(status[4], statusId === 'invalid')}`, `padding:${id === 10 ? '14px' : '18px'};background:#ffffff;border-radius:0 0 14px 14px;`), `border:1px solid ${c.line};border-radius:14px;margin-bottom:18px;overflow:hidden;` ).replace('<table role=', `<table data-course-card="${statusId}" role=`);
  }
  const cards = scenario === 'mixed' ? [['mixed', 1], ['none', 2], ['window', 3], ['retry', 4], ['direct', 5]] : [[scenario, 1]];
  const renderedCards = cards.map(([s, venueIndex]) => card(s, venueIndex)).join('');
  const summaryItems = [['DATE', 'Thu, Oct 29'], ['YOUR WINDOW', sim ? '10 AM – 8 PM' : '8 AM – noon'], [sim ? 'SESSION' : 'GOLFERS', sim ? '60 minutes' : '2 golfers'], [sim ? 'BOOKING' : 'LAYOUT', sim ? 'One bay' : 'Any course layout']];
  const summary = table(`<tr>${summaryItems.map(([label, value]) => `<td class="summary-cell" width="25%" style="width:25%;padding:13px 10px;vertical-align:top"><span style="font-size:10px;line-height:15px;font-weight:800;letter-spacing:.6px;color:${c.muted}">${label}</span><strong style="display:block;margin-top:4px;font-size:13px;line-height:19px">${value}</strong></td>`).join('')}</tr>`, `background:#ffffff;border:1px solid ${c.line};border-radius:12px;margin:18px 0 22px`);
  const counts = hasNew || hasExisting ? table(`<tr><td style="width:50%;padding:13px 14px;background:#ffedce;border-radius:10px 0 0 10px;color:#72400b"><strong style="font-size:22px">${newCount}</strong> &nbsp;<b style="font-size:12px">NEW ${units.toUpperCase()}</b></td><td style="width:50%;padding:13px 14px;background:#eaf3ee;border-radius:0 10px 10px 0;color:#1c593d"><strong style="font-size:22px">${oldCount}</strong> &nbsp;<b style="font-size:12px">STILL AVAILABLE</b></td></tr>`, 'margin:0 0 20px') : '';
  const topTag = tag(effectiveKind === 'setup' ? 'ALERT SAVED' : effectiveKind === 'morning' ? 'YOUR ALERT UPDATE' : '✦ NEW MATCHING OPENINGS', c.orange, '#251807');
  const lead = `${topTag}<h1 style="font-size:27px;line-height:33px;font-weight:800;letter-spacing:-.6px;margin:14px 0 9px">${heading}</h1>${p(intro, `font-size:14px;line-height:22px;color:${c.muted}`)}`;
  const changeBar = [2, 7, 18, 20].includes(id) ? counts : '';
  const leadExtra = id === 7 && hasNew ? table(row(`✦ ${newCount} newly found ${units} · ${oldCount} previously shared`, 'padding:13px 14px;background:#e28a2f;font-weight:800;color:#251807;border-radius:10px;margin-bottom:14px')) : '';
  const brand = table(`<tr><td style="padding:18px 20px;font-size:21px;line-height:26px;font-weight:800;color:#ffffff">⛳ &nbsp;Tee Time Spot</td><td style="width:103px;padding:18px 16px;font-size:11px;line-height:18px;text-align:right;color:#d7e7dd">${sim ? '▣ Simulator' : '⚑ Golf course'}</td></tr>`, `background:${c.dark};border-radius:16px 16px 0 0;border-bottom:3px solid ${c.orange}`);
  const foot = table(row(`${p('You book direct. We never book or hold an opening.', 'font-weight:800;font-size:13px')}${p('Availability can change. The official booking page is the source of truth.', 'font-size:12px;line-height:19px;color:#5c6c64')}${p('Updated Tue, Oct 27 at 7:02 AM EDT · Mock observation', 'font-size:11px;line-height:18px;color:#5c6c64')}${button('Manage this alert', true)}<a href="#preview-action" style="display:block;text-align:center;font-size:12px;line-height:20px;padding:12px 0;color:#315846">I booked — stop these results</a><a href="#preview-action" style="display:block;text-align:center;font-size:12px;line-height:20px;padding:12px 0;color:#6a5a4a">Cancel this alert / unsubscribe</a>`, 'padding:20px;background:#f0f3ec;border-radius:12px;margin-top:6px'));
  const isFrame = id === 17;
  const body = id === 14 ? `${lead}${summary}${changeBar}${renderedCards}${foot}` : `${leadExtra}${lead}${id === 2 ? counts : ''}${summary}${id !== 2 ? changeBar : ''}${renderedCards}${foot}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(design.name)} — ${shortDetail}</title><style>body,table,td,a{-webkit-text-size-adjust:100%;}body{margin:0}td{overflow-wrap:anywhere}img{border:0}a:focus-visible{outline:3px solid #e28a2f;outline-offset:3px}@media(max-width:520px){.outer{padding:0!important}.email-pad{padding:20px 14px!important}.summary-cell{display:inline-block!important;width:50%!important;box-sizing:border-box!important}.four-slot{display:inline-block!important;width:50%!important;box-sizing:border-box!important}.shell{border-radius:0!important}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}</style></head><body style="background:${c.paper};color:${c.ink};font:14px/1.55 Inter,Arial,Helvetica,sans-serif;margin:0"><div style="display:none;max-height:0;overflow:hidden">${hasNew ? newCount + ' new matching ' + units + '. ' : ''}${statuses[scenario][1]}. You book direct.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="outer" align="center" style="padding:24px 14px"><table class="shell" role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;border:1px solid ${c.line};border-radius:16px;background:${isFrame ? c.dark : c.paper};table-layout:fixed">${row(brand)}${row(body, `padding:24px;${isFrame ? 'background:#f4efe5;border:8px solid #14231d;' : ''}` ).replace('<td style=', '<td class="email-pad" style=')}</table></td></tr></table></body></html>`;
}
