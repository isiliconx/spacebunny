/* Builds the demo grid from window.DEMOS.
   Text is assigned via textContent, never innerHTML, so the metadata can never
   inject markup into the page. */
(function () {
  'use strict';

  var grid = document.getElementById('demo-grid');
  if (!grid || !window.DEMOS) return;

  var frag = document.createDocumentFragment();

  window.DEMOS.forEach(function (demo) {
    var href = './demos/' + demo.id + '/index.html';

    var card = document.createElement('a');
    card.className = 'card';
    card.href = href;

    var thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    var img = document.createElement('img');
    img.src = './demos/' + demo.id + '/preview.png';
    img.alt = demo.title + ' — ' + demo.kicker;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 640;
    img.height = 400;
    thumb.appendChild(img);

    var body = document.createElement('div');
    body.className = 'card-body';

    var kicker = document.createElement('p');
    kicker.className = 'card-kicker';
    kicker.textContent = demo.kicker;

    var title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = demo.title;

    var desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = demo.desc;

    var foot = document.createElement('p');
    foot.className = 'card-foot';

    var tags = document.createElement('span');
    tags.className = 'card-tags';
    demo.tags.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = t;
      tags.appendChild(chip);
    });

    var metrics = document.createElement('span');
    metrics.className = 'card-metrics';
    metrics.textContent = demo.metrics;

    foot.appendChild(tags);
    foot.appendChild(metrics);

    body.appendChild(kicker);
    body.appendChild(title);
    body.appendChild(desc);
    body.appendChild(foot);

    card.appendChild(thumb);
    card.appendChild(body);
    frag.appendChild(card);
  });

  grid.appendChild(frag);
})();
