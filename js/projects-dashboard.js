/* Builds the projects grid from window.PROJECTS.
 *
 * Same rule as the demo grid: every string goes in via textContent, never
 * innerHTML, so a project title or description can never inject markup.
 *
 * Fifty cards is a lot to scan, so the grid is filtered by category. The
 * active category lives in the URL hash, which makes a filtered view
 * linkable and survives a reload. */
(function () {
  'use strict';

  var grid = document.getElementById('project-grid');
  if (!grid || !window.PROJECTS) return;

  var filters = document.getElementById('project-filters');
  var emptyNote = document.getElementById('project-empty');
  var groups = window.PROJECT_GROUPS || [];
  var active = 'all';

  // Group order follows the declared category order, not first-seen order, so
  // the filters always read top to bottom the same way.
  var order = groups.map(function (g) { return g.key; });
  window.PROJECTS.forEach(function (p) {
    if (order.indexOf(p.group) < 0) order.push(p.group);
  });

  var labelFor = {};
  groups.forEach(function (g) { labelFor[g.key] = g.label; });

  function makeCard(p) {
    var card = document.createElement('a');
    card.className = 'card';
    card.href = './projects/' + p.slug + '/index.html';
    card.dataset.group = p.group;

    var thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    var img = document.createElement('img');
    img.src = './projects/' + p.slug + '/preview.png';
    img.alt = p.title;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 640;
    img.height = 400;
    thumb.appendChild(img);

    var body = document.createElement('div');
    body.className = 'card-body';

    var kicker = document.createElement('p');
    kicker.className = 'card-kicker';
    kicker.textContent = labelFor[p.group] || p.group;

    var title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = p.title;

    var desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = p.desc;

    var foot = document.createElement('p');
    foot.className = 'card-foot';
    var meta = document.createElement('span');
    meta.className = 'card-metrics';
    meta.textContent = p.kb + ' KB · view →';
    foot.appendChild(meta);

    body.appendChild(kicker);
    body.appendChild(title);
    body.appendChild(desc);
    body.appendChild(foot);

    card.appendChild(thumb);
    card.appendChild(body);
    return card;
  }

  var frag = document.createDocumentFragment();
  window.PROJECTS.forEach(function (p) { frag.appendChild(makeCard(p)); });
  grid.appendChild(frag);

  function apply(group, fromHash) {
    active = group;
    var shown = 0;
    Array.prototype.forEach.call(grid.children, function (card) {
      var match = group === 'all' || card.dataset.group === group;
      card.hidden = !match;
      if (match) shown++;
    });
    if (emptyNote) emptyNote.hidden = shown > 0;

    if (filters) {
      Array.prototype.forEach.call(filters.children, function (btn) {
        var on = btn.dataset.group === group;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.classList.toggle('is-active', on);
      });
    }

    if (!fromHash) {
      var next = group === 'all' ? '#projects' : '#projects/' + group;
      if (location.hash !== next) history.replaceState(null, '', next);
    }
  }

  if (filters) {
    var counts = {};
    window.PROJECTS.forEach(function (p) {
      counts[p.group] = (counts[p.group] || 0) + 1;
    });

    function addFilter(key, text) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filter';
      btn.dataset.group = key;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      var n = key === 'all' ? window.PROJECTS.length : (counts[key] || 0);
      var label = document.createElement('span');
      label.textContent = text;
      var num = document.createElement('span');
      num.className = 'filter-count';
      num.textContent = n;
      btn.appendChild(label);
      btn.appendChild(num);
      btn.addEventListener('click', function () { apply(key); });
      filters.appendChild(btn);
    }

    addFilter('all', 'All');
    order.forEach(function (key) {
      if (counts[key]) addFilter(key, labelFor[key] || key);
    });
  }

  // Hash routing: #projects or #projects/<group>.
  function fromHash() {
    var m = location.hash.match(/^#projects\/?([\w-]*)/);
    if (!m) return null;
    var g = m[1] || 'all';
    return order.indexOf(g) >= 0 || g === 'all' ? g : null;
  }

  apply(fromHash() || 'all', true);
  window.addEventListener('hashchange', function () {
    apply(fromHash() || 'all', true);
  });
})();
