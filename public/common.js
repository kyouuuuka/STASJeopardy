function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
}

async function post(url, body, headers) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return res.ok ? data : { error: data.error };
  } catch {
    return { error: 'No connection to the game' };
  }
}

// A clue image is a file name in images/, or a full web address.
const imgSrc = (name) => (/^https?:\/\//.test(name) ? name : '/images/' + encodeURIComponent(name));

function live(query, onView) {
  const es = new EventSource('/events' + query);
  es.onopen = () => document.body.classList.remove('offline');
  es.onerror = () => document.body.classList.add('offline');
  es.onmessage = (e) => onView(JSON.parse(e.data));
  return es;
}

function scoreboard(v, highlightId) {
  return v.players.length
    ? v.players.map((p) =>
        h('div', { class: 'score' + (p.id === highlightId ? ' up' : '') },
          h('span', { class: 'score-name' }, p.name),
          h('strong', { class: p.score < 0 ? 'neg' : '' }, p.score.toLocaleString()),
          p.id === v.control && h('small', null, 'Picks next')))
    : h('p', { class: 'muted' }, 'Waiting for players to join');
}
