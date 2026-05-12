// Figma MCP plugin — receives commands from ui.html (WebSocket relay) and executes them
figma.showUI(__html__, { width: 320, height: 200, title: "Fauna MCP" });

// ── Console log interception — forwards to MCP server log buffer ──────────
(function() {
  var levels = ['log', 'warn', 'error', 'info'];
  levels.forEach(function(level) {
    var orig = console[level];
    console[level] = function() {
      if (orig) orig.apply(console, arguments);
      try {
        var args = Array.prototype.slice.call(arguments);
        var message = args.map(function(a) {
          if (a === null) return 'null';
          if (a === undefined) return 'undefined';
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
          return String(a);
        }).join(' ');
        figma.ui.postMessage({ type: 'console-capture', level: level, message: message, timestamp: Date.now() });
      } catch(e) {}
    };
  });
})();

// ── Announce file identity to the relay (sent on startup + reconnect) ─────
// Stable local key derived from the root name so reconnects hit the same map slot
var _stableLocalKey = null;
function getFileKey() {
  if (figma.fileKey) return figma.fileKey;
  if (!_stableLocalKey) {
    _stableLocalKey = 'local-' + figma.root.name.replace(/\s+/g, '-').toLowerCase().slice(0, 40);
  }
  return _stableLocalKey;
}
function sendFileInfo() {
  figma.ui.postMessage({
    type: 'FILE_INFO',
    fileName:      figma.root.name,
    fileKey:       getFileKey(),
    currentPage:   figma.currentPage.name,
    currentPageId: figma.currentPage.id
  });
}
sendFileInfo();
figma.on('currentpagechange', sendFileInfo);

// ── Selection change — send full SELECTION_CHANGE (buffered by server) ────
figma.on('selectionchange', async function() {
  var sel = figma.currentPage.selection;
  var info = await Promise.all(sel.map(async function(n) {
    var obj = {
      id: n.id, name: n.name, type: n.type,
      isLayoutGrid: isLayoutGrid(n),
      width: Math.round(n.width || 0), height: Math.round(n.height || 0),
      x: Math.round(n.x || 0),         y: Math.round(n.y || 0)
    };
    if (n.type === 'INSTANCE') {
      obj.slots = getSlotState(n);
      var mc = await n.getMainComponentAsync();
      if (mc) {
        obj.componentName = mc.name;
        obj.componentId   = mc.id;
        if (mc.parent && mc.parent.type === 'COMPONENT_SET') {
          obj.componentSetName = mc.parent.name;
        }
      }
    }
    return obj;
  }));
  // SELECTION_CHANGE is forwarded to the MCP server buffer
  figma.ui.postMessage({ type: 'SELECTION_CHANGE', nodes: info, page: figma.currentPage.name, timestamp: Date.now() });
  // legacy alias kept for Fauna chat UI
  figma.ui.postMessage({ type: 'selection-update', nodes: info });
});

// ── Helpers ────────────────────────────────────────────────────────────────

// Section component key
var SECTION_KEY = 'ec55e1cf42855ce08a89e90ba302bb531dcda8d1';

// LayoutGrid_Section variant keys — used when placing multi-column rows inside a Section
var LAYOUT_GRID_VARIANTS = {
  '1-Row-1':     'cd3267e90f83d7487d7f2976fb9ea3599aa48ff4',
  '1-Column-1':  'ed649391a75f728e8c4a38cf79478095b0fa7d29',
  '2-Row-1':     '399160f011bf1cade3c078cf7b8df3abc1889176',
  '2-Row-1:3':   'c268d614669496370f588f1a432432da70871032',
  '2-Row-3:1':   'fadfc8ba7bea951815c228aa28b3fe1303fe612d',
  '2-Column-1':  'd6c477e1328508974b9b0fb7dcda8ef00fc30369',
  '3-Row-1':     'b27e456a69e7f81710fb82dd5635cd5abd1ee27d',
  '3-Row-2:1:1': '14ac2eb8a0173da1509c9a880c659b47c3a1bc2d',
  '3-Row-1:1:2': 'b19eb1c9135bbdbc582c567ef47b6d9a37bc25a7',
  '3-Row-1:2:1': 'b77a206bf32202a6ddd6d68bf534a38afa94777a',
  '3-Row-2:2:1': 'd2fa18ac1a3b62cfccbf25d2569bc71c6686f4c3',
  '3-Row-1:2:2': 'f9139851858cb38b0268803954670452e02a91c1',
  '3-Column-1':  '7dce8ab36bae599febc0a937b78b58109525bea8',
  '4-Row-1':     'b7c46dd6c84ecd6e80f1cb020c49ddab7e8e8d1e',
  '4-Column-1':  'e6b6b9345005d88c59773aa205fb0104c8078737'
};

function getLayoutGridVariantKey(items, direction, ratio) {
  var k = items + '-' + (direction || 'Row') + '-' + (ratio || '1');
  return LAYOUT_GRID_VARIANTS[k] || LAYOUT_GRID_VARIANTS[items + '-Row-1'] || LAYOUT_GRID_VARIANTS['1-Row-1'];
}

// Read BOOLEAN / TEXT / INSTANCE_SWAP property keys from a ComponentNode's
// componentPropertyDefinitions. Full key strings are what setProperties() expects.
function getSectionComponentProps(compNode) {
  var defs = compNode.componentPropertyDefinitions || {};
  var result = { headerBoolKey: null, titleTextKey: null, descTextKey: null, swapKeys: [] };
  var textKeys = [];
  var ks = Object.keys(defs);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i];
    var def = defs[k];
    var kl = k.toLowerCase();
    if (def.type === 'BOOLEAN') {
      if (result.headerBoolKey === null || kl.indexOf('header') !== -1) result.headerBoolKey = k;
    } else if (def.type === 'TEXT') {
      textKeys.push(k);
    } else if (def.type === 'INSTANCE_SWAP') {
      result.swapKeys.push(k);
    }
  }
  // Assign title/description TEXT keys by name heuristic, falling back to order
  for (var ti = 0; ti < textKeys.length; ti++) {
    var tk = textKeys[ti], tkl = tk.toLowerCase();
    if (tkl.indexOf('title') !== -1 || tkl.indexOf('label') !== -1 || tkl.indexOf('heading') !== -1) {
      result.titleTextKey = tk;
    } else if (tkl.indexOf('desc') !== -1 || tkl.indexOf('subtitle') !== -1 ||
               tkl.indexOf('body') !== -1 || tkl.indexOf('caption') !== -1) {
      result.descTextKey = tk;
    }
  }
  // Fallback: first TEXT → title, second TEXT → description
  if (!result.titleTextKey && textKeys.length > 0) result.titleTextKey = textKeys[0];
  if (!result.descTextKey  && textKeys.length > 1) result.descTextKey  = textKeys[1];
  return result;
}

// Slot keys specific to LayoutGrid_Section instances ("Item N content#…" keys, sorted)
function getLayoutGridSlotKeys(instance) {
  var props = instance.componentProperties || {};
  var keys = [];
  var ks = Object.keys(props);
  for (var i = 0; i < ks.length; i++) {
    var k = ks[i], kl = k.toLowerCase();
    if (props[k].type === 'INSTANCE_SWAP' && kl.indexOf('item') !== -1 && kl.indexOf('content') !== -1) {
      keys.push(k);
    }
  }
  keys.sort(function(a, b) {
    var na = parseInt((a.match(/item\s*(\d+)/i) || [0, 0])[1]);
    var nb = parseInt((b.match(/item\s*(\d+)/i) || [0, 0])[1]);
    return na - nb;
  });
  return keys;
}

// All INSTANCE_SWAP keys on an instance (used by scan-page / swap-slot handlers)
function getInstanceSwapKeys(instance) {
  var props = instance.componentProperties || {};
  var keys = [];
  var ks = Object.keys(props);
  for (var i = 0; i < ks.length; i++) {
    if (props[ks[i]].type === 'INSTANCE_SWAP') keys.push(ks[i]);
  }
  return keys;
}

function isLayoutGrid(node) {
  if (node.type !== 'INSTANCE') return false;
  var name = node.name.toLowerCase();
  return name.indexOf('layoutgrid') !== -1;
}

function getSlotState(instance) {
  var slots = [];
  var keys = getInstanceSwapKeys(instance);
  if (keys.length === 0) return slots;
  var props = instance.componentProperties || {};
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = (props[key] && props[key].value) || '';
    // A slot is "empty" when its value is a short node-id-like string (default placeholder)
    // or empty. Non-empty = has a real component key (long hex string)
    var isEmpty = !val || val.length < 20;
    slots.push({ key: key, label: 'Item ' + (i + 1), isEmpty: isEmpty, currentValue: val });
  }
  return slots;
}

// Apply textOverrides to an instance.
// Step 1: match override keys to component TEXT property definitions → setProperties (clean).
// Step 2: for unmatched keys, find TEXT nodes by name and edit characters (requires font load).
async function applyTextOverrides(instance, overrides) {
  if (!overrides) return;
  var keys = Object.keys(overrides);
  if (keys.length === 0) return;

  var applied = {};

  // Step 1: component TEXT properties
  try {
    var defs = instance.componentPropertyDefinitions || {};
    var defKeys = Object.keys(defs);
    var propsToSet = {};
    for (var oi = 0; oi < keys.length; oi++) {
      var ok = keys[oi], okl = ok.toLowerCase();
      for (var di = 0; di < defKeys.length; di++) {
        var dk = defKeys[di];
        if (defs[dk].type !== 'TEXT') continue;
        var dkl = dk.split('#')[0].toLowerCase().trim();
        if (dkl === okl || dkl.indexOf(okl) !== -1 || okl.indexOf(dkl) !== -1) {
          propsToSet[dk] = String(overrides[ok]);
          applied[ok] = true;
          break;
        }
      }
    }
    if (Object.keys(propsToSet).length > 0) instance.setProperties(propsToSet);
  } catch(_) {}

  // Step 2: text nodes by name for anything not handled above
  var remaining = keys.filter(function(k) { return !applied[k]; });
  if (remaining.length === 0) return;

  try {
    var textNodes = instance.findAll(function(n) { return n.type === 'TEXT'; });
    for (var ri = 0; ri < remaining.length; ri++) {
      var rk = remaining[ri], rkl = rk.toLowerCase();
      for (var ti = 0; ti < textNodes.length; ti++) {
        var tn = textNodes[ti];
        if ((tn.name || '').toLowerCase().indexOf(rkl) !== -1) {
          try {
            await figma.loadFontAsync(tn.fontName);
            tn.characters = String(overrides[rk]);
          } catch(_) {}
          break;
        }
      }
    }
  } catch(_) {}
}

function scanLayoutGrids(page) {
  var results = [];
  var nodes = page.findAllWithCriteria({ types: ['INSTANCE'] });
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (!isLayoutGrid(node)) continue;
    var slots = getSlotState(node);
    if (slots.length === 0) continue;
    var variantProps = {};
    var cp = node.componentProperties || {};
    ['Items', 'Flex-direction', 'Ratio'].forEach(function(k) {
      if (cp[k]) variantProps[k] = cp[k].value;
    });
    results.push({
      nodeId: node.id,
      name: node.name,
      visible: node.visible,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
      variantProps: variantProps,
      slots: slots
    });
  }
  return results;
}

// ── Message handler ────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {

  // ── Create a page with proper nested AutoLayout matching reference ─────────
  if (msg.type === 'create-page-layout') {
    var comps       = msg.components || [];
    var layoutName  = msg.layoutName || 'Page Layout';
    var frameWidth  = msg.frameWidth  || 1920;
    var frameHeight = msg.frameHeight || 1080;
    var targetPageName = msg.targetPageName;

    var targetPage = figma.currentPage;
    if (targetPageName) {
      var foundPage = figma.root.children.find(function(p) {
        return p.name.toLowerCase() === targetPageName.toLowerCase();
      });
      if (foundPage) targetPage = foundPage;
    }

    // Helper: create a blank AutoLayout frame
    function makeALFrame(name, direction, w, h) {
      var f = figma.createFrame();
      f.name = name;
      f.fills = [];
      f.resize(w, h);
      f.layoutMode = direction;
      f.itemSpacing = 0;
      f.paddingTop = f.paddingRight = f.paddingBottom = f.paddingLeft = 0;
      return f;
    }

    // Bucket components by section
    var headerComp = null, sidenavComp = null, navComp = null;
    var pageHeaderComp = null, drawerComp = null;
    var contentComps = [];
    for (var bi = 0; bi < comps.length; bi++) {
      var bc = comps[bi];
      if (bc.section === 'header')     { headerComp = bc; }
      else if (bc.section === 'sidenav') { sidenavComp = bc; }
      else if (bc.section === 'nav')     { navComp = bc; }
      else if (bc.section === 'pageheader') { pageHeaderComp = bc; }
      else if (bc.section === 'drawer')  { drawerComp = bc; }
      else { contentComps.push(bc); }
    }

    var placed = [], errors = [];

    // ── Root App frame: VERTICAL, FIXED×FIXED ──────────────────────────────
    var appFrame = makeALFrame(layoutName, 'VERTICAL', frameWidth, frameHeight);
    appFrame.primaryAxisSizingMode = 'FIXED';
    appFrame.counterAxisSizingMode = 'FIXED';
    appFrame.itemSpacing = 0;
    appFrame.fills = [{ type: 'SOLID', color: { r: 0.969, g: 0.969, b: 0.973 } }];
    targetPage.appendChild(appFrame);

    // ── Header bar: align=STRETCH, grow=0 ──────────────────────────────────
    if (headerComp) {
      try {
        var hmc = await figma.importComponentByKeyAsync(headerComp.key);
        var hi = hmc.createInstance();
        appFrame.appendChild(hi);
        hi.layoutAlign = 'STRETCH';
        await applyTextOverrides(hi, headerComp.textOverrides);
        placed.push({ name: headerComp.name });
      } catch(e) { errors.push({ name: headerComp.name, error: e.message }); }
    }

    // ── Main area: HORIZONTAL, grow=1, align=STRETCH, gap=24 ───────────────
    var mainFrame = makeALFrame('Main', 'HORIZONTAL', frameWidth, frameHeight);
    mainFrame.primaryAxisSizingMode = 'FIXED';
    mainFrame.counterAxisSizingMode = 'FIXED';
    mainFrame.itemSpacing = 24;
    appFrame.appendChild(mainFrame);
    mainFrame.layoutGrow = 1;
    mainFrame.layoutAlign = 'STRETCH';

    // Apply Neutral/Background/4/Rest token to Main
    try {
      var bg4Var = await figma.variables.importVariableByKeyAsync('97aa51374458940b6d7b66c1a8e91186e386bf15');
      mainFrame.fills = [figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: { r: 0.922, g: 0.922, b: 0.922 } },
        'color',
        bg4Var
      )];
    } catch(_) {
      mainFrame.fills = [{ type: 'SOLID', color: { r: 0.922, g: 0.922, b: 0.922 } }];
    }

    // ── Navigation column: grow=0, align=STRETCH ───────────────────────────
    if (sidenavComp || navComp) {
      var navArea = makeALFrame('Navigation', 'HORIZONTAL', 100, 100);
      navArea.counterAxisSizingMode = 'AUTO';
      navArea.primaryAxisSizingMode = 'AUTO';
      navArea.itemSpacing = 0;
      navArea.layoutAlign = 'STRETCH';
      mainFrame.appendChild(navArea);

      if (sidenavComp) {
        try {
          var snmc = await figma.importComponentByKeyAsync(sidenavComp.key);
          var sni = snmc.createInstance();
          navArea.appendChild(sni);
          sni.layoutAlign = 'STRETCH';
          await applyTextOverrides(sni, sidenavComp.textOverrides);
          placed.push({ name: sidenavComp.name });
        } catch(e) { errors.push({ name: sidenavComp.name, error: e.message }); }
      }
      if (navComp) {
        try {
          var nmc = await figma.importComponentByKeyAsync(navComp.key);
          var nmi = nmc.createInstance();
          navArea.appendChild(nmi);
          nmi.layoutAlign = 'STRETCH';
          await applyTextOverrides(nmi, navComp.textOverrides);
          placed.push({ name: navComp.name });
        } catch(e) { errors.push({ name: navComp.name, error: e.message }); }
      }
    }

    // ── Page+ChatPane: HORIZONTAL, grow=1, align=STRETCH ───────────────────
    var chatPane = makeALFrame('Page+ChatPane', 'HORIZONTAL', 100, 100);
    chatPane.primaryAxisSizingMode = 'FIXED';
    chatPane.counterAxisSizingMode = 'AUTO';
    chatPane.itemSpacing = 16;
    chatPane.paddingTop = 16;
    chatPane.paddingRight = 16;
    chatPane.paddingBottom = 0;
    chatPane.paddingLeft = 16;
    mainFrame.appendChild(chatPane);
    chatPane.layoutGrow = 1;
    chatPane.layoutAlign = 'STRETCH';

    // ── PageLayout: VERTICAL, grow=1, align=STRETCH, gap=24 ────────────────
    var pageLayout = makeALFrame('PageLayout', 'VERTICAL', 100, 100);
    pageLayout.primaryAxisSizingMode = 'FIXED';
    pageLayout.counterAxisSizingMode = 'AUTO';
    pageLayout.itemSpacing = 24;
    pageLayout.paddingTop = 0;
    pageLayout.paddingRight = 12;
    pageLayout.paddingBottom = 0;
    pageLayout.paddingLeft = 12;
    chatPane.appendChild(pageLayout);
    pageLayout.layoutGrow = 1;
    pageLayout.layoutAlign = 'STRETCH';
    pageLayout.clipsContent = true;

    // Apply Neutral/Background/2/Rest token
    try {
      var bgVar = await figma.variables.importVariableByKeyAsync('0fa4c8c8fc13d3e98f827a96f25168a46cf5adc9');
      pageLayout.fills = [figma.variables.setBoundVariableForPaint(
        { type: 'SOLID', color: { r: 0.961, g: 0.961, b: 0.961 } },
        'color',
        bgVar
      )];
    } catch(_) {
      pageLayout.fills = [{ type: 'SOLID', color: { r: 0.961, g: 0.961, b: 0.961 } }];
    }

    // Apply Section/Corner radius token (12px)
    try {
      var crVar = await figma.variables.importVariableByKeyAsync('1cc316818f4f64417e936f0d49cc6288620a347f');
      pageLayout.setBoundVariable('cornerRadius', crVar);
    } catch(_) {
      pageLayout.cornerRadius = 12;
    }

    // Page header (HeaderEntity): align=STRETCH, grow=0
    if (pageHeaderComp) {
      try {
        var phmc = await figma.importComponentByKeyAsync(pageHeaderComp.key);
        var phi = phmc.createInstance();
        pageLayout.appendChild(phi);
        phi.layoutAlign = 'STRETCH';
        await applyTextOverrides(phi, pageHeaderComp.textOverrides);
        placed.push({ name: pageHeaderComp.name });
      } catch(e) { errors.push({ name: pageHeaderComp.name, error: e.message }); }
    }

    // Content rows inside PageLayout: each row → one Section, multi-column → LayoutGrid inside Section
    var rowMap2 = {};
    for (var ri2 = 0; ri2 < contentComps.length; ri2++) {
      var rc = contentComps[ri2];
      var ridx = rc.row !== undefined ? rc.row : ri2;
      if (!rowMap2[ridx]) rowMap2[ridx] = [];
      rowMap2[ridx].push(rc);
    }
    var rowKeys2 = Object.keys(rowMap2).map(Number).sort(function(a, b) { return a - b; });

    // Import Section component once and read its property definitions
    var sectionCompNode = null;
    var sectionPropDefs = { headerBoolKey: null, titleTextKey: null, descTextKey: null, swapKeys: [] };
    try {
      sectionCompNode = await figma.importComponentByKeyAsync(SECTION_KEY);
      sectionPropDefs = getSectionComponentProps(sectionCompNode);
    } catch(e) {
      errors.push({ name: 'Section import', error: e.message });
    }

    // Build one Section per row. The first item in the row provides the Section-level fields
    // (showSectionHeader, sectionTitle, sectionDescription, flexDirection, ratio).
    // Single-item rows: content component goes directly into the Section's INSTANCE_SWAP slot.
    // Multi-item rows:  a LayoutGrid_Section variant goes into the slot, then each content
    //                   component is swapped into the LayoutGrid_Section's own slots.
    for (var rkk = 0; rkk < rowKeys2.length; rkk++) {
      var rcomps = rowMap2[rowKeys2[rkk]];
      var firstComp = rcomps[0];

      if (!sectionCompNode) {
        // No Section available — place components directly as fallback
        for (var fbi = 0; fbi < rcomps.length; fbi++) {
          try {
            var fbC = await figma.importComponentByKeyAsync(rcomps[fbi].key);
            var fbI = fbC.createInstance();
            pageLayout.appendChild(fbI);
            fbI.layoutAlign = 'STRETCH';
            placed.push({ name: rcomps[fbi].name });
          } catch(fbe) { errors.push({ name: rcomps[fbi].name, error: fbe.message }); }
        }
        continue;
      }

      try {
        var sInst = sectionCompNode.createInstance();
        pageLayout.appendChild(sInst);
        sInst.layoutAlign = 'STRETCH';
        // Hug height — use newer API first, fall back to sizing mode flags
        try {
          sInst.layoutSizingVertical = 'HUG';
        } catch(_) {
          try { sInst.primaryAxisSizingMode = 'AUTO'; } catch(__) {}
        }

        // Build the Section-level property map (header, title, description)
        var sProps = {};
        if (sectionPropDefs.headerBoolKey !== null) {
          sProps[sectionPropDefs.headerBoolKey] = firstComp.showSectionHeader !== false;
        }
        if (sectionPropDefs.titleTextKey !== null && firstComp.sectionTitle) {
          sProps[sectionPropDefs.titleTextKey] = String(firstComp.sectionTitle);
        }
        if (sectionPropDefs.descTextKey !== null && firstComp.sectionDescription) {
          sProps[sectionPropDefs.descTextKey] = String(firstComp.sectionDescription);
        }

        if (rcomps.length > 1) {
          // ── Multi-column: swap the right LayoutGrid_Section variant into the Section first ──
          var nCols   = rcomps.length;
          var flexDir = firstComp.flexDirection || 'Row';
          var ratio   = firstComp.ratio || '1';
          var lgVKey  = getLayoutGridVariantKey(nCols, flexDir, ratio);
          try {
            var lgSwapComp = await figma.importComponentByKeyAsync(lgVKey);
            if (sectionPropDefs.swapKeys.length > 0) {
              sProps[sectionPropDefs.swapKeys[0]] = lgSwapComp.id;
            }
          } catch(_) {}
        }

        // Apply all Section-level properties (header, title, desc, and content-slot swap if any)
        if (Object.keys(sProps).length > 0) sInst.setProperties(sProps);

        // ── Find the LayoutGrid_Section inside the Section (default or just swapped in) ──
        // Use findAll for deep search — far more reliable than manual recursion
        var lgInst = null;
        try {
          var allInsts = sInst.findAll(function(n) { return isLayoutGrid(n); });
          if (allInsts.length > 0) lgInst = allInsts[0];
        } catch(_) {}

        if (lgInst) {
          // Set LayoutGrid slot(s) with the content component(s)
          var lgSlotKeys = getLayoutGridSlotKeys(lgInst);
          var lgProps = {};
          for (var lsi = 0; lsi < Math.min(lgSlotKeys.length, rcomps.length); lsi++) {
            if (rcomps[lsi].key) {
              try {
                var lgCC = await figma.importComponentByKeyAsync(rcomps[lsi].key);
                lgProps[lgSlotKeys[lsi]] = lgCC.id;
              } catch(_) {}
            }
          }
          if (Object.keys(lgProps).length > 0) lgInst.setProperties(lgProps);

          // Apply text overrides to content instances inside the LayoutGrid (matched by slot order)
          try {
            var contentInsts = lgInst.findAll(function(n) {
              return n.type === 'INSTANCE' && !isLayoutGrid(n);
            });
            // Match by order — same order as rcomps
            var usedIds = {};
            for (var toi = 0; toi < rcomps.length; toi++) {
              if (!rcomps[toi].textOverrides) continue;
              // Find the instance whose mainComponent matches the component we swapped in
              for (var tni = 0; tni < contentInsts.length; tni++) {
                var tin = contentInsts[tni];
                var tinId = tin.id;
                if (usedIds[tinId]) continue;
                var mc = await tin.getMainComponentAsync();
                if (mc && mc.name === rcomps[toi].name) {
                  await applyTextOverrides(tin, rcomps[toi].textOverrides);
                  usedIds[tinId] = true;
                  break;
                }
              }
            }
          } catch(_) {}

          // Make the LayoutGrid itself and its direct row children hug height
          // (they default to a hardcoded fixed height like 56px)
          try {
            try { lgInst.layoutSizingVertical = 'HUG'; } catch(_) {
              try { lgInst.primaryAxisSizingMode = 'AUTO'; } catch(__) {}
            }
            // Also fix each direct child row frame (Row1, Row2, …)
            var lgChildren = lgInst.children || [];
            for (var lci = 0; lci < lgChildren.length; lci++) {
              var lc = lgChildren[lci];
              if (lc.layoutMode && lc.layoutMode !== 'NONE') {
                try { lc.layoutSizingVertical = 'HUG'; } catch(_) {
                  try { lc.primaryAxisSizingMode = 'AUTO'; } catch(__) {}
                }
              }
            }
          } catch(_) {}
        } else if (rcomps.length === 1 && sectionPropDefs.swapKeys.length > 0) {
          // Fallback for single item: no LayoutGrid found — swap content directly into Section slot
          try {
            var directComp = await figma.importComponentByKeyAsync(firstComp.key);
            var directProps = {};
            directProps[sectionPropDefs.swapKeys[0]] = directComp.id;
            sInst.setProperties(directProps);
            // Apply text overrides to the content instance now inside the Section
            if (firstComp.textOverrides) {
              try {
                var directInst = sInst.findAll(function(n) { return n.type === 'INSTANCE' && !isLayoutGrid(n); });
                if (directInst.length > 0) await applyTextOverrides(directInst[0], firstComp.textOverrides);
              } catch(_) {}
            }
          } catch(_) {}
        } else if (!lgInst) {
          errors.push({ name: 'Section row ' + rkk, error: 'LayoutGrid not found inside Section' });
        }

        for (var cpi = 0; cpi < rcomps.length; cpi++) placed.push({ name: rcomps[cpi].name });

      } catch(rowErr) {
        errors.push({ name: 'Section row ' + rkk, error: rowErr.message });
      }
    }

    // Copilot drawer: grow=0, align=STRETCH (placed last in chatPane)
    if (drawerComp) {
      try {
        var dmc = await figma.importComponentByKeyAsync(drawerComp.key);
        var dmi = dmc.createInstance();
        chatPane.appendChild(dmi);
        dmi.layoutAlign = 'STRETCH';
        await applyTextOverrides(dmi, drawerComp.textOverrides);
        placed.push({ name: drawerComp.name });
      } catch(e) { errors.push({ name: drawerComp.name, error: e.message }); }
    }

    await figma.setCurrentPageAsync(targetPage);
    figma.viewport.scrollAndZoomIntoView([appFrame]);
    figma.ui.postMessage({ type: 'place-result', placed: placed, errors: errors });
  }


  // ── Edit an existing layout — insert/replace components in-place ──────────
  if (msg.type === 'edit-layout') {
    var editComps   = msg.components || [];
    var targetId    = msg.targetNodeId;
    var placed      = [], errors = [];

    // Find the root layout frame (by ID from selection, or first FRAME on page)
    var rootFrame = targetId ? await figma.getNodeByIdAsync(targetId) : null;
    if (!rootFrame || (rootFrame.type !== 'FRAME' && rootFrame.type !== 'INSTANCE')) {
      // Walk up to nearest frame ancestor
      if (rootFrame) {
        var p = rootFrame.parent;
        while (p && p.type !== 'FRAME' && p.type !== 'PAGE') { p = p.parent; }
        if (p && p.type === 'FRAME') rootFrame = p;
      }
    }
    if (!rootFrame) {
      figma.ui.postMessage({ type: 'place-result', placed: [], errors: [{ name: 'edit-layout', error: 'No target frame found — select a layout frame first' }] });
      return;
    }

    // Find a named child frame anywhere in the subtree (case-insensitive contains)
    function findFrameByName(root, namePart) {
      var all = root.findAll(function(n) {
        return (n.type === 'FRAME' || n.type === 'GROUP') &&
               n.name.toLowerCase().indexOf(namePart.toLowerCase()) !== -1;
      });
      return all.length > 0 ? all[0] : null;
    }

    // Section → target frame mapping
    function getTargetFrame(section) {
      if (section === 'drawer')     return findFrameByName(rootFrame, 'Page+ChatPane') || findFrameByName(rootFrame, 'chatpane') || findFrameByName(rootFrame, 'main');
      if (section === 'content')    return findFrameByName(rootFrame, 'PageLayout')    || findFrameByName(rootFrame, 'pagelayout');
      if (section === 'pageheader') return findFrameByName(rootFrame, 'PageLayout')    || findFrameByName(rootFrame, 'pagelayout');
      if (section === 'nav')        return findFrameByName(rootFrame, 'Navigation')    || findFrameByName(rootFrame, 'nav');
      if (section === 'sidenav')    return findFrameByName(rootFrame, 'Navigation')    || findFrameByName(rootFrame, 'nav');
      if (section === 'header')     return rootFrame; // top-level, prepend
      return rootFrame;
    }

    for (var ei = 0; ei < editComps.length; ei++) {
      var ec = editComps[ei];
      try {
        var eComp = await figma.importComponentByKeyAsync(ec.key);
        var eInst = eComp.createInstance();
        var tFrame = getTargetFrame(ec.section);

        if (ec.section === 'drawer') {
          // Append drawer to the right of Page+ChatPane
          tFrame.appendChild(eInst);
          eInst.layoutAlign = 'STRETCH';
        } else if (ec.section === 'header') {
          // Prepend header at the very top of the root frame
          tFrame.insertChild(0, eInst);
          eInst.layoutAlign = 'STRETCH';
        } else if (ec.section === 'pageheader') {
          // Insert page header at index 0 inside PageLayout
          tFrame.insertChild(0, eInst);
          eInst.layoutAlign = 'STRETCH';
        } else {
          tFrame.appendChild(eInst);
          eInst.layoutAlign = 'STRETCH';
        }

        await applyTextOverrides(eInst, ec.textOverrides);
        placed.push({ name: ec.name });
      } catch(e) {
        errors.push({ name: ec.name, error: e.message });
      }
    }

    figma.viewport.scrollAndZoomIntoView([rootFrame]);
    figma.ui.postMessage({ type: 'place-result', placed: placed, errors: errors });
  }


  if (msg.type === 'place-components') {
    var components = msg.components;
    var targetPageName = msg.targetPageName;
    var placed = [];
    var errors = [];

    var targetPage = figma.currentPage;
    if (targetPageName) {
      var found = figma.root.children.find(function(p) {
        return p.name.toLowerCase() === targetPageName.toLowerCase();
      });
      if (found) targetPage = found;
    }

    for (var i = 0; i < components.length; i++) {
      var comp = components[i];
      try {
        var component = await figma.importComponentByKeyAsync(comp.key);
        var instance = component.createInstance();
        targetPage.appendChild(instance);
        instance.x = comp.x !== undefined ? comp.x : 100;
        instance.y = comp.y !== undefined ? comp.y : 100;
        placed.push({ name: comp.name, key: comp.key });
      } catch (err) {
        errors.push({ name: comp.name, error: err.message });
      }
    }

    if (placed.length > 0) {
      await figma.setCurrentPageAsync(targetPage);
      var nodes = targetPage.children.slice(-placed.length);
      figma.viewport.scrollAndZoomIntoView(nodes);
    }

    figma.ui.postMessage({ type: 'place-result', placed: placed, errors: errors });
  }

  // ── Scan current page for LayoutGrid instances + slot states ─────────────
  if (msg.type === 'scan-page') {
    var grids = scanLayoutGrids(figma.currentPage);
    figma.ui.postMessage({ type: 'scan-result', grids: grids, page: figma.currentPage.name });
  }

  // ── Swap a slot inside an existing LayoutGrid instance ───────────────────
  if (msg.type === 'swap-slot') {
    var nodeId = msg.nodeId;
    var slotKey = msg.slotKey;   // may be "Item 1" label or full "Item 1 content#XXXX:XX" key
    var componentKey = msg.componentKey;
    var componentName = msg.componentName;

    try {
      var targetNode = await figma.getNodeByIdAsync(nodeId);
      if (!targetNode || targetNode.type !== 'INSTANCE') {
        throw new Error('Node not found or not an instance: ' + nodeId);
      }

      // Resolve the actual property key — may be full key or a short label
      var actualSlotKey = slotKey;
      var liveProps = targetNode.componentProperties || {};
      if (!liveProps[slotKey]) {
        // Try to find by case-insensitive prefix match
        var liveKeys = Object.keys(liveProps);
        for (var lki = 0; lki < liveKeys.length; lki++) {
          if (liveKeys[lki].toLowerCase().indexOf(slotKey.toLowerCase()) === 0) {
            actualSlotKey = liveKeys[lki];
            break;
          }
        }
      }

      // Import the component to get its local node ID (setProperties INSTANCE_SWAP requires node ID, not key)
      var importedComp = await figma.importComponentByKeyAsync(componentKey);
      var propUpdate = {};
      propUpdate[actualSlotKey] = importedComp.id;
      targetNode.setProperties(propUpdate);
      figma.viewport.scrollAndZoomIntoView([targetNode]);
      figma.ui.postMessage({
        type: 'swap-result',
        success: true,
        nodeId: nodeId,
        slotKey: actualSlotKey,
        componentName: componentName
      });
    } catch (err) {
      figma.ui.postMessage({ type: 'swap-result', success: false, error: err.message });
    }
  }

  // ── Make a hidden node visible (reveal optional LayoutGrid row) ──────────
  if (msg.type === 'make-visible') {
    try {
      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (node) {
        node.visible = true;
        figma.viewport.scrollAndZoomIntoView([node]);
        // Re-scan after reveal
        var grids = scanLayoutGrids(figma.currentPage);
        figma.ui.postMessage({ type: 'scan-result', grids: grids, page: figma.currentPage.name });
      }
    } catch (err) {
      figma.ui.postMessage({ type: 'make-visible-error', error: err.message });
    }
  }

  // ── Get selected node info ───────────────────────────────────────────────
  if (msg.type === 'get-selection') {
    var sel = figma.currentPage.selection;
    var info = sel.map(function(n) {
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        isLayoutGrid: isLayoutGrid(n),
        slots: n.type === 'INSTANCE' ? getSlotState(n) : []
      };
    });
    figma.ui.postMessage({ type: 'selection-info', nodes: info });
  }

  // ── List pages ───────────────────────────────────────────────────────────
  if (msg.type === 'get-pages') {
    var pages = figma.root.children.map(function(p) { return p.name; });
    figma.ui.postMessage({ type: 'pages-list', pages: pages });
  }

  // ── Create new page ──────────────────────────────────────────────────────
  if (msg.type === 'create-page') {
    var newPage = figma.createPage();
    newPage.name = msg.name || 'Fauna Canvas';
    await figma.setCurrentPageAsync(newPage);
    figma.ui.postMessage({
      type: 'pages-list',
      pages: figma.root.children.map(function(p) { return p.name; }),
      created: newPage.name
    });
  }

  // ── Apply token (variable) to a node property ────────────────────────────
  if (msg.type === 'apply-token') {
    figma.importVariableByKeyAsync(msg.tokenKey).then(async function(variable) {
      // Determine target node
      var targetNode = null;
      if (msg.nodeId) {
        targetNode = await figma.getNodeByIdAsync(msg.nodeId);
      } else if (msg.layerName) {
        targetNode = figma.currentPage.findOne(function(n) {
          return n.name === msg.layerName;
        });
      } else if (figma.currentPage.selection.length > 0) {
        targetNode = figma.currentPage.selection[0];
      }

      if (!targetNode) {
        figma.ui.postMessage({ type: 'apply-token-result', id: msg.id, success: false, error: 'No target node found' });
        return;
      }

      var prop = msg.property;
      var success = false;

      try {
        if (prop === 'fill' || prop === 'stroke') {
          var paintProp = prop === 'fill' ? 'fills' : 'strokes';
          var existingPaints = Array.from(targetNode[paintProp] || []);
          if (existingPaints.length === 0) {
            existingPaints = [figma.util.solidPaint('#000000')];
          }
          var boundPaint = figma.variables.setBoundVariableForPaint(existingPaints[0], 'color', variable);
          targetNode[paintProp] = [boundPaint];
          success = true;
        } else if (prop === 'cornerRadius') {
          targetNode.setBoundVariable('cornerRadius', variable);
          success = true;
        } else if (prop === 'gap' || prop === 'itemSpacing') {
          targetNode.setBoundVariable('itemSpacing', variable);
          success = true;
        } else if (prop === 'paddingTop' || prop === 'paddingRight' ||
                   prop === 'paddingBottom' || prop === 'paddingLeft') {
          targetNode.setBoundVariable(prop, variable);
          success = true;
        }
        figma.ui.postMessage({ type: 'apply-token-result', id: msg.id, success: success, nodeName: targetNode.name });
      } catch (e) {
        figma.ui.postMessage({ type: 'apply-token-result', id: msg.id, success: false, error: e.message });
      }
    }).catch(function(e) {
      figma.ui.postMessage({ type: 'apply-token-result', id: msg.id, success: false, error: 'Variable import failed: ' + e.message });
    });
  }

  // ── MCP aliases ──────────────────────────────────────────────────────────
  if (msg.type === 'list-pages') {
    var pages = figma.root.children.map(function(p) { return p.name; });
    figma.ui.postMessage({ type: 'place-result', pages: pages, id: msg.id });
  }

  // ── Re-send file info on demand ───────────────────────────────────────────
  if (msg.type === 'get-file-info') {
    sendFileInfo();
  }

  // ── Execute arbitrary Figma Plugin API code ───────────────────────────────
  if (msg.type === 'execute-code') {
    var execId = msg.id;
    var execCode = msg.code || '';

    function safeSerialize(val) {
      if (val === undefined || val === null) return null;
      try { return JSON.parse(JSON.stringify(val)); } catch(e) { return String(val); }
    }

    try {
      // Inject safe helpers for common pitfalls
      var helpers = [
        // safeGetNode: returns node or null (never throws on stale instance sublayer IDs)
        'async function safeGetNode(id) { try { return await figma.getNodeByIdAsync(id); } catch(e) { console.warn("safeGetNode: node " + id + " not found"); return null; } }',
        // safeFindAll: like node.findAll but skips nodes that became stale mid-traversal
        'function safeFindAll(parent, predicate) {',
        '  var results = [];',
        '  try {',
        '    parent.findAll(function(n) { try { if (predicate(n)) results.push(n); } catch(e) {} return false; });',
        '  } catch(e) { console.warn("safeFindAll error: " + e.message); }',
        '  return results;',
        '}',
        // safeGetMainComponent: async wrapper — works with dynamic-page documentAccess
        'async function safeGetMainComponent(node) {',
        '  if (!node || node.type !== "INSTANCE") return null;',
        '  try { return await node.getMainComponentAsync(); } catch(e) { console.warn("safeGetMainComponent error: " + e.message); return null; }',
        '}',
      ].join('\n');
      // Auto-fix: rewrite synchronous .mainComponent to async getMainComponentAsync()
      // This prevents "Cannot call with documentAccess: dynamic-page" errors
      execCode = execCode.replace(/\b(\w+)\.mainComponent\b(?!\s*Async)/g, '(await $1.getMainComponentAsync())');
      // Auto-fix: rewrite synchronous getNodeById to async getNodeByIdAsync
      execCode = execCode.replace(/figma\.getNodeById\(/g, 'await figma.getNodeByIdAsync(');
      // Auto-fix: rewrite figma.currentPage = X to await figma.setCurrentPageAsync(X)
      execCode = execCode.replace(/figma\.currentPage\s*=\s*([^;]+)/g, 'await figma.setCurrentPageAsync($1)');
      // Wrap in async IIFE so `return` statements and await work at top level
      var execResult = eval('(async function __exec__() {\n' + helpers + '\n' + execCode + '\n})()'); // jshint ignore:line
      // Always a Promise from the async IIFE
      execResult.then(function(val) {
        figma.ui.postMessage({ type: 'execute-result', id: execId, success: true, result: safeSerialize(val) });
      }).catch(function(err) {
        figma.ui.postMessage({ type: 'execute-result', id: execId, success: false, error: err.message });
      });
    } catch(execErr) {
      figma.ui.postMessage({ type: 'execute-result', id: execId, success: false, error: execErr.message });
    }
  }

  // ── Progress log from controller ─────────────────────────────────────────
  if (msg.type === 'progress-log') {
    figma.ui.postMessage({ type: 'progress-log', message: msg.message, level: msg.level || 'info' });
  }
};
