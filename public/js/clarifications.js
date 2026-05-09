// Clarification Runtime
// Renders structured assistant questions as in-chat cards and submits answers
// back as user turns so agents can resume with typed input.

var clarificationRuntime = (function() {
  var STORE_KEY = 'fauna-clarification-answers';

  function _answers() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }

  function _answerKey(id, convId) {
    return String(convId || 'global') + '::' + id;
  }

  function _saveAnswer(id, convId, payload) {
    var answers = _answers();
    answers[_answerKey(id, convId)] = payload;
    localStorage.setItem(STORE_KEY, JSON.stringify(answers));
  }

  function _getAnswer(id, convId) {
    return _answers()[_answerKey(id, convId)] || null;
  }

  function _esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _safeId(value) {
    return String(value || ('clarify-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)))
      .replace(/[^A-Za-z0-9_.:-]/g, '-')
      .slice(0, 120);
  }

  function _parse(raw) {
    var text = String(raw || '').trim();
    try { return JSON.parse(text); }
    catch (error) {
      var start = text.indexOf('{');
      var end = text.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
      throw error;
    }
  }

  function _normalize(spec) {
    var normalized = spec && typeof spec === 'object' ? spec : {};
    normalized.id = _safeId(normalized.id || normalized.key || normalized.title || normalized.question);
    normalized.type = String(normalized.type || 'single_choice').toLowerCase().replace(/-/g, '_');
    normalized.title = String(normalized.title || 'Clarification needed');
    normalized.question = String(normalized.question || normalized.message || 'Choose how to continue.');
    normalized.submitLabel = String(normalized.submitLabel || normalized.submit || 'Continue');
    normalized.options = Array.isArray(normalized.options) ? normalized.options : [];
    normalized.fields = Array.isArray(normalized.fields) ? normalized.fields : [];
    return normalized;
  }

  function renderAll(root, convId) {
    if (!root) return;
    var blocks = Array.from(root.querySelectorAll('pre[data-special-lang="clarify"]'));
    blocks.forEach(function(block) {
      var code = block.querySelector('code');
      var raw = code ? code.textContent : '';
      var card;
      try {
        card = renderCard(_normalize(_parse(raw)), convId);
      } catch (error) {
        card = document.createElement('div');
        card.className = 'clarify-card clarify-error';
        card.innerHTML = '<div class="clarify-title"><i class="ti ti-alert-triangle"></i> Clarification block failed</div>' +
          '<div class="clarify-question">' + _esc(error.message) + '</div>';
      }
      block.replaceWith(card);
    });
  }

  function renderCard(spec, convId) {
    var answer = _getAnswer(spec.id, convId);
    var card = document.createElement('div');
    card.className = 'clarify-card' + (answer ? ' answered' : '');
    card.dataset.clarificationId = spec.id;
    card.dataset.convId = convId || '';
    card._clarificationSpec = spec;
    card.innerHTML =
      '<div class="clarify-title"><i class="ti ti-help-circle"></i> ' + _esc(spec.title) + '</div>' +
      '<div class="clarify-question">' + _esc(spec.question) + '</div>' +
      '<div class="clarify-body">' + (answer ? _renderAnswered(answer) : _renderInput(spec)) + '</div>' +
      (answer ? '' : '<div class="clarify-actions"><button class="settings-row-btn" onclick="clarificationRuntime.submit(this)">' + _esc(spec.submitLabel) + '</button></div>');
    return card;
  }

  function _renderAnswered(answer) {
    return '<div class="clarify-answered"><i class="ti ti-check"></i><span>Answered</span><pre>' + _esc(JSON.stringify(answer.values, null, 2)) + '</pre></div>';
  }

  function _renderInput(spec) {
    if (spec.type === 'confirm') return _renderConfirm(spec);
    if (spec.type === 'text') return _renderText(spec);
    if (spec.type === 'multi_choice') return _renderOptions(spec, true);
    if (spec.type === 'form') return _renderForm(spec);
    return _renderOptions(spec, false);
  }

  function _renderConfirm(spec) {
    return '<label class="clarify-check"><input type="checkbox" data-field="confirmed" checked> ' + _esc(spec.confirmLabel || 'Yes, continue') + '</label>';
  }

  function _renderText(spec) {
    var placeholder = _esc(spec.placeholder || 'Type your answer');
    return '<textarea class="settings-input clarify-textarea" data-field="answer" placeholder="' + placeholder + '"></textarea>';
  }

  function _optionValue(option, index) {
    if (option && typeof option === 'object') return String(option.value != null ? option.value : option.label != null ? option.label : index);
    return String(option);
  }

  function _optionLabel(option) {
    return option && typeof option === 'object' ? String(option.label != null ? option.label : option.value) : String(option);
  }

  function _renderOptions(spec, multiple) {
    var inputType = multiple ? 'checkbox' : 'radio';
    var options = spec.options.map(function(option, index) {
      var value = _optionValue(option, index);
      var label = _optionLabel(option);
      var description = option && typeof option === 'object' && option.description ? '<small>' + _esc(option.description) + '</small>' : '';
      var checked = index === 0 && !multiple ? ' checked' : '';
      return '<label class="clarify-option"><input type="' + inputType + '" name="clarify-' + _esc(spec.id) + '" value="' + _esc(value) + '"' + checked + '> <span><strong>' + _esc(label) + '</strong>' + description + '</span></label>';
    }).join('');
    if (spec.allowCustom) {
      options += '<input class="settings-input clarify-custom" data-field="custom" placeholder="Other option">';
    }
    return options || _renderText(spec);
  }

  function _renderForm(spec) {
    return spec.fields.map(function(field) {
      var type = String(field.type || 'text').toLowerCase();
      var id = _safeId(field.id || field.name || field.label);
      var label = _esc(field.label || id);
      var required = field.required ? ' data-required="1"' : '';
      if (type === 'textarea') {
        return '<label class="clarify-field"><span>' + label + '</span><textarea class="settings-input clarify-textarea" data-field="' + _esc(id) + '"' + required + ' placeholder="' + _esc(field.placeholder || '') + '"></textarea></label>';
      }
      if (type === 'select') {
        var options = (field.options || []).map(function(option) {
          return '<option value="' + _esc(_optionValue(option, 0)) + '">' + _esc(_optionLabel(option)) + '</option>';
        }).join('');
        return '<label class="clarify-field"><span>' + label + '</span><select class="settings-input" data-field="' + _esc(id) + '"' + required + '>' + options + '</select></label>';
      }
      if (type === 'checkbox') {
        return '<label class="clarify-check"><input type="checkbox" data-field="' + _esc(id) + '"> ' + label + '</label>';
      }
      return '<label class="clarify-field"><span>' + label + '</span><input class="settings-input" type="text" data-field="' + _esc(id) + '"' + required + ' placeholder="' + _esc(field.placeholder || '') + '"></label>';
    }).join('');
  }

  function _collectValues(card, spec) {
    if (spec.type === 'confirm') return { confirmed: Boolean(card.querySelector('[data-field="confirmed"]')?.checked) };
    if (spec.type === 'text') return { answer: (card.querySelector('[data-field="answer"]')?.value || '').trim() };
    if (spec.type === 'multi_choice') {
      var selected = Array.from(card.querySelectorAll('input[type="checkbox"]:checked')).map(function(input) { return input.value; });
      var customMulti = (card.querySelector('[data-field="custom"]')?.value || '').trim();
      if (customMulti) selected.push(customMulti);
      return { choices: selected };
    }
    if (spec.type === 'form') {
      var values = {};
      card.querySelectorAll('[data-field]').forEach(function(input) {
        values[input.dataset.field] = input.type === 'checkbox' ? Boolean(input.checked) : String(input.value || '').trim();
      });
      return values;
    }
    var selectedRadio = card.querySelector('input[type="radio"]:checked');
    var custom = (card.querySelector('[data-field="custom"]')?.value || '').trim();
    return { choice: custom || (selectedRadio ? selectedRadio.value : '') };
  }

  function _validate(card, spec, values) {
    if (spec.required === false) return '';
    if (spec.type === 'multi_choice' && (!values.choices || !values.choices.length)) return 'Choose at least one option.';
    if (spec.type === 'single_choice' && !values.choice) return 'Choose an option.';
    if (spec.type === 'text' && !values.answer) return 'Enter an answer.';
    if (spec.type === 'form') {
      var missing = spec.fields.find(function(field) {
        var fieldId = _safeId(field.id || field.name || field.label);
        return field.required && !values[fieldId];
      });
      if (missing) return (missing.label || missing.id || 'Field') + ' is required.';
    }
    return '';
  }

  async function submit(button) {
    var card = button.closest('.clarify-card');
    if (!card || !card._clarificationSpec) return;
    var spec = card._clarificationSpec;
    var values = _collectValues(card, spec);
    var validation = _validate(card, spec, values);
    if (validation) {
      if (typeof showToast === 'function') showToast(validation);
      return;
    }
    var payload = { id: spec.id, title: spec.title, type: spec.type, values: values, answeredAt: new Date().toISOString() };
    _saveAnswer(spec.id, card.dataset.convId || state.currentId, payload);
    card.classList.add('answered');
    card.querySelector('.clarify-body').innerHTML = _renderAnswered(payload);
    var actions = card.querySelector('.clarify-actions');
    if (actions) actions.remove();

    var message = [
      'Clarification response: ' + spec.title,
      '',
      '```json',
      JSON.stringify(payload, null, 2),
      '```'
    ].join('\n');
    if (typeof sendDirectMessage === 'function') await sendDirectMessage(message, { targetConvId: card.dataset.convId || state.currentId });
  }

  return { renderAll: renderAll, submit: submit };
})();

function extractAndRenderClarifications(content, msgEl, isHistory, convId) {
  if (!msgEl || typeof clarificationRuntime === 'undefined') return;
  clarificationRuntime.renderAll(msgEl.querySelector('.msg-body') || msgEl, convId || state.currentId);
}