// ── Automation Schedule Picker — RRULE builder component ─────────────────
// Renders a friendly schedule picker inside any container div.
// Outputs a standard RRULE string and a human-readable label.
//
// Usage:
//   scheduleBuilder.render('my-container-id', 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', function(rrule, human) {
//     console.log(rrule, human);
//   });

var scheduleBuilder = (function() {

  // ── RRULE parser (subset) ────────────────────────────────────────────

  var WEEKDAY_CODES  = ['SU','MO','TU','WE','TH','FR','SA'];
  var WEEKDAY_SHORT  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var WEEKDAY_LONG   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function _parse(rruleStr) {
    if (!rruleStr) return {};
    var out = {};
    rruleStr.split(';').forEach(function(part) {
      var i = part.indexOf('=');
      if (i < 0) return;
      var k = part.slice(0, i).trim().toUpperCase();
      var v = part.slice(i + 1).trim();
      switch (k) {
        case 'FREQ':       out.freq = v; break;
        case 'INTERVAL':   out.interval = parseInt(v, 10) || 1; break;
        case 'BYHOUR':     out.byHour = v.split(',').map(Number); break;
        case 'BYMINUTE':   out.byMinute = v.split(',').map(Number); break;
        case 'BYDAY':      out.byDay = v.split(','); break;
        case 'BYMONTHDAY': out.byMonthDay = v.split(',').map(Number); break;
        case 'COUNT':      out.count = parseInt(v, 10); break;
        case 'UNTIL':      out.until = v; break;
      }
    });
    return out;
  }

  function _build(r) {
    if (!r.freq) return '';
    var parts = ['FREQ=' + r.freq];
    if (r.interval && r.interval > 1) parts.push('INTERVAL=' + r.interval);
    if (r.byHour   !== undefined && r.byHour !== null)   parts.push('BYHOUR='     + [].concat(r.byHour).join(','));
    if (r.byMinute !== undefined && r.byMinute !== null) parts.push('BYMINUTE='   + [].concat(r.byMinute).join(','));
    if (r.byDay    && r.byDay.length)    parts.push('BYDAY='      + r.byDay.join(','));
    if (r.byMonthDay && r.byMonthDay.length) parts.push('BYMONTHDAY=' + r.byMonthDay.join(','));
    if (r.count)   parts.push('COUNT=' + r.count);
    if (r.until)   parts.push('UNTIL=' + r.until);
    return parts.join(';');
  }

  // ── Humanizer ────────────────────────────────────────────────────────

  function humanize(rruleStr) {
    if (!rruleStr) return 'Manual';
    var r = _parse(rruleStr);
    if (!r.freq) return rruleStr;
    var h = Array.isArray(r.byHour)   ? r.byHour[0]   : null;
    var m = Array.isArray(r.byMinute) ? r.byMinute[0] : 0;
    var timeStr = h !== null ? _fmtTime(h, m) : null;
    var iv = r.interval || 1;
    switch (r.freq) {
      case 'MINUTELY':
        return iv === 1 ? 'Every minute' : 'Every ' + iv + ' minutes';
      case 'HOURLY':
        return iv === 1 ? 'Every hour' : 'Every ' + iv + ' hours';
      case 'DAILY':
        return (iv === 1 ? 'Every day' : 'Every ' + iv + ' days') + (timeStr ? ' at ' + timeStr : '');
      case 'WEEKLY': {
        var dayLabels = (r.byDay || []).map(function(d) {
          var idx = WEEKDAY_CODES.indexOf(d.replace(/^[+-]?\d*/, ''));
          return idx >= 0 ? WEEKDAY_LONG[idx] : d;
        });
        var dayPart = dayLabels.length ? ' on ' + dayLabels.join(', ') : '';
        return (iv === 1 ? 'Every week' : 'Every ' + iv + ' weeks') + dayPart + (timeStr ? ' at ' + timeStr : '');
      }
      case 'MONTHLY': {
        var dayNum = r.byMonthDay && r.byMonthDay.length ? r.byMonthDay[0] : null;
        var dPart  = dayNum !== null ? ' on the ' + _ordinal(dayNum) : '';
        return (iv === 1 ? 'Every month' : 'Every ' + iv + ' months') + dPart + (timeStr ? ' at ' + timeStr : '');
      }
      case 'YEARLY':
        return 'Every year' + (timeStr ? ' at ' + timeStr : '');
      default:
        return rruleStr;
    }
  }

  function _fmtTime(h, m) {
    var period = h >= 12 ? 'PM' : 'AM';
    var hh = h % 12 || 12;
    var mm = String(m).padStart(2, '0');
    return hh + (m ? ':' + mm : '') + ' ' + period;
  }

  function _ordinal(n) {
    var s = ['th','st','nd','rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ── Component state ──────────────────────────────────────────────────

  var _instances = {};  // containerId → state

  function _defaultState() {
    return {
      preset:    'daily',   // hourly | daily | weekly | monthly | custom
      hour:      9,
      minute:    0,
      weekdays:  [1],       // 0=SU 1=MO ... (weekly)
      monthDay:  1,         // (monthly)
      interval:  1,
      onChange:  null,
    };
  }

  function _stateToRrule(s) {
    switch (s.preset) {
      case 'hourly':
        return _build({ freq: 'HOURLY', interval: s.interval || 1, byMinute: s.minute });
      case 'daily':
        return _build({ freq: 'DAILY', interval: s.interval || 1, byHour: s.hour, byMinute: s.minute });
      case 'weekly':
        return _build({
          freq: 'WEEKLY', interval: s.interval || 1, byHour: s.hour, byMinute: s.minute,
          byDay: s.weekdays.map(function(d) { return WEEKDAY_CODES[d]; }),
        });
      case 'monthly':
        return _build({ freq: 'MONTHLY', interval: s.interval || 1, byHour: s.hour, byMinute: s.minute, byMonthDay: s.monthDay });
      case 'custom':
        return s._customRrule || '';
      default:
        return '';
    }
  }

  function _rruleToState(rruleStr) {
    var s = _defaultState();
    if (!rruleStr) return s;
    var r = _parse(rruleStr);
    s.hour     = (r.byHour && r.byHour.length)   ? r.byHour[0]   : 9;
    s.minute   = (r.byMinute && r.byMinute.length) ? r.byMinute[0] : 0;
    s.interval = r.interval || 1;
    switch (r.freq) {
      case 'HOURLY':
        s.preset = 'hourly'; break;
      case 'DAILY':
        s.preset = 'daily'; break;
      case 'WEEKLY':
        s.preset = 'weekly';
        s.weekdays = (r.byDay || ['MO']).map(function(d) {
          var idx = WEEKDAY_CODES.indexOf(d.replace(/^[+-]?\d*/, ''));
          return idx >= 0 ? idx : 1;
        });
        break;
      case 'MONTHLY':
        s.preset = 'monthly';
        s.monthDay = (r.byMonthDay && r.byMonthDay.length) ? r.byMonthDay[0] : 1;
        break;
      default:
        s.preset = 'custom';
        s._customRrule = rruleStr;
    }
    return s;
  }

  // ── Render ───────────────────────────────────────────────────────────

  function _render(containerId) {
    var s = _instances[containerId];
    var c = document.getElementById(containerId);
    if (!c || !s) return;

    var rrule = _stateToRrule(s);
    var human = humanize(rrule);

    var hourOpts = '';
    for (var hh = 0; hh < 24; hh++) {
      hourOpts += '<option value="' + hh + '"' + (s.hour === hh ? ' selected' : '') + '>' +
        _fmtTime(hh, 0).replace(/:\d+/, '') + ' (' + String(hh).padStart(2, '0') + ':xx)</option>';
    }
    var minOpts = [0, 15, 30, 45].map(function(mm) {
      return '<option value="' + mm + '"' + (s.minute === mm ? ' selected' : '') + '>:' + String(mm).padStart(2, '0') + '</option>';
    }).join('');

    var presets = [
      { key: 'hourly',  label: 'Every hour' },
      { key: 'daily',   label: 'Daily' },
      { key: 'weekly',  label: 'Weekly' },
      { key: 'monthly', label: 'Monthly' },
      { key: 'custom',  label: 'Custom' },
    ];
    var presetBtns = presets.map(function(p) {
      return '<button class="sched-preset' + (s.preset === p.key ? ' active' : '') + '" ' +
        'onclick="scheduleBuilder._setPreset(\'' + containerId + '\',\'' + p.key + '\')">' +
        p.label + '</button>';
    }).join('');

    // Time row (shown for all except custom)
    var showTime = s.preset !== 'hourly' && s.preset !== 'custom';
    var timeRow = showTime
      ? '<div class="sched-row"><label class="sched-lbl">At</label>' +
        '<div class="sched-time-group">' +
        '<select class="sched-select" onchange="scheduleBuilder._setField(\'' + containerId + '\',\'hour\',+this.value)">' + hourOpts + '</select>' +
        '<select class="sched-select sched-min" onchange="scheduleBuilder._setField(\'' + containerId + '\',\'minute\',+this.value)">' + minOpts + '</select>' +
        '</div></div>'
      : '';

    // Weekday toggles (weekly)
    var weekRow = '';
    if (s.preset === 'weekly') {
      var dayBtns = WEEKDAY_SHORT.map(function(d, i) {
        var active = s.weekdays.indexOf(i) >= 0;
        return '<button class="sched-day' + (active ? ' active' : '') + '" ' +
          'onclick="scheduleBuilder._toggleDay(\'' + containerId + '\',' + i + ')">' + d + '</button>';
      }).join('');
      weekRow = '<div class="sched-row"><label class="sched-lbl">On</label><div class="sched-days">' + dayBtns + '</div></div>';
    }

    // Month-day (monthly)
    var monthRow = '';
    if (s.preset === 'monthly') {
      var dayOpts = '';
      for (var dd = 1; dd <= 31; dd++) {
        dayOpts += '<option value="' + dd + '"' + (s.monthDay === dd ? ' selected' : '') + '>' + _ordinal(dd) + '</option>';
      }
      monthRow = '<div class="sched-row"><label class="sched-lbl">On</label>' +
        '<select class="sched-select" onchange="scheduleBuilder._setField(\'' + containerId + '\',\'monthDay\',+this.value)">' + dayOpts + '</select>' +
        '<span class="sched-lbl" style="margin-left:4px">of the month</span></div>';
    }

    // Interval (not for hourly/custom)
    var ivRow = '';
    if (s.preset !== 'custom' && s.preset !== 'hourly') {
      var ivUnit = { daily: 'day', weekly: 'week', monthly: 'month' }[s.preset] || 'day';
      ivRow = s.interval > 1 ? '' :
        '<div class="sched-row sched-interval-row">' +
        '<label class="sched-lbl">Every</label>' +
        '<input class="sched-interval-input" type="number" min="1" max="99" value="' + s.interval + '" ' +
          'onchange="scheduleBuilder._setField(\'' + containerId + '\',\'interval\',+this.value)">' +
        '<span class="sched-lbl">' + ivUnit + '(s)</span></div>';
    }

    // Custom RRULE textarea
    var customRow = '';
    if (s.preset === 'custom') {
      customRow = '<div class="sched-row sched-custom-row">' +
        '<label class="sched-lbl">RRULE</label>' +
        '<input class="sched-custom-input" type="text" placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=10;BYMINUTE=0" ' +
          'value="' + (s._customRrule || '') + '" ' +
          'onchange="scheduleBuilder._setCustom(\'' + containerId + '\',this.value)" ' +
          'oninput="scheduleBuilder._setCustom(\'' + containerId + '\',this.value)">' +
        '</div>';
    }

    // Human-readable preview
    var preview = rrule
      ? '<div class="sched-preview">' + human + '</div>'
      : '<div class="sched-preview sched-preview-empty">No schedule — manual only</div>';

    c.innerHTML =
      '<div class="sched-presets">' + presetBtns + '</div>' +
      timeRow + weekRow + monthRow + ivRow + customRow +
      preview;
  }

  // ── Public API ───────────────────────────────────────────────────────

  function render(containerId, initialRrule, onChange) {
    var s = _rruleToState(initialRrule || '');
    s.onChange = onChange || null;
    _instances[containerId] = s;
    _render(containerId);
  }

  function getValue(containerId) {
    var s = _instances[containerId];
    return s ? _stateToRrule(s) : '';
  }

  function _setPreset(containerId, preset) {
    var s = _instances[containerId];
    if (!s) return;
    s.preset = preset;
    _afterChange(containerId);
  }

  function _setField(containerId, field, val) {
    var s = _instances[containerId];
    if (!s) return;
    s[field] = val;
    _afterChange(containerId);
  }

  function _toggleDay(containerId, dayIdx) {
    var s = _instances[containerId];
    if (!s) return;
    var i = s.weekdays.indexOf(dayIdx);
    if (i >= 0) {
      if (s.weekdays.length > 1) s.weekdays.splice(i, 1); // keep at least one
    } else {
      s.weekdays.push(dayIdx);
      s.weekdays.sort(function(a,b) { return a - b; });
    }
    _afterChange(containerId);
  }

  function _setCustom(containerId, val) {
    var s = _instances[containerId];
    if (!s) return;
    s._customRrule = val.trim();
    _afterChange(containerId);
  }

  function _afterChange(containerId) {
    var s = _instances[containerId];
    if (!s) return;
    _render(containerId);
    if (typeof s.onChange === 'function') {
      var rrule = _stateToRrule(s);
      s.onChange(rrule, humanize(rrule));
    }
  }

  // ── Next occurrences preview (client-side, mirrors server logic) ─────

  function nextOccurrences(rruleStr, n) {
    if (!rruleStr) return [];
    // Delegate to server for accuracy
    return fetch('/api/rrule/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rrule: rruleStr, count: n || 3 }),
    })
      .then(function(r) { return r.json(); })
      .then(function(d) { return d.occurrences || []; })
      .catch(function() { return []; });
  }

  return {
    render: render,
    getValue: getValue,
    humanize: humanize,
    nextOccurrences: nextOccurrences,
    // internal (called from inline onclick)
    _setPreset: _setPreset,
    _setField: _setField,
    _toggleDay: _toggleDay,
    _setCustom: _setCustom,
  };
})();
